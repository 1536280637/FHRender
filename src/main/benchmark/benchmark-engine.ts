import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  BenchmarkCandidate,
  BenchmarkEvent,
  BenchmarkLogLine,
  BenchmarkRunResult,
  BenchmarkSessionState,
  CliCapabilities,
  ComparisonFailure,
  ComparisonModeStatus,
  ComparisonProgress,
  ComparisonRunDiagnostics,
  ComparisonStage,
  PerformanceMode,
  SmokeTestResult
} from '@shared/types/performance'
import type { RenderRequest, RenderSettings } from '@shared/types/render'
import { DEFAULT_CLEANUP_POLICY } from '@shared/types/cleanup'
import type { TestCleanupPolicy, TestCleanupSummary } from '@shared/types/cleanup'
import { buildCliInvocation, killProcessTree, parseLine, stripAnsi } from '../process/hyperframes'
import type { ResourceMonitor } from '../monitor/resource-monitor'
import { cleanupStrayBrowsers } from '../process/stray-browsers'
import { ComparisonLog } from './comparison-log'
import { describeCliEnvironment } from './env-snapshot'
import { runRenderProcess } from './render-runner'
import { buildTaskReport } from './task-report'
import { PerformanceTestCleanup, waitForProcessExit } from '../cleanup/cleanup-engine'
import { TestWorkspace } from '../cleanup/test-workspace'

export interface BenchmarkStartInput {
  projectPath: string
  settings: RenderSettings
  candidates: BenchmarkCandidate[]
  runsPerCandidate: number
  includeOfficial: boolean
  officialRuns: number
  /** 是否对最优候选追加一次复测以确认稳定性 */
  confirmBest: boolean
  /** matrix：单模式候选矩阵（默认）；comparison：四模式对比测试 */
  kind?: 'matrix' | 'comparison'
  comparisonKind?: 'quick' | 'precise'
  /** 预热次数：正式计时前额外运行第一个候选并丢弃成绩（精确对比使用） */
  warmupRuns?: number
  /** 项目元信息（用于产出文件验证：时长 / 分辨率 / 帧率） */
  projectMeta?: {
    width?: number | null
    height?: number | null
    durationSec?: number | null
    fps?: number | null
  } | null
}

export interface BenchmarkDeps {
  getCliCommand: () => Promise<string>
  getCli: () => Promise<CliCapabilities>
  monitor: ResourceMonitor
  /** 清理策略（来自用户设置）；缺省时使用默认值：自动清理开 / 保留失败现场关 / 保留报告开 */
  getCleanupPolicy?: () => Promise<TestCleanupPolicy>
  /** 额外禁止删除的目录（用户正式输出目录等），清理前会做安全守卫 */
  getForbiddenRoots?: () => Promise<string[]>
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000
const COMPARISON_TIMEOUT_MS = 40 * 60_000
/** 冒烟预检超时：小项目几秒，大项目可能要几分钟 */
const SMOKE_TIMEOUT_MS = 15 * 60_000
/**
 * 对比测试统一放宽的「页面就绪等待」。
 * CLI 默认只有 45s，而每个 worker 都要独立启动 Chrome 并初始化 composition，
 * 多 worker 模式下 45s 很容易误判为失败。该值只影响等待容忍度，不影响渲染速度，
 * 四种模式统一使用同一数值，因此不会破坏对比公平性。
 */
const COMPARISON_READY_TIMEOUT_MS = 180_000

/** 从混有日志的输出中提取结尾的 JSON 文档 */
export function extractTrailingJson<T>(text: string): T | null {
  const lines = stripAnsi(text).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '{') continue
    const candidate = lines.slice(i).join('\n')
    try {
      return JSON.parse(candidate) as T
    } catch {
      /* 继续向前找 */
    }
  }
  // 退化：直接尝试整段解析
  try {
    return JSON.parse(stripAnsi(text)) as T
  } catch {
    return null
  }
}

/** 依据输出参数推导出「期望的产出规格」，用于验证产出的时长 / 分辨率 / 帧率。
 * 推不出来的项一律为 null（不校验），绝不编造期望值。
 */
export function expectedVideoSpec(
  settings: RenderSettings,
  meta?: BenchmarkStartInput['projectMeta']
): { fps: number | null; width: number | null; height: number | null; durationSec: number | null } {
  const RESOLUTIONS: Record<string, [number, number]> = {
    landscape: [1920, 1080],
    portrait: [1080, 1920],
    square: [1080, 1080],
    'landscape-4k': [3840, 2160],
    'portrait-4k': [2160, 3840],
    'square-4k': [2160, 2160]
  }

  let fps: number | null = null
  if (settings.fpsMode === 'project') fps = meta?.fps ?? null
  else if (settings.fpsMode === 'custom') {
    const raw = (settings.customFps ?? '').trim()
    const rational = raw.match(/^(\d+)\s*\/\s*(\d+)$/)
    if (rational) fps = Number(rational[1]) / Number(rational[2])
    else if (/^\d+(\.\d+)?$/.test(raw)) fps = Number(raw)
  } else {
    fps = Number(settings.fpsMode)
  }

  // resolution=project 时保持项目原始尺寸，不需要与预设比较
  const preset = settings.resolution === 'project' ? null : RESOLUTIONS[settings.resolution]
  return {
    fps: Number.isFinite(fps) && (fps ?? 0) > 0 ? (fps as number) : null,
    width: preset ? preset[0] : null,
    height: preset ? preset[1] : null,
    durationSec: meta?.durationSec ?? null
  }
}

/**
 * Benchmark 引擎：
 * 1) 优先调用官方 `hyperframes benchmark --json`；
 * 2) 对官方覆盖不到的组合作独立矩阵测试（worker / 编码 / 捕获路径）；
 * 3) 所有测试输出写入 userData 下的独立目录，绝不写入用户项目。
 *
 * 四模式对比测试（kind = comparison）额外要求：
 * - 先跑基础渲染冒烟预检，失败即停止，不进入四模式；
 * - 每种模式独立输出目录（performance-tests/<test-id>/<mode>/）；
 * - 每次运行都产出完整诊断日志（logs/performance-comparison/<test-id>/）；
 * - 单个模式失败不影响其余模式，失败原因按阶段 / 类型归类后返回给界面。
 */
