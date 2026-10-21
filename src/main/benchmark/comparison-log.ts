/**
 * 性能对比测试的独立诊断日志。
 *
 * 目录结构（位于 Electron userData 下，可用「打开日志目录」按钮直接定位）：
 *
 *   performance-tests/<test-id>/logs/
 *     session.log                 人读时间线（阶段 / 事件 / 失败原因）
 *     session.json                机器可读快照（环境、参数、每轮结果、验证结果）
 *     smoke/stdout.log           冒烟预检原始 stdout
 *     smoke/stderr.log           冒烟预检原始 stderr
 *     <mode>/run-<n>/stdout.log  每种模式每次运行的原始 stdout
 *     <mode>/run-<n>/stderr.log  每种模式每次运行的原始 stderr
 *     <mode>/run-<n>/run.json    该次运行的完整诊断记录
 *
 * 这些日志与同目录上层的 report.json 一起长期保留；临时媒体文件由
 * cleanup-engine 单独清理，不会动 logs/。
 *
 * 原则：
 * 1. 原始 stdout / stderr / 子进程 error 事件全部落盘，不裁剪到只剩一句「测试失败」；
 * 2. 单文件超过上限时保留开头与结尾（中间的进度刷屏对定位没价值），并写明截断位置；
 * 3. 任何写日志失败都不能影响测试本身。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ComparisonRunDiagnostics, SmokeTestResult } from '@shared/types/performance'

/** 单文件上限：8MB（超出后停止追加，避免日志无限膨胀；尾部仍保留在 run.json 里） */
const MAX_STREAM_BYTES = 8 * 1024 * 1024
/** 流式落盘间隔：渲染中就能 tail -f 看到原始输出 */
const FLUSH_INTERVAL_MS = 3000

export interface ComparisonLogInit {
  testId: string
  projectPath: string
  cliCommand: string
  cliVersion: string | null
  nodeVersion: string
  electronVersion?: string | null
  platform: string
  settings: unknown
  comparisonKind: 'quick' | 'precise'
  modes: string[]
  outputRoot: string
}

export class ComparisonLog {
  readonly testId: string
  readonly dir: string
  readonly file: string

  /** 待落盘的原始输出（按流分组），定时 + 结束时刷盘 */
  private readonly pendingStreams = new Map<string, Buffer>()
  private readonly writtenBytes = new Map<string, number>()
  private readonly truncatedKeys = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private readonly ensureDirs = new Set<string>()
  private session: Record<string, unknown> = {}

  constructor(testId: string, userDataPath: string, dirOverride?: string) {
    this.testId = testId
    // 默认落在 userData/logs/performance-comparison/<test-id>；
    // 对比测试改为写入任务自己的 performance-tests/<test-id>/logs/，
    // 这样清理时日志与报告可以跟着任务目录一起保留，不会散落在两处。
    this.dir = dirOverride ?? join(userDataPath, 'logs', 'performance-comparison', testId)
    this.file = join(this.dir, 'session.log')
  }

  /** 创建目录并写入会话头（环境 / 参数），返回是否成功 */
  async init(data: ComparisonLogInit): Promise<boolean> {

    try {
      await fs.mkdir(this.dir, { recursive: true })
      this.session = {
        testId: data.testId,
        startedAt: new Date().toISOString(),
        projectPath: data.projectPath,
        cliCommand: data.cliCommand,
        cliVersion: data.cliVersion,
        nodeVersion: data.nodeVersion,
        electronVersion: data.electronVersion ?? null,
        platform: data.platform,
        comparisonKind: data.comparisonKind,
        modes: data.modes,
        outputRoot: data.outputRoot,
        settings: data.settings,
        smoke: null,
        runs: [],
        finishedAt: null,
        status: 'running'
      }
      await this.info('会话开始', {
        testId: data.testId,
        project: data.projectPath,
        cli: data.cliCommand,
        cliVersion: data.cliVersion,
        node: data.nodeVersion,
        platform: data.platform,
        kind: data.comparisonKind
      })
      await this.flushSession()
      return true
    } catch (err) {
      // 日志目录不可写不能阻断测试
      console.error('[comparison-log] 初始化失败', err)
      return false
    }
  }

  /* ------------------------------ 时间线 ------------------------------ */

  /** 写一行时间线（同时输出到应用日志面板之外，仅落盘） */
  async info(message: string, extra?: Record<string, unknown>): Promise<void> {
    const line = `[${new Date().toISOString()}] ${message}${
      extra ? ` ${safeJson(extra)}` : ''
    }\n`
    try {
      await fs.appendFile(this.file, line, 'utf-8')
    } catch {
      /* 忽略写失败 */
    }
  }

  /* ---------------------------- 原始流文件 ---------------------------- */

