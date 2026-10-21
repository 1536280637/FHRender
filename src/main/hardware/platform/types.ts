import type { CpuInfo, DiskInfo, GpuInfo, GpuMetrics, MemoryInfo, OsInfo } from '@shared/types/hardware'
import type { EncoderFamily } from '@shared/types/performance'

/** Electron 提供的当前 GPU 线索（平台无关），用于标记哪块卡真正在用 */
export interface GpuActiveHint {
  activeVendorId: number | null
  activeDeviceId: number | null
  deviceString: string | null
  driverVersion: string | null
}

export interface GpuSample {
  /** 能对应到具体 GPU 时给出 id，否则为 null（聚合采样） */
  gpuId: string | null
  metrics: Partial<GpuMetrics>
}

export interface GpuSamplerHandle {
  stop(): void
  /** 说明采样来源，例如 "nvidia-smi 2s" */
  describe(): string
}

export interface ProcessMemorySample {
  renderBytes: number | null
  chromeBytes: number | null
}

export interface PlatformProbe {
  os: OsInfo
  cpu: Omit<CpuInfo, 'usagePct' | 'loadAvg'>
  gpus: GpuInfo[]
  disk: DiskInfo
  warnings: string[]
}

export interface PlatformAdapter {
  readonly id: string
  readonly label: string
  /** 采集静态硬件信息；activeGpu 由上层从 Electron 获取后传入 */
  probe(input: { activeGpu: GpuActiveHint | null }): Promise<PlatformProbe>
  readMemory(processMemory?: ProcessMemorySample | null): Promise<MemoryInfo>
  readProcessMemory(): Promise<ProcessMemorySample>
  /** 启动实时 GPU 采样；平台无法采样时返回 null（界面显示 N/A） */
  startGpuSampler(onSample: (sample: GpuSample) => void, intervalMs: number): GpuSamplerHandle | null
  /** 该平台可能可用的编码器家族，用于限定真实试编码的范围 */
  encoderFamilies(gpus: GpuInfo[]): EncoderFamily[]
  /** 捕获路径能力（是否允许多 worker 并行流等） */
  captureSupport(): { parallelStream: boolean; fastCapture: boolean; note: string }
  /** 该平台无法读取的指标说明 */
  limitations(): string[]
}
