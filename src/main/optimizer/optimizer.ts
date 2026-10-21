import { hash32 } from '@shared/types/hardware'
import type { HardwareReport } from '@shared/types/hardware'
import type {
  BenchmarkSessionState,
  CapturePath,
  CapabilityReport,
  CliCapabilities,
  OptimizationRecommendation,
  PerformanceMode,
  RecommendationReason,
  RenderProfile,
  WorkloadProfile
} from '@shared/types/performance'
import { DEFAULT_EXTRA_OPTIONS, type RenderSettings } from '@shared/types/render'
import { FORMAT_CAPABILITIES } from '../process/hyperframes'
import type { HardwareReference } from '../profiles/reference-profiles'
import { decideCapturePath } from './capture-pipeline'
import { generateWorkerCandidates, estimateTestMinutes } from './worker-candidates'
import { presetSettingsPatch, resolveModePreset } from './mode-presets'

export interface OptimizeInput {
  mode: PerformanceMode
  hardware: HardwareReport
  capability: CapabilityReport
  cli: CliCapabilities
  workload: WorkloadProfile | null
  settings: RenderSettings
  history: RenderProfile[]
  benchmark: BenchmarkSessionState | null
  reference: HardwareReference | null
  /** 是否允许为测试开启实验性开关 */
  allowExperimental: boolean
  platformSupport: { parallelStream: boolean; fastCapture: boolean; note: string }
}

const FAMILY_PRIORITY = ['nvidia', 'apple', 'intel', 'amd', 'vaapi', 'other', 'software']

/** 从 benchmark 结果里选取最快且稳定的配置；差距很小则优先更少 worker */
function pickBenchmarkBest(
  benchmark: BenchmarkSessionState | null,
  mode: PerformanceMode
): { candidateId: string; workers: number | 'auto'; ms: number; reason: string } | null {
  if (!benchmark || benchmark.results.length === 0) return null
  const ok = benchmark.results.filter((r) => r.status === 'ok' && r.durationMs > 0)
  if (ok.length === 0) return null
  const sorted = [...ok].sort((a, b) => a.durationMs - b.durationMs)
  const best = sorted[0]
  // 极限模式要的是"真的最快"，容差收紧；其它模式宁可用更少 worker 换余量
  const tolerance = mode === 'extreme' ? 1.03 : 1.08
  const close = sorted.filter((r) => r.durationMs <= best.durationMs * tolerance)
  const resolveWorkers = (id: string): number | 'auto' =>
    benchmark.candidates.find((c) => c.id === id)?.workers ?? 'auto'
  const pick = close
    .map((r) => ({ ...r, workers: resolveWorkers(r.candidateId) }))
    .sort((a, b) => {
      const aw = typeof a.workers === 'number' ? a.workers : 0
      const bw = typeof b.workers === 'number' ? b.workers : 0
      if (aw !== bw) return aw - bw
      return a.durationMs - b.durationMs
    })[0]

  return {
    candidateId: pick.candidateId,
    workers: pick.workers,
    ms: pick.durationMs,
    reason:
      close.length > 1
        ? `实测最快的一组成绩彼此接近（相差 < ${Math.round((tolerance - 1) * 100)}%），按"更少 worker、更多余量"选择了 ${pick.workers}`
        : `实测最快配置：${pick.durationMs}ms`
  }
}

/**
 * 优化决策入口。
 *
 * 平衡 / 性能 / 极限三种固定模式走静态预设（{@link optimizeFixed}）：
 * 不读 Benchmark、不动态计算 worker，只做硬件等级匹配与兼容性回退。
 * 只有智能模式拥有动态计算、历史复用与 Benchmark 结果驱动的能力。
 */
