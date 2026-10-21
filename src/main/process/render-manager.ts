import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import {
  buildCliInvocation,
  buildRenderArgs,
  extractErrorMessage,
  isDecorationLine,
  killProcessTree,
  parseLine,
  stripAnsi
} from './hyperframes'
import type {
  RenderEvent,
  RenderHistoryEntry,
  RenderLogLine,
  RenderRequest,
  RenderSettings,
  RenderStartResult,
  RenderTaskConfigSnapshot,
  RenderTaskState,
  StoppedResult,
  LogLevel,
  LogStream
} from '@shared/types/render'
import { DEFAULT_EXTRA_OPTIONS } from '@shared/types/render'
import type { FallbackContext } from '../fallback/fallback-manager'
import type { CliCapabilities, PerformanceMode } from '@shared/types/performance'
import { cleanupStrayBrowsers } from './stray-browsers'
import { describeBudget, planDiskBudget } from './disk-budget'
import { RenderEtaEstimator } from './eta-estimator'
import { describeEncoder, probeOutputMedia, startEncoderWatch, type EncoderWatchHandle } from './encoder-probe'
import {
  applyBrowserGpuEvidence,
  applyEncoderEvidence,
  applyFallback,
  applyOutputProbe,
  buildTaskConfigSnapshot,
  exportFormatLine,
  exportSpecLine,
  PERFORMANCE_MODE_LABEL,
  performanceDetailLine,
  performanceSourceLabel,
  refreshEffectiveFromArgs
} from './task-config'

const MAX_LOG_LINES = 6000
const FLUSH_INTERVAL = 70
const TASK_THROTTLE = 160

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let gbkDecoder: TextDecoder | null = null

/** 渲染临时帧（磁盘捕获）的存放策略 */
export interface ScratchOptions {
  /** 用户指定的暂存目录；为空表示跟随系统临时目录 */
  scratchDir?: string | null
  /** 系统临时目录空间不足时是否自动切换到其他盘 */
  autoScratch?: boolean
  /**
   * 本次任务选择的性能模式。
   * 只在**启动那一刻**读取并写进任务快照：之后用户切换模式不会影响正在跑的任务。
   */
  performanceMode?: PerformanceMode
}

/** Windows 下 cmd / 部分工具输出 GBK，按行兜底解码 */
function decodeBytes(buf: Buffer): string {
  if (buf.length === 0) return ''
  try {
    return utf8Strict.decode(buf)
  } catch {
    try {
      gbkDecoder ??= new TextDecoder('gbk')
      return gbkDecoder.decode(buf)
    } catch {
      return buf.toString('utf-8')
    }
  }
}

/** 故障回退给出的降载动作（与 FallbackManager 的输出同构，避免反向依赖具体实现） */
export interface FallbackStep {
  key: string
  label: string
  reason: string
  patch: Partial<RenderSettings> & { env?: Record<string, string> }
  env?: Record<string, string>
  blocking?: boolean
}

/** 单次渲染最多自动重试几次；每次重试都会按回退规则进一步降载 */
const MAX_AUTO_RETRIES = 2

/**
 * 按负载估算页面就绪等待时间。
 * 每个 worker 都要独立启动一个 Chrome 并把 composition 初始化到
 * `window.__hf.duration > 0`，并发越多 / 分辨率越高就越慢。
 * CLI 默认只有 45s，高负载下很容易误判成失败，所以这里主动放宽。
 * 返回 null 表示不需要干预（用户已显式指定，或负载不足以成为瓶颈）。
 */
export function suggestReadyTimeoutMs(request: RenderRequest): number | null {
  if (request.extra?.playerReadyTimeoutMs) return null
  if (request.workers !== 'auto' && request.workers <= 1) return null

  const workers = request.workers === 'auto' ? 4 : request.workers
  const meta = request.projectMeta
  const px = meta?.width && meta?.height ? meta.width * meta.height : null
  const is4k = px !== null && px >= 3840 * 2160 * 0.9
  const isHd = px !== null && px >= 1920 * 1080 * 0.9

  if (is4k && workers > 1) return 240_000
  if (is4k || (isHd && workers > 2)) return 150_000
  if (isHd && workers > 1) return 90_000
  if (workers >= 4) return 90_000
  return null
}

