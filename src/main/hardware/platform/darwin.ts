import { arch, release, tmpdir } from 'node:os'
import type { GpuInfo, MemoryInfo, OsInfo } from '@shared/types/hardware'
import type { EncoderFamily } from '@shared/types/performance'
import { detectKind, detectVendor, emptyGpuMetrics, encoderHintsFor, gpuIdOf, normalizeGpuName } from '../gpu-utils'
import { basicMemoryInfo, readDiskInfo, resolvedLocale } from '../sampler-utils'
import { num, parseJson, runBinary } from './shell'
import type {
  GpuActiveHint,
  GpuSamplerHandle,
  PlatformAdapter,
  PlatformProbe,
  ProcessMemorySample
} from './types'

interface DisplaysJson {
  SPDisplaysDataType?: {
    _name?: string
    sppci_vendor?: string
    sppci_device_id?: string
    sppci_model?: string
    spdisplays_vram?: string
    spdisplays_vram_shared?: string
    spdisplays_metal?: string
  }[]
}

/**
 * macOS 适配层。
 * 统一通过 sysctl / system_profiler 读取，不引入任何第三方二进制。
 * GPU 实时占用需要 powermetrics（root 权限），普通权限下返回 N/A。
 */
export class DarwinAdapter implements PlatformAdapter {
  readonly id = 'darwin'
  readonly label = 'macOS'

  async probe(input: { activeGpu: GpuActiveHint | null }): Promise<PlatformProbe> {
    const warnings: string[] = []

    const [brandRes, physRes, logicalRes, freqRes] = await Promise.all([
      runBinary('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeoutMs: 8000 }),
      runBinary('sysctl', ['-n', 'hw.physicalcpu'], { timeoutMs: 8000 }),
      runBinary('sysctl', ['-n', 'hw.logicalcpu'], { timeoutMs: 8000 }),
      runBinary('sysctl', ['-n', 'hw.cpufrequency'], { timeoutMs: 8000 })
    ])

    const model = brandRes.ok ? brandRes.stdout.trim() : ''
    const cpu: PlatformProbe['cpu'] = {
      brand: /apple/i.test(model) ? 'Apple' : /intel/i.test(model) ? 'Intel' : 'Unknown',
      model: model || '未知处理器',
      physicalCores: physRes.ok ? num(physRes.stdout) : null,
      logicalCores: logicalRes.ok ? num(logicalRes.stdout) : null,
      baseClockMhz: freqRes.ok ? (num(freqRes.stdout) ?? 0) / 1000 || null : null,
      currentClockMhz: null,
      temperatureC: null,
      features: []
    }
    warnings.push('macOS 不提供 CPU 指令集与温度的普通权限读取接口，已显示 N/A')
    warnings.push('GPU 实时占用需要 powermetrics（root），当前显示 N/A')

    const gpus = await this.readGpus(input.activeGpu, warnings)

    const [prodRes, verRes, buildRes] = await Promise.all([
      runBinary('sw_vers', ['-productName'], { timeoutMs: 6000 }),
      runBinary('sw_vers', ['-productVersion'], { timeoutMs: 6000 }),
      runBinary('sw_vers', ['-buildVersion'], { timeoutMs: 6000 })
    ])

    const os: OsInfo = {
      platform: 'darwin',
      name: prodRes.ok ? prodRes.stdout.trim() : `macOS ${release()}`,
      release: release(),
      version: [verRes.ok ? verRes.stdout.trim() : '', buildRes.ok ? buildRes.stdout.trim() : '']
        .filter(Boolean)
        .join(' '),
      arch: arch(),
      isElevated: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
      locale: resolvedLocale()
    }

    return { os, cpu, gpus, disk: await readDiskInfo(tmpdir()), warnings }
  }

  private async readGpus(activeGpu: GpuActiveHint | null, warnings: string[]): Promise<GpuInfo[]> {
    const res = await runBinary('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 15_000 })
    if (!res.ok) {
      warnings.push('system_profiler 读取显卡失败')
      return []
    }
    const data = parseJson<DisplaysJson>(res.stdout)
    const list = data?.SPDisplaysDataType ?? []
    return list.map((item) => {
      const name = normalizeGpuName(item._name ?? item.sppci_model ?? '未知显卡')
      const vendor = detectVendor({ name, compatibility: item.sppci_vendor ?? null })
      const kind = detectKind({ name, vendor })
      const vramText = item.spdisplays_vram ?? item.spdisplays_vram_shared ?? ''
      const vramMatch = vramText.match(/(\d+)\s*(MB|GB)/i)
      const vramBytes = vramMatch
        ? Number(vramMatch[1]) * (vramMatch[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2)
        : null
      return {
        id: gpuIdOf({ name, vendor }),
        name,
        vendor,
        kind,
        vramBytes,
        driverVersion: null,
        activeForBrowser: activeGpu?.deviceString ? name.toLowerCase().includes(activeGpu.deviceString.toLowerCase()) : null,
        metrics: emptyGpuMetrics(),
        encoderHints: encoderHintsFor(vendor)
      }
    })
  }

  async readMemory(): Promise<MemoryInfo> {
    return basicMemoryInfo(null)
  }

  async readProcessMemory(): Promise<ProcessMemorySample> {
    const res = await runBinary('ps', ['-axo', 'rss,comm'], { timeoutMs: 8000 })
    if (!res.ok) return { renderBytes: null, chromeBytes: null }
    let chrome = 0
    let node = 0
    let chromeSeen = false
    let nodeSeen = false
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const kb = Number(match[1])
      const cmd = match[2]
      if (/chrome|Chromium|headless_shell/i.test(cmd)) {
        chrome += kb
        chromeSeen = true
      } else if (/(^|\/)(node|HyperFrames)/i.test(cmd)) {
        node += kb
        nodeSeen = true
      }
    }
    return {
      renderBytes: nodeSeen ? node * 1024 : null,
      chromeBytes: chromeSeen ? chrome * 1024 : null
    }
  }

  startGpuSampler(): GpuSamplerHandle | null {
    // 无 root 无法读取 GPU 占用；不伪造数据
    return null
  }

  encoderFamilies(): EncoderFamily[] {
    return ['apple', 'software']
  }

  captureSupport(): { parallelStream: boolean; fastCapture: boolean; note: string } {
    return {
      parallelStream: false,
      fastCapture: true,
      note: '官方 fast capture 在 macOS + 硬件 GPU 下默认启用（drawElementImage）'
    }
  }

  limitations(): string[] {
    return ['macOS 普通权限无法读取 GPU 占用 / 温度 / 功耗，界面显示 N/A']
  }
}
