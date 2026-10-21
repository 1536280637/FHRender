import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { arch, cpus, homedir, platform, release, tmpdir, totalmem, version } from 'node:os'
import { join } from 'node:path'
import type { CpuInfo, DiskInfo, GpuInfo, OsInfo } from '@shared/types/hardware'
import type { HardwareCacheStatus } from '@shared/types/cache'
import {
  dirBytes,
  expiresAtOf,
  isExpired,
  profilesDir,
  readJsonFile,
  removeFiles,
  writeJsonFile
} from './cache-io'

/**
 * 硬件静态档案缓存。
 *
 * 只缓存「换机器 / 换驱动才会变」的信息：CPU 型号与核心数、内存总量、GPU 型号 /
 * 显存 / 驱动、OS 版本、磁盘容量。CPU 占用率、GPU 占用率、显存占用、温度这些
 * 动态指标永远实时采样，不写进缓存。
 *
 * 失效判定（任一命中就重新完整检测）：
 * 1. 缓存文件缺失 / 损坏；
 * 2. 超过 TTL（默认 7 天，可配置）；
 * 3. 静态签名变化（OS 版本、CPU 型号、内存总量、GPU 列表、驱动版本）。
 */

const TTL_HOURS = 168
const VERSION = 1

export interface HardwareCacheFile {
  version: number
  fingerprint: string
  signature: string
  checkedAt: string
  ttlHours: number
  platform: string
  os: OsInfo
  /** usagePct / temperatureC / loadAvg 为动态字段，缓存里固定为 null */
  cpu: CpuInfo
  memoryTotalBytes: number
  gpus: GpuInfo[]
  disk: DiskInfo
  warnings: string[]
  cliVersion: string | null
}

interface ElectronGpuInfo {
  gpuDevice?: {
    active?: boolean
    vendorId?: number
    deviceId?: number
    vendorString?: string
    deviceString?: string
    driverVendor?: string
    driverVersion?: string
  }[]
}

/**
 * 计算静态签名：全部来自 os 模块与 Electron API，不启动任何子进程。
 * 这样「读缓存」这条路径是毫秒级的，不会因为校验缓存而重新跑 WMI / nvidia-smi。
 */
export async function buildStaticSignature(
  electronGpu: ElectronGpuInfo | null
): Promise<{ signature: string; parts: Record<string, string> }> {
  const cores = cpus()
  const parts: Record<string, string> = {
    platform: platform(),
    arch: arch(),
    osVersion: `${release()} ${version()}`,
    cpu: (cores[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
    logicalCores: String(cores.length),
    totalMemGb: String(Math.round(totalmem() / 1024 ** 3)),
    gpu: (electronGpu?.gpuDevice ?? [])
      .map((d) => `${d.deviceString ?? d.vendorString ?? '?'}@${d.driverVersion ?? '?'}`)
      .sort()
      .join('|')
  }
  return { signature: Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(';'), parts }
}

export class HardwareProfileCache {
  private readonly file = join(profilesDir(), 'hardware-profile.json')
  private memory: HardwareCacheFile | null = null
  private loaded = false
  private lastStaleReason: string | null = null

  get path(): string {
    return this.file
  }

  async load(): Promise<HardwareCacheFile | null> {
    if (this.loaded && this.memory) return this.memory
    const data = await readJsonFile<HardwareCacheFile>(this.file)
    this.loaded = true
    this.memory = data && data.version === VERSION ? data : null
    return this.memory
  }

  async save(payload: Omit<HardwareCacheFile, 'version' | 'ttlHours'> & { signature: string }): Promise<void> {
    const record: HardwareCacheFile = {
      ...payload,
      version: VERSION,
      ttlHours: TTL_HOURS
    }
    this.memory = record
    this.loaded = true
    await writeJsonFile(this.file, record)
  }

  /** 读取可直接复用的缓存；不可用时返回 null 并记录原因 */
  async getReusable(signature: string): Promise<HardwareCacheFile | null> {
    const cached = await this.load()
    if (!cached) {
      this.lastStaleReason = '本地还没有硬件档案'
      return null
    }
    if (isExpired(cached.checkedAt, cached.ttlHours || TTL_HOURS)) {
      this.lastStaleReason = `缓存超过 ${cached.ttlHours || TTL_HOURS} 小时有效期`
      return null
    }
    if (cached.signature !== signature) {
      this.lastStaleReason = '静态硬件签名变化（OS / CPU / 内存 / GPU / 驱动）'
      return null
    }
    this.lastStaleReason = null
    return cached
  }

  markStale(reason: string): void {
    this.lastStaleReason = reason
    this.memory = null
    this.loaded = false
  }

  async status(): Promise<HardwareCacheStatus> {
    const cached = this.memory ?? (await this.load())
    const ttl = cached?.ttlHours ?? TTL_HOURS
    return {
      available: !!cached,
      checkedAt: cached?.checkedAt ?? null,
      file: this.file,
      expiresAt: expiresAtOf(cached?.checkedAt ?? null, ttl),
      staleReason: cached ? null : (this.lastStaleReason ?? '本地还没有硬件档案'),
      key: cached?.fingerprint ?? null,
      fingerprint: cached?.fingerprint ?? null,
      cpuModel: cached?.cpu.model ?? null,
      gpuNames: cached?.gpus.map((g) => g.name) ?? [],
      totalMemoryBytes: cached?.memoryTotalBytes ?? null,
      driverVersions: Object.fromEntries(
        (cached?.gpus ?? []).map((g) => [g.name, g.driverVersion ?? ''])
      ),
      ttlHours: ttl
    }
  }

  async clear(): Promise<string[]> {
    this.memory = null
    this.loaded = false
    this.lastStaleReason = null
    return removeFiles([this.file])
  }

  async bytes(): Promise<number> {
    return dirBytes(profilesDir())
  }
}

/** 从缓存的静态字段拼出完整报告所需的 CPU 字段（动态部分由调用方实时采样） */
export function staticCpuOf(cached: HardwareCacheFile): CpuInfo {
  return {
    ...cached.cpu,
    usagePct: null,
    temperatureC: null,
    loadAvg: null,
    currentClockMhz: null
  }
}

/** 缓存里的 GPU 只保留静态字段，占用率/温度/显存占用全部清空，等待实时采样 */
export function staticGpusOf(cached: { gpus: GpuInfo[] }): GpuInfo[] {
  return cached.gpus.map((gpu) => ({
    ...gpu,
    metrics: {
      usage3dPct: null,
      videoEncodePct: null,
      videoDecodePct: null,
      copyPct: null,
      vramUsedBytes: null,
      temperatureC: null,
      powerW: null,
      powerLimitW: null
    }
  }))
}

/**
 * 临时盘剩余空间：从缓存恢复时用一次 statfs 刷新，避免显示上次的旧值。
 * 失败则保留缓存值（调用方会在 warnings 里说明）。
 */
export async function readDiskFree(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

export function defaultTempDir(): string {
  return tmpdir() || homedir()
}

/** 主进程启动时可以提前把 GPU 信息读出来，缓存在模块里复用 */
let gpuInfoPromise: Promise<ElectronGpuInfo | null> | null = null
export function electronGpuInfo(): Promise<ElectronGpuInfo | null> {
  if (!gpuInfoPromise) {
    gpuInfoPromise = app
      .getGPUInfo('complete')
      .then((info) => info as ElectronGpuInfo)
      .catch(() => null)
  }
  return gpuInfoPromise
}

export function invalidateElectronGpuInfo(): void {
  gpuInfoPromise = null
}
