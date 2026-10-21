import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { arch, release, tmpdir } from 'node:os'
import type { GpuInfo, MemoryInfo, OsInfo } from '@shared/types/hardware'
import type { EncoderFamily } from '@shared/types/performance'
import { findExecutable } from '../../process/hyperframes'
import { detectKind, detectVendor, emptyGpuMetrics, encoderHintsFor, gpuIdOf, normalizeGpuName } from '../gpu-utils'
import { basicMemoryInfo, readDiskInfo, resolvedLocale } from '../sampler-utils'
import { num, runBinary } from './shell'
import type {
  GpuActiveHint,
  GpuSample,
  GpuSamplerHandle,
  PlatformAdapter,
  PlatformProbe,
  ProcessMemorySample
} from './types'

function fieldOf(block: string, key: string): string {
  const line = block.split(/\r?\n/).find((l) => l.startsWith(`${key}`))
  return line ? (line.split(':')[1] ?? '').trim() : ''
}

/**
 * Linux 适配层：/proc + lspci + nvidia-smi。
 * 读不到的能力如实标记为 N/A，不影响基本渲染。
 */
export class LinuxAdapter implements PlatformAdapter {
  readonly id = 'linux'
  readonly label = 'Linux'

  async probe(input: { activeGpu: GpuActiveHint | null }): Promise<PlatformProbe> {
    const warnings: string[] = []
    const cpu = await this.readCpu(warnings)
    const gpus = await this.readGpus(input.activeGpu, warnings)
    const lscpu = await runBinary('lscpu', ['-p'], { timeoutMs: 8000 })
    if (lscpu.ok) {
      const freq = this.pickLscpu(lscpu.stdout, 'CPU max MHz')
      if (freq) cpu.baseClockMhz = freq
    }

    const os: OsInfo = {
      platform: 'linux',
      name: await this.readOsName(),
      release: release(),
      version: process.env.VERSION_ID ?? '',
      arch: arch(),
      isElevated: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
      locale: resolvedLocale()
    }

    return { os, cpu, gpus, disk: await readDiskInfo(tmpdir()), warnings }
  }