/** 把回退动作合并进渲染请求；extra 需要逐字段合并而不是整体替换 */
function applyFallbackPatch(request: RenderRequest, steps: FallbackStep[]): RenderRequest {
  let next: RenderRequest = { ...request }
  for (const step of steps) {
    const patch = step.patch
    next = { ...next, ...patch }
    if (patch.extra) {
      next.extra = { ...(next.extra ?? DEFAULT_EXTRA_OPTIONS), ...patch.extra }
    }
    if (patch.env) next.env = { ...(next.env ?? {}), ...patch.env }
  }
  return next
}

export class RenderManager {
  private child: ChildProcess | null = null
  private cancelRequested = false
  private task: RenderTaskState = this.idleTask()
  private logs: RenderLogLine[] = []
  private logSeq = 0
  private pending: RenderLogLine[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private taskTimer: NodeJS.Timeout | null = null
  private buffers: Record<'stdout' | 'stderr', Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  }
  private stderrTail: string[] = []
  /** 最近的有效输出行，用于失败时给出可读原因 */
  private recentLines: string[] = []
  private listeners = new Set<(event: RenderEvent) => void>()
  private startGuard = false
  private cliProvider: (() => Promise<CliCapabilities | null>) | null = null
  private fallbackProvider:
    | ((errorText: string, ctx: FallbackContext) => FallbackStep[] | Promise<FallbackStep[]>)
    | null = null
  /** 当前是第几次尝试（0 = 首次） */
  private attempt = 0
  private baseScratch: ScratchOptions = {}
  /** 本次任务选择的性能模式快照（启动时冻结） */
  private selectedMode: PerformanceMode = 'smart'
  /** 编码器运行时监听（ffmpeg 真实命令行） */
  private encoderWatch: EncoderWatchHandle | null = null
  /** 历史记录写入回调（由 main 注入，保证 UI / 日志 / 历史同一份快照） */
  private historySink: ((entry: RenderHistoryEntry) => Promise<void>) | null = null
  /** 动态 ETA 估算器（每次启动 / 重试时重置） */
  private eta = new RenderEtaEstimator()

  /** 注入历史记录存储器 */
  setHistorySink(sink: (entry: RenderHistoryEntry) => Promise<void>): void {
    this.historySink = sink
  }

  /** 注入故障回退分析器，用于渲染失败后自动降载重试 */
  setFallbackProvider(
    provider: (errorText: string, ctx: FallbackContext) => FallbackStep[] | Promise<FallbackStep[]>
  ): void {
    this.fallbackProvider = provider
  }

