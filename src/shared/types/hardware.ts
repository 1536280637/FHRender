/**
 * 硬件与操作系统信息类型
 *
 * 约定：任何平台无法可靠读取的指标一律为 null，由界面显示 N/A。
 * 禁止用 0 或推测值冒充真实数据。
 */

export type PlatformId = 'win32' | 'darwin' | 'linux'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'microsoft' | 'unknown'

export type GpuKind = 'discrete' | 'integrated' | 'virtual' | 'unknown'

export interface CpuInfo {
  brand: string
  model: string
  physicalCores: number | null
  logicalCores: number | null
  baseClockMhz: number | null
  currentClockMhz: number | null
  /** 采样得到的整体占用率（%），来自 os.cpus() 时间差 */
  usagePct: number | null
  /** 仅部分平台 / 需要管理员权限时可得 */
  temperatureC: number | null
  /** 通过 /proc/cpuinfo、sysctl 或 PowerShell 读取到的指令集特征 */
  features: string[]
  loadAvg: number[] | null
}

export interface MemoryInfo {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usagePct: number
  /** 渲染相关进程（node / chrome）工作集合计 */
  renderProcessBytes: number | null
}

export interface GpuMetrics {
  usage3dPct: number | null
  videoEncodePct: number | null
  videoDecodePct: number | null
  copyPct: number | null
  vramUsedBytes: number | null
  temperatureC: number | null
  powerW: number | null
  powerLimitW: number | null
}

export interface GpuInfo {
  /** 稳定标识：vendor:deviceId 或名称归一化结果 */
  id: string
  name: string
  vendor: GpuVendor
  kind: GpuKind
  vramBytes: number | null
  driverVersion: string | null
  /** 是否为 Electron / Chrome 当前实际使用的 GPU */
  activeForBrowser: boolean | null
  metrics: GpuMetrics
  /** 该 GPU 相关的编码器线索（真实可用性由 capability 层测试） */
  encoderHints: string[]
  note?: string
}

export interface OsInfo {
  platform: PlatformId | string
  name: string
  release: string
  version: string
  arch: string
  /** 是否具备管理员 / root 权限 */
  isElevated: boolean | null
  locale: string
}

export interface DiskInfo {
  /** 系统临时目录（渲染中间产物默认落盘位置） */
  tempDir: string
  tempFreeBytes: number | null
  tempTotalBytes: number | null
}

export interface HardwareReport {
  scannedAt: string
  platform: PlatformId | string
  os: OsInfo
  cpu: CpuInfo
  memory: MemoryInfo
  gpus: GpuInfo[]
  disk: DiskInfo
  /** 用于判断"硬件是否变化、是否需要重新 benchmark" */
  fingerprint: string
  /** 哪些指标未能读取、原因是什么 */
  warnings: string[]
  /** 静态硬件信息是否来自本地缓存（CPU/GPU 占用率始终是实时采样） */
  fromCache?: boolean
  /** 缓存中记录的真实检测时间 */
  cacheCheckedAt?: string
}

/** 硬件指纹（不含序列号等可识别信息，只做能力判定） */
export function buildHardwareFingerprint(input: {
  platform: string
  arch: string
  cpuModel: string
  physicalCores: number | null
  logicalCores: number | null
  totalMemoryBytes: number
  gpuIds: string[]
  driverVersions: string[]
}): string {
  const raw = [
    input.platform,
    input.arch,
    input.cpuModel.replace(/\s+/g, ' ').trim(),
    input.physicalCores ?? '?',
    input.logicalCores ?? '?',
    Math.round(input.totalMemoryBytes / 1024 ** 3),
    [...input.gpuIds].sort().join('|'),
    [...input.driverVersions].sort().join('|')
  ].join('::')
  return `hw_${hash32(raw)}`
}

/** FNV-1a 32 位，足够做本地档案键，且不泄露原始信息 */
export function hash32(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
