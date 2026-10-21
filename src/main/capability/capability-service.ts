import type { CapabilityReport, CpuCapability, EncoderCapability } from '@shared/types/performance'
import type { HardwareReport } from '@shared/types/hardware'
import type { HardwareService } from '../hardware/hardware-service'
import { probeBrowserGpu } from './browser-gpu'
import { findFfmpeg, probeEncoders } from './ffmpeg-probe'
import { EnvironmentProfileCache } from '../cache/environment-profile-cache'
import { cacheCounters } from '../cache/counters'

/** 进程内缓存：同一个页面里反复取快照时不必重算 */
const MEMORY_TTL_MS = 3 * 60_000

/** 单 worker 的估算内存开销（Chrome ~256MB + node 侧中转开销，CLI 帮助中明确提示 256MB） */
const MEMORY_PER_WORKER_BYTES = 768 * 1024 * 1024

export function computeCpuCapability(hw: HardwareReport): CpuCapability {
  const physical = hw.cpu.physicalCores ?? Math.max(1, Math.floor((hw.cpu.logicalCores ?? 2) / 2))
  const logical = hw.cpu.logicalCores ?? physical
  const totalGb = hw.memory.totalBytes / 1024 ** 3
  const availableBytes = Math.max(hw.memory.freeBytes, hw.memory.totalBytes * 0.15)

  const cpuCeiling = Math.max(1, Math.floor(physical * 1.5))
  const memoryCeiling = Math.max(1, Math.floor(availableBytes / MEMORY_PER_WORKER_BYTES))
  let ceiling = Math.min(cpuCeiling, memoryCeiling, logical)
  // 与 CLI 的低内存策略保持一致：总内存 <= 8GB 时固定 1 worker
  if (totalGb <= 8) ceiling = 1
  ceiling = Math.min(32, Math.max(1, ceiling))

  const notes: string[] = [`${physical} 物理核 / ${logical} 线程`]
  if (totalGb <= 8) notes.push('总内存 ≤ 8GB，按 CLI 低内存策略固定 1 worker')
  else notes.push(`可用内存约 ${(availableBytes / 1024 ** 3).toFixed(1)}GB，按每 worker 0.75GB 估算`)

  return {
    physicalCores: hw.cpu.physicalCores,
    logicalCores: logical,
    safeWorkerCeiling: ceiling,
    features: hw.cpu.features,
    throttled: null,
    note: notes.join('；')
  }
}

export class CapabilityService {
  private hardware: HardwareService
  private envCache: EnvironmentProfileCache
  private cache: CapabilityReport | null = null
  private cachedAt = 0
  private cacheKey = ''
  private inFlight: Promise<CapabilityReport> | null = null

  constructor(hardware: HardwareService, envCache = new EnvironmentProfileCache()) {
    this.hardware = hardware
    this.envCache = envCache
  }

  /**
   * 编码器能力报告。
   *
   * 试编码要起 ffmpeg 子进程（单次 3–8 秒），因此结果持久化在
   * `profiles/environment-profile.json`，按「硬件指纹 + ffmpeg 路径」缓存 7 天。
   * 浏览器 GPU 状态来自 Electron API，本身没有进程开销，每次都实时读。
   */
  async scan(force = false): Promise<CapabilityReport> {
    const hw = await this.hardware.scan(force)
    const key = `${hw.fingerprint}:${hw.gpus.map((g) => g.driverVersion ?? '').join(',')}`
    if (!force && this.cache && this.cacheKey === key && Date.now() - this.cachedAt < MEMORY_TTL_MS) {
      cacheCounters.envCacheHits += 1
      return this.cache
    }
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      const families = this.hardware.activeAdapter.encoderFamilies(hw.gpus)
      const ffmpegPath = findFfmpeg()
      const browserGpu = await probeBrowserGpu()

      const cachedEncoders = force
        ? null
        : await this.envCache.getEncoders(`${hw.fingerprint}:${ffmpegPath ?? 'none'}`, ffmpegPath)

      if (cachedEncoders) {
        cacheCounters.envCacheHits += 1
        const report: CapabilityReport = {
          scannedAt: new Date().toISOString(),
          cpu: computeCpuCapability(hw),
          encoders: cachedEncoders.encoders,
          browserGpu,
          ffmpeg: { ...cachedEncoders.ffmpeg },
          warnings: [...new Set([...cachedEncoders.warnings, '编码器能力来自本地缓存（硬件与 ffmpeg 未变）'])]
        }
        this.cache = report
        this.cachedAt = Date.now()
        this.cacheKey = key
        return report
      }

      cacheCounters.encoderProbes += 1
      const [encoderProbe] = await Promise.all([
        probeEncoders({ families, timeoutBudgetMs: 90_000 })
      ])

      const warnings: string[] = []
      if (!encoderProbe.ffmpeg.found) warnings.push('未找到 ffmpeg，无法验证硬件编码能力')
      const working = encoderProbe.encoders.filter((e) => e.working)
      if (working.length === 0) warnings.push('没有任何编码器通过试编码验证')
      if (!working.some((e) => e.family !== 'software')) {
        warnings.push('没有可用的硬件编码器，将使用 CPU 编码')
      }
      if (browserGpu.probed && browserGpu.softwareOnly) {
        warnings.push('浏览器处于软件渲染（SwiftShader），WebGL 相关合成会变慢')
      }
      if (browserGpu.probed && browserGpu.hardwareCompositing === false) {
        warnings.push('Chromium 未启用硬件合成')
      }

      const report: CapabilityReport = {
        scannedAt: new Date().toISOString(),
        cpu: computeCpuCapability(hw),
        encoders: encoderProbe.encoders,
        browserGpu,
        ffmpeg: {
          found: encoderProbe.ffmpeg.found,
          path: encoderProbe.ffmpeg.path,
          version: encoderProbe.ffmpeg.version,
          encodersProbedAt: new Date().toISOString()
        },
        warnings: [...new Set(warnings)]
      }

      await this.envCache.saveEncoders({
        fingerprint: `${hw.fingerprint}:${ffmpegPath ?? 'none'}`,
        mediaKey: ffmpegPath ?? 'none',
        report
      })
      await this.envCache.mergeMedia({
        ffmpegPath: encoderProbe.ffmpeg.path,
        ffmpegVersion: encoderProbe.ffmpeg.version
      })

      this.cache = report
      this.cachedAt = Date.now()
      this.cacheKey = key
      return report
    })()

    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  get cached(): CapabilityReport | null {
    return this.cache
  }

  /** 没有可用缓存时（首次启动）返回 null，界面可以显示「正在验证编码器」 */
  peekCached(): CapabilityReport | null {
    return this.cache
  }

  invalidate(): void {
    this.cache = null
    this.cachedAt = 0
    this.cacheKey = ''
  }

  /** 列出对某个输出格式可用的硬件编码器 */
  hardwareEncodersFor(report: CapabilityReport, format: string): EncoderCapability[] {
    return report.encoders.filter(
      (e) => e.working && e.family !== 'software' && e.formats.includes(format as never)
    )
  }
}