  /** 订阅渲染事件（可多个订阅者，返回取消函数） */
  onEvent(listener: (event: RenderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: RenderEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** 注入 CLI 能力探测结果，用于决定高级性能参数是否真正下发 */
  setCliProvider(provider: () => Promise<CliCapabilities | null>): void {
    this.cliProvider = provider
  }

  private idleTask(): RenderTaskState {
    return {
      id: 'idle',
      status: 'idle',
      request: null,
      command: '',
      progress: { pct: null, label: '等待开始' },
      stats: {}
    }
  }

  getState(): RenderTaskState {
    return this.task
  }

  isBusy(): boolean {
    return this.task.status === 'running' || this.task.status === 'preparing'
  }

  clearLogs(): void {
    this.logs = []
    this.pending = []
    this.emit({ type: 'logs', lines: [] })
  }

  /* ------------------------------ 启动 ------------------------------ */

  /**
   * 启动一次渲染。
   * 磁盘捕获会把每一帧先写到临时目录，空间不足时 CLI 会直接以
   * "Disk capture may need …" 失败；这里在 spawn 前先做预算并在必要时
   * 把子进程的系统临时目录切换到更充裕的盘（CLI 在 Windows 上固定用 os.tmpdir()）。
   */
  async start(
    request: RenderRequest,
    cliCommand: string,
    scratch: ScratchOptions = {}
  ): Promise<RenderStartResult> {
    if (this.isBusy() || this.startGuard) {
      return { ok: false, error: '已有渲染任务在运行中，请先停止或等待完成' }
    }
    this.startGuard = true

    try {
      const validationError = await this.validate(request)
      if (validationError) {
        this.startGuard = false
        return { ok: false, error: validationError }
      }
      this.attempt = 0
      this.baseScratch = scratch
      // 模式快照只在这里（任务启动时）取值：之后用户切模式不会影响本任务
      if (scratch.performanceMode) this.selectedMode = scratch.performanceMode
      return await this.launch(request, cliCommand, scratch)
    } catch (err) {
      this.startGuard = false
      this.child = null
      const message = err instanceof Error ? err.message : String(err)
      this.task = {
        ...this.task,
        status: 'failed',
        progress: { ...this.task.progress, label: '渲染失败' },
        endedAt: new Date().toISOString(),
        error: message
      }
      this.emitTask(true)
      return { ok: false, error: message }
    }
  }

  /**
   * 真正 spawn 一次渲染进程。失败后 {@link tryRecover} 会用降载后的请求再次调用这里，
   * 因此这个方法必须能重入（不依赖"首次渲染"的前置状态）。
   */
  private async launch(
    request: RenderRequest,
    cliCommand: string,
    scratch: ScratchOptions
  ): Promise<RenderStartResult> {
    const isRetry = this.attempt > 0
    try {
      /* ---------- 页面就绪超时：按负载主动放宽，避免用 CLI 默认 45s 直接失败 ---------- */
      const readyTimeoutMs = suggestReadyTimeoutMs(request)
      if (readyTimeoutMs) {
        request = {
          ...request,
          extra: { ...(request.extra ?? DEFAULT_EXTRA_OPTIONS), playerReadyTimeoutMs: readyTimeoutMs }
        }
      }

      const cli = this.cliProvider ? await this.cliProvider().catch(() => null) : null
      const { args, outputPath, warnings } = buildRenderArgs(request, cli ?? undefined)
      const invocation = await buildCliInvocation(args, cliCommand)

      /* -------------- 临时磁盘预检（磁盘捕获会把每一帧先落盘） -------------- */
      const budget = planDiskBudget({
        request,
        scratchDir: scratch.scratchDir,
        autoScratch: scratch.autoScratch !== false
      })
      if (budget.error) {
        this.startGuard = false
        this.pushSystem(describeBudget(budget), 'warn')
        this.pushSystem(`无法开始渲染：${budget.error}`, 'error')
        this.emitTask(true)
        return { ok: false, error: budget.error }
      }
      const tempEnv: Record<string, string> = budget.overrideTempDir
        ? {
            TMP: budget.overrideTempDir,
            TEMP: budget.overrideTempDir,
            TMPDIR: budget.overrideTempDir
          }
        : {}

      this.stderrTail = []
      this.recentLines = []
      this.buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      if (!isRetry) {
        this.cancelRequested = false
        this.logSeq = 0
        this.logs = []
        this.pending = []
        this.emit({ type: 'logs', lines: [] })
      }

      /* ---------- 任务配置快照：只认真正下发的 args 与运行时证据 ---------- */
      const taskId = isRetry ? this.task.id : randomUUID()
      const previousConfig = this.task.config
      const config: RenderTaskConfigSnapshot =
        isRetry && previousConfig
          ? refreshEffectiveFromArgs(previousConfig, request, args)
          : buildTaskConfigSnapshot({
              taskId,
              request,
              args,
              performanceMode: this.selectedMode
            })

      this.task = {
        // 重试沿用同一个 task id 与开始时间，界面上是一次任务的连续过程
        id: taskId,
        status: 'preparing',
        request,
        command: invocation.display,
        progress: { pct: null, label: isRetry ? `第 ${this.attempt} 次重试` : '准备中' },
        startedAt: isRetry ? this.task.startedAt : new Date().toISOString(),
        endedAt: undefined,
        error: undefined,
        stats: { outputPath },
        eta: null,
        config
      }
      // 新任务 / 重试都从零开始估算，避免上一轮速度污染本轮 ETA
      this.eta.reset()

      if (isRetry) this.pushSystem(`—— 第 ${this.attempt} 次重试 ——`, 'warn')
      this.pushSystem(`项目目录  ${request.projectPath}`)
      this.pushSystem(`输出路径  ${outputPath}`)
      this.pushSystem(`执行命令  ${invocation.display}`)
      this.pushSnapshotLogs(config)
      if (invocation.realCommand !== invocation.display) {
        this.pushSystem(`实际进程  ${invocation.realCommand}`, 'debug')
      }
      for (const warning of warnings) this.pushSystem(`注意：${warning}`, 'warn')
      if (readyTimeoutMs) {
        this.pushSystem(
          `页面就绪等待  已放宽到 ${Math.round(readyTimeoutMs / 1000)}s（CLI 默认 45s；` +
            `每个 worker 都要独立初始化页面，${request.workers === 'auto' ? 'auto' : request.workers} 个 worker 并发时容易超时）`,
          'info'
        )
      }
      this.pushSystem(describeBudget(budget), 'info')
      for (const note of budget.warnings) this.pushSystem(`注意：${note}`, 'warn')
      if (budget.overrideTempDir) {
        this.pushSystem(`临时目录  ${budget.overrideTempDir}（已通过 TMP / TEMP 环境变量下发）`, 'debug')
      }
      this.emitTask(true)

      await fs.mkdir(dirname(outputPath), { recursive: true })

      // 先起编码器监听再 spawn：PowerShell 启动需要几百毫秒，
      // 提前起可以避免短渲染（几秒就编码完）漏掉 ffmpeg 进程
      this.startEncoderWatch(config)

      const child = spawn(invocation.file, invocation.args, {
        cwd: request.projectPath,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          CI: '1',
          ...tempEnv,
          ...pickAllowedEnv(request.env)
        },
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32'
      })
      this.child = child

      let closed = false
      const finalize = async (code: number | null, spawnError?: string): Promise<void> => {
        if (closed) return
        closed = true
        this.child = null
        this.drainBuffers()
        this.stopEncoderWatch()

        if (this.flushTimer) {
          clearInterval(this.flushTimer)
          this.flushTimer = null
        }

        const endedAt = new Date().toISOString()
        const elapsedMs = this.task.startedAt
          ? Date.now() - new Date(this.task.startedAt).getTime()
          : undefined
        const finalPath = this.task.stats.outputPath ?? outputPath
        // 渲染结束：停止 ETA 并记录「最初预计 vs 实际」的误差，供后续预测校准
        const finalEta = this.eta.finishState(elapsedMs ?? null)
        // 记住是哪个任务：探测 / 写历史是异步的，期间用户可能已经开始下一个任务
        const taskId = this.task.id
        let nextTask: RenderTaskState = {
          ...this.task,
          endedAt,
          elapsedMs,
          eta: finalEta
        }

        if (this.cancelRequested) {
          nextTask = {
            ...nextTask,
            status: 'canceled',
            progress: { ...nextTask.progress, label: '已停止' }
          }
          this.pushSystem('渲染已被用户停止', 'warn')
        } else if (code === 0) {
          nextTask = {
            ...nextTask,
            status: 'succeeded',
            progress: { pct: 100, label: '渲染完成' },
            stats: { ...nextTask.stats, outputPath: finalPath },
            outputExists: existsSync(finalPath)
          }
          this.pushSystem(outputPathLine(finalPath, existsSync(finalPath)), 'success')
          if (finalEta?.note) this.pushSystem(finalEta.note, 'info')
        } else {
          // 回退规则匹配的是 CLI 原始英文报错，不能用翻译后的中文去做判断
          const rawError = [spawnError ?? '', ...this.stderrTail, ...this.recentLines]
            .filter(Boolean)
            .join('\n')
          const error =
            spawnError ||
            this.task.error ||
            extractErrorMessage(this.stderrTail) ||
            extractErrorMessage(this.recentLines) ||
            '渲染失败，请查看日志中的错误信息'

          // 先尝试按故障回退规则降载重试；只有确实无法重试才真正判失败
          if (await this.tryRecover(rawError, cliCommand)) return

          nextTask = {
            ...nextTask,
            status: 'failed',
            progress: { ...nextTask.progress, label: '渲染失败' },
            error
          }
          this.pushSystem(`渲染失败：${error}`, 'error')
        }

        this.startGuard = false
        // 先用产出文件校正快照，再写历史（UI / 日志 / 历史共用同一份快照）。
        // 探测是异步的，期间不提交终态，避免界面先看到"完成"但配置还没校正。
        const finalTask = await this.finalizeConfig(nextTask, finalPath)
        if (this.task.id === taskId) {
          this.task = finalTask
          this.emitTask(true)
        }
        // 渲染结束后清理 CLI 留下的无头浏览器孤儿进程，避免占用内存并影响下一次渲染
        if (!this.cancelRequested) {
          void cleanupStrayBrowsers()
            .then((killed) => {
              if (killed > 0) this.pushSystem(`清理了 ${killed} 个残留的无头浏览器进程`, 'warn')
            })
            .catch(() => undefined)
        }
      }

      child.stdout?.on('data', (buf: Buffer) => this.consume(buf, 'stdout'))
      child.stderr?.on('data', (buf: Buffer) => this.consume(buf, 'stderr'))
      child.on('error', (err) => {
        void finalize(null, `无法启动渲染进程：${err.message}`).catch(() => undefined)
      })
      child.on('close', (code) => {
        void finalize(code).catch(() => undefined)
      })

      this.flushTimer = setInterval(() => this.flushLogs(), FLUSH_INTERVAL)

      this.task = {
        ...this.task,
        status: 'running',
        progress: { pct: null, label: '启动渲染进程' }
      }
      this.startGuard = false
      this.emitTask(true)
      return { ok: true, task: this.task }
    } catch (err) {
      this.startGuard = false
      this.child = null
      const message = err instanceof Error ? err.message : String(err)
      this.task = {
        ...this.task,
        status: 'failed',
        error: message,
        progress: { pct: null, label: '启动失败' },
        endedAt: new Date().toISOString()
      }
      this.pushSystem(`启动失败：${message}`, 'error')
      this.emitTask(true)
      return { ok: false, error: message }
    }
  }

  /**
   * 渲染失败后按故障回退规则降载重试。
   * 只降低负载 / 回退加速路径，绝不改动输出格式、分辨率与质量参数。
   * 返回 true 表示已经重新拉起一次渲染，调用方不应再把任务标记成失败。
   */
  private async tryRecover(errorText: string, cliCommand: string): Promise<boolean> {
    if (!this.fallbackProvider) return false
    if (this.attempt >= MAX_AUTO_RETRIES) return false

    const current = this.task.request
    if (!current) return false

    let actions: FallbackStep[] = []
    try {
      actions =
        (await this.fallbackProvider(errorText, {
          workers: current.workers,
          gpuEncode: current.gpu,
          capturePath: current.extra?.fastCapture === 'on' ? 'fast-capture' : 'default',
          browserGpu: current.browserGpu,
          extra: current.extra
        })) ?? []
    } catch {
      return false
    }

    const actionable = actions.filter(
      (action) => !action.blocking && action.patch && Object.keys(action.patch).length > 0
    )
    if (actionable.length === 0) return false

    const next = applyFallbackPatch(current, actionable)
    const changed =
      JSON.stringify({
        workers: next.workers,
        gpu: next.gpu,
        browserGpu: next.browserGpu,
        extra: next.extra,
        env: next.env
      }) !==
      JSON.stringify({
        workers: current.workers,
        gpu: current.gpu,
        browserGpu: current.browserGpu,
        extra: current.extra,
        env: current.env
      })
    if (!changed) return false

    this.attempt += 1
    const labels = actionable.map((a) => a.label)
    // 回退会改变实际生效的配置：先把动作记进任务快照（界面立刻能看到"已回退"）
    if (this.task.config) {
      this.task = { ...this.task, config: applyFallback(this.task.config, labels, this.attempt) }
    }
    this.pushSystem(
      `第 ${this.attempt}/${MAX_AUTO_RETRIES} 次自动重试（${labels.join(' + ')}）：` +
        `${actionable.map((a) => a.reason).join('；')}`,
      'warn'
    )
    if (current.gpu && next.gpu === false) {
      this.pushSystem('GPU 编码已回退为 CPU 编码，实际编码器会在重试任务里重新确认', 'warn')
    }

    // 残留的无头浏览器会拖慢下一次 launch，重试前先清干净
    await cleanupStrayBrowsers()
      .then((killed) => {
        if (killed > 0) this.pushSystem(`清理了 ${killed} 个残留的无头浏览器进程`, 'warn')
      })
      .catch(() => undefined)

    const result = await this.launch(next, cliCommand, this.baseScratch)
    return result.ok
  }

  /* ---------------------------- 配置快照 ---------------------------- */

  /** 启动时把快照写进日志（与界面显示同一份数据） */
  private pushSnapshotLogs(config: RenderTaskConfigSnapshot): void {
    this.pushSystem(
      `性能模式  ${PERFORMANCE_MODE_LABEL[config.selectedPerformanceMode]} · ${performanceSourceLabel(config)}（任务启动时冻结）`
    )
    this.pushSystem(`生效配置  ${performanceDetailLine(config)}`)
    this.pushSystem(
      `导出规格  ${exportSpecLine(config)} · ${exportFormatLine(config)} · 质量 ${config.quality}`
    )
    if (config.format !== 'png-sequence') {
      this.pushSystem('编码器    确认中（只认 ffmpeg / ffprobe 的真实证据，不把请求当结果）', 'debug')
    }
  }

  /** 监听真实 ffmpeg 进程的 `-c:v`；png-sequence 不编码，无需监听 */
  private startEncoderWatch(config: RenderTaskConfigSnapshot): void {
    this.stopEncoderWatch()
    if (config.format === 'png-sequence') return
    this.encoderWatch = startEncoderWatch({
      onEncoder: (encoderId) => this.onEncoderEvidence(encoderId),
      onError: (message) => this.pushSystem(`编码器监听不可用：${message}`, 'debug'),
      timeoutMs: 20 * 60_000
    })
  }

  private stopEncoderWatch(): void {
    this.encoderWatch?.stop()
    this.encoderWatch = null
  }

  /** 运行时拿到真实编码器：立刻更新快照并记录日志 */
  private onEncoderEvidence(encoderId: string): void {
    const config = this.task.config
    if (!config || config.encoder.id === encoderId) return
    const hardwareBefore = config.encoder.hardware
    const next = applyEncoderEvidence(config, encoderId, 'process')
    this.task = { ...this.task, config: next }
    const descriptor = describeEncoder(encoderId)
    const kind =
      descriptor.hardware === true ? '硬件编码' : descriptor.hardware === false ? 'CPU 软件编码' : '类型未知'
    if (config.gpuEncodingEnabled && descriptor.hardware === false) {
      this.pushSystem(
        `实际编码器  ${descriptor.label}（${encoderId}）· ${kind} —— 请求了 GPU 编码，本次实际由 CPU 完成`,
        'warn'
      )
    } else if (hardwareBefore !== null && hardwareBefore !== descriptor.hardware) {
      this.pushSystem(`实际编码器  ${descriptor.label}（${encoderId}）· ${kind}（与上一次证据不同，已更新）`, 'warn')
    } else {
      this.pushSystem(`实际编码器  ${descriptor.label}（${encoderId}）· ${kind}`, 'info')
    }
    this.emitTask(true)
  }

  /** 从 CLI 输出里识别浏览器 GPU 合成状态（只在 auto 且尚无证据时更新） */
  private updateBrowserGpuEvidence(line: string): void {
    const config = this.task.config
    if (!config || config.browserGpuEnabled !== null) return
    const lower = line.toLowerCase()
    let enabled: boolean | null = null
    if (/hardware gpu|hardware acceleration|gpu compositing/.test(lower)) enabled = true
    else if (/swiftshader|software rendering|software gpu|software rasterization/.test(lower)) enabled = false
    if (enabled === null) return
    this.task = { ...this.task, config: applyBrowserGpuEvidence(config, enabled) }
    this.pushSystem(`浏览器 GPU  ${enabled ? '已启用（硬件合成）' : '未启用（软件渲染）'}`, enabled ? 'info' : 'warn')
    this.emitTask()
  }

  /** 结束后用产出文件校正分辨率 / 帧率 / 编码器，并写历史记录 */
  private async finalizeConfig(task: RenderTaskState, finalPath: string): Promise<RenderTaskState> {
    const snapshot = task.config
    if (!snapshot) {
      await this.saveHistory(null, finalPath, task)
      return task
    }
    let next = snapshot
    const format = task.request?.format ?? snapshot.format
    const directoryOutput = format === 'png-sequence' || format === 'hls'

    if (task.status === 'succeeded' && !directoryOutput && existsSync(finalPath)) {
      const probe = await probeOutputMedia(finalPath)
      const beforeEncoder = next.encoder.id
      next = applyOutputProbe(next, probe)
      if (next.encoder.id && next.encoder.id !== beforeEncoder) {
        this.pushSystem(`实际编码器  ${next.encoder.label}（${next.encoder.id}，来自产出文件）`, 'info')
      }
      if (next.resolution.confirmed) {
        this.pushSystem(`实际输出  ${next.resolution.width}×${next.resolution.height} · ${next.fps.label}`, 'info')
      }
      if (probe.available && !probe.ok && probe.error) {
        this.pushSystem(`产出文件探测失败（不影响渲染结果）：${probe.error}`, 'debug')
      }
    }

    if (next.encoder.source === 'none' && format !== 'png-sequence') {
      next = {
        ...next,
        encoder: { ...next.encoder, label: '未确认（运行日志与产出文件都未暴露编码器）' }
      }
    }

    const finalTask: RenderTaskState = { ...task, config: next }
    await this.saveHistory(next, finalPath, finalTask)
    return finalTask
  }

  private async saveHistory(
    config: RenderTaskConfigSnapshot | null,
    finalPath: string,
    task: RenderTaskState
  ): Promise<void> {
    const sink = this.historySink
    if (!sink || !config) return
    const entry: RenderHistoryEntry = {
      taskId: task.id,
      status: task.status,
      startedAt: task.startedAt ?? config.createdAt,
      finishedAt: task.endedAt ?? new Date().toISOString(),
      elapsedMs: task.elapsedMs ?? null,
      config,
      outputPath: task.stats.outputPath ?? (finalPath || null),
      sizeText: task.stats.sizeText ?? null,
      error: task.error ?? null
    }
    try {
      await sink(entry)
    } catch (err) {
      this.pushSystem(`历史记录写入失败：${err instanceof Error ? err.message : String(err)}`, 'warn')
    }
  }

  private async validate(request: RenderRequest): Promise<string | null> {
    if (!request.projectPath) return '请先选择项目目录'
    if (!existsSync(request.projectPath)) return '项目目录不存在，请重新选择'

    const composition = (request.composition ?? '').trim()
    if (composition && composition !== 'index.html' && composition !== '.') {
      const compPath = isAbsolute(composition) ? composition : join(request.projectPath, composition)
      if (!existsSync(compPath)) {
        return `指定的 composition 不存在：${composition}`
      }
    } else if (!existsSync(join(request.projectPath, 'index.html'))) {
      return '项目目录缺少 index.html，无法渲染。请在高级设置中指定 composition 文件，或重新选择项目。'
    }

    if (!request.outputDir) return '请选择输出位置'
    if (!(request.outputName ?? '').trim()) return '请填写输出文件名'
    if (request.fpsMode === 'custom') {
      const value = (request.customFps ?? '').trim()
      if (!value) return '自定义帧率不能为空'
      if (!/^\d+(\s*\/\s*\d+)?$/.test(value)) return '自定义帧率格式无效（示例：30 或 30000/1001）'
      const [a, b] = value.split('/').map((s) => Number(s.trim()))
      const fps = b ? a / b : a
      if (!(fps >= 1 && fps <= 240)) return '自定义帧率需在 1–240 之间'
    }
    if (request.crf !== null && request.crf !== undefined && (request.crf < 0 || request.crf > 63)) {
      return 'CRF 需在 0–63 之间'
    }
    if (request.videoBitrate && !/^\d+(\.\d+)?[kKmM]?$/.test(request.videoBitrate.trim())) {
      return '视频码率格式无效（示例：10M / 8000k）'
    }
    return null
  }

  /* ------------------------------ 停止 ------------------------------ */

  async stop(): Promise<StoppedResult> {
    if (!this.child || !this.isBusy()) {
      return { ok: false, error: '当前没有正在运行的渲染任务' }
    }
    const child = this.child
    this.cancelRequested = true
    this.task = {
      ...this.task,
      status: 'canceled',
      progress: { ...this.task.progress, label: '正在停止…' }
    }
    this.emitTask(true)

    killProcessTree(child)

    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      child.once('close', finish)
      setTimeout(() => {
        // 兜底：再次强杀并收敛状态
        if (!done) killProcessTree(child)
        finish()
      }, 6000)
    })

