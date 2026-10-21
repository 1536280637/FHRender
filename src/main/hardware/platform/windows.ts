import { spawn, type ChildProcess } from 'node:child_process'
import { arch, release, version as osVersion } from 'node:os'
import { tmpdir } from 'node:os'
import type { GpuInfo, MemoryInfo, OsInfo } from '@shared/types/hardware'
import type { EncoderFamily } from '@shared/types/performance'
import { findExecutable } from '../../process/hyperframes'
import { detectKind, detectVendor, emptyGpuMetrics, encoderHintsFor, gpuIdOf, normalizeGpuName } from '../gpu-utils'
import { basicMemoryInfo, readDiskInfo, resolvedLocale } from '../sampler-utils'
import { findPowerShell, num, parseJson, runPowerShell } from './shell'
import type {
  GpuActiveHint,
  GpuSample,
  GpuSamplerHandle,
  PlatformAdapter,
  PlatformProbe,
  ProcessMemorySample
} from './types'

interface CimGpu {
  Name?: string
  DriverVersion?: string
  AdapterCompatibility?: string
  AdapterRAM?: number | null
  PNPDeviceID?: string
}

interface WinProbe {
  cpu?: {
    name?: string
    cores?: number
    threads?: number
    max?: number
    cur?: number
    load?: number
  }
  os?: { caption?: string; version?: string; build?: string }
  gpus?: CimGpu[]
  reg?: { desc?: string; vram?: number | string | null }[]
  temp?: number | null
  elevated?: boolean
}

interface NvidiaRow {
  index: number
  name: string
  util: number | null
  encoder: number | null
  decoder: number | null
  memUsed: number | null
  memTotal: number | null
  temp: number | null
  power: number | null
  powerLimit: number | null
  driver: string | null
}

/** 一次性采集所有静态信息的 PowerShell 脚本（内容为常量，不拼接用户输入） */
function buildProbeScript(): string {
  const lines = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$p = Get-CimInstance Win32_Processor | Select-Object -First 1',
    '$o = Get-CimInstance Win32_OperatingSystem',
    '$g = Get-CimInstance Win32_VideoController',
    '$reg = @()',
    "$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    'foreach ($k in (Get-ChildItem $base | Where-Object { $_.PSChildName -match \'^\\d{4}$\' })) {',
    '  $d = Get-ItemProperty $k.PSPath',
    '  if ($d.DriverDesc) { $reg += [pscustomobject]@{ desc = $d.DriverDesc; vram = $d.\'HardwareInformation.qwMemorySize\' } }',
    '}',
    '$temp = $null',
    'try {',
    '  $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop',
    '  $avg = ($t | Measure-Object -Property CurrentTemperature -Average).Average',
    '  if ($avg) { $temp = [math]::Round(($avg / 10) - 273.15, 1) }',
    '} catch { $temp = $null }',
    '$elev = $false',
    'try { $elev = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $elev = $false }',
    '[pscustomobject]@{',
    '  cpu = @{ name = $p.Name; cores = $p.NumberOfCores; threads = $p.NumberOfLogicalProcessors; max = $p.MaxClockSpeed; cur = $p.CurrentClockSpeed; load = $p.LoadPercentage };',
    '  os = @{ caption = $o.Caption; version = $o.Version; build = $o.BuildNumber };',
    '  gpus = @($g);',
    '  reg = @($reg);',
    '  temp = $temp;',
    '  elevated = $elev',
    '} | ConvertTo-Json -Depth 6 -Compress'
  ]
  return lines.join('\n')
}

function parseNvidiaLine(line: string): NvidiaRow | null {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length < 10) return null
  return {
    index: num(parts[0]) ?? 0,
    name: parts[1] ?? '',
    util: num(parts[2]),
    encoder: num(parts[3]),
    decoder: num(parts[4]),
    memUsed: num(parts[5]),
    memTotal: num(parts[6]),
    temp: num(parts[7]),
    power: num(parts[8]),
    powerLimit: num(parts[9]),
    driver: null
  }
}

/** nvidia-smi 只提供显存 MB、功耗 W 等原生单位 */
async function readNvidiaRows(): Promise<{ rows: NvidiaRow[]; driver: string | null }> {
  const exe = findExecutable('nvidia-smi')
  if (!exe) return { rows: [], driver: null }
  const query =
    'index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,power.limit'
  const { runBinary } = await import('./shell')
  const res = await runBinary(exe, [`--query-gpu=${query}`, '--format=csv,noheader,nounits'], { timeoutMs: 8000 })
  if (!res.ok) return { rows: [], driver: null }
  const rows = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseNvidiaLine)
    .filter((row): row is NvidiaRow => row !== null)

  const drv = await runBinary(exe, ['--query-gpu=driver_version', '--format=csv,noheader'], { timeoutMs: 8000 })
  const driver = drv.ok ? (drv.stdout.split(/\r?\n/)[0] ?? '').trim() || null : null
  return { rows, driver }
}

