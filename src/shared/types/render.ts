/**
 * 渲染相关类型定义
 * 所有参数均对应 HyperFrames CLI（>=0.8.x）真实的 render 选项
 */

import type { PerformanceMode } from './performance'

export type VideoFormat = 'mp4' | 'webm' | 'mov' | 'gif' | 'png-sequence' | 'hls'

export type QualityPreset = 'draft' | 'looks' | 'standard' | 'high' | 'delivery'

export type ResolutionPreset =
  | 'project'
  | 'landscape'
  | 'portrait'
  | 'landscape-4k'
  | 'portrait-4k'
  | 'square'
  | 'square-4k'

export type FpsMode = 'project' | '24' | '25' | '30' | '60' | 'custom'

export type BrowserGpuMode = 'auto' | 'on' | 'off'

/**
 * 渲染性能相关的高级选项。
 * 统一由性能引擎按"当前 CLI 是否支持"决定是否真正传给命令行，
 * 不支持时会被忽略并在日志中说明，不会导致渲染失败。
 */
export interface RenderExtraOptions {
  /** --experimental-fast-capture / =false */
  fastCapture: 'auto' | 'on' | 'off'
  /** --page-side-compositing / --no-page-side-compositing */
  pageSideCompositing: boolean
  /** --low-memory-mode / --no-low-memory-mode */
  lowMemoryMode: 'auto' | 'on' | 'off'
  /** --browser-timeout（秒） */
  browserTimeoutSec: number | null
  /** --player-ready-timeout（毫秒） */
  playerReadyTimeoutMs: number | null
}

export const DEFAULT_EXTRA_OPTIONS: RenderExtraOptions = {
  fastCapture: 'auto',
  pageSideCompositing: true,
  lowMemoryMode: 'auto',
  browserTimeoutSec: null,
  playerReadyTimeoutMs: null
}

/** 渲染参数（不含项目路径与输出位置的部分，可保存为预设） */
export interface RenderSettings {
  format: VideoFormat
  fpsMode: FpsMode
  customFps: string
  quality: QualityPreset
  resolution: ResolutionPreset
  /** 高级参数 */
  docker: boolean
  gpu: boolean
  browserGpu: BrowserGpuMode
  workers: number | 'auto'
  crf: number | null
  videoBitrate: string
  strict: boolean
  gifLoop: number
  hlsSegmentSeconds: number
  /** 性能引擎写入的高级选项；缺省视为 AUTO_EXTRA */
  extra?: RenderExtraOptions
}

/**
 * 项目元信息（来自 `hyperframes info` 的项目检测）。
 * 只用于主进程在渲染前估算资源占用（帧数 / 临时磁盘空间），不会传给命令行。
 */
export interface ProjectMeta {
  width?: number | null
  height?: number | null
  durationSec?: number | null
  fps?: number | null
}

/** 一次完整的渲染请求 */
export interface RenderRequest extends RenderSettings {
  projectPath: string
  /** 相对项目根目录的 composition；空字符串表示使用 index.html */
  composition: string
  outputDir: string
  /** 文件名主体（不含扩展名） */
  outputName: string
  /** 可选：项目原始宽高 / 时长 / 帧率，供主进程预估帧数与临时空间占用 */
  projectMeta?: ProjectMeta
  /**
   * 额外环境变量（仅用于经实测验证的性能开关，例如并行流捕获）。
   * 只允许性能引擎已知的白名单键，渲染进程不会透传任意环境变量。
   */
  env?: Record<string, string>
}

export type RenderStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface RenderProgress {
  /** 可解析到的真实进度百分比；无法解析时为 null */
  pct: number | null
  code?: string
  label: string
  done?: number
  total?: number
}

/** ETA 估算可靠度 */
export type EtaReliability =
  | 'high' // 有足够连续采样且速度稳定
  | 'medium' // 有进度数据，但速度波动较大
  | 'estimating' // 样本不足或仍在初始化
  | 'stalled' // 进度停滞（不能把剩余时间显示为零）
  | 'unavailable' // 没有可靠进度依据

/** 动态剩余时间估算状态（全部来自真实渲染输出，无估算依据时为 null） */
export interface EtaState {
  reliability: EtaReliability
  /** 预计剩余时间（毫秒）；不可估算为 null */
  etaMs: number | null
  /** 预计总耗时（毫秒） */
  totalEstimateMs: number | null
  /** 预计完成时刻（ISO 字符串） */
  etaFinishAt: string | null
  /** 当前实际渲染速度（帧/秒）；无帧数依据为 null */
  speedFps: number | null
  /** 当前阶段的人读名称 */
  phaseLabel: string | null
  /** 进度是否停滞 */
  stalled: boolean
  /** 补充说明（阶段切换 / 停滞原因等） */
  note: string | null
  /** 首次形成稳定估算时的预计总耗时（完成后用于对比预估误差） */
  initialTotalMs?: number | null
}

export type LogStream = 'stdout' | 'stderr' | 'system'
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug'

export interface RenderLogLine {
  id: number
  ts: string
  stream: LogStream
  level: LogLevel
  text: string
}