export class BenchmarkEngine {
  private deps: BenchmarkDeps
  private child: ChildProcess | null = null
  private canceled = false
  private listeners = new Set<(event: BenchmarkEvent) => void>()
  private logs: BenchmarkLogLine[] = []

  /** 对比测试的日志上下文 */
  private comparisonLog: ComparisonLog | null = null
  private diagRuns: ComparisonRunDiagnostics[] = []
  private outputRoot = ''
  /** 本次测试的独立工作区（performance-tests/<test-id>/）与清理引擎 */
  private workspace: TestWorkspace | null = null
  private cleanupEngine: PerformanceTestCleanup | null = null
  private cliVersion: string | null = null

  private state: BenchmarkSessionState = {
    id: '',
    status: 'idle',
    kind: 'matrix',
    projectPath: '',
    format: 'mp4',
    quality: 'looks',
    resolution: 'project',
    fpsLabel: '跟随项目',
    candidates: [],
    results: [],
    currentIndex: 0,
    estimatedMinutes: 0,
    official: { ran: false, ok: false, results: [] }
  }

  constructor(deps: BenchmarkDeps) {
    this.deps = deps
  }

  onEvent(listener: (event: BenchmarkEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): BenchmarkSessionState {
    return this.state
  }

  isRunning(): boolean {
    return this.state.status === 'running'
  }

  private emit(): void {
    for (const listener of this.listeners) listener({ type: 'state', state: this.state })
  }

  /* --------------------------- 进度（对比测试） --------------------------- */

  private progressState: ComparisonProgress | null = null
  private lastProgressEmit = 0

  /**
   * 更新对比测试进度并（节流）推送。
   *
   * 注意：`pct` 只在 CLI 真的打印了百分比时才会被赋值；任务级的「第 2/4 项」
   * 属于任务进度，界面用不定进度条表示，不会伪装成视频渲染百分比。
   */
  private setProgress(
    patch: Partial<Omit<ComparisonProgress, 'modeStatus'>> & {
      modeStatus?: Partial<Record<PerformanceMode, ComparisonModeStatus>>
    },
    force = false
  ): void {
    if (this.state.kind !== 'comparison') return
    const base: ComparisonProgress =
      this.progressState ?? {
        mode: null,
        label: '',
        itemIndex: 0,
        itemTotal: this.state.candidates.length,
        phase: 'idle',
        runIndex: 0,
        runTotal: 1,
        pct: null,
        pctLabel: null,
        modeStatus: {
          smart: 'pending',
          balanced: 'pending',
          performance: 'pending',
          extreme: 'pending'
        },
        updatedAt: new Date().toISOString()
      }
    this.progressState = {
      ...base,
      ...patch,
      modeStatus: { ...base.modeStatus, ...(patch.modeStatus ?? {}) },
      updatedAt: new Date().toISOString()
    }
    this.state = { ...this.state, progress: this.progressState }
    const now = Date.now()
    if (force || now - this.lastProgressEmit >= 900) {
      this.lastProgressEmit = now
      this.emit()
    }
  }

  private markModeStatus(mode: PerformanceMode | null, status: ComparisonModeStatus): void {
    if (!mode) return
    this.setProgress({ modeStatus: { [mode]: status } as Partial<ComparisonProgress['modeStatus']> }, true)
  }

  private resetProgress(): void {
    this.progressState = null
    this.lastProgressEmit = 0
  }

  private log(text: string, level: BenchmarkLogLine['level'] = 'info'): void {
    const line: BenchmarkLogLine = { ts: new Date().toISOString(), text, level }
    this.logs.push(line)
    for (const listener of this.listeners) listener({ type: 'log', line })
    void this.comparisonLog?.info(text, { level })
  }

  /* ------------------------------ 启动 ------------------------------ */

  async start(input: BenchmarkStartInput): Promise<{ ok: boolean; error?: string }> {
    if (this.isRunning()) return { ok: false, error: '已有性能测试在运行' }
    if (!input.projectPath || !existsSync(input.projectPath)) {
      return { ok: false, error: '项目目录不存在' }
    }
    if (input.candidates.length === 0) return { ok: false, error: '没有可测试的候选配置' }

    this.canceled = false
    this.logs = []
    this.diagRuns = []
    this.child = null

    const isComparison = (input.kind ?? 'matrix') === 'comparison'
    const id = isComparison
      ? `cmp_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 4)}`
      : `bench_${randomUUID().slice(0, 8)}`

    this.state = {
      id,
      status: 'running',
      kind: input.kind ?? 'matrix',
      comparisonKind: input.comparisonKind,
      projectPath: input.projectPath,
      format: input.settings.format,
      quality: input.settings.quality,
      resolution: input.settings.resolution,
      fpsLabel: fpsLabelOf(input.settings),
      candidates: input.candidates,
      results: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      estimatedMinutes: Math.max(
        1,
        Math.round((input.candidates.length * input.runsPerCandidate * 30) / 60)
      ),
      official: { ran: false, ok: false, results: [] }
    }

    if (isComparison) {
      const userData = app.getPath('userData')
      /* ---- 独立任务目录：performance-tests/<test-id>/ ---- */
      try {
        this.workspace = await TestWorkspace.create({
          userDataDir: userData,
          taskId: id,
          taskKind: 'comparison',
          projectPath: input.projectPath
        })
      } catch (err) {
        const message = `无法创建测试目录：${err instanceof Error ? err.message : String(err)}`
        this.finish('failed', message, 'file')
        return { ok: false, error: message }
      }
      this.outputRoot = this.workspace.root
      this.comparisonLog = new ComparisonLog(id, userData, this.workspace.logDir)
      const inited = await this.comparisonLog.init({
        testId: id,
        projectPath: input.projectPath,
        cliCommand: '(pending)',
        cliVersion: null,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        platform: `${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ''}`.trim(),
        settings: input.settings,
        comparisonKind: input.comparisonKind ?? 'quick',
        modes: input.candidates.map((c) => c.mode ?? c.id),
        outputRoot: this.outputRoot
      })
      this.state = {
        ...this.state,
        comparison: {
          testId: id,
          logDir: this.comparisonLog.dir,
          logFile: this.comparisonLog.file,
          smoke: inited
            ? {
                status: 'pending',
                durationMs: null,
                command: '',
                outputPath: null,
                outputBytes: null,
                failure: null,
                logFile: null
              }
            : null
        }
      }
      // 进度初始化：四项测试全部 pending，界面立刻进入「测试中」状态
      this.resetProgress()
      this.setProgress(
        {
          phase: 'environment',
          label: '环境检查',
          itemIndex: 0,
          itemTotal: input.candidates.length,
          mode: null,
          pct: null,
          pctLabel: null,
          modeStatus: { smart: 'pending', balanced: 'pending', performance: 'pending', extreme: 'pending' }
        },
        true
      )
    } else {
      /* 矩阵测试同样使用独立任务目录：产物与日志都登记到 manifest，结束后按同一套规则清理 */
      const userData = app.getPath('userData')
      try {
        this.workspace = await TestWorkspace.create({
          userDataDir: userData,
          taskId: id,
          taskKind: 'matrix',
          projectPath: input.projectPath
        })
      } catch (err) {
        const message = `无法创建测试目录：${err instanceof Error ? err.message : String(err)}`
        this.finish('failed', message, 'file')
        return { ok: false, error: message }
      }
      this.outputRoot = this.workspace.root
      this.comparisonLog = new ComparisonLog(id, userData, this.workspace.logDir)
      await this.comparisonLog.init({
        testId: id,
        projectPath: input.projectPath,
        cliCommand: '(pending)',
        cliVersion: null,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        platform: `${process.platform} ${process.arch}`.trim(),
        settings: input.settings,
        comparisonKind: 'quick',
        modes: input.candidates.map((c) => c.mode ?? c.id),
        outputRoot: this.outputRoot
      })
    }

    this.emit()
    void this.run(input)
    return { ok: true }
  }

  stop(): { ok: boolean } {
    if (!this.isRunning()) return { ok: false }
    this.canceled = true
    if (this.child) killProcessTree(this.child)
    this.state = { ...this.state, status: 'canceled', endedAt: new Date().toISOString() }
    this.log('测试已被用户停止', 'warn')
    void this.comparisonLog?.finish('canceled', '用户停止')
    this.emit()
    return { ok: true }
  }

  private async run(input: BenchmarkStartInput): Promise<void> {
    const isComparison = this.state.kind === 'comparison'
    // 所有产物都写在本次任务的独立目录里（performance-tests/<test-id>/）
    const baseDir = this.outputRoot

    try {
      /* ---------------- 环境检查：CLI 可用性 ---------------- */
      const cliCommand = await this.deps.getCliCommand()
      let cli: CliCapabilities
      try {
        cli = await this.deps.getCli()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.cliVersion = null
        this.finish('failed', `CLI 能力探测失败：${message}`, 'environment')
        return
      }
      this.cliVersion = cli.version ?? null

      if (this.comparisonLog) {
        const env = await describeCliEnvironment(cliCommand)
        await this.comparisonLog.info('环境检查', {
          cliCommand,
          cliVersion: cli.version,
          renderOk: cli.render.ok,
          flags: cli.render.flags.length,
          env
        })
        // 会话头里补上真实探测到的 CLI 命令 / 版本 / 环境解析结果
        await this.comparisonLog.updateSession({
          extra: { cliCommand, cliVersion: cli.version, environment: env }
        })
      }

      if (!cli.render.ok) {
        this.finish(
          'failed',
          `CLI 不可用（${cliCommand}）：${cli.render.error ?? 'render --help 探测失败'}。请先在「环境」里修复 CLI 后重试`,
          'environment'
        )
        return
      }

      /* ---------------- 项目检查 ---------------- */
      const projectProblem = this.checkProject(input.projectPath)
      if (projectProblem) {
        this.finish('failed', projectProblem.detail, 'project', projectProblem)
        return
      }

      if (input.includeOfficial && cli.benchmark.available) {
        await this.runOfficial(input, cliCommand)
      } else if (input.includeOfficial) {
        this.log('当前 CLI 不支持 benchmark，跳过官方基准测试', 'warn')
      }

      /* ---------------- 基础渲染冒烟预检 ---------------- */
      if (isComparison) {
        this.setProgress({ phase: 'smoke', label: '基础渲染预检', itemIndex: 0, pct: null, pctLabel: null }, true)
        const smoke = await this.runSmokeTest(input, cli, cliCommand)
        if (smoke.status !== 'ok') {
          const failure = smoke.failure
          this.finish(
            'failed',
            failure
              ? `基础渲染测试失败（阶段：${stageLabel(failure.stage)} · 类型：${errorTypeLabel(
                  failure.errorType
                )}）：${firstLine(failure.highlight ?? failure.detail)}`
              : '基础渲染测试失败',
            failure?.stage ?? 'render',
            failure ?? null
          )
          return
        }
      }

      /* ---------------- 预热（精确对比）：先跑一次丢弃成绩 ---------------- */
      const warmupRuns = Math.max(0, input.warmupRuns ?? 0)
      if (warmupRuns > 0 && input.candidates.length > 0) {
        this.log(`预热 ${warmupRuns} 次（不计成绩，让缓存 / 温度先进入稳定状态）`)
        this.setProgress(
          {
            phase: 'warmup',
            mode: input.candidates[0].mode ?? null,
            label: '预热（不计成绩）',
            itemIndex: 0,
            pct: null,
            pctLabel: null
          },
          true
        )
        for (let w = 0; w < warmupRuns; w += 1) {
          if (this.canceled) return
          await this.runCandidate(input.candidates[0], -1, -(w + 1), input, cli, cliCommand, baseDir)
        }
      }

      for (let i = 0; i < input.candidates.length; i += 1) {
        if (this.canceled) return
        const candidate = input.candidates[i]
        this.state = { ...this.state, currentIndex: i }
        this.log(
          `开始测试 [${i + 1}/${input.candidates.length}] ${candidate.label}（${input.runsPerCandidate} 次）`
        )
        this.setProgress(
          {
            phase: 'render',
            mode: candidate.mode ?? null,
            label: candidate.label,
            itemIndex: i + 1,
            itemTotal: input.candidates.length,
            runIndex: 1,
            runTotal: Math.max(1, input.runsPerCandidate),
            pct: null,
            pctLabel: null,
            modeStatus: candidate.mode
              ? ({ [candidate.mode]: 'running' } as Partial<ComparisonProgress['modeStatus']>)
              : undefined
          },
          true
        )
        this.emit()

        const results: BenchmarkRunResult[] = []
        for (let run = 0; run < Math.max(1, input.runsPerCandidate); run += 1) {
          if (this.canceled) return
          const result = await this.runCandidate(candidate, i, run, input, cli, cliCommand, baseDir)
          results.push(result)
          this.log(
            result.status === 'ok'
              ? `  · ${candidate.label} 第 ${run + 1} 次：${(result.durationMs / 1000).toFixed(1)}s${
                  result.sizeBytes ? ` · ${(result.sizeBytes / 1024 / 1024).toFixed(2)}MB` : ''
                }`
              : `  · ${candidate.label} 第 ${run + 1} 次失败（${stageLabel(
                  result.diagnostics?.stage ?? 'render'
                )} / ${errorTypeLabel(result.diagnostics?.errorType ?? 'unknown')}）：${result.error ?? '未知错误'}`,
            result.status === 'ok' ? 'info' : 'warn'
          )
        }

        const merged = mergeRuns(results, candidate)
        this.state = { ...this.state, results: [...this.state.results, merged] }
        this.markModeStatus(candidate.mode ?? null, merged.status === 'ok' ? 'ok' : 'failed')
        this.emit()
        await this.comparisonLog?.updateSession({ runs: this.diagRuns })
      }

      if (this.canceled) return

      if (input.confirmBest) {
        const best = [...this.state.results]
          .filter((r) => r.status === 'ok')
          .sort((a, b) => a.durationMs - b.durationMs)[0]
        if (best) {
          const candidate = input.candidates.find((c) => c.id === best.candidateId)
          if (candidate) {
            this.log(`复测最优配置以确认稳定性：${candidate.label}`)
            const confirm = await this.runCandidate(candidate, 99, 0, input, cli, cliCommand, baseDir)
            if (confirm.status === 'ok' && confirm.durationMs > best.durationMs * 1.35) {
              this.log(
                `复测耗时 ${(confirm.durationMs / 1000).toFixed(1)}s 明显慢于首次 ${(best.durationMs / 1000).toFixed(
                  1
                )}s，该配置可能不稳定`,
                'warn'
              )
              this.state = {
                ...this.state,
                results: this.state.results.map((r) =>
                  r.candidateId === best.candidateId ? { ...r, status: 'failed' as const, error: '复测不稳定' } : r
                )
              }
            }
          }
        }
      }

      const okCount = this.state.results.filter((r) => r.status === 'ok').length
      if (isComparison) {
        const failed = this.state.results.filter((r) => r.status !== 'ok')
        this.log(
          `对比测试结束：成功 ${okCount} / ${this.state.results.length} 种模式${
            failed.length > 0 ? `，失败 ${failed.length} 种（详见下方失败明细）` : ''
          }`,
          failed.length > 0 ? 'warn' : 'success'
        )
        await this.comparisonLog?.updateSession({ runs: this.diagRuns, status: 'done' })
      }
      this.finish('done')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.finish('failed', `测试执行异常：${message}`, 'render')
    } finally {
      /* ------------------------------------------------------------------
       * 清理生命周期：成功 / 失败 / 取消 三种情况都会走到这里。
       * 顺序很重要：先落日志 → 等子进程退出 → 写 report.json → 再删临时媒体。
       * 清理内部任何异常都只记录，不会覆盖已经得到的测试结果。
       * ------------------------------------------------------------------ */
      await this.finishLog()
      await this.cleanupBrowsers()
      await this.finalizeWorkspace()
    }
  }

  /* ------------------------------------------------------------------ */
  /* 任务收尾：性能数据落盘 + 临时文件清理                                  */
  /* ------------------------------------------------------------------ */

  private cleanup(): PerformanceTestCleanup {
    if (!this.cleanupEngine) {
      this.cleanupEngine = new PerformanceTestCleanup({
        userDataDir: app.getPath('userData'),
        log: (message, level) => this.log(`[清理] ${message}`, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info')
      })
    }
    return this.cleanupEngine
  }

  private async finalizeWorkspace(): Promise<void> {
    const workspace = this.workspace
    if (!workspace) return
    const taskId = this.state.id

    const status = this.state.status === 'done' || this.state.status === 'failed' || this.state.status === 'canceled'
      ? this.state.status
      : 'failed'

    // 1) 等 CLI / Chrome / FFmpeg 相关子进程退出（超时不阻塞，清理阶段还会按占用重试）
    const waitStarted = Date.now()
    let childExited = true
    try {
      childExited = await waitForProcessExit(this.child, 8000)
    } catch {
      childExited = false
    }
    const waitExitMs = Date.now() - waitStarted

    // 2) 收集性能数据并写 report.json（媒体被删后这份数据仍然保留）
    try {
      const report = buildTaskReport({
        testId: this.state.id,
        taskKind: this.state.kind,
        status,
        error: this.state.error ?? null,
        startedAt: this.state.startedAt ?? null,
        endedAt: this.state.endedAt ?? null,
        projectPath: this.state.projectPath,
        outputRoot: workspace.root,
        format: this.state.format,
        quality: this.state.quality,
        resolution: this.state.resolution,
        fpsLabel: this.state.fpsLabel,
        cliVersion: this.cliVersion,
        candidates: this.state.candidates.map((c) => ({ mode: c.mode ?? null, workers: c.workers })),
        runs: this.diagRuns.map((run) => ({
          mode: run.mode,
          label: run.label,
          status: run.runStatus ?? (run.failure ? 'failed' : 'ok'),
          stage: run.stage,
          errorType: run.errorType,
          failureDetail: run.failure?.detail ?? null,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs: run.durationMs,
          outputBytes: run.outputBytes,
          outputPath: run.outputPath,
          execFile: run.execFile,
          exitCode: run.exitCode,
          probe: run.fileCheck?.probe
            ? {
                durationSec: run.fileCheck.probe.durationSec,
                width: run.fileCheck.probe.width,
                height: run.fileCheck.probe.height,
                fps: run.fileCheck.probe.fps
              }
            : null
        }))
      })
      await workspace.writeReport(report)
    } catch (err) {
      this.log(`性能数据落盘失败（不影响测试结论）：${err instanceof Error ? err.message : String(err)}`, 'warn')
    }

    // 3) 登记任务状态，执行清理
    try {
      await workspace.setStatus(status)
      const policy = (await this.deps.getCleanupPolicy?.()) ?? DEFAULT_CLEANUP_POLICY
      let forbidden: string[] = []
      try {
        forbidden = (await this.deps.getForbiddenRoots?.()) ?? []
      } catch {
        forbidden = []
      }
      const summary: TestCleanupSummary = await this.cleanup().cleanupTask({
        workspace,
        taskStatus: status,
        policy,
        forbiddenRoots: forbidden,
        waitExitMs
      })
      // 清理期间用户可能已经启动了新测试：只有状态仍属于这次任务时才回传，
      // 否则会把旧任务的清理结果挂到新任务上。
      if (this.state.id !== taskId) return
      this.state = { ...this.state, cleanup: summary }
      this.emit()

      if (summary.skipped) {
        this.log(`临时文件未清理：${summary.skipReason ?? '策略跳过'}`, 'warn')
      } else {
        this.log(
          `已清理临时文件 ${summary.deletedFiles} 个，释放 ${formatBytes(summary.freedBytes)}` +
            (summary.failedFiles > 0 ? `；${summary.failedFiles} 个文件被占用，已记录并保留待下次清理` : '') +
            (summary.keptLogDir ? `；日志与性能报告已保留` : '')
        )
      }
      if (!childExited) {
        this.log('有残留子进程未在 8 秒内退出，被占用的文件已跳过后重试仍失败的部分', 'warn')
      }
    } catch (err) {
      if (this.state.id === taskId) {
        this.log(`清理临时文件失败（测试结果不受影响）：${err instanceof Error ? err.message : String(err)}`, 'warn')
      }
    }
  }

  /** 会话日志收尾（对比测试保留目录，供用户打开查看） */
  private async finishLog(): Promise<void> {
    if (!this.comparisonLog) return
    await this.comparisonLog.updateSession({ runs: this.diagRuns })
    await this.comparisonLog.finish(this.state.status, this.state.error ?? null)
  }

  /** 登记单次运行的产物（目录型输出按目录登记） */
  private async registerOutput(path: string, source: string, bytes: number | null): Promise<void> {
    const workspace = this.workspace
    if (!workspace || !path) return
    const directoryOutput = this.state.format === 'png-sequence' || this.state.format === 'hls'
    try {
      await workspace.registerPath(path, {
        source,
        entry: directoryOutput ? 'dir' : 'file',
        kind: this.state.format === 'png-sequence' ? 'png-sequence' : null
      })
      if (bytes != null) workspace.setEntryBytes(path, bytes)
      await workspace.flush()
    } catch {
      /* 登记失败只影响清理精度，不影响测试结果 */
    }
  }

  /** 项目目录基础检查：只检查"能不能渲染"，不检查项目内部实现 */
  private checkProject(projectPath: string): ComparisonFailure | null {
    if (!existsSync(projectPath)) {
      return {
        stage: 'project',
        errorType: 'invalid-project',
        detail: `项目目录不存在：${projectPath}`,
        hint: '请重新选择项目目录'
      }
    }
    const indexHtml = join(projectPath, 'index.html')
    if (!existsSync(indexHtml)) {
      return {
        stage: 'project',
        errorType: 'invalid-project',
        detail:
          `项目目录缺少 index.html：${projectPath}\n` +
          'HyperFrames 渲染需要一个入口 HTML（或通过 -c 指定 composition）。' +
          '若项目入口不在根目录，请在渲染页选择 composition 后重试。',
        hint: '确认选择的是 HyperFrames 项目根目录（包含 index.html / hyperframes.json）'
      }
    }
    return null
  }

  /** 测试结束清理残留的无头浏览器，避免影响后续渲染 */
  private async cleanupBrowsers(): Promise<void> {
    const killed = await cleanupStrayBrowsers()
    if (killed > 0) this.log(`清理了 ${killed} 个残留的无头浏览器进程`, 'warn')
  }

  private finish(
    status: 'done' | 'failed' | 'canceled',
    error?: string,
    stage?: ComparisonStage,
    failure?: ComparisonFailure | null
  ): void {
    this.state = {
      ...this.state,
      status,
      endedAt: new Date().toISOString(),
      error,
      ...(failure
        ? { comparison: { ...(this.state.comparison ?? emptyLogContext()), lastFailure: failure } }
        : stage
          ? {
              comparison: {
                ...(this.state.comparison ?? emptyLogContext()),
                lastFailure: {
                  stage,
                  errorType: stage === 'environment' ? 'command-not-found' : 'unknown',
                  detail: error ?? '',
                  hint: ''
                }
              }
            }
          : {})
    }
    if (status === 'done') this.log('性能测试完成', 'success')
    if (error) this.log(`性能测试失败：${error}`, 'error')
    // 结束时收紧进度：不再显示任何百分比，界面据此停止不定进度动画
    if (this.state.kind === 'comparison') {
      const current = this.progressState
      const nextStatus: Partial<ComparisonProgress['modeStatus']> = {}
      if (current) {
        for (const key of Object.keys(current.modeStatus) as PerformanceMode[]) {
          // 会话级失败时，正在跑的那一项记为失败；其余项保持原状态（成功的不丢）
          if (current.modeStatus[key] === 'running' && status !== 'done') nextStatus[key] = 'failed'
        }
      }
      this.setProgress({ phase: 'idle', pct: null, pctLabel: null, modeStatus: nextStatus }, true)
    }
    this.emit()
  }

  /* ---------------------------- 冒烟预检 ---------------------------- */

  /**
   * 基础渲染冒烟测试：用最简单的一组参数（30fps / 单 worker）先确认
   * 「项目 + CLI + 输出目录」这条链本身可用，再进入四模式对比。
   * 参数依据当前 CLI 实际的 --help 选择：不支持 standard 时退回 looks。
   */
  private async runSmokeTest(
    input: BenchmarkStartInput,
    cli: CliCapabilities,
    cliCommand: string
  ): Promise<SmokeTestResult> {
    const quality = cli.render.flags.includes('-q') && qualitySupported(cli, 'standard') ? 'standard' : 'looks'
    const outDir = this.workspace ? await this.workspace.ensureModeDir('smoke') : join(this.outputRoot, 'smoke')
    const outputName = 'smoke-test'
    const request: RenderRequest = {
      ...input.settings,
      format: 'mp4',
      fpsMode: '30',
      customFps: '',
      quality,
      resolution: 'project',
      docker: false,
      gpu: false,
      browserGpu: 'auto',
      workers: 1,
      crf: null,
      videoBitrate: '',
      strict: false,
      projectPath: input.projectPath,
      composition: '',
      outputDir: outDir,
      outputName,
      extra: {
        fastCapture: 'auto',
        pageSideCompositing: true,
        lowMemoryMode: 'auto',
        // 冒烟预检不继承用户的高级超时设置，避免把测试参数带进预检
        browserTimeoutSec: null,
        playerReadyTimeoutMs: COMPARISON_READY_TIMEOUT_MS
      }
    }

    this.state = {
      ...this.state,
      comparison: {
        ...(this.state.comparison ?? emptyLogContext()),
        smoke: {
          status: 'running',
          startedAt: new Date().toISOString(),
          durationMs: null,
          command: `render --format mp4 -f 30 -q ${quality} -w 1 -o ${join(outDir, 'smoke-test.mp4')}`,
          outputPath: join(outDir, 'smoke-test.mp4'),
          outputBytes: null,
          failure: null,
          logFile: null
        }
      }
    }
    this.log(`基础渲染预检开始（-f 30 -q ${quality} -w 1）`)
    this.emit()

    const outcome = await runRenderProcess({
      group: 'smoke',
      projectPath: input.projectPath,
      request,
      cliCommand,
      cli,
      log: this.comparisonLog ?? new ComparisonLog(this.state.id, app.getPath('userData')),
      timeoutMs: SMOKE_TIMEOUT_MS,
      // 子进程的 TMP/TEMP/TMPDIR 指向本任务 tmp/，Chrome 配置与中间文件都落在任务目录内
      env: this.workspace?.sandboxEnv(),
      onChild: (child) => {
        this.child = child
      },
      isCanceled: () => this.canceled,
      onStdoutLine: (line) => {
        const parsed = parseLine(line)
        if (typeof parsed.progress?.pct === 'number') {
          this.setProgress({
            phase: parsed.progress.pct >= 100 ? 'verify' : 'smoke',
            pct: Math.round(parsed.progress.pct),
            pctLabel: parsed.progress.label ?? null
          })
        }
      },
      verify: {
        expectedFps: 30,
        expectedDurationSec: null
      }
    })

    await this.registerOutput(outcome.outputPath, 'smoke', outcome.outputBytes)

    if (outcome.failure) {
      const smoke: SmokeTestResult = {
        status: 'failed',
        startedAt: outcome.startedAt,
        endedAt: outcome.endedAt,
        durationMs: outcome.durationMs,
        command: outcome.command,
        outputPath: outcome.outputPath,
        outputBytes: outcome.outputBytes,
        failure: outcome.failure,
        logFile: this.comparisonLog?.file ?? null
      }
      this.state = {
        ...this.state,
        comparison: { ...(this.state.comparison ?? emptyLogContext()), smoke }
      }
      await this.comparisonLog?.updateSession({ smoke })
      this.log(
        `基础渲染预检失败（${stageLabel(outcome.failure.stage)} / ${errorTypeLabel(
          outcome.failure.errorType
        )}）：${firstLine(outcome.failure.highlight ?? outcome.failure.detail)}`,
        'error'
      )
      this.emit()
      return smoke
    }

    const smoke: SmokeTestResult = {
      status: 'ok',
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      durationMs: outcome.durationMs,
      command: outcome.command,
      outputPath: outcome.outputPath,
      outputBytes: outcome.outputBytes,
      failure: null,
      logFile: this.comparisonLog?.file ?? null
    }
    this.state = {
      ...this.state,
      comparison: { ...(this.state.comparison ?? emptyLogContext()), smoke }
    }
    await this.comparisonLog?.updateSession({ smoke })
    this.log(
      `基础渲染预检通过：${(outcome.durationMs / 1000).toFixed(1)}s · ${
        outcome.outputBytes ? `${(outcome.outputBytes / 1024 / 1024).toFixed(2)}MB` : '体积未知'
      }`,
      'success'
    )
    this.emit()
    return smoke
  }

  /* ---------------------------- 单次测量 ---------------------------- */

  private async runCandidate(
    candidate: BenchmarkCandidate,
    index: number,
    run: number,
    input: BenchmarkStartInput,
    cli: CliCapabilities,
    cliCommand: string,
    baseDir: string
  ): Promise<BenchmarkRunResult> {
    const isComparison = this.state.kind === 'comparison'
    const spec = expectedVideoSpec(input.settings, input.projectMeta)

    // 每种模式独立输出目录，绝不共用同一个输出文件
    const outputDir = isComparison
      ? this.workspace
        ? await this.workspace.ensureModeDir(candidate.mode ?? sanitizeSegment(candidate.id))
        : join(baseDir, candidate.mode ?? sanitizeSegment(candidate.id))
      : this.workspace
        ? await this.workspace.ensureModeDir('matrix')
        : baseDir
    const outputName = isComparison
      ? `${sanitizeSegment(candidate.mode ?? candidate.id)}-run-${run + 1}`
      : `bench-${index}-${run}`

    const request: RenderRequest = {
      ...input.settings,
      projectPath: input.projectPath,
      composition: '',
      outputDir,
      outputName,
      workers: candidate.workers,
      gpu: candidate.gpuEncode,
      browserGpu: candidate.browserGpu,
      docker: false,
      strict: false,
      crf: null,
      videoBitrate: '',
      extra: {
        fastCapture: candidate.capturePath === 'fast-capture' ? 'on' : input.settings.extra?.fastCapture ?? 'auto',
        pageSideCompositing: candidate.pageSideCompositing,
        lowMemoryMode: input.settings.extra?.lowMemoryMode ?? 'auto',
        // 对比测试统一放宽页面就绪等待（不影响渲染速度，只提高失败容忍度）
        browserTimeoutSec: input.settings.extra?.browserTimeoutSec ?? null,
        playerReadyTimeoutMs:
          input.settings.extra?.playerReadyTimeoutMs && input.settings.extra.playerReadyTimeoutMs > 0
            ? input.settings.extra.playerReadyTimeoutMs
            : COMPARISON_READY_TIMEOUT_MS
      },
      env: candidate.env
    }

    this.deps.monitor.resetSamples()
    const label = `${safeFileName(candidate.mode ?? candidate.id)}-run-${String(run + 1).padStart(2, '0')}`

    const outcome = await runRenderProcess({
      group: candidate.mode ?? sanitizeSegment(candidate.id),
      subdir: `run-${run + 1}`,
      projectPath: input.projectPath,
      request,
      cliCommand,
      cli,
      log: this.comparisonLog ?? new ComparisonLog(this.state.id, app.getPath('userData')),
      timeoutMs: isComparison ? COMPARISON_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      // 任务沙箱：Chrome 配置 / 帧缓存 / 编码中间文件都写入本任务 tmp/
      env: this.workspace?.sandboxEnv(),
      onChild: (child) => {
        this.child = child
      },
      isCanceled: () => this.canceled,
      onStdoutLine: (line) => {
        const parsed = parseLine(line)
        if (parsed.progress?.done && parsed.progress.total) {
          this.deps.monitor.setProgress({
            frameDone: parsed.progress.done,
            frameTotal: parsed.progress.total,
            workerCount: typeof candidate.workers === 'number' ? candidate.workers : null
          })
        }
        // 只有 CLI 真的打印了百分比时才更新数字；否则保持「正在测试」的不定进度
        if (typeof parsed.progress?.pct === 'number') {
          this.setProgress({
            phase: parsed.progress.pct >= 100 ? 'verify' : 'render',
            pct: Math.round(parsed.progress.pct),
            pctLabel: parsed.progress.label ?? null,
            runIndex: Math.max(1, run + 1),
            runTotal: Math.max(1, input.runsPerCandidate)
          })
        }
      },
      verify: {
        expectedFps: spec.fps,
        expectedWidth: spec.width,
        expectedHeight: spec.height,
        expectedDurationSec: spec.durationSec,
        directoryOutput: input.settings.format === 'png-sequence' || input.settings.format === 'hls'
      }
    })

    const peaks = this.deps.monitor.getPeaks()
    // 登记本次产物：清理时只认 manifest 里登记过的路径
    await this.registerOutput(
      outcome.outputPath,
      run < 0 ? 'warmup' : (candidate.mode ?? candidate.id),
      outcome.outputBytes
    )
    const diagnostics: ComparisonRunDiagnostics = {
      testId: this.state.id,
      mode: candidate.mode ?? null,
      label,
      projectPath: input.projectPath,
      stage: outcome.stage,
      errorType: outcome.failure?.errorType ?? 'none',
      failure: outcome.failure,
      runStatus: outcome.status,
      logDir: this.comparisonLog?.dir ?? '',
      logFile: this.comparisonLog?.file ?? '',
      command: outcome.command,
      execFile: outcome.execFile,
      execArgs: outcome.execArgs,
      cwd: outcome.cwd,
      pid: outcome.pid,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      spawnError: outcome.spawnError,
      outputPath: outcome.outputPath,
      outputBytes: outcome.outputBytes,
      fileCheck: outcome.fileCheck,
      stdoutTail: outcome.stdoutTail,
      stderrTail: outcome.stderrTail
    }
    this.diagRuns.push(diagnostics)
    await this.comparisonLog?.writeRun(diagnostics)

    const errorText = outcome.failure
      ? `${stageLabel(outcome.failure.stage)} / ${errorTypeLabel(outcome.failure.errorType)}：${firstLine(
          outcome.failure.highlight ?? outcome.failure.detail
        )}`
      : undefined

    return {
      candidateId: candidate.id,
      label: candidate.label,
      status: outcome.status === 'ok' ? 'ok' : 'failed',
      durationMs: outcome.durationMs,
      sizeBytes: outcome.outputBytes,
      peak: {
        cpuPct: peaks.cpuPct,
        memoryBytes: peaks.memoryBytes,
        vramBytes: peaks.vramBytes,
        gpuPct: peaks.gpuPct,
        videoEncodePct: peaks.videoEncodePct
      },
      avgCpuPct: peaks.avgCpuPct,
      outputPath: outcome.outputPath,
      error: errorText,
      diagnostics
    }
  }

  /* -------------------------- 官方 benchmark -------------------------- */

  private async runOfficial(input: BenchmarkStartInput, cliCommand: string): Promise<void> {
    this.log(`运行官方 benchmark（runs=${input.officialRuns}）…`)
    this.state = { ...this.state, official: { ran: true, ok: false, results: [] } }
    this.emit()

    const args = ['benchmark', '.', '--runs', String(Math.max(1, input.officialRuns)), '--json']
    let invocation
    try {
      invocation = await buildCliInvocation(args, cliCommand)
    } catch (err) {
      this.state = {
        ...this.state,
        official: { ran: true, ok: false, results: [], error: err instanceof Error ? err.message : String(err) }
      }
      this.emit()
      return
    }

    const output = await new Promise<string>((resolvePromise) => {
      let buffer = ''
      let child: ChildProcess
      let settled = false
      const finishOnce = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        resolvePromise(buffer)
      }
      try {
        child = spawnInvocation(invocation, input.projectPath)
        this.child = child
      } catch {
        resolvePromise('')
        return
      }

      const timer = setTimeout(() => {
        killProcessTree(child)
        finishOnce()
      }, 45 * 60_000)

      child.stdout?.on('data', (buf: Buffer) => {
        buffer += buf.toString('utf-8')
        if (buffer.length > 4 * 1024 * 1024) buffer = buffer.slice(-2 * 1024 * 1024)
      })
      child.stderr?.on('data', (buf: Buffer) => {
        const text = buf.toString('utf-8')
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() && /benchmark|config|run/i.test(line)) this.log(line.trim(), 'info')
        }
      })
      child.on('error', () => finishOnce())
      child.on('close', () => finishOnce())
    })