    if (this.task.status !== 'canceled' || !this.task.endedAt) {
      this.task = {
        ...this.task,
        status: 'canceled',
        progress: { ...this.task.progress, label: '已停止' },
        endedAt: this.task.endedAt ?? new Date().toISOString()
      }
      this.emitTask(true)
    }
    return { ok: true }
  }

  /* ---------------------------- 输出处理 ---------------------------- */

  private consume(buf: Buffer, stream: 'stdout' | 'stderr'): void {
    const merged = Buffer.concat([this.buffers[stream], buf])
    let start = 0
    for (let i = 0; i < merged.length; i += 1) {
      const byte = merged[i]
      if (byte === 0x0a) {
        this.emitLine(merged.subarray(start, i), stream)
        start = i + 1
      } else if (byte === 0x0d) {
        // 结尾的 \r 需要等下一块数据才能判断是否属于 \r\n
        if (i === merged.length - 1) break
        if (merged[i + 1] === 0x0a) continue
        // 单独的 \r：终端的原地重绘，按"新行"处理
        this.emitLine(merged.subarray(start, i), stream)
        start = i + 1
      }
    }
    this.buffers[stream] = merged.subarray(start)
  }

  private emitLine(bytes: Buffer, stream: 'stdout' | 'stderr'): void {
    const text = decodeBytes(bytes).replace(/\r/g, '')
    // 先去掉转义序列，再判断是否为纯边框装饰行
    if (!stripAnsi(text).trim() || isDecorationLine(stripAnsi(text))) return
    this.handleLine(text, stream)
  }

  private drainBuffers(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.buffers[stream]
      if (rest.length > 0) {
        this.emitLine(rest, stream)
        this.buffers[stream] = Buffer.alloc(0)
      }
    }
  }

  private handleLine(rawLine: string, stream: LogStream): void {
    const parsed = parseLine(rawLine)
    const line = stripAnsi(rawLine).replace(/\r/g, '').trimEnd()

    if (stream === 'stderr') {
      this.stderrTail.push(line)
      if (this.stderrTail.length > 80) this.stderrTail.shift()
    }

    if (parsed.progress) {
      const prev = this.task.progress
      if (
        prev.pct !== parsed.progress.pct ||
        prev.label !== parsed.progress.label ||
        prev.done !== parsed.progress.done
      ) {
        this.task = { ...this.task, progress: parsed.progress }
        // 真实进度驱动动态 ETA；解析失败 / 无依据时 estimator 会给出 estimating 状态
        this.task = { ...this.task, eta: this.eta.update(parsed.progress) }
        this.emitTask()
      }
    }

    if (parsed.outputPath) {
      this.task = { ...this.task, stats: { ...this.task.stats, outputPath: parsed.outputPath } }
      this.emitTask()
    }

    if (parsed.stats) {
      this.task = { ...this.task, stats: { ...this.task.stats, ...parsed.stats } }
      this.emitTask()
    }

    if (parsed.hidden) return

    if (!line.trim()) return

    // CLI 自己的总结行里会写明 hardware gpu / software rendering
    this.updateBrowserGpuEvidence(line)

    let level: LogLevel = parsed.level ?? (stream === 'stderr' ? 'warn' : 'info')
    if (stream === 'stderr' && /^\s*✗/.test(line)) level = 'error'

    if (level !== 'debug') {
      this.recentLines.push(line)
      if (this.recentLines.length > 60) this.recentLines.shift()
    }

    const entry: RenderLogLine = {
      id: ++this.logSeq,
      ts: new Date().toISOString(),
      stream,
      level,
      text: line
    }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    this.pending.push(entry)
  }

  private pushSystem(text: string, level: LogLevel = 'info'): void {
    const entry: RenderLogLine = {
      id: ++this.logSeq,
      ts: new Date().toISOString(),
      stream: 'system',
      level,
      text
    }
    this.logs.push(entry)
    this.pending.push(entry)
    if (!this.flushTimer) this.flushLogs()
  }

  private flushLogs(): void {
    if (this.pending.length === 0) return
    const lines = this.pending
    this.pending = []
    this.emit({ type: 'logs', lines })
  }

  private emitTask(immediate = false): void {
    if (immediate) {
      this.flushLogs()
      if (this.taskTimer) {
        clearTimeout(this.taskTimer)
        this.taskTimer = null
      }
      this.emit({ type: 'task', task: this.task })
      return
    }
    if (this.taskTimer) return
    this.taskTimer = setTimeout(() => {
      this.taskTimer = null
      this.emit({ type: 'task', task: this.task })
    }, TASK_THROTTLE)
  }

  dispose(): void {
    this.stopEncoderWatch()
    if (this.child) {
      this.cancelRequested = true
      killProcessTree(this.child)
      this.child = null
    }
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.taskTimer) clearTimeout(this.taskTimer)
  }
}

function outputPathLine(path: string, exists: boolean): string {
  return exists ? `输出文件已生成：${path}` : `渲染结束，但未在预期路径找到输出：${path}`
}

/** 只允许这些经过确认的官方性能开关透传到渲染进程 */
const ALLOWED_ENV_KEYS = new Set(['HF_CAPTURE_PARALLEL_STREAM', 'HF_SEGMENTED_CAPTURE'])

function pickAllowedEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV_KEYS.has(key) && typeof value === 'string') result[key] = value
  }
  return result
}