export interface RenderStats {
  outputPath?: string
  sizeText?: string
  durationText?: string
  elapsedText?: string
  summary?: string
}

/* ------------------------------------------------------------------ */
/* 任务配置快照（渲染状态 UI / 日志 / 历史记录唯一数据源）                    */
/* ------------------------------------------------------------------ */

/** 性能配置来源：智能模式自动优化 / 固定预设 */
export type PerformanceConfigSource = 'smart-auto' | 'fixed-preset'

/** 捕获路径（与性能引擎的 CapturePath 同构，避免跨层依赖） */
export type TaskCaptureMode = 'default' | 'fast-capture' | 'parallel-stream'

/** 编码器证据来源：运行时进程 / 产出文件探测 / 尚未确认 */
export type EncoderEvidenceSource = 'none' | 'process' | 'ffprobe'

export interface RenderTaskResolutionInfo {
  preset: ResolutionPreset
  /** 生效宽度；项目原始尺寸且未知时为 null */
  width: number | null
  height: number | null
  /** 人读标签，例如「4K」「1080p」「项目尺寸 1920×1080」 */
  label: string
  /** 是否已被产出文件（ffprobe）证实 */
  confirmed: boolean
}

export interface RenderTaskFpsInfo {
  mode: FpsMode
  /** 生效帧率；无法确定时为 null */
  value: number | null
  label: string
  confirmed: boolean
}

/** 实际视频编码器（绝不把"请求的编码器"当成"已启动的编码器"） */
export interface RenderTaskEncoderInfo {
  /** ffmpeg 真实的 `-c:v` 值，例如 h264_nvenc / libx264；未确认时为 null */
  id: string | null
  /** 人读名称，例如「NVENC H.264」「x264（CPU）」 */
  label: string
  /** 是否硬件编码；未确认时为 null */
  hardware: boolean | null
  source: EncoderEvidenceSource
  confirmedAt: string | null
}

/** 本次任务真正生效的性能相关配置 */
export interface EffectivePerformanceConfig {
  workers: number | 'auto'
  /** 实际下发了 --gpu（受格式 / Docker 能力限制后） */
  gpuEncodingEnabled: boolean
  browserGpuMode: BrowserGpuMode
  /** 浏览器 GPU 合成是否真的开启；auto 且尚无运行时证据时为 null */
  browserGpuEnabled: boolean | null
  captureMode: TaskCaptureMode
  pageSideCompositing: boolean
  lowMemoryMode: 'auto' | 'on' | 'off'
  source: PerformanceConfigSource
  /** 运行时回退记录（worker 降载 / GPU 编码回退 / 捕获路径回退…） */
  fallbacks: string[]
}

/**
 * 一次渲染任务的配置快照。
 *
 * 启动时冻结：用户之后切换性能模式或改参数，都不会影响这份快照，
 * 因此界面、日志、历史记录看到的一定是「这个任务真正用了什么」。
 */
export interface RenderTaskConfigSnapshot {
  version: 1
  taskId: string
  createdAt: string
  selectedPerformanceMode: PerformanceMode
  effectivePerformanceConfig: EffectivePerformanceConfig
  resolution: RenderTaskResolutionInfo
  fps: RenderTaskFpsInfo
  format: VideoFormat
  quality: QualityPreset
  encoder: RenderTaskEncoderInfo
  workers: number | 'auto'
  gpuEncodingEnabled: boolean
  browserGpuEnabled: boolean | null
  captureMode: TaskCaptureMode
  /** 实际下发到 CLI 的参数（用于核对「界面显示 = 真实命令」） */
  cliArgs: string[]
  /** 是否发生过自动重试（回退后重新拉起） */
  attempt: number
}

export interface RenderTaskState {
  id: string
  status: RenderStatus
  request: RenderRequest | null
  /** 用于展示的完整命令行 */
  command: string
  progress: RenderProgress
  startedAt?: string
  endedAt?: string
  /** 结束时间 - 开始时间（毫秒） */
  elapsedMs?: number
  stats: RenderStats
  error?: string
  /** 输出文件或目录是否存在 */
  outputExists?: boolean
  /** 动态 ETA 估算状态（只在渲染中有效，结束后为 null） */
  eta?: EtaState | null
  /** 本次任务的配置快照（启动时冻结，运行中只更新"实际证据"） */
  config?: RenderTaskConfigSnapshot
}

export type RenderEvent =
  | { type: 'task'; task: RenderTaskState }
  | { type: 'logs'; lines: RenderLogLine[] }

/** 历史渲染记录（保存本次任务真正使用的配置，供「历史渲染记录」查看） */
export interface RenderHistoryEntry {
  taskId: string
  status: RenderStatus
  startedAt: string
  finishedAt: string
  elapsedMs: number | null
  /** 任务配置快照（与渲染状态区、日志同一份数据） */
  config: RenderTaskConfigSnapshot
  outputPath: string | null
  sizeText: string | null
  error: string | null
}

export interface RenderStartResult {
  ok: boolean
  task?: RenderTaskState
  error?: string
}

export interface StoppedResult {
  ok: boolean
  error?: string
}