    this.child = null
    if (this.canceled) return

    const parsed = extractTrailingJson<{
      results?: { config?: string; avgTimeMs?: number; avgSizeBytes?: number; failures?: number }[]
    }>(output)

    if (!parsed?.results) {
      this.state = {
        ...this.state,
        official: { ran: true, ok: false, results: [], error: '未能解析官方 benchmark 的 JSON 输出' }
      }
      this.log('官方 benchmark 未返回可解析结果，继续执行自有矩阵测试', 'warn')
      this.emit()
      return
    }

    const results = parsed.results.map((r) => ({
      name: r.config ?? '未命名配置',
      seconds: Math.round(((r.avgTimeMs ?? 0) / 1000) * 10) / 10,
      sizeBytes: r.avgSizeBytes ?? null
    }))
    this.state = { ...this.state, official: { ran: true, ok: true, results } }
    this.log(`官方 benchmark 完成，共 ${results.length} 组配置`, 'success')
    this.emit()
  }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function spawnInvocation(
  invocation: Awaited<ReturnType<typeof buildCliInvocation>>,
  cwd: string
): ChildProcess {
  // 单独抽出，保证官方 benchmark 与普通渲染走同一套 spawn 配置
  return spawn(invocation.file, invocation.args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
    windowsHide: true,
    shell: false
  })
}

