import type { HardwareReport } from '@shared/types/hardware'
import type {
  MonitorState,
  PressureLevel,
  ResourcePressure,
  ResourceSample
} from '@shared/types/performance'
import type { GpuSample, GpuSamplerHandle } from '../hardware/platform/types'
import type { HardwareService } from '../hardware/hardware-service'
import { basicMemoryInfo, sampleCpuUsage } from '../hardware/sampler-utils'

const MAX_SAMPLES = 150

export interface RenderProgressHint {
  frameDone: number | null
  frameTotal: number | null
  workerCount: number | null
}

/**
 * 实时资源监控：CPU / 内存来自 Node 与平台适配器，
 * GPU 指标来自平台采样器（nvidia-smi 或 Windows 性能计数器）。
 * 拿不到的指标保持 null，界面显示 N/A。
 */
export class ResourceMonitor {
  private hardware: HardwareService
  private timer: ReturnType<typeof setInterval> | null = null
  private gpuHandle: GpuSamplerHandle | null = null
  private samples: ResourceSample[] = []
  private latest: ResourceSample | null = null
  private ticks = 0
  private running = false
  private progress: RenderProgressHint = { frameDone: null, frameTotal: null, workerCount: null }
  private listeners = new Set<(state: MonitorState) => void>()
  private unavailable: string[] = []
  /** 只要采到过一次 GPU 数据，就不再提示"未启用" */
  private sawGpuSample = false
  private intervalMs: number
  private hw: HardwareReport | null = null
  /**
   * full：渲染色时使用，额外采集渲染进程 / Chrome 进程内存（每次查询约 1 秒，代价较高）
   * light：性能测试时使用，只采 CPU / 内存总量 / GPU，避免测量行为本身拖慢被测渲染
   */
  private profile: 'full' | 'light' = 'full'

  constructor(hardware: HardwareService, intervalMs = 2000) {
    this.hardware = hardware
    this.intervalMs = intervalMs
  }

  /** 切换采样档位；基准测试用 light，保证各候选配置承受相同的测量开销 */
  setProfile(profile: 'full' | 'light'): void {
    this.profile = profile
  }