export function optimize(input: OptimizeInput): OptimizationRecommendation {
  if (input.mode !== 'smart') return optimizeFixed(input)
  const cap = FORMAT_CAPABILITIES[input.settings.format] ?? FORMAT_CAPABILITIES.mp4
  const reasons: RecommendationReason[] = []
  const warnings: string[] = []

  const hardwareEncoders = input.capability.encoders
    .filter((e) => e.working && e.family !== 'software' && e.formats.includes(input.settings.format))
    .sort((a, b) => FAMILY_PRIORITY.indexOf(a.family) - FAMILY_PRIORITY.indexOf(b.family))

  const matchedHistory = input.history
    .filter((p) => p.format === input.settings.format)
    .sort((a, b) => (a.benchmarkMs ?? Number.MAX_SAFE_INTEGER) - (b.benchmarkMs ?? Number.MAX_SAFE_INTEGER))[0]

  const benchBest = pickBenchmarkBest(input.benchmark, input.mode)
  const benchmarkMatchesFormat = input.benchmark?.format === input.settings.format

  /* ------------------------- GPU 编码 ------------------------- */
  let gpuEncode = false
  let encoderId: string | null = null
  let encoderLabel: string | null = null

  if (!cap.supportsGpu) {
    reasons.push({
      key: 'gpu',
      label: 'GPU 编码',
      value: '关闭',
      reason: `${cap.label} 固定使用 ${input.settings.format === 'mov' ? 'ProRes 4444' : '软件编码'}，CLI 不支持 GPU 编码`,
      confidence: 'high',
      source: 'heuristic'
    })
  } else if (hardwareEncoders.length === 0) {
    gpuEncode = false
    reasons.push({
      key: 'gpu',
      label: 'GPU 编码',
      value: '关闭',
      reason: '没有任何硬件编码器通过真实试编码，使用 CPU 编码更稳妥',
      confidence: 'high',
      source: 'heuristic'
    })
  } else {
    const best = hardwareEncoders[0]
    encoderId = best.id
    encoderLabel = best.label
    gpuEncode = true
    reasons.push({
      key: 'gpu',
      label: 'GPU 编码',
      value: '开启',
      reason: `${best.label} 已通过真实试编码（${best.latencyMs ?? '?'}ms）`,
      confidence: 'high',
      source: 'benchmark'
    })
    if (benchmarkMatchesFormat) {
      warnings.push('实测成绩对比后如发现 GPU 编码不划算，会按实测调整')
    }
    warnings.push('CLI 只提供 --gpu 开关，无法指定具体编码器；此处显示的是当前格式下最可能被采用的硬件编码器')
  }

  /* ------------------------- 浏览器 GPU ------------------------- */
  let browserGpu: 'auto' | 'on' | 'off' = 'auto'
  const browserProbe = input.capability.browserGpu
  if (browserProbe.probed && browserProbe.softwareOnly) {
    browserGpu = 'auto'
    warnings.push('浏览器当前处于软件渲染（SwiftShader），已保留 auto 让 CLI 自行探测，不强行开启硬件 GPU')
    reasons.push({
      key: 'browserGpu',
      label: 'Browser GPU',
      value: 'auto',
      reason: 'Chromium 报告软件渲染，强制开启可能失败',
      confidence: 'medium',
      source: 'heuristic'
    })
  } else {
    reasons.push({
      key: 'browserGpu',
      label: 'Browser GPU',
      value: 'auto',
      reason: '交给 CLI 首次启动时探测，最安全',
      confidence: 'medium',
      source: 'heuristic'
    })
  }

  /* --------------------------- Workers --------------------------- */
  const workerCandidates = generateWorkerCandidates({
    mode: input.mode,
    cli: input.cli,
    hardware: input.hardware,
    cpu: input.capability.cpu,
    workload: input.workload,
    historyWorkers: matchedHistory?.workers ?? null,
    reference: input.reference
  })

  const ceiling = input.capability.cpu.safeWorkerCeiling
  let workers: number | 'auto'
  let basedOn: OptimizationRecommendation['basedOn'] = 'heuristic'

  if (benchBest && benchmarkMatchesFormat) {
    workers = benchBest.workers
    basedOn = 'benchmark'
    reasons.push({
      key: 'workers',
      label: 'Workers',
      value: String(workers),
      reason: benchBest.reason,
      confidence: 'high',
      source: 'benchmark'
    })
  } else if (input.mode === 'smart' && matchedHistory) {
    workers = matchedHistory.workers
    basedOn = 'history'
    reasons.push({
      key: 'workers',
      label: 'Workers',
      value: String(workers),
      reason: `沿用本机同项目的历史最优配置（${matchedHistory.benchmarkMs ? `${Math.round(matchedHistory.benchmarkMs / 1000)}s` : '已记录'}）`,
      confidence: 'medium',
      source: 'history'
    })
  } else if (input.mode === 'smart') {
    workers = input.cli.worker.supportsAuto ? 'auto' : Math.min(2, ceiling)
    reasons.push({
      key: 'workers',
      label: 'Workers',
      value: String(workers),
      reason: '智能模式首次运行：使用 CLI 官方 auto 校准，避免无依据的猜测',
      confidence: 'medium',
      source: 'heuristic'
    })
  } else {
    // 不可达：固定模式已在 optimizeFixed 处理；保留兜底
    workers = input.cli.worker.supportsAuto ? 'auto' : Math.min(2, ceiling)
    reasons.push({
      key: 'workers',
      label: 'Workers',
      value: String(workers),
      reason: '使用 CLI 官方 auto 校准',
      confidence: 'medium',
      source: 'heuristic'
    })
  }

  if (typeof workers === 'number' && workers > ceiling) {
    warnings.push(`推荐 worker 数超过当前内存/核心可承受上限（${ceiling}），已下调`)
    workers = ceiling
  }

  /* -------------------------- 捕获路径 -------------------------- */
  const capture = decideCapturePath({
    platform: input.hardware.platform,
    cli: input.cli,
    support: input.platformSupport,
    mode: input.mode,
    workload: input.workload,
    workers,
    allowExperimental: input.allowExperimental
  })
  warnings.push(...capture.warnings)
  if (capture.reasons.length > 0) {
    reasons.push({
      key: 'capture',
      label: '捕获路径',
      value: capture.path === 'fast-capture' ? 'fast capture' : capture.path === 'parallel-stream' ? '并行流（实验）' : '默认截图',
      reason: capture.reasons.join('；'),
      confidence: capture.path === 'default' ? 'high' : 'low',
      source: 'heuristic'
    })
  }

  /* --------------------------- 附加项 --------------------------- */
  const totalGb = input.hardware.memory.totalBytes / 1024 ** 3
  const lowMemoryMode: 'auto' | 'on' | 'off' =
    totalGb <= 8 || input.hardware.memory.freeBytes < 1.5 * 1024 ** 3 ? 'on' : 'auto'
  if (lowMemoryMode === 'on') {
    warnings.push('当前可用内存偏低，已启用 CLI 的 --low-memory-mode（固定 1 worker、跳过自动校准）')
    if (typeof workers === 'number' && workers > 1) {
      warnings.push('低内存模式下实际生效的 worker 会被 CLI 压到 1')
    }
  }

  const heavy = input.workload?.complexity === '4k-heavy' || input.workload?.complexity === 'high'
  const browserTimeoutSec = heavy && input.cli.features.browserTimeout ? 120 : null
  const playerReadyTimeoutMs = heavy ? 90_000 : null

  const extra = {
    fastCapture: (capture.path === 'fast-capture' ? 'on' : 'auto') as 'auto' | 'on' | 'off',
    pageSideCompositing: input.cli.features.pageSideCompositing
      ? DEFAULT_EXTRA_OPTIONS.pageSideCompositing
      : DEFAULT_EXTRA_OPTIONS.pageSideCompositing,
    lowMemoryMode,
    browserTimeoutSec,
    playerReadyTimeoutMs
  }

  if (browserTimeoutSec) {
    reasons.push({
      key: 'timeout',
      label: '浏览器超时',
      value: `${browserTimeoutSec}s`,
      reason: '高复杂度 / 4K 项目首屏加载较慢，放宽 page.goto 超时避免误判失败',
      confidence: 'medium',
      source: 'heuristic'
    })
  }

  /* --------------------------- 汇总 --------------------------- */
  const expectedMs = benchBest?.ms ?? matchedHistory?.benchmarkMs ?? null
  const settingsPatch: Partial<RenderSettings> = {
    workers,
    gpu: gpuEncode,
    browserGpu,
    extra
  }

  const id = `rec_${hash32(
    [input.mode, input.hardware.fingerprint, input.workload?.analyzedAt ?? '', input.settings.format, workers, Date.now()].join('|')
  )}`

  return {
    id,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    projectPath: input.workload?.projectPath ?? '',
    workerCandidates,
    chosen: {
      workers,
      gpuEncode,
      encoderId,
      encoderLabel,
      browserGpu,
      capturePath: capture.path as CapturePath,
      extra
    },
    reasons,
    warnings: [...new Set(warnings)],
    basedOn,
    sampleCount: input.benchmark?.results.filter((r) => r.status === 'ok').length ?? 0,
    expectedMs,
    settingsPatch
  }
}

