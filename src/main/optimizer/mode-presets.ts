import type { HardwareReport } from '@shared/types/hardware'
import type {
  CapturePath,
  CapabilityReport,
  CliCapabilities,
  HardwareTier,
  ModePresetSpec,
  PerformanceMode,
  ResolvedModePreset
} from '@shared/types/performance'
import { DEFAULT_EXTRA_OPTIONS, type RenderSettings, type VideoFormat } from '@shared/types/render'
import { formatCapability } from '../process/hyperframes'

/* ------------------------------------------------------------------ */
/* 硬件能力等级                                                         */
/* ------------------------------------------------------------------ */

/**
 * 依据 CPU 逻辑核心、物理核心与系统内存评定硬件等级。
 * 只做「等级匹配」用于选择静态预设，不做任何动态性能计算。
 */
export function detectHardwareTier(hardware: HardwareReport): HardwareTier {
  const logical = hardware.cpu.logicalCores ?? 4
  const physical = hardware.cpu.physicalCores ?? Math.max(2, Math.floor(logical / 2))
  const ramGb = hardware.memory.totalBytes / 1024 ** 3
  const discreteVram = hardware.gpus
    .filter((g) => g.kind === 'discrete')
    .reduce((max, g) => Math.max(max, (g.vramBytes ?? 0) / 1024 ** 3), 0)

  // 综合评分：核心数为主，内存与独立显存作修正
  let score = 0
  if (logical >= 6) score += 1
  if (logical >= 12) score += 1
  if (logical >= 20) score += 1
  if (physical >= 8) score += 1
  if (ramGb >= 16) score += 1
  if (ramGb >= 32) score += 1
  if (discreteVram >= 6) score += 1

  if (score <= 2) return 'entry'
  if (score <= 4) return 'mainstream'
  if (score <= 6) return 'high-end'
  return 'workstation'
}

/* ------------------------------------------------------------------ */
/* 固定模式静态预设表                                                     */
/* ------------------------------------------------------------------ */

/**
 * 三种固定模式的静态参数表。
 *
 * 设计原则（对应产品需求）：
 * 1. 全部数值由开发者预先定义并在开发阶段实测，运行期不做 Benchmark、不动态寻优；
 * 2. worker 数是等级档位值，渲染前还会按「安全上限」（内存 / CLI 声明）收敛，
 *    这是资源保护，不是性能寻优；
 * 3. GPU 编码表达的是「意图」：prefer 表示有通过试编码的硬件编码器才开启，
 *    NVENC 参数永远不会被套到 AMD / Intel 设备上——编码器选择只来自真实能力检测；
 * 4. 极限模式允许实验性开关，但只使用经实测验证的选项（并行流捕获），
 *    且仍受 CLI 能力与平台支持约束。
 */
