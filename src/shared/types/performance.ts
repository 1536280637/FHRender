/**
 * 性能优化系统类型：能力矩阵、负载档案、推荐配置、Benchmark、监控
 */

import type {
  BrowserGpuMode,
  QualityPreset,
  RenderExtraOptions,
  RenderSettings,
  ResolutionPreset,
  VideoFormat
} from './render'
import type { MetadataSource } from './project'

/* ------------------------------------------------------------------ */
/* 性能模式                                                             */
/* ------------------------------------------------------------------ */

export type PerformanceMode = 'smart' | 'balanced' | 'performance' | 'extreme'

export const PERFORMANCE_MODES: { value: PerformanceMode; label: string; desc: string }[] = [
  { value: 'smart', label: '智能', desc: '识别硬件与项目，优先复用历史最优结果，不重复测试' },
  { value: 'balanced', label: '平衡', desc: '速度与系统占用平衡，保留足够余量给其他程序' },
  { value: 'performance', label: '性能', desc: '优先有效 GPU 加速与更快的捕获路径' },
  { value: 'extreme', label: '极限', desc: '实测对比多种配置，选当前机器最快且稳定的组合' }
]

/* ------------------------------------------------------------------ */
/* 能力矩阵                                                             */
/* ------------------------------------------------------------------ */

export type EncoderFamily = 'nvidia' | 'amd' | 'intel' | 'apple' | 'vaapi' | 'software' | 'other'

export type EncoderCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'gif' | 'prores' | 'other'

export interface EncoderCapability {
  /** 对应的 ffmpeg 编码器名，例如 h264_nvenc */
  id: string
  label: string
  family: EncoderFamily
  codec: EncoderCodec
  /** 是否出现在当前 ffmpeg 的 -encoders 列表中 */
  compiled: boolean
  /** 是否做过真实试编码 */
  tested: boolean
  /** 真实试编码是否成功（未测试为 false，需结合 tested 判断） */
  working: boolean
  /** 该编码器可用于哪些输出格式 */
  formats: VideoFormat[]
  /** 失败原因（ffmpeg 原始错误的精简版） */
  reason?: string
  /** 试编码耗时 */
  latencyMs?: number
}

export interface CpuCapability {
  physicalCores: number | null
  logicalCores: number
  /** 可安全驱动的渲染 worker 上限（考虑内存与核心） */
  safeWorkerCeiling: number
  features: string[]
  /** 是否疑似存在功耗/温度限制（无法判断时为 null） */
  throttled: boolean | null
  note: string
}

export interface BrowserGpuProbe {
  /** 是否做过探测 */
  probed: boolean
  /** Chrome/Electron 是否在用硬件 GPU 合成 */
  hardwareCompositing: boolean | null
  webgl: boolean | null
  webgl2: boolean | null
  /** 是否退回软件渲染（SwiftShader） */
  softwareOnly: boolean
  /** 当前实际使用的 GPU 名称（来自 getGPUInfo） */
  activeGpuName: string | null
  activeVendorId: number | null
  activeDeviceId: number | null
  driverVersion: string | null
  /** h264 / vp9 等硬件解码能力（来自 featureStatus） */
  hardwareVideoDecode: boolean | null
  reason?: string
}

export interface FfmpegInfo {
  found: boolean
  path: string | null
  version: string | null
  /** 是否支持某个编码器 */
  encodersProbedAt?: string
}

