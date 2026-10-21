import type { HardwareReport } from '@shared/types/hardware'
import { buildHardwareFingerprint } from '@shared/types/hardware'
import { pickPrimaryGpu } from './gpu-utils'
import { createPlatformAdapter } from './platform'
import type { GpuActiveHint, PlatformAdapter } from './platform/types'
import { sampleCpuUsage } from './sampler-utils'
import {
  buildStaticSignature,
  defaultTempDir,
  electronGpuInfo,
  HardwareProfileCache,
  readDiskFree,
  staticCpuOf,
  staticGpusOf
} from '../cache/hardware-profile-cache'
import { cacheCounters } from '../cache/counters'

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

/** 进程内缓存只用于「同一个页面里连续调用」，跨启动一律走磁盘缓存 */
const MEMORY_TTL_MS = 60_000

export class HardwareService {
  private adapter: PlatformAdapter
  private cache: HardwareProfileCache
  private memory: HardwareReport | null = null
  private cachedAt = 0
  private inFlight: Promise<HardwareReport> | null = null

  constructor(adapter: PlatformAdapter = createPlatformAdapter(), cache = new HardwareProfileCache()) {
    this.adapter = adapter
    this.cache = cache
  }

  get platformLabel(): string {
    return this.adapter.label
  }

  get activeAdapter(): PlatformAdapter {
    return this.adapter
  }

  get profileCache(): HardwareProfileCache {
    return this.cache
  }

  /** 读取 Electron 侧的 GPU 信息，用于判断"哪块卡真的在用" */
  private async readActiveGpuHint(): Promise<GpuActiveHint | null> {
    try {
      const info = (await electronGpuInfo()) as ElectronGpuInfo | null
      const devices = info?.gpuDevice ?? []
      const active = devices.find((d) => d.active) ?? devices[0]
      if (!active) return null
      return {
        activeVendorId: typeof active.vendorId === 'number' ? active.vendorId : null,
        activeDeviceId: typeof active.deviceId === 'number' ? active.deviceId : null,
        deviceString: active.deviceString ?? active.vendorString ?? null,
        driverVersion: active.driverVersion ?? null
      }
    } catch {
      return null
    }
  }

  /**
   * 读取硬件报告。
   *
   * 缓存优先：静态信息（CPU 型号、核心数、GPU 型号/显存/驱动、OS）来自
   * `profiles/hardware-profile.json`；占用率、内存、临时盘剩余空间每次实时读。
   * 只有 force、缓存缺失、TTL 过期或静态签名变化时才执行完整探测。
   */
  async scan(force = false): Promise<HardwareReport> {
    const now = Date.now()
    if (!force && this.memory && now - this.cachedAt < MEMORY_TTL_MS) {
      cacheCounters.hardwareCacheHits += 1
      return this.memory
    }
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      const gpuInfo = (await electronGpuInfo()) as ElectronGpuInfo | null
      const { signature } = await buildStaticSignature(gpuInfo)
      const reusable = force ? null : await this.cache.getReusable(signature)

      if (reusable) {
        cacheCounters.hardwareCacheHits += 1
        const [memory, cpuUsage, tempFree] = await Promise.all([
          this.adapter.readMemory(),
          sampleCpuUsage(250),
          readDiskFree(reusable.disk.tempDir || defaultTempDir())
        ])
        const gpus = staticGpusOf(reusable)
        const report: HardwareReport = {
          scannedAt: new Date().toISOString(),
          platform: reusable.platform,
          os: reusable.os,
          cpu: { ...staticCpuOf(reusable), usagePct: cpuUsage },
          memory,
          gpus,
          disk: {
            ...reusable.disk,
            tempFreeBytes: tempFree ?? reusable.disk.tempFreeBytes
          },
          fingerprint: reusable.fingerprint,
          warnings: reusable.warnings,
          fromCache: true,
          cacheCheckedAt: reusable.checkedAt
        }
        this.memory = report
        this.cachedAt = Date.now()
        return report
      }

      cacheCounters.hardwareScans += 1
      return this.fullScan(gpuInfo, signature)
    })()

    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async fullScan(gpuInfo: ElectronGpuInfo | null, signature: string): Promise<HardwareReport> {
    const activeGpu = await this.readActiveGpuHint()
    const cpuUsage = await sampleCpuUsage(250)
    const probe = await this.adapter.probe({ activeGpu })
    const memory = await this.adapter.readMemory()

    const gpus = probe.gpus.map((gpu) => ({
      ...gpu,
      metrics: gpu.metrics
    }))

    const fingerprint = buildHardwareFingerprint({
      platform: probe.os.platform,
      arch: probe.os.arch,
      cpuModel: probe.cpu.model,
      physicalCores: probe.cpu.physicalCores,
      logicalCores: probe.cpu.logicalCores,
      totalMemoryBytes: memory.totalBytes,
      gpuIds: gpus.map((g) => g.id),
      driverVersions: gpus.map((g) => g.driverVersion ?? '')
    })

    const warnings = [...probe.warnings, ...this.adapter.limitations()]
    if (gpus.every((g) => g.kind === 'virtual')) {
      warnings.push('仅检测到虚拟显示设备，硬件加速可能不可用')
    }
    if (!pickPrimaryGpu(gpus)) {
      warnings.push('未检测到可用 GPU，将使用软件渲染')
    }

    const report: HardwareReport = {
      scannedAt: new Date().toISOString(),
      platform: probe.os.platform,
      os: probe.os,
      cpu: { ...probe.cpu, usagePct: cpuUsage, loadAvg: null },
      memory,
      gpus,
      disk: probe.disk,
      fingerprint,
      warnings: [...new Set(warnings)],
      fromCache: false
    }

    // 写缓存：动态指标一律清空，缓存只保留静态事实
    await this.cache.save({
      fingerprint,
      signature,
      checkedAt: report.scannedAt,
      platform: report.platform,
      os: report.os,
      cpu: {
        ...report.cpu,
        usagePct: null,
        temperatureC: null,
        currentClockMhz: null,
        loadAvg: null
      },
      memoryTotalBytes: memory.totalBytes,
      gpus: staticGpusOf({ gpus: report.gpus }),
      disk: report.disk,
      warnings: report.warnings,
      cliVersion: null
    })

    this.memory = report
    this.cachedAt = Date.now()
    void gpuInfo
    return report
  }

  /** 实时读数：CPU 占用、内存、进程占用（GPU 由 sampler 单独推送） */
  async readLive(): Promise<{
    cpuPct: number | null
    memory: HardwareReport['memory']
    processBytes: { renderBytes: number | null; chromeBytes: number | null }
  }> {
    const [cpuPct, processBytes] = await Promise.all([sampleCpuUsage(200), this.adapter.readProcessMemory()])
    const memory = await this.adapter.readMemory(processBytes)
    return { cpuPct, memory, processBytes }
  }

  startGpuSampler(onSample: Parameters<PlatformAdapter['startGpuSampler']>[0], intervalMs: number) {
    return this.adapter.startGpuSampler(onSample, intervalMs)
  }

  get cachedReport(): HardwareReport | null {
    return this.memory
  }

  /** 强制下次重新完整检测（手动刷新 / 驱动变化） */
  invalidate(): void {
    this.memory = null
    this.cachedAt = 0
    this.cache.markStale('手动刷新设备信息')
  }
}