/** 供界面展示的测试规模预估 */
export function estimateBenchmark(input: OptimizeInput): { candidates: number; minutes: number } {
  const list = generateWorkerCandidates({
    mode: input.mode,
    cli: input.cli,
    hardware: input.hardware,
    cpu: input.capability.cpu,
    workload: input.workload,
    historyWorkers: null,
    reference: input.reference
  })
  const projectSeconds = input.workload?.durationSec ?? 15
  return {
    candidates: list.length,
    minutes: estimateTestMinutes({ candidates: list.length, projectSeconds, workload: input.workload })
  }
}

/* ------------------------------------------------------------------ */
/* 固定模式（平衡 / 性能 / 极限）：静态预设决策                            */
/* ------------------------------------------------------------------ */

/**
 * 固定模式推荐：读取开发者预定义的静态预设表，按硬件等级匹配，
 * 再做兼容性回退与资源保护。
 *
 * 严格遵守：
 * - 不读取 Benchmark 结果与渲染历史（数据源里即使有也不使用）；
 * - 不动态计算 / 寻优 worker；
 * - 预设本身不被本函数或任何 Benchmark 结果修改。
 */
function optimizeFixed(input: OptimizeInput): OptimizationRecommendation {
  const fixedMode = input.mode as 'balanced' | 'performance' | 'extreme'
  const resolved = resolveModePreset({
    mode: fixedMode,
    hardware: input.hardware,
    capability: input.capability,
    cli: input.cli,
    format: input.settings.format,
    settings: input.settings,
    allowExperimental: input.allowExperimental,
    platformSupport: input.platformSupport
  })

  const reasons: RecommendationReason[] = []
  for (const note of resolved.notes) {
    reasons.push({
      key: `preset-note-${reasons.length}`,
      label: '固定预设',
      value: input.mode === 'balanced' ? '平衡' : input.mode === 'performance' ? '性能' : '极限',
      reason: note,
      confidence: 'high',
      source: 'heuristic'
    })
  }
  for (const fb of resolved.fallbacks) {
    reasons.push({
      key: `preset-fallback-${reasons.length}`,
      label: '兼容性回退',
      value: '已调整',
      reason: fb,
      confidence: 'high',
      source: 'heuristic'
    })
  }

  const warnings: string[] = []
  if (resolved.lowMemoryMode === 'on') {
    warnings.push('低内存模式已启用：实际生效的 worker 数会被 CLI 压到 1')
  }

  const extra = {
    ...DEFAULT_EXTRA_OPTIONS,
    fastCapture: (resolved.capturePath === 'fast-capture' ? 'on' : 'auto') as 'auto' | 'on' | 'off',
    lowMemoryMode: resolved.lowMemoryMode
  }

  return {
    id: `rec_${hash32([input.mode, input.hardware.fingerprint, resolved.workers, resolved.gpuEncode, Date.now()].join('|'))}`,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    projectPath: input.workload?.projectPath ?? '',
    workerCandidates: [resolved.workers],
    chosen: {
      workers: resolved.workers,
      gpuEncode: resolved.gpuEncode,
      encoderId: resolved.encoderId,
      encoderLabel: resolved.encoderLabel,
      browserGpu: resolved.browserGpu,
      capturePath: resolved.capturePath,
      extra
    },
    reasons,
    warnings: [...new Set(warnings)],
    basedOn: 'heuristic',
    sampleCount: 0,
    // 固定模式没有实测依据，不提供预计耗时，避免把猜测当数据
    expectedMs: null,
    settingsPatch: presetSettingsPatch(resolved)
  }
}
