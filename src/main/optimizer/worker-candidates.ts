import type { HardwareReport } from '@shared/types/hardware'
import type {
  CliCapabilities,
  CpuCapability,
  PerformanceMode,
  WorkloadProfile
} from '@shared/types/performance'
import type { HardwareReference } from '../profiles/reference-profiles'

export interface WorkerCandidateInput {
  mode: PerformanceMode
  cli: CliCapabilities
  hardware: HardwareReport
  cpu: CpuCapability
  workload: WorkloadProfile | null
  /** 历史最优（同一设备 + 项目 + 格式） */
  historyWorkers?: number | 'auto' | null
  reference?: HardwareReference | null
}

const MODE_LIMITS: Record<PerformanceMode, number> = {
  smart: 2,
  balanced: 3,
  performance: 4,
  extreme: 6
}

/**
 * 动态生成 worker 候选：
 * 上限来自 CLI 声明范围（若有）、CPU 物理核、可用内存与项目负载，
 * 不使用任何硬编码的 "1/2/3/4" 作为全局规则。
 */
export function generateWorkerCandidates(input: WorkerCandidateInput): (number | 'auto')[] {
  const ceilingByCpu = input.cpu.safeWorkerCeiling
  const cliMax = input.cli.worker.max
  let ceiling = cliMax ? Math.min(ceilingByCpu, cliMax) : ceilingByCpu

  const workload = input.workload
  if (workload) {
    if (workload.complexity === '4k-heavy') ceiling = Math.min(ceiling, 4)
    else if (workload.complexity === 'high') ceiling = Math.min(ceiling, 6)
  }
  ceiling = Math.max(1, ceiling)

  const candidates = new Set<number>()
  const add = (value: number): void => {
    if (Number.isFinite(value) && value >= 1 && value <= ceiling) candidates.add(Math.round(value))
  }

  const includeAuto = input.cli.worker.supportsAuto

  if (input.mode === 'smart') {
    if (typeof input.historyWorkers === 'number') return [input.historyWorkers]
    if (input.historyWorkers === 'auto' && includeAuto) return ['auto']
    return includeAuto ? ['auto'] : [Math.min(2, ceiling)]
  }

  if (input.mode === 'balanced') {
    add(Math.min(2, ceiling))
    add(Math.min(3, ceiling))
  } else if (input.mode === 'performance') {
    add(Math.min(2, ceiling))
    add(Math.min(4, ceiling))
    add(ceiling)
  } else {
    // extreme：覆盖低并行度、中间值与上限，避免盲目枚举
    add(1)
    add(2)
    add(3)
    add(4)
    add(Math.ceil(ceiling / 2))
    add(ceiling)
    if (input.reference) {
      for (const value of input.reference.workerCandidates) add(value)
    }
  }

  // 历史最优优先排在前面，便于界面展示与快速复测
  const sorted = [...candidates].sort((a, b) => a - b)
  if (typeof input.historyWorkers === 'number' && sorted.includes(input.historyWorkers)) {
    sorted.splice(sorted.indexOf(input.historyWorkers), 1)
    sorted.unshift(input.historyWorkers)
  }

  const limit = MODE_LIMITS[input.mode]
  const limited = sorted.slice(0, limit)

  if (includeAuto && input.mode !== 'balanced') {
    // auto 作为官方基准，只在性能 / 极限模式里参与对比
    if (input.mode === 'performance' || input.mode === 'extreme') return ['auto', ...limited]
  }
  return limited.length > 0 ? limited : [Math.min(2, ceiling)]
}

/** 估算每轮测试的耗时（用于界面提示） */
export function estimateTestMinutes(input: {
  candidates: number
  projectSeconds: number
  workload: WorkloadProfile | null
}): number {
  const perRun = Math.max(12, input.projectSeconds * 2.2)
  return Math.max(1, Math.round((perRun * input.candidates) / 60))
}