  private async streamPath(key: string): Promise<string> {
    // key 形如 `smoke/stdout` 或 `balanced/run-1/stdout`
    const parts = key.split('/')
    const stream = parts.pop() ?? 'stdout'
    const group = parts[0] ?? 'misc'
    const subdir = parts.length > 1 ? parts[1] : null
    const dir = join(this.dir, group, ...(subdir ? [subdir] : []))
    if (!this.ensureDirs.has(dir)) {
      await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
      this.ensureDirs.add(dir)
    }
    return join(dir, `${stream}.log`)
  }

  /**
   * 追加原始输出。
   * 数据先进入内存缓冲，由定时器每 3 秒追加到磁盘，因此渲染进行中也能直接查看日志。
   * key 形如 `balanced/run-1/stdout`、`smoke/stdout`。
   */
  appendStream(key: string, chunk: string): void {
    if (!chunk) return
    if (this.truncatedKeys.has(key)) return
    const current = this.pendingStreams.get(key) ?? Buffer.alloc(0)
    const next = Buffer.concat([current, Buffer.from(chunk, 'utf-8')])
    this.pendingStreams.set(key, next)
    this.ensureFlushTimer()
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => void this.flushPending(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref?.()
  }

  /** 把缓冲区里尚未落盘的内容追加到文件 */
  private async flushPending(): Promise<void> {
    for (const [key, buffer] of [...this.pendingStreams]) {
      if (buffer.length === 0) {
        this.pendingStreams.delete(key)
        continue
      }
      const written = this.writtenBytes.get(key) ?? 0
      if (written >= MAX_STREAM_BYTES) {
        this.pendingStreams.delete(key)
        if (!this.truncatedKeys.has(key)) {
          this.truncatedKeys.add(key)
          const target = await this.streamPath(key)
          await fs
            .appendFile(target, '\n[日志超过 8MB，后续输出不再写入该文件；尾部内容见 run.json]\n')
            .catch(() => undefined)
        }
        continue
      }
      const room = MAX_STREAM_BYTES - written
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
      try {
        const target = await this.streamPath(key)
        await fs.appendFile(target, slice)
        this.writtenBytes.set(key, written + slice.length)
      } catch {
        /* 写失败不阻断测试 */
      }
      this.pendingStreams.delete(key)
    }
  }

  /** 立即把某个流的剩余内容写到磁盘，返回文件路径 */
  async flushStream(key: string, _truncated = false): Promise<string | null> {
    try {
      if (this.pendingStreams.has(key)) {
        // 只刷这一个 key
        const buffer = this.pendingStreams.get(key) ?? Buffer.alloc(0)
        this.pendingStreams.delete(key)
        const written = this.writtenBytes.get(key) ?? 0
        if (buffer.length > 0 && written < MAX_STREAM_BYTES) {
          const room = MAX_STREAM_BYTES - written
          const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
          const target = await this.streamPath(key)
          await fs.appendFile(target, slice)
          this.writtenBytes.set(key, written + slice.length)
        }
      }
      const target = await this.streamPath(key)
      this.writtenBytes.set(key, this.writtenBytes.get(key) ?? 0)
      return target
    } catch {
      return null
    }
  }

  /* ------------------------------ 结构化 ------------------------------ */

  async writeRun(record: ComparisonRunDiagnostics): Promise<string | null> {
    const group = record.mode ?? 'unknown'
    // 与原始流文件放在同一个 run 目录里（例如 balanced/run-1/run.json）。
    // label 形如 balanced-run-01，序号要去掉前导零，否则会落到 run-01/ 与 run-1/ 两个目录。
    const rawIndex = record.label.match(/run-(\d+)/)?.[1]
    const runIndex = rawIndex ? String(Number(rawIndex)) : '1'
    const dir = join(this.dir, group, `run-${runIndex}`)
    try {
      await fs.mkdir(dir, { recursive: true })
      const target = join(dir, 'run.json')
      await fs.writeFile(target, JSON.stringify(record, null, 2), 'utf-8')
      return target
    } catch {
      return null
    }
  }

  /** 更新会话快照（环境 / 参数 / 每轮结果 / 冒烟结果） */
  async updateSession(patch: {
    smoke?: SmokeTestResult | null
    runs?: ComparisonRunDiagnostics[]
    status?: string
    finishedAt?: string | null
    error?: string | null
    extra?: Record<string, unknown>
  }): Promise<void> {
    this.session = {
      ...this.session,
      ...(patch.smoke !== undefined ? { smoke: patch.smoke } : {}),
      ...(patch.runs ? { runs: patch.runs } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.extra ?? {})
    }
    await this.flushSession()
  }

  private async flushSession(): Promise<void> {
    try {
      await fs.writeFile(join(this.dir, 'session.json'), JSON.stringify(this.session, null, 2), 'utf-8')
    } catch {
      /* 忽略 */
    }
  }

  /** 会话结束时写尾巴，并返回日志文件绝对路径 */
  async finish(status: string, error?: string | null): Promise<string> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushPending()
    await this.info(`会话结束：${status}${error ? ` · ${error}` : ''}`)
    await this.updateSession({
      status,
      error: error ?? null,
      finishedAt: new Date().toISOString()
    })
    return this.file
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