export const MODE_PRESET_TABLE: Record<Exclude<PerformanceMode, 'smart'>, ModePresetSpec[]> = {
  balanced: [
    {
      mode: 'balanced',
      tier: 'entry',
      workers: 1,
      gpuEncode: 'prefer',
      browserGpu: 'auto',
      capturePath: 'default',
      lowMemoryGuard: true,
      notes: ['入门设备以可用性优先，单 worker 避免挤占系统资源']
    },
    {
      mode: 'balanced',
      tier: 'mainstream',
      workers: 2,
      gpuEncode: 'prefer',
      browserGpu: 'auto',
      capturePath: 'default',
      lowMemoryGuard: true,
      notes: ['主流设备 2 worker，为其他程序保留核心与内存余量']
    },
    {
      mode: 'balanced',
      tier: 'high-end',
      workers: 3,
      gpuEncode: 'prefer',
      browserGpu: 'auto',
      capturePath: 'default',
      lowMemoryGuard: true,
      notes: ['高性能设备 3 worker，速度与占用兼顾']
    },
    {
      mode: 'balanced',
      tier: 'workstation',
      workers: 4,
      gpuEncode: 'prefer',
      browserGpu: 'auto',
      capturePath: 'default',
      lowMemoryGuard: true,
      notes: ['工作站 4 worker，仍保留一半核心给系统与其他任务']
    }
  ],
  performance: [
    {
      mode: 'performance',
      tier: 'entry',
      workers: 2,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'default',
      lowMemoryGuard: true,
      notes: ['入门设备 2 worker，优先硬件编码，捕获路径保持默认稳妥']
    },
    {
      mode: 'performance',
      tier: 'mainstream',
      workers: 3,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: true,
      notes: ['主流设备 3 worker + 快速捕获（CLI 支持时生效）']
    },
    {
      mode: 'performance',
      tier: 'high-end',
      workers: 5,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: false,
      notes: ['高性能设备 5 worker + 快速捕获，提高吞吐']
    },
    {
      mode: 'performance',
      tier: 'workstation',
      workers: 6,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: false,
      notes: ['工作站 6 worker + 快速捕获，最大化吞吐并保留资源保护判断']
    }
  ],
  extreme: [
    {
      mode: 'extreme',
      tier: 'entry',
      workers: 2,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: true,
      notes: ['入门设备极限档仍以 2 worker 为上限，避免换页导致更慢']
    },
    {
      mode: 'extreme',
      tier: 'mainstream',
      workers: 4,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: false,
      notes: ['主流设备 4 worker，实测验证过的激进档位']
    },
    {
      mode: 'extreme',
      tier: 'high-end',
      workers: 6,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: false,
      notes: ['高性能设备 6 worker，优先硬件编码器']
    },
    {
      mode: 'extreme',
      tier: 'workstation',
      workers: 8,
      gpuEncode: 'prefer',
      browserGpu: 'on',
      capturePath: 'fast-capture',
      lowMemoryGuard: false,
      notes: ['工作站 8 worker，占用绝大多数核心；超出的部分由安全上限自动收敛']
    }
  ]
}

/* ------------------------------------------------------------------ */
/* 静态预设 → 真实参数（兼容性回退）                                       */
/* ------------------------------------------------------------------ */

export interface ResolvePresetInput {
  mode: Exclude<PerformanceMode, 'smart'>
  hardware: HardwareReport
  capability: CapabilityReport
  cli: CliCapabilities
  format: VideoFormat
  settings: RenderSettings
  allowExperimental: boolean
  platformSupport: { parallelStream: boolean; fastCapture: boolean; note: string }
}

/**
 * 把静态预设解析成真实可下发的参数。
 * 只做兼容性检查与资源保护：
 * - 不读取任何 Benchmark / 历史成绩；
 * - 不修改预设本身的定义；
 * - 硬件或 CLI 不支持的意图按真实能力回退，并写入 fallbacks。
 */
