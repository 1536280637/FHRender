import { performance } from 'node:perf_hooks'
import type { EtaState, RenderProgress } from '@shared/types/render'

/**
 * 动态剩余渲染时间估算（RenderEtaEstimator）。
 *
 * 数据来源：HyperFrames CLI 的真实进度输出。当前 CLI（0.8.x）在非 TTY 环境下
 * 同时打印两种进度：
 *
 *   1. `@hf-progress {"code":"capture","done":76,"total":150,"pct":53}`
 *      —— `pct` 是 **整个任务** 的全局进度（编译 5 / 提取 10 / 音频 20 /
 *      启动浏览器 25 / 捕获 25→80 / 编码 75→90 / 封装 90→99 / 完成 100），
 *      `done`/`total` 只是 **当前阶段** 的帧数（捕获帧数或编码帧数）。
 *   2. 进度条文本 `████░░ 53% Streaming frame 76/150`（无 code 字段，需按
 *      文案前缀推断阶段）。
 *
 * 因此：
 * - 整体 ETA 只能用全局 `pct` 的速率估算，不能把某个阶段的帧数当成整体任务；
 * - 阶段帧速度仅用于展示「当前速度」，以及在拿不到全局速率时给出阶段级估算。
 *
 * 单位约定（历史 bug 就出在这里）：
 * - 内部 **一律用秒** 表示速度（%/秒、帧/秒）和剩余时间，输出到 `etaMs` 时
 *   只做一次 ×1000 换算；
 * - 时间差用单调时钟（performance.now）计算，不受系统时间跳变影响。
 */

/** 采样窗口：最近 30 秒 */
const WINDOW_MS = 30_000
/** 形成一个速率结论所需的最小时间跨度（CLI 的 pct 是取整后的整数，
 *  跨度太短会把 1% 的量化误差放大成数倍速率误差） */
const MIN_SPAN_MS = 5_000
/** 样本上限（防御性，避免长时间高频输出堆积） */
const MAX_SAMPLES = 400
/** 进度停滞判定 */
const STALL_MS = 25_000
/** 进度回退超过该幅度视为进入新阶段（而非输出抖动） */
const PHASE_RESET_DROP = 4
/** 高可信度所需窗口跨度 / 样本数 */
const HIGH_SPAN_MS = 8_000
const HIGH_SAMPLES = 6
/** 荒谬值保护：超过 12 小时的估算视为无效，不展示 */
const MAX_ETA_SEC = 12 * 3600
/** EMA 权重：旧值占 70%，新值占 30% */
const EMA_KEEP = 0.7

