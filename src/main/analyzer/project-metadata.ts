/**
 * HyperFrames 项目元数据分析器。
 *
 * 设计原则（对应本次修复要求）：
 * 1. 先用当前安装版本真实打印的 `--help` 判断 `info` / `compositions` 是否可用、
 *    是否支持 `--json`，再决定是否调用——不按版本号猜能力；
 * 2. 时长只来自官方 `info --json` / `compositions --json` 或根元素 `data-duration`；
 *    拿不到就是 null（界面显示「待检测」），绝不再出现「默认 4 秒」；
 * 3. 项目原始 FPS 只来自根元素 `data-fps`；CLI 在未声明时使用 30，这个 30 单独
 *    记录为 `cliDefaultFps`，不覆盖 `projectFps`；
 * 4. 多 Composition 项目只取「当前渲染入口」对应那一个，绝不把各 Composition 时长相加。
 */

import { promises as fs } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type {
  CompositionInfo,
  MetadataSource,
  ProjectCommandCapability,
  ProjectMetadata
} from '@shared/types/project'
import { extractJsonObject, runCliCapture, stripAnsi } from '../process/hyperframes'
import { cacheCounters } from '../cache/counters'

interface InfoJson {
  name?: string
  resolution?: string
  width?: number
  height?: number
  duration?: number
  elements?: number
  tracks?: number
  types?: Record<string, number>
  size?: number
  /** 部分版本可能把 composition 列表直接放在 info 里 */
  compositions?: CompositionInfo[]
  _meta?: { version?: string }
}

interface CompositionsJson {
  compositions?: CompositionInfo[]
  _meta?: { version?: string }
}

interface RootFacts {
  compositionId: string | null
  durationSec: number | null
  fps: number | null
  width: number | null
  height: number | null
  /** 是否找到了可解析的合成根元素 */
  found: boolean
}

const NUMBER_ATTRS: { attr: string; key: keyof Omit<RootFacts, 'compositionId' | 'found'> }[] = [
  { attr: 'data-duration', key: 'durationSec' },
  { attr: 'data-fps', key: 'fps' },
  { attr: 'data-width', key: 'width' },
  { attr: 'data-height', key: 'height' }
]

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i')
  const m = tag.match(re)
  if (!m) return null
  return (m[2] ?? m[3] ?? m[4] ?? '').trim() || null
}