function emptyLogContext(): {
  testId: string
  logDir: string
  logFile: string
  smoke: SmokeTestResult | null
  lastFailure: ComparisonFailure | null
} {
  return { testId: '', logDir: '', logFile: '', smoke: null, lastFailure: null }
}

function safeFileName(text: string): string {
  return text.replace(/[^\w.-]+/g, '_')
}

function sanitizeSegment(text: string): string {
  return text.replace(/[^\w.-]+/g, '_')
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? text).slice(0, 400)
}

/** 中文化的阶段名（界面与日志共用） */
export function stageLabel(stage: ComparisonStage): string {
  const map: Record<ComparisonStage, string> = {
    environment: '环境检查',
    project: '项目检查',
    args: '参数构建',
    spawn: '子进程启动',
    render: '视频渲染',
    file: '文件验证',
    parse: '结果解析',
    none: '无'
  }
  return map[stage] ?? stage
}

/** 中文化的错误类型（界面与日志共用） */
export function errorTypeLabel(type: string): string {
  const map: Record<string, string> = {
    'command-not-found': '命令不存在',
    'unsupported-arg': '参数不支持',
    'invalid-project': '项目无效',
    'file-write': '文件写入失败',
    chrome: 'Chrome 异常',
    ffmpeg: 'FFmpeg 异常',
    'out-of-memory': '内存不足',
    timeout: '超时',
    unknown: '未知错误',
    none: '无'
  }
  return map[type] ?? type
}