  private pickLscpu(text: string, label: string): number | null {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${label}:`))
    return line ? num(line.slice(label.length + 1)) : null
  }

  private async readCpu(warnings: string[]): Promise<PlatformProbe['cpu']> {
    try {
      const text = await fs.readFile('/proc/cpuinfo', 'utf-8')
      const blocks = text.split(/\n\s*\n/).filter((b) => b.trim())
      const first = blocks[0] ?? ''
      const physicalKeys = new Set(
        blocks.map((b) => `${fieldOf(b, 'physical id')}:${fieldOf(b, 'core id')}`).filter((k) => k !== ':')
      )
      const flags = fieldOf(first, 'flags').split(/\s+/).filter(Boolean)
      if (flags.length === 0) warnings.push('未从 /proc/cpuinfo 读取到指令集标志')
      return {
        brand: /intel/i.test(fieldOf(first, 'vendor_id')) ? 'Intel' : /amd/i.test(fieldOf(first, 'vendor_id')) ? 'AMD' : 'Unknown',
        model: fieldOf(first, 'model name') || fieldOf(first, 'Processor') || '未知处理器',
        physicalCores: physicalKeys.size > 0 ? physicalKeys.size : null,
        logicalCores: blocks.length,
        baseClockMhz: null,
        currentClockMhz: fieldOf(first, 'cpu MHz') ? num(fieldOf(first, 'cpu MHz')) : null,
        temperatureC: await this.readCpuTemp(),
        features: flags
      }
    } catch {
      warnings.push('无法读取 /proc/cpuinfo')
      return {
        brand: 'Unknown',
        model: '未知处理器',
        physicalCores: null,
        logicalCores: 1,
        baseClockMhz: null,
        currentClockMhz: null,
        temperatureC: null,
        features: []
      }
    }
  }

  private async readCpuTemp(): Promise<number | null> {
    try {
      const entries = await fs.readdir('/sys/class/thermal')
      for (const entry of entries) {
        if (!entry.startsWith('thermal_zone')) continue
        const raw = await fs.readFile(`/sys/class/thermal/${entry}/temp`, 'utf-8')
        const value = Number(raw.trim())
        if (Number.isFinite(value) && value > 0) return Number((value / 1000).toFixed(1))
      }
    } catch {
      /* ignore */
    }
    return null
  }

  private async readOsName(): Promise<string> {
    try {
      const text = await fs.readFile('/etc/os-release', 'utf-8')
      const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
      if (match) return match[1]
    } catch {
      /* ignore */
    }
    return `Linux ${release()}`
  }

  private async readGpus(activeGpu: GpuActiveHint | null, warnings: string[]): Promise<GpuInfo[]> {
    const gpus: GpuInfo[] = []
    const pci = await runBinary('lspci', [], { timeoutMs: 8000 })
    if (!pci.ok) warnings.push('lspci 不可用，无法枚举 PCI 显卡')

    const lines = pci.ok
      ? pci.stdout
          .split(/\r?\n/)
          .filter((l) => /\b(vga compatible controller|3d controller|display controller)\b/i.test(l))
      : []

    const nvidiaSmi = findExecutable('nvidia-smi')
    let nvidiaStats: { memTotal: number | null; memUsed: number | null; temp: number | null; util: number | null; enc: number | null; dec: number | null; power: number | null; driver: string | null } | null = null

    if (nvidiaSmi) {
      const res = await runBinary(
        nvidiaSmi,
        [
          '--query-gpu=memory.total,memory.used,temperature.gpu,utilization.gpu,utilization.encoder,utilization.decoder,power.draw,driver_version',
          '--format=csv,noheader,nounits'
        ],
        { timeoutMs: 8000 }
      )
      if (res.ok) {
        const [total, used, temp, util, enc, dec, power, driver] = res.stdout.trim().split(',').map((s) => s.trim())
        nvidiaStats = {
          memTotal: num(total),
          memUsed: num(used),
          temp: num(temp),
          util: num(util),
          enc: num(enc),
          dec: num(dec),
          power: num(power),
          driver: driver || null
        }
      }
    }

    for (const line of lines) {
      const raw = line.split(':').slice(2).join(':').trim()
      const name = normalizeGpuName(raw.replace(/\s*\(rev [^)]+\)\s*$/i, ''))
      const vendor = detectVendor({ name })
      const kind = detectKind({ name, vendor })
      const metrics = emptyGpuMetrics()
      let vramBytes: number | null = null
      let driverVersion: string | null = null

      if (vendor === 'nvidia' && nvidiaStats) {
        vramBytes = nvidiaStats.memTotal ? Math.round(nvidiaStats.memTotal * 1024 * 1024) : null
        metrics.vramUsedBytes = nvidiaStats.memUsed ? Math.round(nvidiaStats.memUsed * 1024 * 1024) : null
        metrics.temperatureC = nvidiaStats.temp
        metrics.usage3dPct = nvidiaStats.util
        metrics.videoEncodePct = nvidiaStats.enc
        metrics.videoDecodePct = nvidiaStats.dec
        metrics.powerW = nvidiaStats.power
        driverVersion = nvidiaStats.driver
      }

      gpus.push({
        id: gpuIdOf({ name, vendor }),
        name,
        vendor,
        kind,
        vramBytes,
        driverVersion,
        activeForBrowser: activeGpu?.deviceString
          ? name.toLowerCase().includes(activeGpu.deviceString.toLowerCase())
          : null,
        metrics,
        encoderHints: encoderHintsFor(vendor)
      })
    }

    if (gpus.length === 0) warnings.push('未枚举到独立 / 集成显卡')
    if (!existsSync('/dev/dri')) warnings.push('/dev/dri 不存在，硬件视频编码很可能不可用')
    return gpus
  }

  async readMemory(): Promise<MemoryInfo> {
    try {
      const text = await fs.readFile('/proc/meminfo', 'utf-8')
      const pick = (key: string): number | null => {
        const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
        return match ? Number(match[1]) * 1024 : null
      }
      const total = pick('MemTotal')
      const available = pick('MemAvailable')
      if (total && available != null) {
        const used = total - available
        return {
          totalBytes: total,
          usedBytes: used,
          freeBytes: available,
          usagePct: Number(((used / total) * 100).toFixed(1)),
          renderProcessBytes: null
        }
      }
    } catch {
      /* ignore */
    }
    return basicMemoryInfo(null)
  }

  async readProcessMemory(): Promise<ProcessMemorySample> {
    const res = await runBinary('ps', ['-eo', 'rss,comm'], { timeoutMs: 8000 })
    if (!res.ok) return { renderBytes: null, chromeBytes: null }
    let chrome = 0
    let node = 0
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const kb = Number(match[1])
      const cmd = match[2]
      if (/chrome|chromium|headless_shell/i.test(cmd)) chrome += kb
      else if (/(^|\/)(node|electron)/i.test(cmd)) node += kb
    }
    return { renderBytes: node > 0 ? node * 1024 : null, chromeBytes: chrome > 0 ? chrome * 1024 : null }
  }

  startGpuSampler(onSample: (sample: GpuSample) => void, intervalMs: number): GpuSamplerHandle | null {
    const exe = findExecutable('nvidia-smi')
    if (!exe) return null
    let child: ChildProcess
    try {
      child = spawn(
        exe,
        [
          '--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,temperature.gpu,power.draw',
          '--format=csv,noheader,nounits',
          `--loop-ms=${Math.max(500, intervalMs)}`
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch {
      return null
    }
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const p = line.split(',').map((s) => num(s))
        if (p.length < 4) continue
        onSample({
          gpuId: null,
          metrics: {
            usage3dPct: p[0],
            videoEncodePct: p[1],
            videoDecodePct: p[2],
            vramUsedBytes: p[3] ? Math.round(p[3] * 1024 * 1024) : null,
            temperatureC: p[4],
            powerW: p[5]
          }
        })
      }
    })
    child.on('error', () => {
      /* ignore */
    })
    return {
      stop: () => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      },
      describe: () => `nvidia-smi 轮询（${intervalMs}ms）`
    }
  }

  encoderFamilies(gpus: GpuInfo[]): EncoderFamily[] {
    const families = new Set<EncoderFamily>(['software'])
    for (const gpu of gpus) {
      if (gpu.vendor === 'nvidia') families.add('nvidia')
      if (gpu.vendor === 'amd') families.add('amd')
      if (gpu.vendor === 'intel') families.add('intel')
    }
    if (existsSync('/dev/dri')) families.add('vaapi')
    return [...families]
  }

  captureSupport(): { parallelStream: boolean; fastCapture: boolean; note: string } {
    return {
      parallelStream: true,
      fastCapture: false,
      note: 'Linux 支持多 worker 并行截图；fast capture 官方默认不启用'
    }
  }

  limitations(): string[] {
    return ['AMD / Intel 的实时占用需要 rocm-smi / intel_gpu_top，未安装时显示 N/A']
  }
}