export function resolveModePreset(input: ResolvePresetInput): ResolvedModePreset {
  const tier = detectHardwareTier(input.hardware)
  const spec =
    MODE_PRESET_TABLE[input.mode].find((p) => p.tier === tier) ??
    MODE_PRESET_TABLE[input.mode][0]

  const fallbacks: string[] = []
  const notes = [...spec.notes]
  const cap = formatCapability(input.format)

  /* ---------------- worker：档位值 + 安全上限收敛 ---------------- */
  const ceilingByCpu = input.capability.cpu.safeWorkerCeiling
  const cliMax = input.cli.worker.max
  const ceiling = Math.max(1, Math.min(ceilingByCpu, cliMax ?? Number.POSITIVE_INFINITY))
  let workers = Math.min(spec.workers, ceiling)
  if (workers < spec.workers) {
    fallbacks.push(
      `worker 由预设 ${spec.workers} 收敛到 ${workers}（当前内存 / 核心安全上限 ${ceiling}，或 CLI 声明上限 ${cliMax ?? '未给出'}）`
    )
  }
  if (spec.workers > ceiling) {
    notes.push(`预设 worker ${spec.workers} 超出本机安全上限，渲染时自动按 ${ceiling} 执行`)
  }

  /* ---------------- GPU 编码：意图 → 真实能力 ---------------- */
  let gpuEncode = false
  let encoderId: string | null = null
  let encoderLabel: string | null = null
  const hardwareEncoders = input.capability.encoders
    .filter((e) => e.working && e.family !== 'software' && e.formats.includes(input.format))
    .sort((a, b) => encoderPriority(a.family) - encoderPriority(b.family))

  if (spec.gpuEncode === 'off') {
    fallbacks.push('预设定义为软件编码，未启用 GPU 编码')
  } else if (!cap.supportsGpu) {
    fallbacks.push(`${cap.label} 不支持 GPU 编码，回退软件编码`)
  } else if (hardwareEncoders.length === 0) {
    fallbacks.push('没有硬件编码器通过真实试编码，回退 CPU 编码')
  } else {
    const best = hardwareEncoders[0]
    gpuEncode = true
    encoderId = best.id
    encoderLabel = best.label
    notes.push(`GPU 编码使用 ${best.label}（已通过真实试编码）`)
  }

  /* ---------------- 捕获路径：CLI 能力 + 平台支持 ---------------- */
  let capturePath: CapturePath = spec.capturePath
  if (capturePath === 'fast-capture') {
    const cliSupports = input.cli.features.fastCapture
    const platformSupports = input.platformSupport.fastCapture
    if (!cliSupports) {
      capturePath = 'default'
      fallbacks.push('当前 CLI 版本不支持快速捕获，回退默认截图捕获')
    } else if (!platformSupports) {
      capturePath = 'default'
      fallbacks.push(`当前平台不适合快速捕获（${input.platformSupport.note}），回退默认捕获`)
    } else {
      notes.push('使用快速捕获路径')
    }
  }

  /* ---------------- 低内存保护 ---------------- */
  const totalGb = input.hardware.memory.totalBytes / 1024 ** 3
  const freeGb = input.hardware.memory.freeBytes / 1024 ** 3
  const memoryTight = totalGb <= 8 || freeGb < 1.5
  let lowMemoryMode: 'auto' | 'on' = 'auto'
  if (spec.lowMemoryGuard && memoryTight) {
    lowMemoryMode = 'on'
    fallbacks.push('内存紧张，已启用 CLI 低内存模式（实际生效 worker 会被 CLI 压到 1）')
  }

  /* ---------------- Browser GPU ---------------- */
  let browserGpu = spec.browserGpu
  if (browserGpu === 'on' && input.capability.browserGpu.probed && input.capability.browserGpu.softwareOnly) {
    browserGpu = 'auto'
    fallbacks.push('浏览器处于软件渲染（SwiftShader），强制开启可能失败，回退 auto 交给 CLI 探测')
  }

  return {
    mode: input.mode,
    tier,
    workers,
    gpuEncode,
    encoderId,
    encoderLabel,
    browserGpu,
    capturePath,
    lowMemoryMode,
    allowExperimental: input.mode === 'extreme' ? input.allowExperimental : false,
    fallbacks,
    notes
  }
}

const FAMILY_PRIORITY = ['nvidia', 'apple', 'intel', 'amd', 'vaapi', 'other'] as const
function encoderPriority(family: string): number {
  const idx = FAMILY_PRIORITY.indexOf(family as (typeof FAMILY_PRIORITY)[number])
  return idx === -1 ? FAMILY_PRIORITY.length : idx
}

/** 把解析结果转成渲染参数补丁（固定模式不触碰格式 / 质量 / 分辨率） */
export function presetSettingsPatch(resolved: ResolvedModePreset): Partial<RenderSettings> {
  return {
    workers: resolved.workers,
    gpu: resolved.gpuEncode,
    browserGpu: resolved.browserGpu,
    extra: {
      ...DEFAULT_EXTRA_OPTIONS,
      fastCapture: resolved.capturePath === 'fast-capture' ? 'on' : 'auto',
      lowMemoryMode: resolved.lowMemoryMode
    }
  }
}