export interface CapabilityReport {
  scannedAt: string
  cpu: CpuCapability
  encoders: EncoderCapability[]
  browserGpu: BrowserGpuProbe
  ffmpeg: FfmpegInfo
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* CLI 版本与能力适配                                                    */
/* ------------------------------------------------------------------ */

export interface CliOptionInfo {
  flag: string
  takesValue: boolean
  description?: string
}

export interface CliFeatureMatrix {
  gpuEncode: boolean
  browserGpu: boolean
  fastCapture: boolean
  pageSideCompositing: boolean
  lowMemoryMode: boolean
  strictAll: boolean
  hdr: boolean
  segmented: boolean
  maxConcurrentRenders: boolean
  browserTimeout: boolean
  framesCacheDir: boolean
}

export interface CliCapabilities {
  probedAt: string
  command: string
  version: string | null
  render: {
    ok: boolean
    options: CliOptionInfo[]
    /** 规范化后的 flag 集合（含短选项） */
    flags: string[]
    error?: string
    probedMs?: number
  }
  benchmark: {
    available: boolean
    options: CliOptionInfo[]
    flags: string[]
    error?: string
  }
  worker: {
    supportsAuto: boolean
    min: number
    /** 当前 CLI 明确给出的上限；未给出时为 null（由本应用按硬件推导） */
    max: number | null
    source: 'help' | 'derived'
  }
  features: CliFeatureMatrix
}

/* ------------------------------------------------------------------ */
/* 项目负载                                                             */
/* ------------------------------------------------------------------ */

export type WorkloadClass = 'light' | 'normal' | 'multi-asset' | 'high' | '4k-heavy' | 'unknown'

export const WORKLOAD_LABELS: Record<WorkloadClass, string> = {
  light: '轻量负载',
  normal: '普通负载',
  'multi-asset': '较高负载',
  high: '高复杂度负载',
  '4k-heavy': '高复杂度负载（4K）',
  unknown: '负载未知'
}

/** 负载得分的构成项（界面用于解释「为什么是这个等级」，不是黑箱数字） */
export interface WorkloadScorePart {
  key: string
  label: string
  points: number
  detail: string
}

export interface WorkloadProfile {
  projectPath: string
  projectName: string
  width: number | null
  height: number | null
  /** 项目原始 FPS（根元素 data-fps）；未声明时为 null，绝不填默认值 */
  fps: number | null
  /** 本次导出使用的 FPS；用于计算总帧数 */
  exportFps: number | null
  /** 项目时长（秒）；无法可靠确定时为 null */
  durationSec: number | null
  /** 预计总帧数：仅当 durationSec 与 exportFps 都真实可用时计算 */
  frameCount: number | null
  frameCountSource: MetadataSource
  /** 时长 / FPS 的数据来源，界面需据此说明「待检测」 */
  durationSource: MetadataSource
  fpsSource: MetadataSource
  /** 当前 CLI 未声明 data-fps 时的默认帧率 */
  cliDefaultFps: number | null
  resolutionLabel: string
  imageCount: number
  videoCount: number
  assetBytes: number
  largestAssetBytes: number
  webgl: boolean
  canvasCount: number
  /** 仅在能可靠分析时给出 */
  domElements: number | null
  animationHints: string[]
  /** info --json 返回的元素 / 轨道 / 体积 */
  elements: number | null
  tracks: number | null
  projectBytes: number | null
  compositionId: string | null
  complexity: WorkloadClass
  /** 0-100，越大越吃性能；旧字段保留给优化器使用 */
  score: number
  confidence: 'high' | 'medium' | 'low'
  /** 无法识别的维度（界面显示为「未知」而不是编造值） */
  unknownFields: string[]
  scoreBreakdown: WorkloadScorePart[]
  notes: string[]
  analyzedAt: string
  /** 是否直接来自缓存 */
  fromCache?: boolean
}

/* ------------------------------------------------------------------ */
/* 档案                                                                 */
/* ------------------------------------------------------------------ */

export interface HardwareProfileEncoder {
  id: string
  family: EncoderFamily
  working: boolean
}

export interface HardwareProfile {
  /** 与 fingerprint 一致 */
  id: string
  /** 展示名，例如 "Ryzen 7 5800H · RTX 3060 Laptop" */
  name: string
  fingerprint: string
  cpuModel: string
  cpuCores: string
  gpuNames: string[]
  memoryGb: number
  os: string
  arch: string
  driverVersions: Record<string, string>
  encoders: HardwareProfileEncoder[]
  cliVersion: string | null
  firstSeenAt: string
  lastSeenAt: string
  /** 是否为内置参考档案（仅本机开发验证用，不会自动应用到其他设备） */
  reference: boolean
  referenceId?: string
}

export type CapturePath = 'default' | 'fast-capture' | 'parallel-stream'

export interface RenderProfile {
  id: string
  hardwareFingerprint: string
  /** 设备级（''）或项目级（项目绝对路径） */
  scope: 'device' | 'project'
  projectPath: string
  projectName: string
  format: VideoFormat
  resolution: ResolutionPreset
  fpsLabel: string
  quality: QualityPreset
  workers: number | 'auto'
  browserGpu: BrowserGpuMode
  gpuEncode: boolean
  encoderId: string | null
  capturePath: CapturePath
  pageSideCompositing: boolean
  benchmarkMs: number | null
  resourcePeak: {
    cpuPct: number | null
    memoryBytes: number | null
    vramBytes: number | null
    gpuPct: number | null
  }
  testedAt: string
  cliVersion: string | null
  notes: string[]
}

/* ------------------------------------------------------------------ */
/* 推荐配置                                                             */
/* ------------------------------------------------------------------ */

export type RecommendationSource = 'benchmark' | 'history' | 'heuristic'

export interface RecommendationReason {
  key: string
  label: string
  value: string
  reason: string
  confidence: 'high' | 'medium' | 'low'
  source: RecommendationSource
}

/** 界面上的高级性能选项（与 RenderSettings.extra 对应） */
export type { RenderExtraOptions }

export interface OptimizationRecommendation {
  id: string
  mode: PerformanceMode
  createdAt: string
  projectPath: string
  workerCandidates: (number | 'auto')[]
  chosen: {
    workers: number | 'auto'
    gpuEncode: boolean
    encoderId: string | null
    encoderLabel: string | null
    browserGpu: BrowserGpuMode
    capturePath: CapturePath
    extra: RenderExtraOptions
  }
  reasons: RecommendationReason[]
  warnings: string[]
  basedOn: RecommendationSource
  sampleCount: number
  expectedMs: number | null
  /** 可直接合并到 RenderSettings 的补丁 */
  settingsPatch: Partial<RenderSettings>
}

/* ------------------------------------------------------------------ */
/* Benchmark                                                            */
/* ------------------------------------------------------------------ */

export type BenchmarkStatus = 'idle' | 'running' | 'done' | 'failed' | 'canceled'

export interface BenchmarkCandidate {
  id: string
  label: string
  /** 候选对应的性能模式（四模式对比测试时必填，矩阵测试可省略） */
  mode?: PerformanceMode
  workers: number | 'auto'
  gpuEncode: boolean
  encoderId: string | null
  browserGpu: BrowserGpuMode
  capturePath: CapturePath
  pageSideCompositing: boolean
  env?: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* 性能对比诊断（失败阶段 / 错误类型 / 原始错误 + 日志位置）                 */
/* ------------------------------------------------------------------ */

/** 失败发生阶段：用于界面精确定位，不再笼统显示「测试失败」 */
export type ComparisonStage =
  | 'environment' // 环境检查（CLI / Node / 平台）
  | 'project' // 项目检查（目录 / index.html）
  | 'args' // 参数构建与 CLI 兼容性校验
  | 'spawn' // 子进程启动
  | 'render' // 视频渲染（CLI 进程本身）
  | 'file' // 输出文件验证
  | 'parse' // 结果解析
  | 'none' // 没有失败

/** 错误类型分类（依据真实原始输出判定，不做猜测） */
export type ComparisonErrorType =
  | 'command-not-found'
  | 'unsupported-arg'
  | 'invalid-project'
  | 'file-write'
  | 'chrome'
  | 'ffmpeg'
  | 'out-of-memory'
  | 'timeout'
  | 'unknown'
  | 'none'

export interface ComparisonFailure {
  stage: ComparisonStage
  errorType: ComparisonErrorType
  /** 真实错误文本（CLI 原始输出，未做翻译或截断到不可用） */
  detail: string
  /**
   * 从原始输出里摘出的关键错误行（含上下文），用于界面和单行状态显示。
   * detail 往往有几千行进度日志，直接展示首行会误导，所以额外给出这一份摘要；
   * detail 仍然是完整原文，两者都保留。
   */
  highlight?: string
  /** 依据错误类型给出的处理建议（不替代原始错误） */
  hint: string
}

/** ffprobe 对产出文件的真实校验结果 */
export interface OutputProbeResult {
  available: boolean
  ok: boolean
  /** 视频时长（秒） */
  durationSec: number | null
  width: number | null
  height: number | null
  /** 解析出的平均帧率 */
  fps: number | null
  videoCodec: string | null
  /** ffprobe 原始报错（不可用时为空） */
  error: string | null
}

/** 产出文件验证结果（存在 / 大小 / 是否仍在写入 / ffprobe） */
export interface OutputFileCheck {
  exists: boolean
  bytes: number | null
  /** 两次采样大小一致，说明已停止写入 */
  writeSettled: boolean
  /** 采样期间仍在增大 */
  stillGrowing: boolean
  probe: OutputProbeResult | null
  /** 未通过的检查项（人读） */
  problems: string[]
}

/** 单次测试运行的完整诊断记录（同时写入日志文件） */
export interface ComparisonRunDiagnostics {
  testId: string
  mode: PerformanceMode | null
  label: string
  /** 项目绝对路径 */
  projectPath: string
  stage: ComparisonStage
  errorType: ComparisonErrorType
  failure: ComparisonFailure | null
  /** 该次运行的真实结果（ok / failed / canceled）；旧日志可能没有 */
  runStatus?: 'ok' | 'failed' | 'canceled'
  logDir: string
  logFile: string
  /** 面向用户的逻辑命令 */
  command: string
  /** 实际执行的可执行文件与参数（排查 Windows 启动问题用） */
  execFile: string
  execArgs: string[]
  cwd: string
  pid: number | null
  startedAt: string
  endedAt: string
  /** 该次运行的真实耗时（进程启动 → 结束含产出验证，单位毫秒） */
  durationMs: number
  exitCode: number | null
  signal: string | null
  /** 子进程 'error' 事件的原始内容（没有则为 null） */
  spawnError: string | null
  outputPath: string
  outputBytes: number | null
  fileCheck: OutputFileCheck | null
  stdoutTail: string
  stderrTail: string
}

/** 基础渲染冒烟预检结果 */
export interface SmokeTestResult {
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
  startedAt?: string
  endedAt?: string
  durationMs: number | null
  command: string
  outputPath: string | null
  outputBytes: number | null
  failure: ComparisonFailure | null
  logFile: string | null
}

/** 一次对比测试的日志上下文 */
export interface ComparisonLogContext {
  testId: string
  logDir: string
  logFile: string
  smoke: SmokeTestResult | null
  /** 会话级别的失败（冒烟预检失败 / 环境检查失败等），无失败为 null */
  lastFailure?: ComparisonFailure | null
}

export interface BenchmarkRunResult {
  candidateId: string
  label: string
  status: 'ok' | 'failed' | 'skipped'
  durationMs: number
  sizeBytes: number | null
  /** 本次运行的诊断信息（失败阶段 / 错误类型 / 日志路径），旧档案可能没有 */
  diagnostics?: ComparisonRunDiagnostics
  peak: {
    cpuPct: number | null
    memoryBytes: number | null
    vramBytes: number | null
    /** GPU 3D 利用率峰值（非 Video Encode，两者不能混用） */
    gpuPct: number | null
    /** GPU Video Encode 利用率峰值（拿不到为 null，界面显示 N/A） */
    videoEncodePct?: number | null
  }
  /** CPU 平均使用率（全部有效采样的均值；拿不到为 null） */
  avgCpuPct?: number | null
  outputPath?: string
  error?: string
}

export interface BenchmarkSessionState {
  id: string
  status: BenchmarkStatus
  /** matrix：单模式候选矩阵；comparison：四模式对比测试 */
  kind: 'matrix' | 'comparison'
  /** 对比测试规模（kind === 'comparison' 时有效） */
  comparisonKind?: 'quick' | 'precise'
  projectPath: string
  format: VideoFormat
  quality: QualityPreset
  resolution: ResolutionPreset
  fpsLabel: string
  candidates: BenchmarkCandidate[]
  results: BenchmarkRunResult[]
  currentIndex: number
  startedAt?: string
  endedAt?: string
  estimatedMinutes: number
  official: {
    ran: boolean
    ok: boolean
    results: { name: string; seconds: number; sizeBytes: number | null }[]
    error?: string
  }
  error?: string
  recommendation?: OptimizationRecommendation
  /** 四种模式对比测试的日志上下文与冒烟预检结果 */
  comparison?: ComparisonLogContext
  /** 实时进度（对比测试期间逐步更新；结束后保留最后状态） */
  progress?: ComparisonProgress
  /** 本次测试结束后的临时文件清理结果（成功 / 失败 / 取消都会产生） */
  cleanup?: import('./cleanup').TestCleanupSummary
}

export interface BenchmarkLogLine {
  ts: string
  text: string
  level: 'info' | 'warn' | 'error' | 'success'
}

/* ------------------------------------------------------------------ */
/* 测试进度（对比测试期间的状态，不是伪装出来的百分比）                       */
/* ------------------------------------------------------------------ */

export type ComparisonPhase = 'idle' | 'environment' | 'smoke' | 'warmup' | 'render' | 'verify' | 'summarize'

export type ComparisonModeStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'

/**
 * 对比测试的实时进度。
 *
 * 关键点：`pct` 只在当前子任务真的能从 CLI 输出里解析到百分比时才非 null。
 * 四个测试项本身的推进（第 2/4 项）是「任务进度」，不能当成视频渲染百分比展示。
 */
export interface ComparisonProgress {
  /** 当前正在测的模式 */
  mode: PerformanceMode | null
  /** 当前模式中文名（主进程给，界面直接用，避免两边各写一份） */
  label: string
  /** 第几项 / 共几项（1-based；冒烟预检也算一项时由 total 体现） */
  itemIndex: number
  itemTotal: number
  phase: ComparisonPhase
  /** 当前模式的第几次运行 */
  runIndex: number
  runTotal: number
  /** 当前子任务真实渲染百分比（CLI 给出时才非 null） */
  pct: number | null
  /** CLI 自己的进度描述，例如 "Capturing frame 76/112" */
  pctLabel: string | null
  /** 逐模式状态：某项失败不会影响其他项的结果 */
  modeStatus: Record<PerformanceMode, ComparisonModeStatus>
  updatedAt: string
}

export const PHASE_LABELS: Record<ComparisonPhase, string> = {
  idle: '待开始',
  environment: '环境检查',
  smoke: '基础渲染预检',
  warmup: '预热',
  render: '正在渲染',
  verify: '正在验证产出',
  summarize: '汇总结果'
}

/** 测试计划预览：开始前展示任务数量与预计耗时 */
export interface BenchmarkPlan {
  candidates: BenchmarkCandidate[]
  workerCandidates: (number | 'auto')[]
  totalRuns: number
  estimatedMinutes: number
  notes: string[]
}

export interface BenchmarkStartInput {
  mode: PerformanceMode
  projectPath: string
  settings: RenderSettings
  runsPerCandidate?: number
  includeOfficial?: boolean
  officialRuns?: number
  allowExperimental?: boolean
  confirmBest?: boolean
}

export type BenchmarkEvent =
  | { type: 'state'; state: BenchmarkSessionState }
  | { type: 'log'; line: BenchmarkLogLine }

/* ------------------------------------------------------------------ */
/* 实时监控                                                             */
/* ------------------------------------------------------------------ */

export interface ResourceSample {
  ts: string
  cpuPct: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  renderProcessBytes: number | null
  chromeProcessBytes: number | null
  gpu3dPct: number | null
  videoEncodePct: number | null
  videoDecodePct: number | null
  vramUsedBytes: number | null
  gpuTempC: number | null
  gpuPowerW: number | null
  /** 采样时读到的进度帧数 */
  frameDone: number | null
  frameTotal: number | null
  workerCount: number | null
}

export type PressureLevel = 'ok' | 'warn' | 'critical' | 'unknown'

export interface ResourcePressure {
  memory: PressureLevel
  vram: PressureLevel
  disk: PressureLevel
  note?: string
}

export interface MonitorState {
  active: boolean
  intervalMs: number
  latest: ResourceSample | null
  samples: ResourceSample[]
  pressure: ResourcePressure
  /** 监控不可用的指标及原因 */
  unavailable: string[]
}

/* ------------------------------------------------------------------ */
/* 故障回退                                                             */
/* ------------------------------------------------------------------ */

export interface FallbackEvent {
  ts: string
  scope: string
  from: string
  to: string
  reason: string
}

/* ------------------------------------------------------------------ */
/* 性能面板整体状态                                                     */
/* ------------------------------------------------------------------ */

export interface PerformanceSnapshot {
  hardware: import('./hardware').HardwareReport
  capabilities: CapabilityReport
  cli: CliCapabilities
  workload: WorkloadProfile | null
  hardwareProfile: HardwareProfile | null
  profiles: RenderProfile[]
  recommendation: OptimizationRecommendation | null
  monitor: MonitorState
  fallbacks: FallbackEvent[]
  benchmark: BenchmarkSessionState
  /* ---------------- 以下为性能中心扩展字段 ---------------- */
  /** 四种模式的预设解析结果（固定三模式 + 智能模式当前推荐） */
  modePresets: ResolvedModePreset[]
  /** 智能模式优化档案状态 */
  smartArchive: SmartArchiveStatus
  /** 历史性能报告（最新在前，最多 20 条） */
  reports: PerformanceReport[]
  /** 与当前设备 + 项目 + 导出参数匹配的最新对比报告（无匹配为 null） */
  currentReport: PerformanceReport | null
  /** 缓存状态（硬件 / 环境 / 当前项目），供「缓存与检测」面板展示 */
  cache: import('./cache').CacheOverview
  /** 性能测试临时文件占用（performance-tests 下各任务的体积） */
  testStorage: import('./cleanup').TestStorageUsage
}

/* ------------------------------------------------------------------ */
/* 固定模式静态预设（平衡 / 性能 / 极限）                                   */
/* ------------------------------------------------------------------ */

/** 硬件能力等级（由 CPU 核心 / 内存 / GPU 显存综合评定） */
export type HardwareTier = 'entry' | 'mainstream' | 'high-end' | 'workstation'

export const HARDWARE_TIER_LABELS: Record<HardwareTier, string> = {
  entry: '入门设备',
  mainstream: '主流设备',
  'high-end': '高性能设备',
  workstation: '专业工作站'
}

/**
 * 固定模式的静态预设规格。
 * 全部由开发者在开发阶段预先定义并测试，运行期只做「等级匹配 + 兼容性回退」，
 * 不会被 Benchmark 结果或用户操作修改。
 */
export interface ModePresetSpec {
  mode: Exclude<PerformanceMode, 'smart'>
  tier: HardwareTier
  /** 预定义 worker 数（不是动态计算值） */
  workers: number
  /** prefer = 有可用硬件编码器就开；off = 始终软件编码 */
  gpuEncode: 'prefer' | 'off'
  browserGpu: BrowserGpuMode
  capturePath: CapturePath
  /** 内存紧张时是否自动启用 CLI 低内存保护 */
  lowMemoryGuard: boolean
  notes: string[]
}

/** 静态预设经过兼容性检查后的最终参数（真实下发给渲染的内容） */
export interface ResolvedModePreset {
  mode: PerformanceMode
  tier: HardwareTier
  /** 固定模式为预定义档位值；智能模式可能是 CLI auto 校准 */
  workers: number | 'auto'
  gpuEncode: boolean
  encoderId: string | null
  encoderLabel: string | null
  browserGpu: BrowserGpuMode
  capturePath: CapturePath
  lowMemoryMode: 'auto' | 'on'
  /** 极限模式下是否启用了实验性开关（由用户设置决定，预设本身不含实验参数） */
  allowExperimental: boolean
  /** 兼容性回退记录：哪些预设意图因硬件 / CLI 不支持而调整 */
  fallbacks: string[]
  notes: string[]
}

/* ------------------------------------------------------------------ */
/* 智能模式优化档案                                                      */
/* ------------------------------------------------------------------ */

/**
 * 智能模式的优化档案：一次完整 Benchmark + 优化后的持久化结果。
 * 智能模式优先复用档案，只在档案失效（硬件 / 驱动 / CLI 版本 / 项目 / 输出参数变化）
 * 或用户主动重新优化时才重新测试。
 */
export interface OptimizationArchive {
  id: string
  /** 硬件指纹（含驱动版本，硬件或驱动变化会改变） */
  hardwareFingerprint: string
  projectPath: string
  format: VideoFormat
  resolution: ResolutionPreset
  fpsLabel: string
  quality: QualityPreset
  /** 生成档案时的 CLI 版本；版本变化即失效 */
  cliVersion: string | null
  recommendation: OptimizationRecommendation
  /** 生成档案时的有效测试次数 */
  runCount: number
  testedAt: string
}

/** 智能模式优化档案的状态描述 */
export interface SmartArchiveStatus {
  /** 是否存在针对当前条件的档案 */
  exists: boolean
  /** 档案是否仍然有效（硬件 / 驱动 / CLI / 项目 / 输出参数均未变化） */
  valid: boolean
  testedAt: string | null
  /** 有效性判定的人读说明 */
  reason: string
}

/* ------------------------------------------------------------------ */
/* 性能报告（四模式对比测试的持久化结果）                                   */
/* ------------------------------------------------------------------ */

export interface PerformanceReportEntry {
  mode: PerformanceMode
  label: string
  status: 'ok' | 'failed'
  workers: number | 'auto'
  gpuEncode: boolean
  encoderId: string | null
  encoderLabel: string | null
  capturePath: CapturePath
  /** 每次有效测试的耗时（毫秒），按时间顺序 */
  runs: number[]
  /** 多次测试的中位数（唯一比较依据） */
  medianMs: number | null
  bestMs: number | null
  /** 平均渲染吞吐（输出字节 / 秒），拿不到为 null */
  avgSpeedBytesPerSec: number | null
  peak: {
    cpuPct: number | null
    memoryBytes: number | null
    vramBytes: number | null
    gpuPct: number | null
    videoEncodePct: number | null
  }
  avgCpuPct: number | null
  error?: string
}

export interface PerformanceReport {
  id: string
  createdAt: string
  kind: 'quick' | 'precise'
  cliVersion: string | null
  device: {
    fingerprint: string
    cpuModel: string
    gpuNames: string[]
    memoryGb: number
    os: string
  }
  project: {
    path: string
    name: string
    format: VideoFormat
    resolution: ResolutionPreset
    fpsLabel: string
    quality: QualityPreset
  }
  entries: PerformanceReportEntry[]
  /** 实测最快的模式（仅在至少两种模式有有效结果时给出） */
  fastestMode: PerformanceMode | null
  fastestMedianMs: number | null
  /** 该模式多次测试的稳定参考耗时（中位数） */
  fastestStableMs: number | null
  /**
   * 耗时缩短率：(平衡耗时 - 当前耗时) / 平衡耗时 × 100%。正数 = 比平衡快。
   * 注意与吞吐提升率含义不同，标签不能混用。
   */
  timeSavedPct: Partial<Record<PerformanceMode, number>>
  /** 渲染吞吐提升率：平衡耗时 / 当前耗时 × 100% - 100%。 */
  throughputGainPct: Partial<Record<PerformanceMode, number>>
  failures: { mode: PerformanceMode; label: string; error: string }[]
}

/** 四模式对比测试的计划预览 */
export interface ModeComparisonPlan {
  modes: PerformanceMode[]
  runsPerMode: number
  /** 预热次数（precise 模式下首个模式前额外跑一次不计成绩） */
  warmupRuns: number
  totalRuns: number
  estimatedMinutes: number
  notes: string[]
  /** 智能模式尚无有效配置时为 true（需先执行智能优化） */
  missingSmartConfig: boolean
}