function num(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 从 HTML 里找合成根元素并读取属性。
 * 只做属性解析，不做「用 DOM 结构猜时长」这类不可靠推断。
 */
export function parseRootFacts(html: string): RootFacts {
  const facts: RootFacts = {
    compositionId: null,
    durationSec: null,
    fps: null,
    width: null,
    height: null,
    found: false
  }

  // 1. 优先：带 data-composition-id 的元素（HyperFrames 实际渲染的对象）
  const compTag = html.match(/<[a-zA-Z][\w-]*\b[^>]*\bdata-composition-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)
  const tags: string[] = []
  if (compTag) tags.push(compTag[0])

  // 2. 兜底：html / body 上直接声明（部分项目把 data-duration 放在 <html>）
  for (const name of ['html', 'body']) {
    const m = html.match(new RegExp(`<${name}\\b[^>]*>`, 'i'))
    if (m) tags.push(m[0])
  }

  for (const tag of tags) {
    if (!facts.compositionId) {
      const id = attr(tag, 'data-composition-id')
      if (id) facts.compositionId = id
    }
    for (const item of NUMBER_ATTRS) {
      if (facts[item.key] !== null) continue
      const value = num(attr(tag, item.attr))
      if (value !== null) facts[item.key] = value
    }
  }

  facts.found = facts.compositionId !== null || facts.durationSec !== null || facts.fps !== null
  return facts
}

async function readTextFile(path: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return await fs.readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** 从 render --help 里读出「未声明 data-fps 时用的默认帧率」 */
export function parseDefaultFps(help: string): number | null {
  const text = stripAnsi(help)
  const declared = text.match(/defaults?\s+to[^.\n]*?else\s+(\d{1,3})/i)
  if (declared) return Number(declared[1])
  const line = text.split(/\r?\n/).find((l) => /-f,\s*--fps/.test(l) || /--fps=/.test(l))
  const fallback = line?.match(/default[:\s]+(\d{1,3})/i)
  return fallback ? Number(fallback[1]) : null
}

export class ProjectMetadataAnalyzer {
  private getCliCommand: () => Promise<string>
  private capabilityCache = new Map<string, ProjectCommandCapability>()
  private capabilityInFlight = new Map<string, Promise<ProjectCommandCapability>>()

  constructor(getCliCommand: () => Promise<string>) {
    this.getCliCommand = getCliCommand
  }

  /**
   * 探测当前 CLI 的项目元数据能力。
   * `info --help` / `compositions --help` 都很轻，但仍按 CLI 命令 + 版本记忆，
   * 避免每次进入页面重复执行。
   */
  async probeCapability(cliCommand?: string): Promise<ProjectCommandCapability> {
    const command = cliCommand ?? (await this.getCliCommand())
    const hit = this.capabilityCache.get(command)
    if (hit) return hit
    const running = this.capabilityInFlight.get(command)
    if (running) return running

    const task = (async (): Promise<ProjectCommandCapability> => {
      const [infoHelp, compHelp, renderHelp] = await Promise.all([
        runCliCapture(['info', '--help'], command, { timeoutMs: 60_000 }),
        runCliCapture(['compositions', '--help'], command, { timeoutMs: 60_000 }),
        runCliCapture(['render', '--help'], command, { timeoutMs: 90_000 })
      ])

      const infoText = stripAnsi(`${infoHelp.stdout}\n${infoHelp.stderr}`)
      const compText = stripAnsi(`${compHelp.stdout}\n${compHelp.stderr}`)
      const renderText = stripAnsi(`${renderHelp.stdout}\n${renderHelp.stderr}`)

      const infoOk = /USAGE\s+hyperframes\s+info/i.test(infoText)
      const compOk = /USAGE\s+hyperframes\s+compositions/i.test(compText)
      const infoJson = /--json\b/.test(infoText)
      const compJson = /--json\b/.test(compText)
      const version = (infoText.match(/hyperframes info v(\d+\.\d+\.\d+)/) ?? renderText.match(/v(\d+\.\d+\.\d+)/))?.[1]

      const capability: ProjectCommandCapability = {
        info: infoOk && infoJson,
        compositions: compOk && compJson,
        json: infoOk && compOk && infoJson && compJson,
        error:
          infoOk && compOk
            ? null
            : `当前 CLI 未提供 ${[!infoOk ? 'info' : null, !compOk ? 'compositions' : null]
                .filter(Boolean)
                .join(' / ')} 命令`,
        defaultFps: parseDefaultFps(renderText),
        cliVersion: version ?? null,
        probedAt: new Date().toISOString()
      }
      this.capabilityCache.set(command, capability)
      return capability
    })().finally(() => {
      this.capabilityInFlight.delete(command)
    })

    this.capabilityInFlight.set(command, task)
    return task
  }

  /** 已缓存的 CLI 能力（没有则为 null） */
  get cachedCapability(): ProjectCommandCapability | null {
    const values = [...this.capabilityCache.values()]
    return values.length > 0 ? values[values.length - 1] : null
  }

  /** 写入外部带来的能力（来自环境缓存，避免重复探测） */
  primeCapability(cliCommand: string, capability: ProjectCommandCapability): void {
    this.capabilityCache.set(cliCommand, capability)
  }

  /** CLI 版本变化后调用：清掉内存里的能力缓存，下次重新读 --help */
  invalidateCapability(): void {
    this.capabilityCache.clear()
  }

  /**
   * 分析一个项目：官方 info/compositions 优先，入口 HTML 属性兜底。
   * 任何一步失败都写入 warnings，不会中断整个分析。
   */
  async analyze(input: {
    projectPath: string
    /** 用户当前选择的渲染入口（文件相对路径或 composition id） */
    composition?: string | null
    /** 项目内 html 文件列表（可选，用于按 id 定位 composition 文件） */
    entryFiles?: string[]
  }): Promise<ProjectMetadata> {
    const projectPath = input.projectPath
    const cliCommand = await this.getCliCommand()
    const capability = await this.probeCapability(cliCommand)
    const warnings: string[] = []
    const detectedAt = new Date().toISOString()

    /* ---------------- 入口文件与根元素属性 ---------------- */

    const entryFiles = input.entryFiles ?? []
    const compositionArg = (input.composition ?? '').trim()
    const preferredEntry =
      compositionArg && /\.html?$/i.test(compositionArg)
        ? compositionArg.replace(/\\/g, '/')
        : 'index.html'

    const rootFacts = await this.readRootFacts(projectPath, preferredEntry, compositionArg, entryFiles)
    if (!rootFacts) {
      warnings.push(`未能读取入口文件 ${preferredEntry}（文件不存在或体积过大），根元素属性不可用`)
    }

    /* ---------------- 官方 CLI 元数据 ---------------- */

    let info: InfoJson | null = null
    let compositions: CompositionInfo[] = []
    let cliVersion: string | null = capability.cliVersion

    if (capability.info) {
      cacheCounters.cliInfoCalls += 1
      const res = await runCliCapture(['info', projectPath, '--json'], cliCommand, {
        cwd: projectPath,
        timeoutMs: 120_000
      })
      if (res.code === 0) {
        info = extractJsonObject<InfoJson>(res.stdout)
        cliVersion = info?._meta?.version ?? cliVersion
        if (!info) warnings.push('info --json 输出无法解析为 JSON')
      } else {
        warnings.push(
          `info --json 执行失败（退出码 ${res.code ?? 'unknown'}）：${firstLine(
            stripAnsi(res.stderr) || res.error || ''
          )}`
        )
      }
    } else {
      warnings.push(capability.error ?? '当前 CLI 不支持 info 命令')
    }

    if (capability.compositions) {
      cacheCounters.cliCompositionCalls += 1
      const res = await runCliCapture(['compositions', projectPath, '--json'], cliCommand, {
        cwd: projectPath,
        timeoutMs: 120_000
      })
      if (res.code === 0) {
        const parsed = extractJsonObject<CompositionsJson>(res.stdout)
        compositions = parsed?.compositions ?? []
        cliVersion = parsed?._meta?.version ?? cliVersion
      } else {
        warnings.push(
          `compositions --json 执行失败（退出码 ${res.code ?? 'unknown'}）：${firstLine(
            stripAnsi(res.stderr) || res.error || ''
          )}`
        )
      }
    } else if (capability.error) {
      warnings.push(capability.error)
    }

    if (compositions.length === 0 && info?.compositions) compositions = info.compositions

    /* ---------------- 定位当前渲染入口对应的 composition ---------------- */

    /** 用户是否明确指定了 index.html 之外的入口文件 */
    const explicitEntry =
      !!compositionArg && /\.html?$/i.test(compositionArg) && !/^index\.html?$/i.test(compositionArg)

    const compositionId = rootFacts?.compositionId ?? matchCompositionId(compositionArg, compositions)
    const matchedComposition = compositionId
      ? (compositions.find((c) => c.id === compositionId) ?? null)
      : compositions.length === 1
        ? compositions[0]
        : null

    /* ---------------- 时长 ---------------- */
    // 规则：显式选择的入口文件 > 匹配到的 composition > info > 入口根元素 data-duration。
    // 绝不把多个 composition 的时长相加，也不会拿子 composition 冒充整个项目。

    let durationSec: number | null = null
    let durationSource: MetadataSource = 'unknown'
    if (explicitEntry && rootFacts?.durationSec && rootFacts.durationSec > 0) {
      durationSec = rootFacts.durationSec
      durationSource = 'entry-html'
    } else if (matchedComposition?.duration && matchedComposition.duration > 0) {
      durationSec = matchedComposition.duration
      durationSource = 'composition'
    } else if (typeof info?.duration === 'number' && info.duration > 0) {
      durationSec = info.duration
      durationSource = 'cli-info'
    } else if (rootFacts?.durationSec && rootFacts.durationSec > 0) {
      durationSec = rootFacts.durationSec
      durationSource = 'entry-html'
    }

    if (durationSec === null) {
      warnings.push('无法从 info / compositions / 根元素 data-duration 得到时长，界面将显示「时长待检测」')
    }

    if (compositions.length > 1) {
      warnings.push(
        `项目含 ${compositions.length} 个 composition，界面只展示当前渲染入口（${
          compositionId ?? '未识别'
        }）的时长与分辨率，不做求和`
      )
    }

    /* ---------------- 分辨率 / FPS ---------------- */

    const width = explicitEntry
      ? (rootFacts?.width ?? matchedComposition?.width ?? info?.width ?? null)
      : (matchedComposition?.width ?? info?.width ?? rootFacts?.width ?? null)
    const height = explicitEntry
      ? (rootFacts?.height ?? matchedComposition?.height ?? info?.height ?? null)
      : (matchedComposition?.height ?? info?.height ?? rootFacts?.height ?? null)

    const projectFps = rootFacts?.fps ?? null
    const projectFpsSource: MetadataSource = projectFps !== null ? 'entry-html' : 'unknown'
    if (projectFps === null) {
      warnings.push(
        capability.defaultFps
          ? `根元素未声明 data-fps，按当前 CLI 规则默认 ${capability.defaultFps}fps 导出（项目原始帧率未知）`
          : '根元素未声明 data-fps，且未能从 render --help 读出默认帧率'
      )
    }

    const name = info?.name && info.name.trim() ? info.name.trim() : basename(projectPath)

    return {
      path: projectPath,
      name,
      compositionId: compositionId ?? matchedComposition?.id ?? null,
      width,
      height,
      durationSec,
      durationSource,
      projectFps,
      projectFpsSource,
      cliDefaultFps: capability.defaultFps,
      elements: typeof info?.elements === 'number' ? info.elements : (matchedComposition?.elementCount ?? null),
      tracks: typeof info?.tracks === 'number' ? info.tracks : null,
      types: info?.types ?? {},
      projectBytes: typeof info?.size === 'number' ? info.size : null,
      compositions,
      capability,
      cliVersion,
      detectedAt,
      warnings
    }
  }

  /** 读取入口文件根元素；给定 composition id 但 index.html 不匹配时，按 id 在项目内查找 */
  private async readRootFacts(
    projectPath: string,
    preferredEntry: string,
    compositionArg: string,
    entryFiles: string[]
  ): Promise<RootFacts | null> {
    const tryFile = async (rel: string): Promise<RootFacts | null> => {
      const text = await readTextFile(join(projectPath, rel))
      if (!text) return null
      const facts = parseRootFacts(text)
      return facts.found ? facts : null
    }

    const primary = await tryFile(preferredEntry)
    const isFileArg = /\.html?$/i.test(compositionArg)
    if (
      primary &&
      (isFileArg || !compositionArg || !primary.compositionId || primary.compositionId === compositionArg)
    ) {
      return primary
    }

    // composition 可能是 id（不是文件）：在项目 html 里找声明了该 id 的文件
    const wanted = compositionArg || primary?.compositionId || ''
    if (!wanted) return primary
    const candidates = entryFiles
      .filter((file) => /\.html?$/i.test(file) && file.replace(/\\/g, '/') !== preferredEntry)
      .slice(0, 40)
    for (const rel of candidates) {
      const text = await readTextFile(join(projectPath, rel), 1024 * 1024)
      if (!text || !text.includes(wanted)) continue
      const facts = parseRootFacts(text)
      if (facts.compositionId === wanted) return facts
    }
    return primary
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? '（无输出）'
  )
}

/** composition 参数可能写成 `main`、`compositions/main.html` 或绝对路径 */
function matchCompositionId(compositionArg: string, compositions: CompositionInfo[]): string | null {
  if (!compositionArg) return null
  const plain = compositionArg.replace(/\\/g, '/')
  const stem = plain
    .replace(/^.*\//, '')
    .replace(/\.html?$/i, '')
  const byId = compositions.find((c) => c.id === compositionArg)
  if (byId) return byId.id
  const byStem = compositions.find((c) => c.id === stem)
  if (byStem) return byStem.id
  return null
}

/** 供调试：项目内相对路径 */
export function relOf(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/')
}