function nameMatches(a: string, b: string): boolean {
  const na = normalizeGpuName(a).toLowerCase()
  const nb = normalizeGpuName(b).toLowerCase()
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

export class WindowsAdapter implements PlatformAdapter {
  readonly id = 'win32'
  readonly label = 'Windows'

  async probe(input: { activeGpu: GpuActiveHint | null }): Promise<PlatformProbe> {
    const warnings: string[] = []
    const ps = await runPowerShell(buildProbeScript(), 25_000)
    const data = ps.ok ? parseJson<WinProbe>(ps.stdout) : null
    if (!data) {
      warnings.push('无法通过 PowerShell 读取 CPU / GPU 信息，部分字段显示为 N/A')
    }

    const nvidia = await readNvidiaRows()
    const gpus = this.mapGpus(data, nvidia.rows, nvidia.driver, input.activeGpu, warnings)

    const cpuName = data?.cpu?.name?.trim() ?? ''
    const cpu: PlatformProbe['cpu'] = {
      brand: /intel/i.test(cpuName) ? 'Intel' : /amd/i.test(cpuName) ? 'AMD' : 'Unknown',
      model: cpuName || '未知处理器',
      physicalCores: data?.cpu?.cores ?? null,
      logicalCores: data?.cpu?.threads ?? null,
      baseClockMhz: data?.cpu?.max ?? null,
      currentClockMhz: data?.cpu?.cur ?? null,
      temperatureC: typeof data?.temp === 'number' ? data.temp : null,
      features: []
    }
    if (cpu.features.length === 0) {
      warnings.push(
        'Windows 不通过 CIM 暴露 CPU 指令集（AVX/SSE 需要 CPUID 或第三方工具），已显示为 N/A；该信息不参与渲染参数决策'
      )
    }
    if (cpu.temperatureC === null) {
      warnings.push('CPU 温度需要管理员权限（WMI 热区），未读取到')
    }

    const os: OsInfo = {
      platform: 'win32',
      name: data?.os?.caption?.trim() || `Windows ${release()}`,
      release: release(),
      version: data?.os?.version ?? osVersion(),
      arch: arch(),
      isElevated: data?.elevated ?? null,
      // 用 ICU 解析出的系统区域，比 LANG/LC_ALL 更贴近 Windows 的真实设置
      locale: resolvedLocale()
    }

    return { os, cpu, gpus, disk: await readDiskInfo(tmpdir()), warnings }
  }

  private mapGpus(
    data: WinProbe | null,
    nvidiaRows: NvidiaRow[],
    nvidiaDriver: string | null,
    activeGpu: GpuActiveHint | null,
    warnings: string[]
  ): GpuInfo[] {
    const cimGpus = data?.gpus ?? []
    const regList = data?.reg ?? []
    const result: GpuInfo[] = []

    for (const raw of cimGpus) {
      const name = normalizeGpuName(raw.Name ?? '') || '未知显卡'
      const vendor = detectVendor({
        name,
        compatibility: raw.AdapterCompatibility,
        pnpId: raw.PNPDeviceID
      })
      const kind = detectKind({ name, vendor, pnpId: raw.PNPDeviceID })
      const id = gpuIdOf({ name, pnpId: raw.PNPDeviceID, vendor })

      const regEntry = regList.find((r) => r.desc && nameMatches(r.desc, name))
      let vramBytes = regEntry?.vram != null ? Number(regEntry.vram) : null
      if (!vramBytes || !Number.isFinite(vramBytes)) {
        const adapterRam = Number(raw.AdapterRAM)
        // AdapterRAM 是 32 位有符号，>4GB 会溢出，仅在小于 4GB 时采信
        vramBytes = Number.isFinite(adapterRam) && adapterRam > 0 && adapterRam < 4 * 1024 ** 3 ? adapterRam : null
      }

      const metrics = emptyGpuMetrics()
      let driverVersion = raw.DriverVersion ?? null

      if (vendor === 'nvidia') {
        const row =
          nvidiaRows.find((r) => nameMatches(r.name, name)) ??
          (nvidiaRows.length === 1 ? nvidiaRows[0] : undefined)
        if (row) {
          if (row.memTotal) vramBytes = Math.round(row.memTotal * 1024 * 1024)
          metrics.vramUsedBytes = row.memUsed ? Math.round(row.memUsed * 1024 * 1024) : null
          metrics.usage3dPct = row.util
          metrics.videoEncodePct = row.encoder
          metrics.videoDecodePct = row.decoder
          metrics.temperatureC = row.temp
          metrics.powerW = row.power
          metrics.powerLimitW = row.powerLimit
          if (nvidiaDriver) driverVersion = nvidiaDriver
        } else {
          warnings.push(`未检测到 nvidia-smi，${name} 的显存 / 温度 / 占用无法读取`)
        }
      }

      const activeMatch =
        activeGpu?.activeVendorId != null &&
        raw.PNPDeviceID?.toUpperCase().includes(
          `VEN_${activeGpu.activeVendorId.toString(16).toUpperCase().padStart(4, '0')}`
        )
          ? true
          : activeGpu?.deviceString
            ? nameMatches(activeGpu.deviceString, name)
            : null

      result.push({
        id,
        name,
        vendor,
        kind,
        vramBytes,
        driverVersion,
        activeForBrowser: kind === 'virtual' ? false : activeMatch,
        metrics,
        encoderHints: encoderHintsFor(vendor),
        note: kind === 'virtual' ? '虚拟 / 显示重定向设备，不参与渲染加速' : undefined
      })
    }

    // 只有 nvidia-smi 但没有 CIM 数据时的兜底
    if (result.length === 0 && nvidiaRows.length > 0) {
      for (const row of nvidiaRows) {
        const name = normalizeGpuName(row.name)
        result.push({
          id: gpuIdOf({ name, vendor: 'nvidia' }),
          name,
          vendor: 'nvidia',
          kind: 'discrete',
          vramBytes: row.memTotal ? Math.round(row.memTotal * 1024 * 1024) : null,
          driverVersion: nvidiaDriver,
          activeForBrowser: null,
          metrics: {
            ...emptyGpuMetrics(),
            usage3dPct: row.util,
            videoEncodePct: row.encoder,
            videoDecodePct: row.decoder,
            vramUsedBytes: row.memUsed ? Math.round(row.memUsed * 1024 * 1024) : null,
            temperatureC: row.temp,
            powerW: row.power,
            powerLimitW: row.powerLimit
          },
          encoderHints: encoderHintsFor('nvidia')
        })
      }
    }

    return result
  }

  async readMemory(): Promise<MemoryInfo> {
    const proc = await this.readProcessMemory()
    return basicMemoryInfo(proc.renderBytes)
  }

  async readProcessMemory(): Promise<ProcessMemorySample> {
    const script = [
      "$names = @('chrome','chrome-headless-shell','node','HF Render')",
      '$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName }',
      '$chrome = ($p | Where-Object { $_.ProcessName -like "chrome*" } | Measure-Object WorkingSet64 -Sum).Sum',
      '$node = ($p | Where-Object { $_.ProcessName -in @("node","HF Render") } | Measure-Object WorkingSet64 -Sum).Sum',
      '[pscustomobject]@{ chrome = [int64]$chrome; node = [int64]$node } | ConvertTo-Json -Compress'
    ].join('\n')
    const res = await runPowerShell(script, 12_000)
    const data = res.ok ? parseJson<{ chrome?: number; node?: number }>(res.stdout) : null
    if (!data) return { renderBytes: null, chromeBytes: null }
    return {
      renderBytes: typeof data.node === 'number' ? data.node : null,
      chromeBytes: typeof data.chrome === 'number' ? data.chrome : null
    }
  }

  startGpuSampler(onSample: (sample: GpuSample) => void, intervalMs: number): GpuSamplerHandle | null {
    const nvidia = findExecutable('nvidia-smi')
    if (nvidia) {
      const handle = this.startNvidiaSampler(nvidia, onSample, intervalMs)
      if (handle) return handle
    }
    return this.startCounterSampler(onSample, intervalMs)
  }

  private startNvidiaSampler(
    exe: string,
    onSample: (sample: GpuSample) => void,
    intervalMs: number
  ): GpuSamplerHandle | null {
    const query =
      'index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,power.limit'
    let child: ChildProcess
    try {
      child = spawn(
        exe,
        [`--query-gpu=${query}`, '--format=csv,noheader,nounits', `--loop-ms=${Math.max(500, intervalMs)}`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
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
        const row = parseNvidiaLine(line.trim())
        if (!row) continue
        onSample({
          gpuId: null,
          metrics: {
            usage3dPct: row.util,
            videoEncodePct: row.encoder,
            videoDecodePct: row.decoder,
            vramUsedBytes: row.memUsed != null ? Math.round(row.memUsed * 1024 * 1024) : null,
            temperatureC: row.temp,
            powerW: row.power,
            powerLimitW: row.powerLimit
          }
        })
      }
    })

    child.on('error', () => {
      /* 采样失败不影响渲染 */
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

  /** AMD / Intel / 无 nvidia-smi 时：用 Windows 性能计数器聚合 GPU 引擎占用 */
  private startCounterSampler(onSample: (sample: GpuSample) => void, intervalMs: number): GpuSamplerHandle | null {
    const ps = findPowerShell()
    if (!ps) return null

    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'while ($true) {',
      '  $e = (Get-Counter "\\GPU Engine(*)\\Utilization Percentage").CounterSamples',
      '  $d3 = 0.0; $ve = 0.0; $vd = 0.0; $cp = 0.0',
      '  foreach ($s in $e) {',
      '    if ($s.InstanceName -match "engtype_(\\w+)") {',
      '      $t = $matches[1].ToLower()',
      '      if ($t -eq "3d") { $d3 += $s.CookedValue }',
      '      elseif ($t -eq "videoencode") { $ve += $s.CookedValue }',
      '      elseif ($t -eq "videodecode") { $vd += $s.CookedValue }',
      '      elseif ($t -eq "copy") { $cp += $s.CookedValue }',
      '    }',
      '  }',
      '  $vram = 0',
      '  $m = (Get-Counter "\\GPU Adapter Memory(*)\\Dedicated Usage").CounterSamples',
      '  if ($m) { $vram = ($m | Measure-Object -Property CookedValue -Sum).Sum }',
      '  $o = [pscustomobject]@{ d3 = [math]::Min(100, [math]::Round($d3, 1)); ve = [math]::Min(100, [math]::Round($ve, 1)); vd = [math]::Min(100, [math]::Round($vd, 1)); cp = [math]::Min(100, [math]::Round($cp, 1)); vram = [int64]$vram }',
      '  Write-Output ("@@" + ($o | ConvertTo-Json -Compress))',
      '  Start-Sleep -Milliseconds ' + String(Math.max(1000, intervalMs)),
      '}'
    ].join('\n')

    let child: ChildProcess
    try {
      child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      return null
    }

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('@@')) continue
        const payload = parseJson<{ d3?: number; ve?: number; vd?: number; cp?: number; vram?: number }>(
          trimmed.slice(2)
        )
        if (!payload) continue
        onSample({
          gpuId: null,
          metrics: {
            usage3dPct: typeof payload.d3 === 'number' ? payload.d3 : null,
            videoEncodePct: typeof payload.ve === 'number' ? payload.ve : null,
            videoDecodePct: typeof payload.vd === 'number' ? payload.vd : null,
            copyPct: typeof payload.cp === 'number' ? payload.cp : null,
            vramUsedBytes: typeof payload.vram === 'number' && payload.vram > 0 ? payload.vram : null
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
      describe: () => `Windows GPU 性能计数器（约 ${Math.round((intervalMs + 3500) / 1000)}s 一次，系统计数器固有开销）`
    }
  }

  encoderFamilies(gpus: GpuInfo[]): EncoderFamily[] {
    const families = new Set<EncoderFamily>(['software'])
    for (const gpu of gpus) {
      if (gpu.kind === 'virtual') continue
      if (gpu.vendor === 'nvidia') families.add('nvidia')
      if (gpu.vendor === 'amd') families.add('amd')
      if (gpu.vendor === 'intel') families.add('intel')
    }
    return [...families]
  }

  captureSupport(): { parallelStream: boolean; fastCapture: boolean; note: string } {
    return {
      parallelStream: true,
      fastCapture: false,
      note: 'Windows 支持多 worker 并行截图；fast capture 依赖 Chrome 的 drawElementImage，官方默认仅在 macOS 启用'
    }
  }

  limitations(): string[] {
    return [
      'CPU 指令集在 Windows 上需要管理员权限或第三方工具，普通权限下显示 N/A',
      'CPU 温度取自 ACPI 热区（MSAcpi_ThermalZoneTemperature），部分机型该值并非核心温度或为固定值',
      'AMD / Intel 显卡的实时占用来自 Windows 性能计数器，单次采样约需 4 秒',
      '部分 NVIDIA 驱动下 nvidia-smi 的 utilization.encoder 恒为 0（本机实测如此），编码是否真正生效以 ffmpeg 实际使用的编码器为准'
    ]
  }
}