/** 单调时钟（毫秒）。优先用 performance.now，缺失时退回 Date.now */
function monoNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`
  return `${s}s`
}

/**
 * 从阶段文案推断进度码。
 * 进度条文本行不带 code，只能按前缀归类；注意不能按整行文本判断，
 * 因为帧号每帧都在变（"Capturing frame 76/150" → "Capturing frame 77/150"）。
 * 文案取自真实 CLI 0.8.181 的输出（Compiling composition / Extracting video
 * frames / Processing audio tracks / Starting browsers (1/2 ready) /
 * Capturing frame 4/112 / Encoding video / Encoding frame 70/112 /
 * Assembling final video / Render complete）。
 */
const LABEL_STAGE_RULES: { pattern: RegExp; code: string }[] = [
  { pattern: /capturing|streaming|screenshot|捕获帧/i, code: 'capture' },
  { pattern: /encoding|\bencode\b|编码视频/i, code: 'encode' },
  { pattern: /assembling|muxing|合成输出/i, code: 'assemble' },
  { pattern: /starting browsers|launching|启动渲染浏览器/i, code: 'start_browsers' },
  { pattern: /compiling|编译合成/i, code: 'compile' },
  { pattern: /extracting|提取视频/i, code: 'extract_video' },
  { pattern: /processing audio|处理音频/i, code: 'process_audio' },
  { pattern: /complete|done|完成/i, code: 'done' }
]

/** 只有这两个阶段的 done/total 是「帧」，其余阶段（浏览器就绪、封装秒数）不能当帧用 */
const FRAME_STAGES = new Set(['capture', 'encode'])

function inferStageCode(label: string | null | undefined): string | null {
  if (!label) return null
  for (const rule of LABEL_STAGE_RULES) {
    if (rule.pattern.test(label)) return rule.code
  }
  return null
}

interface PctSample {
  t: number
  pct: number
}

interface FrameSample {
  t: number
  done: number
}

export class RenderEtaEstimator {
  private pctSamples: PctSample[] = []
  private frameSamples: FrameSample[] = []
  /** 全局进度速率，单位 %/秒 */
  private smoothPctRate: number | null = null
  /** 当前阶段帧速度，单位 帧/秒 */
  private smoothFrameSpeed: number | null = null
  /** 单调时钟起点 */
  private startedAt: number | null = null
  private lastChangeAt: number | null = null
  private lastDone: number | null = null
  private lastPct: number | null = null
  private lastStage: string | null = null
  private initialTotalMs: number | null = null
  private lastState: EtaState | null = null
  /** 上一次输出给界面的 ETA（秒），用于「可降不可暴涨」的平滑 */
  private lastEtaSec: number | null = null
  private lastEtaAt: number | null = null

  reset(now: number = monoNow()): void {
    this.pctSamples = []
    this.frameSamples = []
    this.smoothPctRate = null
    this.smoothFrameSpeed = null
    this.startedAt = now
    this.lastChangeAt = null
    this.lastDone = null
    this.lastPct = null
    this.lastStage = null
    this.initialTotalMs = null
    this.lastState = null
    this.lastEtaSec = null
    this.lastEtaAt = null
  }

  /** 渲染结束（成功 / 失败 / 取消）后停止估算 */
  finish(): void {
    this.lastState = null
  }

  /**
   * 渲染结束时的最终 ETA 状态：停止估算，并记录
   * 「最初预计总耗时 vs 实际耗时」的误差（用于后续预测校准与界面展示）。
   */
  finishState(elapsedMs: number | null): EtaState | null {
    const initial = this.initialTotalMs
    this.lastState = null
    let note: string | null = null
    if (initial != null && elapsedMs != null && elapsedMs > 0) {
      const deviation = Math.round(((elapsedMs - initial) / initial) * 1000) / 10
      note =
        `最初预计总耗时 ${formatMs(initial)}，实际 ${formatMs(elapsedMs)}` +
        `（预估误差 ${deviation > 0 ? '+' : ''}${deviation}%）`
    }
    return {
      reliability: 'unavailable',
      etaMs: null,
      totalEstimateMs: null,
      etaFinishAt: null,
      speedFps: null,
      phaseLabel: null,
      stalled: false,
      note,
      initialTotalMs: initial
    }
  }

  /** 上一次估算结果（用于完成后对比预估误差） */
  get snapshot(): EtaState | null {
    return this.lastState
  }

  get initialEstimateMs(): number | null {
    return this.initialTotalMs
  }

  update(progress: RenderProgress, now?: number): EtaState {
    // 时钟：未显式传入（生产）时用单调时钟，避免系统时间跳变影响速率
    const clock = now ?? monoNow()
    if (this.startedAt == null) this.reset(clock)

    const pct = typeof progress.pct === 'number' && Number.isFinite(progress.pct) ? progress.pct : null
    const rawDone = typeof progress.done === 'number' && Number.isFinite(progress.done) ? progress.done : null
    const rawTotal = typeof progress.total === 'number' && Number.isFinite(progress.total) ? progress.total : null
    // 只有 total 为正数时帧数才有意义
    const total = rawTotal != null && rawTotal > 0 ? rawTotal : null
    const done = total != null && rawDone != null ? Math.max(0, Math.min(rawDone, total)) : null
    const stage = progress.code ?? inferStageCode(progress.label) ?? null

    /* ---------------- 阶段切换检测 ---------------- */
    let phaseNote: string | null = null
    const stageChanged = this.lastStage != null && stage != null && this.lastStage !== stage
    const pctDropped =
      pct != null && this.lastPct != null && pct < this.lastPct - PHASE_RESET_DROP
    if (stageChanged || pctDropped) {
      // 阶段帧速度必然失真 → 直接作废（帧数在阶段之间不可比）；
      // 全局 pct 采样也清空，但保留上一阶段的速率作为种子：
      // 新阶段自己的采样一旦够 5 秒就会经 EMA 接管，既不会因为
      // 「把上一阶段的冻结区间也算进速率」而算出几分钟的假 ETA，
      // 也不会每次换阶段都退回「正在计算」。
      this.frameSamples = []
      this.smoothFrameSpeed = null
      this.lastDone = null
      this.pctSamples = []
      phaseNote = stageChanged
        ? `进入新阶段（${progress.label || stage}），重新估算剩余时间`
        : '检测到进度回退，重新估算剩余时间'
    }
    if (stage != null) this.lastStage = stage
    const frameStage = stage != null && FRAME_STAGES.has(stage)

    /* ---------------- 采样与停滞计时 ---------------- */
    const pctAdvanced = pct != null && (this.lastPct == null || pct !== this.lastPct)
    const frameAdvanced = done != null && (this.lastDone == null || done !== this.lastDone)
    if (pctAdvanced || frameAdvanced) this.lastChangeAt = clock
    if (pct != null) this.lastPct = pct
    if (done != null) this.lastDone = done

    if (pct != null) {
      this.pctSamples.push({ t: clock, pct })
      this.trim(this.pctSamples, clock)
    }
    // 只有真正的帧阶段（捕获 / 编码）才把 done 当帧数采样；
    // 「浏览器就绪 1/2」「封装 3/10 秒」这类计数不是帧，不能用来推帧速度。
    if (done != null && total != null && frameStage) {
      this.frameSamples.push({ t: clock, done })
      this.trim(this.frameSamples, clock)
    }

    /* ---------------- 速率更新（EMA 平滑） ---------------- */
    const pctRate = this.rateOfPct()
    if (pctRate != null) {
      this.smoothPctRate =
        this.smoothPctRate == null ? pctRate : this.smoothPctRate * EMA_KEEP + pctRate * (1 - EMA_KEEP)
    }
    const frameSpeed = frameStage ? this.speedOfFrames() : null
    if (frameSpeed != null) {
      this.smoothFrameSpeed =
        this.smoothFrameSpeed == null
          ? frameSpeed
          : this.smoothFrameSpeed * EMA_KEEP + frameSpeed * (1 - EMA_KEEP)
    }

    const sinceChange = clock - (this.lastChangeAt ?? this.startedAt ?? clock)
    const elapsedMs = clock - (this.startedAt ?? clock)

    /* ---------------- 停滞检测 ---------------- */
    if (sinceChange > STALL_MS) {
      return this.state({
        reliability: 'stalled',
        etaMs: null,
        totalEstimateMs: null,
        etaFinishAt: null,
        speedFps: this.roundSpeed(this.smoothFrameSpeed),
        phaseLabel: progress.label || null,
        stalled: true,
        note:
          phaseNote ??
          `等待渲染进度…（已 ${Math.round(sinceChange / 1000)} 秒没有新进度，可能在等待资源或遇到卡顿）`
      })
    }

    /* ---------------- 已到 100%：不再估算，等待结束确认 ---------------- */
    // 注意：只有「全局进度 100%」才算任务完成。帧数 done===total 只是当前阶段
    // （捕获 / 编码各自的帧数）走完，后面还有编码、封装，不能当成整体完成。
    if (pct != null && pct >= 100) {
      return this.state({
        reliability: 'high',
        etaMs: 0,
        totalEstimateMs: elapsedMs,
        etaFinishAt: new Date(Date.now()).toISOString(),
        speedFps: this.roundSpeed(this.smoothFrameSpeed),
        phaseLabel: progress.label || null,
        stalled: false,
        note: '渲染进度已到 100%，正在收尾'
      })
    }

    /* ---------------- 整体 ETA：全局进度百分比 ---------------- */
    // CLI 的 pct 是跨阶段的全局进度，因此它是「整个任务」剩余时间的唯一正确依据。
    if (pct != null && this.smoothPctRate != null && this.smoothPctRate > 0) {
      const remainingPct = Math.max(0, 100 - pct)
      const rawEtaSec = remainingPct / this.smoothPctRate // % ÷ (%/秒) = 秒
      const etaSec = this.filterEta(rawEtaSec, clock)
      if (this.isSaneEta(etaSec)) {
        return this.state({
          reliability: phaseNote ? 'medium' : this.reliabilityOf(this.pctSamples.length, sinceChange),
          etaMs: etaSec * 1000, // 唯一的秒→毫秒换算点
          totalEstimateMs: elapsedMs + etaSec * 1000,
          etaFinishAt: new Date(Date.now() + etaSec * 1000).toISOString(),
          speedFps: this.roundSpeed(this.smoothFrameSpeed),
          phaseLabel: progress.label || null,
          stalled: false,
          note: phaseNote
        })
      }
    }

    /* ---------------- 阶段级 ETA：只有帧数时 ---------------- */
    // 拿不到全局速率时，只用当前阶段的帧数估「当前阶段还剩多久」，
    // 并在 note 里说清楚这是阶段估算，不冒充整体任务剩余时间。
    if (frameStage && done != null && total != null && done >= total) {
      // 当前阶段帧数走完，但整体进度未知：不返回 0（会误导成「马上完成」）
      return this.state({
        reliability: 'estimating',
        etaMs: null,
        totalEstimateMs: null,
        etaFinishAt: null,
        speedFps: this.roundSpeed(this.smoothFrameSpeed),
        phaseLabel: progress.label || null,
        stalled: false,
        note: phaseNote ?? '当前阶段已完成，等待下一阶段进度…'
      })
    }
    if (
      frameStage &&
      done != null &&
      total != null &&
      this.smoothFrameSpeed != null &&
      this.smoothFrameSpeed > 0
    ) {
      const remainingFrames = Math.max(0, total - done)
      const rawEtaSec = remainingFrames / this.smoothFrameSpeed // 帧 ÷ (帧/秒) = 秒
      const etaSec = this.filterEta(rawEtaSec, clock)
      if (this.isSaneEta(etaSec)) {
        return this.state({
          reliability: 'medium',
          etaMs: etaSec * 1000,
          totalEstimateMs: elapsedMs + etaSec * 1000,
          etaFinishAt: new Date(Date.now() + etaSec * 1000).toISOString(),
          speedFps: this.roundSpeed(this.smoothFrameSpeed),
          phaseLabel: progress.label || null,
          stalled: false,
          note: phaseNote ?? '整体进度尚不可用，这里按当前阶段的帧速度估算'
        })
      }
    }

    /* ---------------- 依据不足 ---------------- */
    return this.state({
      reliability: 'estimating',
      etaMs: null,
      totalEstimateMs: null,
      etaFinishAt: null,
      speedFps: this.roundSpeed(this.smoothFrameSpeed),
      phaseLabel: progress.label || null,
      stalled: false,
      note: phaseNote ?? '正在计算剩余时间…（需要更多进度采样）'
    })
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  /** 保留窗口内的样本（按单调时钟） */
  private trim<T extends { t: number }>(samples: T[], clock: number): void {
    while (samples.length > 0 && clock - samples[0].t > WINDOW_MS) samples.shift()
    while (samples.length > MAX_SAMPLES) samples.shift()
  }

  /** 全局进度速率：窗口首尾两点的平均速率，单位 %/秒 */
  private rateOfPct(): number | null {
    if (this.pctSamples.length < 2) return null
    const first = this.pctSamples[0]
    const last = this.pctSamples[this.pctSamples.length - 1]
    const spanMs = last.t - first.t
    const deltaPct = last.pct - first.pct
    if (spanMs < MIN_SPAN_MS || deltaPct <= 0) return null
    return (deltaPct / spanMs) * 1000 // %/毫秒 → %/秒
  }

  /** 阶段帧速度：窗口首尾两点的平均速度，单位 帧/秒 */
  private speedOfFrames(): number | null {
    if (this.frameSamples.length < 2) return null
    const first = this.frameSamples[0]
    const last = this.frameSamples[this.frameSamples.length - 1]
    const spanMs = last.t - first.t
    const deltaFrames = last.done - first.done
    if (spanMs < MIN_SPAN_MS || deltaFrames <= 0) return null
    return (deltaFrames / spanMs) * 1000 // 帧/毫秒 → 帧/秒
  }

  /**
   * ETA 平滑：允许立即变短（渲染加速时必须马上反映），
   * 但变长受限为「每秒最多 +25%」——避免个别采样点把剩余时间从 30s 跳到 2 分钟。
   * 注意基准取「上一次展示出去的值」，否则连续上调时上限会跟着失控。
   * 长时间没有更新（例如停滞恢复后）时 dt 很大，等价于重新起算。
   * 这是对估算值的平滑，不是把值钉成某个常数。
   */
  private filterEta(etaSec: number, clock: number): number {
    if (!Number.isFinite(etaSec) || etaSec < 0) return etaSec
    const prev = this.lastEtaSec
    const at = this.lastEtaAt
    let shown = etaSec
    if (prev != null && at != null && etaSec > prev) {
      const dtSec = Math.max((clock - at) / 1000, 0.001)
      shown = Math.min(etaSec, prev * Math.pow(1.25, dtSec) + 1)
    }
    this.lastEtaSec = shown
    this.lastEtaAt = clock
    return shown
  }

  private isSaneEta(etaSec: number): boolean {
    return Number.isFinite(etaSec) && etaSec >= 0 && etaSec <= MAX_ETA_SEC
  }

  private roundSpeed(speed: number | null): number | null {
    if (speed == null || !Number.isFinite(speed) || speed <= 0) return null
    return Math.round(speed * 100) / 100
  }

  private reliabilityOf(sampleCount: number, sinceChangeMs: number): 'high' | 'medium' {
    const span =
      this.pctSamples.length > 1
        ? this.pctSamples[this.pctSamples.length - 1].t - this.pctSamples[0].t
        : 0
    if (sampleCount >= HIGH_SAMPLES && span >= HIGH_SPAN_MS && sinceChangeMs < STALL_MS / 2) {
      return 'high'
    }
    return 'medium'
  }

  /** 记录首次稳定估算的总耗时，供完成后计算预估误差 */
  private state(state: EtaState): EtaState {
    // 只把「高可信度」的估算记为基准总耗时：早期样本太少时的估算误差太大，
    // 拿去和实际耗时对比会得出毫无意义的偏差值。
    if (
      this.initialTotalMs == null &&
      state.totalEstimateMs != null &&
      state.etaMs != null &&
      state.reliability === 'high'
    ) {
      this.initialTotalMs = state.totalEstimateMs
    }
    state.initialTotalMs = this.initialTotalMs
    this.lastState = state
    return state
  }
}
