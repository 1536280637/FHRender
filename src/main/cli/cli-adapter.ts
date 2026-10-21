import type { CliCapabilities, CliFeatureMatrix, CliOptionInfo } from '@shared/types/performance'
import { runCliCapture, stripAnsi } from '../process/hyperframes'
import { EnvironmentProfileCache } from '../cache/environment-profile-cache'
import { cacheCounters } from '../cache/counters'

const CACHE_TTL_MS = 10 * 60_000

interface ParsedHelp {
  options: CliOptionInfo[]
  flags: Set<string>
}

/**
 * 解析 CLI 帮助文本。所有能力判断都基于"当前安装版本实际打印的内容"，
 * 不把某个版本的参数写成永久规则。
 */
export function parseHelp(help: string): ParsedHelp {
  const options: CliOptionInfo[] = []
  const flags = new Set<string>()

  for (const raw of help.split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd()
    if (!line.trim()) continue

    // 形如：  -w, --workers=<workers>    Parallel render workers ...
    const withDesc = line.match(
      /^\s+((?:-{1,2}[A-Za-z0-9-]+(?:=<[^>]+>)?)(?:\s*,\s*-{1,2}[A-Za-z0-9-]+(?:=<[^>]+>)?)?)\s{2,}(\S.*)$/
    )
    // 形如（没有描述，独占一行）：  --no-page-side-compositing
    const solo = line.match(/^\s+(-{1,2}[A-Za-z0-9-]+(?:=<[^>]+>)?)\s*$/)

    const group = withDesc?.[1] ?? solo?.[1]
    if (!group) continue
    const description = withDesc?.[2]?.trim()

    for (const token of group.split(',').map((t) => t.trim()).filter(Boolean)) {
      const takesValue = token.includes('=')
      const flag = token.replace(/=.*$/, '')
      if (!/^-{1,2}[A-Za-z0-9-]+$/.test(flag)) continue
      flags.add(flag)
      options.push({ flag, takesValue, description })
    }
  }

  return { options, flags }
}

function detectVersion(help: string): string | null {
  const match = help.match(/v(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

function detectWorkerRange(help: string): { supportsAuto: boolean; max: number | null } {
  const line = help
    .split(/\r?\n/)
    .find((l) => /--workers/.test(l) && /\bnumber\b|auto|range/i.test(l))
  const supportsAuto = /['"]auto['"]|\bauto\b/i.test(line ?? '')
  const range = (line ?? '').match(/range[:\s]+(\d+)\s*-\s*(\d+)/i)
  return { supportsAuto, max: range ? Number(range[2]) : null }
}

function buildFeatures(flags: Set<string>): CliFeatureMatrix {
  return {
    gpuEncode: flags.has('--gpu'),
    browserGpu: flags.has('--browser-gpu') || flags.has('--no-browser-gpu'),
    fastCapture: flags.has('--experimental-fast-capture'),
    pageSideCompositing: flags.has('--page-side-compositing') || flags.has('--no-page-side-compositing'),
    lowMemoryMode: flags.has('--low-memory-mode') || flags.has('--no-low-memory-mode'),
    strictAll: flags.has('--strict-all'),
    hdr: flags.has('--hdr'),
    segmented: flags.has('--resume') || flags.has('--keep-segments'),
    maxConcurrentRenders: flags.has('--max-concurrent-renders'),
    browserTimeout: flags.has('--browser-timeout'),
    framesCacheDir: flags.has('--frames-cache-dir')
  }
}

function emptyCapabilities(command: string, error: string): CliCapabilities {
  return {
    probedAt: new Date().toISOString(),
    command,
    version: null,
    render: { ok: false, options: [], flags: [], error },
    benchmark: { available: false, options: [], flags: [], error },
    worker: { supportsAuto: true, min: 1, max: null, source: 'derived' },
    features: {
      gpuEncode: false,
      browserGpu: false,
      fastCapture: false,
      pageSideCompositing: false,
      lowMemoryMode: false,
      strictAll: false,
      hdr: false,
      segmented: false,
      maxConcurrentRenders: false,
      browserTimeout: false,
      framesCacheDir: false
    }
  }
}

export class CliAdapter {
  private getCliCommand: () => Promise<string>
  private envCache: EnvironmentProfileCache
  private cache: CliCapabilities | null = null
  private cachedAt = 0
  private cacheCommand = ''
  private inFlight: Promise<CliCapabilities> | null = null

  constructor(getCliCommand: () => Promise<string>, envCache = new EnvironmentProfileCache()) {
    this.getCliCommand = getCliCommand
    this.envCache = envCache
  }

  async probe(force = false): Promise<CliCapabilities> {
    const command = (await this.getCliCommand()).trim() || 'npx --yes hyperframes@latest'
    if (!force && this.cache && this.cacheCommand === command && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cache
    }
    if (this.inFlight) return this.inFlight

    // 跨启动缓存：CLI 命令 + 版本一致且未超过 24 小时，直接复用上次的 --help 解析结果
    if (!force) {
      const persisted = await this.envCache.getCliCapabilities(command)
      if (persisted) {
        cacheCounters.envCacheHits += 1
        this.cache = persisted
        this.cachedAt = Date.now()
        this.cacheCommand = command
        return persisted
      }
    }

    this.inFlight = (async () => {
      const started = Date.now()
      const renderRes = await runCliCapture(['render', '--help'], command, { timeoutMs: 180_000 })
      const helpText = stripAnsi(`${renderRes.stdout}\n${renderRes.stderr}`).trim()

      if (!renderRes.error && !/USAGE|OPTIONS/i.test(helpText)) {
        const reason =
          helpText.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300) ||
          `render --help 退出码 ${renderRes.code ?? 'unknown'}`
        const result = emptyCapabilities(command, reason)
        this.cache = result
        this.cachedAt = Date.now()
        this.cacheCommand = command
        return result
      }

      const parsed = parseHelp(helpText)
      const worker = detectWorkerRange(helpText)

      const benchmarkRes = await runCliCapture(['benchmark', '--help'], command, { timeoutMs: 90_000 })
      const benchText = stripAnsi(`${benchmarkRes.stdout}\n${benchmarkRes.stderr}`).trim()
      const benchParsed = parseHelp(benchText)
      const benchAvailable =
        !benchmarkRes.error && /USAGE\s+hyperframes\s+benchmark/i.test(benchText) && benchParsed.flags.size > 0

      const capabilities: CliCapabilities = {
        probedAt: new Date().toISOString(),
        command,
        version: detectVersion(helpText),
        render: {
          ok: true,
          options: parsed.options,
          flags: [...parsed.flags],
          probedMs: Date.now() - started
        },
        benchmark: {
          available: benchAvailable,
          options: benchParsed.options,
          flags: [...benchParsed.flags],
          error: benchAvailable ? undefined : benchText.split(/\r?\n/).slice(-2).join(' ').slice(0, 200) || undefined
        },
        worker: {
          supportsAuto: worker.supportsAuto,
          min: 1,
          max: worker.max,
          source: worker.max ? 'help' : 'derived'
        },
        features: buildFeatures(parsed.flags)
      }

      this.cache = capabilities
      this.cachedAt = Date.now()
      this.cacheCommand = command
      // 只有真的探测成功才落盘，失败结果不持久化（下次启动重试）
      if (capabilities.render.ok) {
        cacheCounters.envProbes += 1
        await this.envCache.saveCliCapabilities(command, capabilities)
      }
      return capabilities
    })()

    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  get cached(): CliCapabilities | null {
    return this.cache
  }

  invalidate(): void {
    this.cache = null
    this.cachedAt = 0
  }
}
