import type { CapturePath, CliCapabilities, PerformanceMode, WorkloadProfile } from '@shared/types/performance'

export interface CaptureDecision {
  path: CapturePath
  env: Record<string, string>
  reasons: string[]
  warnings: string[]
}

export interface CaptureInput {
  platform: string
  cli: CliCapabilities
  /** 平台适配器声明支持哪些捕获能力 */
  support: { parallelStream: boolean; fastCapture: boolean; note: string }
  mode: PerformanceMode
  workload: WorkloadProfile | null
  workers: number | 'auto'
  /** 是否允许尝试实验性开关（极限模式下由用户确认） */
  allowExperimental: boolean
}

/**
 * 捕获管线决策。
 * 只启用"当前 CLI 支持 + 当前平台允许 + 当前格式兼容"的能力。
 */
export function decideCapturePath(input: CaptureDecisionInput): CaptureDecision {
  const reasons: string[] = []
  const warnings: string[] = []

  const fastCaptureAvailable = input.cli.features.fastCapture && input.support.fastCapture
  const wantsSpeed = input.mode === 'performance' || input.mode === 'extreme'
  const heavy = input.workload?.complexity === '4k-heavy' || input.workload?.complexity === 'high'

  if (fastCaptureAvailable && wantsSpeed && (heavy || input.mode === 'extreme')) {
    reasons.push('fast capture 可用：CLI 支持且当前平台允许（drawElementImage 路径）')
    warnings.push('fast capture 由 CLI 自动回退：遇到不兼容的合成会自动改用截图捕获')
    return { path: 'fast-capture', env: {}, reasons, warnings }
  }

  if (fastCaptureAvailable && !wantsSpeed) {
    warnings.push('已检测到 fast capture 能力，但平衡 / 智能模式不主动启用')
  }

  const parallelAllowed =
    input.support.parallelStream &&
    input.platform === 'win32' &&
    input.mode === 'extreme' &&
    input.allowExperimental

  if (parallelAllowed) {
    reasons.push('极限模式下尝试实验性并行流捕获 HF_CAPTURE_PARALLEL_STREAM=true')
    warnings.push('实验性开关：必须通过实测确认更快且稳定，否则请回退到默认捕获')
    return {
      path: 'parallel-stream',
      env: { HF_CAPTURE_PARALLEL_STREAM: 'true' },
      reasons,
      warnings
    }
  }

  if (input.mode === 'extreme' && !input.allowExperimental && input.support.parallelStream) {
    warnings.push('实验性并行流捕获需在 Benchmark 中显式验证后才会启用')
  }

  reasons.push('使用 CLI 默认捕获路径（screenshot）')
  return { path: 'default', env: {}, reasons, warnings }
}

type CaptureDecisionInput = CaptureInput