/** 当前 CLI 的 -q 是否接受某个质量档位（依据帮助文本真实描述） */
function qualitySupported(cli: CliCapabilities, quality: string): boolean {
  const option = cli.render.options.find((o) => o.flag === '-q' || o.flag === '--quality')
  if (!option?.description) return false
  return new RegExp(`\\b${quality}\\b`, 'i').test(option.description)
}

function mergeRuns(results: BenchmarkRunResult[], candidate: BenchmarkCandidate): BenchmarkRunResult {
  const ok = results.filter((r) => r.status === 'ok')
  if (ok.length === 0) {
    const first = results[0]
    return { ...first, candidateId: candidate.id, label: candidate.label }
  }
  const sorted = [...ok].sort((a, b) => a.durationMs - b.durationMs)
  const median = sorted[Math.floor(sorted.length / 2)]
  const cpuValues = ok.map((r) => r.peak.cpuPct).filter((v): v is number => v != null)
  const cpuAvg = cpuValues.length > 0 ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : null
  return {
    ...median,
    candidateId: candidate.id,
    label: candidate.label,
    status: 'ok',
    avgCpuPct: median.avgCpuPct ?? cpuAvg,
    peak: {
      ...median.peak,
      cpuPct: Math.max(...ok.map((r) => r.peak.cpuPct ?? 0)) || null,
      memoryBytes: Math.max(...ok.map((r) => r.peak.memoryBytes ?? 0)) || null,
      vramBytes: Math.max(...ok.map((r) => r.peak.vramBytes ?? 0)) || null,
      gpuPct: Math.max(...ok.map((r) => r.peak.gpuPct ?? 0)) || null,
      videoEncodePct: Math.max(...ok.map((r) => r.peak.videoEncodePct ?? 0)) || null
    }
  }
}

function fpsLabelOf(settings: RenderSettings): string {
  if (settings.fpsMode === 'project') return '跟随项目'
  if (settings.fpsMode === 'custom') return settings.customFps || '自定义'
  return `${settings.fpsMode}fps`
}

/** 清理日志里用的体积文本 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