  onState(listener: (state: MonitorState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setProgress(hint: Partial<RenderProgressHint>): void {
    this.progress = { ...this.progress, ...hint }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.samples = []
    this.latest = null
    this.ticks = 0
    this.sawGpuSample = false
    this.hw = await this.hardware.scan()
    this.unavailable = []

    this.gpuHandle = this.hardware.startGpuSampler((sample) => this.applyGpuSample(sample), this.intervalMs)
    if (!this.gpuHandle) {
      this.unavailable.push('GPU 实时指标（当前平台没有可用的采样接口）')
    }

    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.gpuHandle?.stop()
    this.gpuHandle = null
    this.progress = { frameDone: null, frameTotal: null, workerCount: null }
    this.emit()
  }

  private applyGpuSample(sample: GpuSample): void {
    this.sawGpuSample = true
    const base = this.latest ?? this.emptySample()
    const merged: ResourceSample = {
      ...base,
      ts: new Date().toISOString(),
      gpu3dPct: sample.metrics.usage3dPct ?? base.gpu3dPct,
      videoEncodePct: sample.metrics.videoEncodePct ?? base.videoEncodePct,
      videoDecodePct: sample.metrics.videoDecodePct ?? base.videoDecodePct,
      vramUsedBytes: sample.metrics.vramUsedBytes ?? base.vramUsedBytes,
      gpuTempC: sample.metrics.temperatureC ?? base.gpuTempC,
      gpuPowerW: sample.metrics.powerW ?? base.gpuPowerW
    }
    this.latest = merged
    this.emit()
  }

  private emptySample(): ResourceSample {
    return {
      ts: new Date().toISOString(),
      cpuPct: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      renderProcessBytes: null,
      chromeProcessBytes: null,
      gpu3dPct: null,
      videoEncodePct: null,
      videoDecodePct: null,
      vramUsedBytes: null,
      gpuTempC: null,
      gpuPowerW: null,
      frameDone: null,
      frameTotal: null,
      workerCount: null
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    this.ticks += 1
    const cpuPct = await sampleCpuUsage(Math.min(400, this.intervalMs / 4))
    const base = basicMemoryInfo(null)

    let renderBytes: number | null = null
    let chromeBytes: number | null = null
    // 进程级内存查询代价较高（Windows 需启动 PowerShell，实测约 1 秒 CPU 开销），
    // 因此只在 full 档、且每 5 个采样点做一次
    if (this.profile === 'full' && this.ticks % 5 === 1) {
      const live = await this.hardware.readLive()
      renderBytes = live.processBytes.renderBytes
      chromeBytes = live.processBytes.chromeBytes
    } else {
      renderBytes = this.latest?.renderProcessBytes ?? null
      chromeBytes = this.latest?.chromeProcessBytes ?? null
    }

    const sample: ResourceSample = {
      ...(this.latest ?? this.emptySample()),
      ts: new Date().toISOString(),
      cpuPct,
      memoryUsedBytes: base.usedBytes,
      memoryTotalBytes: base.totalBytes,
      renderProcessBytes: renderBytes,
      chromeProcessBytes: chromeBytes,
      frameDone: this.progress.frameDone,
      frameTotal: this.progress.frameTotal,
      workerCount: this.progress.workerCount
    }

    this.latest = sample
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.shift()
    this.emit()
  }

  private pressureOf(): ResourcePressure {
    const sample = this.latest
    const hw = this.hw
    if (!sample) return { memory: 'unknown', vram: 'unknown', disk: 'unknown' }

    const level = (ratio: number, warn: number, critical: number): PressureLevel =>
      ratio >= critical ? 'critical' : ratio >= warn ? 'warn' : 'ok'

    let memory: PressureLevel = 'unknown'
    if (sample.memoryTotalBytes && sample.memoryUsedBytes != null) {
      memory = level(sample.memoryUsedBytes / sample.memoryTotalBytes, 0.85, 0.94)
    }

    let vram: PressureLevel = 'unknown'
    const gpu = hw?.gpus.find((g) => (g.vramBytes ?? 0) > 0 && g.kind !== 'virtual')
    if (gpu?.vramBytes && sample.vramUsedBytes != null) {
      vram = level(sample.vramUsedBytes / gpu.vramBytes, 0.85, 0.95)
    }

    let disk: PressureLevel = 'unknown'
    if (hw?.disk.tempFreeBytes != null) {
      const free = hw.disk.tempFreeBytes
      disk = free < 2 * 1024 ** 3 ? 'critical' : free < 8 * 1024 ** 3 ? 'warn' : 'ok'
    }

    return { memory, vram, disk }
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  getState(): MonitorState {
    const gpuUnavailable = !this.gpuHandle && !this.sawGpuSample
    return {
      active: this.running,
      intervalMs: this.intervalMs,
      latest: this.latest,
      samples: [...this.samples],
      pressure: this.pressureOf(),
      unavailable: gpuUnavailable ? [...this.unavailable, 'GPU 实时指标'] : [...this.unavailable]
    }
  }

  getPeaks(): {
    cpuPct: number | null
    memoryBytes: number | null
    vramBytes: number | null
    gpuPct: number | null
    videoEncodePct: number | null
    avgCpuPct: number | null
  } {
    let cpu: number | null = null
    let memory: number | null = null
    let vram: number | null = null
    let gpu: number | null = null
    let videoEncode: number | null = null
    let cpuSum = 0
    let cpuCount = 0
    for (const s of this.samples) {
      if (s.cpuPct != null) {
        cpu = cpu == null ? s.cpuPct : Math.max(cpu, s.cpuPct)
        cpuSum += s.cpuPct
        cpuCount += 1
      }
      if (s.memoryUsedBytes != null) memory = memory == null ? s.memoryUsedBytes : Math.max(memory, s.memoryUsedBytes)
      if (s.vramUsedBytes != null) vram = vram == null ? s.vramUsedBytes : Math.max(vram, s.vramUsedBytes)
      if (s.gpu3dPct != null) gpu = gpu == null ? s.gpu3dPct : Math.max(gpu, s.gpu3dPct)
      if (s.videoEncodePct != null) {
        videoEncode = videoEncode == null ? s.videoEncodePct : Math.max(videoEncode, s.videoEncodePct)
      }
    }
    return {
      cpuPct: cpu,
      memoryBytes: memory,
      vramBytes: vram,
      gpuPct: gpu,
      videoEncodePct: videoEncode,
      // CPU 平均使用率：GPU 3D 总利用率不能替代 Video Encode，两者在报告里分开呈现
      avgCpuPct: cpuCount > 0 ? Math.round((cpuSum / cpuCount) * 10) / 10 : null
    }
  }

  resetSamples(): void {
    this.samples = []
    this.latest = null
    this.emit()
  }
}
