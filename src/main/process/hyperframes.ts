import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type {
  RenderRequest,
  RenderProgress,
  VideoFormat,
  RenderStats
} from '@shared/types/render'
import { checkBrowserTimeout } from '@shared/render-limits'
import type { CliCapabilities } from '@shared/types/performance'

/* ------------------------------------------------------------------ */
/* 格式能力表 —— 严格对应 `hyperframes render --help`（v0.8.x）            */
/* ------------------------------------------------------------------ */

export interface FormatCapability {
  label: string
  /** 输出是否为目录（PNG 序列 / HLS） */
  directoryOutput: boolean
  extension: string
  supportsCrf: boolean
  supportsBitrate: boolean
  supportsGpu: boolean
  supportsGifLoop: boolean
  supportsHlsSegment: boolean
  note?: string
}

export const FORMAT_CAPABILITIES: Record<VideoFormat, FormatCapability> = {
  mp4: {
    label: 'MP4',
    directoryOutput: false,
    extension: '.mp4',
    supportsCrf: true,
    supportsBitrate: true,
    supportsGpu: true,
    supportsGifLoop: false,
    supportsHlsSegment: false
  },
  webm: {
    label: 'WebM',
    directoryOutput: false,
    extension: '.webm',
    supportsCrf: true,
    supportsBitrate: true,
    supportsGpu: true,
    supportsGifLoop: false,
    supportsHlsSegment: false,
    note: 'WebM 支持透明通道'
  },
  mov: {
    label: 'MOV',
    directoryOutput: false,
    extension: '.mov',
    supportsCrf: false,
    supportsBitrate: false,
    supportsGpu: true,
    supportsGifLoop: false,
    supportsHlsSegment: false,
    note: 'MOV 固定使用 ProRes 4444（保留透明），不支持 CRF / 码率'
  },
  gif: {
    label: 'GIF',
    directoryOutput: false,
    extension: '.gif',
    supportsCrf: false,
    supportsBitrate: false,
    supportsGpu: true,
    supportsGifLoop: true,
    supportsHlsSegment: false,
    note: 'GIF 建议 15fps 以获得较好的体积与流畅度'
  },
  'png-sequence': {
    label: 'PNG Sequence',
    directoryOutput: true,
    extension: '',
    supportsCrf: false,
    supportsBitrate: false,
    supportsGpu: false,
    supportsGifLoop: false,
    supportsHlsSegment: false,
    note: 'PNG 序列输出到目录（RGBA 帧），供 AE / Nuke / Fusion 使用'
  },
  hls: {
    label: 'HLS',
    directoryOutput: true,
    extension: '',
    supportsCrf: false,
    supportsBitrate: false,
    supportsGpu: false,
    supportsGifLoop: false,
    supportsHlsSegment: true,
    note: 'HLS 输出为 VOD 播放列表目录（H.264/AAC，仅 SDR，不用 GPU 编码）'
  }
}

export function formatCapability(format: VideoFormat): FormatCapability {
  return FORMAT_CAPABILITIES[format] ?? FORMAT_CAPABILITIES.mp4
}

/* ------------------------------------------------------------------ */
/* 输出路径与文件名                                                     */
/* ------------------------------------------------------------------ */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 清洗文件 / 目录名，兼容 Windows 非法字符 */
export function sanitizeOutputName(input: string, format: VideoFormat): string {
  const cap = formatCapability(format)
  let name = (input ?? '').trim()
  // 去掉用户可能误输入的扩展名
  if (cap.extension && name.toLowerCase().endsWith(cap.extension)) {
    name = name.slice(0, -cap.extension.length)
  }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  name = name.replace(/[.\s]+$/g, '')
  if (!name) name = 'render'
  if (WINDOWS_RESERVED.test(name)) name = `${name}-out`
  return name.slice(0, 120)
}

export function resolveOutputPath(outputDir: string, outputName: string, format: VideoFormat): string {
  const cap = formatCapability(format)
  const safeName = sanitizeOutputName(outputName, format)
  return join(resolve(outputDir), `${safeName}${cap.extension}`)
}

/* ------------------------------------------------------------------ */
/* CLI 定位（跨平台 + 防命令注入）                                       */
/* ------------------------------------------------------------------ */

interface CliInvocation {
  file: string
  args: string[]
  /** 面向用户的逻辑命令（可在终端直接复现） */
  display: string
  /** 实际执行的进程与参数，用于排查 */
  realCommand: string
  /** 是否需要 shell（仅极端兜底场景为 true） */
  shell: boolean
  strategy: string
}

const WINDOWS = process.platform === 'win32'

function pathExtCandidates(base: string): string[] {
  if (!WINDOWS) return [base]
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [base, ...exts.map((e) => `${base}${e.toLowerCase()}`), ...exts.map((e) => `${base}${e}`)]
}

/** 在 PATH 中查找可执行文件 */
export function findExecutable(name: string): string | null {
  if (isAbsolute(name) && existsSync(name)) return name
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const candidate of pathExtCandidates(name)) {
      const full = join(dir, candidate)
      try {
        if (existsSync(full)) return full
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

export function findNodeExecutable(): string | null {
  if (process.env.HF_RENDER_NODE && existsSync(process.env.HF_RENDER_NODE)) {
    return process.env.HF_RENDER_NODE
  }
  return findExecutable('node')
}

/** 从 npx.cmd / npm.cmd 内容中解析 npm 的 cli js 入口 */
export async function resolveNpmCliJs(cmdPath: string): Promise<string | null> {
  const dir = dirname(cmdPath)
  // 只解析文本型的包装脚本（.cmd / .bat / shell 脚本），不要整块读 node.exe 这类二进制：
  // 读 100MB 的二进制当 UTF-8 会卡住事件循环几十秒，而且永远匹配不到 npm-cli.js。
  const stat = await fs.stat(cmdPath).catch(() => null)
  if (!stat || !stat.isFile() || stat.size > 512 * 1024) return null
  try {
    const content = await fs.readFile(cmdPath, 'utf-8')
    const match = content.match(/([^\s"']*node_modules[\\/]npm[\\/]bin[\\/](?:npx|npm)-cli\.js)/i)
    if (match) {
      // npx.cmd 内是 %~dp0%\node_modules\npm\bin\npx-cli.js（也有 %dp0% 写法）
      const rel = match[1].replace(/%~?dp0%?[\\/]?/i, '')
      const full = isAbsolute(rel) ? rel : resolve(dir, rel)
      if (existsSync(full)) return full
    }
  } catch {
    /* ignore */
  }
  // 标准安装布局
  const guessed = join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (existsSync(guessed)) return guessed
  const guessed2 = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(guessed2)) return guessed2
  return null
}

/** 把设置里的 CLI 命令拆成 token（支持引号） */
export function parseCliCommand(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function quoteDisplay(parts: string[]): string {
  return parts
    .map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(' ')
}

/**
 * hyperframes 的子命令。
 * 用户可能把「CLI 命令」写成 `npx hyperframes@0.8.176 preview`（把子命令也写进去了），
 * 我们再追加一次 `preview <目录>` 就会变成 `preview preview <目录>`，CLI 报
 * "Unexpected extra argument for hyperframes preview: <dir>"。
 * 这里统一把命令末尾多写的子命令剥掉，避免参数重复。
 */
const HYPERFRAMES_SUBCOMMANDS = new Set([
  'preview',
  'render',
  'doctor',
  'init',
  'list',
  'serve',
  'version',
  'help'
])

function stripTrailingSubcommand(binArgs: string[]): string[] {
  const out = [...binArgs]
  while (out.length > 0) {
    const last = out[out.length - 1].toLowerCase()
    if (!HYPERFRAMES_SUBCOMMANDS.has(last)) break
    out.pop()
  }
  return out
}

/**
 * 构造实际可执行的 CLI 调用。
 * 优先用 node 直接执行 npm 的 npx-cli.js：参数以数组传递，不经过 shell，
 * 因此项目路径中的中文、空格、& | ^ % 等字符不会被解释，也就不存在命令注入。
 */
export async function buildCliInvocation(
  cliArgs: string[],
  cliCommand: string
): Promise<CliInvocation> {
  const tokens = parseCliCommand(cliCommand || 'npx --yes hyperframes@latest')
  if (tokens.length === 0) tokens.push('npx', '--yes', 'hyperframes@latest')

  const [bin, ...rawBinArgs] = tokens
  const binArgs = stripTrailingSubcommand(rawBinArgs)
  const binName = bin.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? bin
  const isNpx = binName === 'npx' || binName === 'npx.cmd' || binName === 'npx.exe'
  const isNpm = binName === 'npm' || binName === 'npm.cmd' || binName === 'npm.exe'

  const fullArgs = [...binArgs, ...cliArgs]

  if (isNpx || isNpm) {
    const resolvedBin = findExecutable(bin)
    const cliJs = resolvedBin ? await resolveNpmCliJs(resolvedBin) : null
    if (cliJs) {
      const node = findNodeExecutable()
      if (node) {
        // npm exec 等价于 npx；若拿到 npm-cli.js 需要补 exec
        const needsExec = /npm-cli\.js$/i.test(cliJs) && !/^exec$/.test(fullArgs[0] ?? '')
        const args = [cliJs, ...(needsExec ? ['exec', '--'] : []), ...fullArgs]
        return {
          file: node,
          args,
          display: quoteDisplay([bin, ...fullArgs]),
          realCommand: quoteDisplay([node, ...args]),
          shell: false,
          strategy: `node+${needsExec ? 'npm exec' : 'npx'}`
        }
      }
    }
    if (!WINDOWS && resolvedBin) {
      return {
        file: resolvedBin,
        args: fullArgs,
        display: quoteDisplay([bin, ...fullArgs]),
        realCommand: quoteDisplay([resolvedBin, ...fullArgs]),
        shell: false,
        strategy: 'npx-direct'
      }
    }
  }

  // 兜底：Windows 上直接执行 .cmd 需要 cmd.exe（Node 22 起禁止无 shell 执行 .cmd）
  const resolved = findExecutable(bin)
  if (WINDOWS && (binName.endsWith('.cmd') || binName.endsWith('.bat') || /^npx$|^npm$/.test(binName))) {
    if (fullArgs.some((a) => /[%!]/.test(a))) {
      throw new Error(
        '无法安全地通过 cmd.exe 传递包含 % 或 ! 的参数，请确认 Node.js（含 npm/npx）已正确安装并在 PATH 中。'
      )
    }
    const cmdExe = process.env.ComSpec || 'cmd.exe'
    const inner = [resolved ?? bin, ...fullArgs]
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(' ')
    return {
      file: cmdExe,
      args: ['/d', '/s', '/c', `"${inner}"`],
      display: quoteDisplay([bin, ...fullArgs]),
      realCommand: `cmd.exe /d /s /c "${inner}"`,
      shell: false,
      strategy: 'cmd-wrapper'
    }
  }

  return {
    file: resolved ?? bin,
    args: fullArgs,
    display: quoteDisplay([bin, ...fullArgs]),
    realCommand: quoteDisplay([resolved ?? bin, ...fullArgs]),
    shell: false,
    strategy: 'direct'
  }
}

/* ------------------------------------------------------------------ */
/* 参数构造                                                             */
/* ------------------------------------------------------------------ */

function normalizeFps(mode: RenderRequest['fpsMode'], custom: string): string | null {
  if (mode === 'project') return null
  if (mode === 'custom') {
    const value = (custom ?? '').trim()
    if (!value) return null
    // 支持整数或 ffmpeg 风格有理数（30000/1001）
    if (/^\d+$/.test(value)) {
      const n = Number(value)
      return n >= 1 && n <= 240 ? String(n) : null
    }
    const m = value.match(/^(\d+)\s*\/\s*(\d+)$/)
    if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
      const fps = Number(m[1]) / Number(m[2])
      return fps >= 1 && fps <= 240 ? `${m[1]}/${m[2]}` : null
    }
    return null
  }
  return mode
}

export interface BuiltRenderArgs {
  args: string[]
  outputPath: string
  warnings: string[]
}

/** 依据真实 CLI 选项构造 `hyperframes render` 参数数组 */
export function buildRenderArgs(request: RenderRequest, cli?: CliCapabilities): BuiltRenderArgs {
  const cap = formatCapability(request.format)
  const warnings: string[] = []
  const outputPath = resolveOutputPath(request.outputDir, request.outputName, request.format)
  const args: string[] = ['render']

  args.push('--format', request.format)
  if (request.quality) args.push('-q', request.quality)

  const fps = normalizeFps(request.fpsMode, request.customFps)
  if (fps) args.push('-f', fps)

  if (request.resolution && request.resolution !== 'project') {
    args.push('--resolution', request.resolution)
  }

  if (request.workers === 'auto') {
    args.push('-w', 'auto')
  } else if (Number.isFinite(request.workers) && Number(request.workers) > 0) {
    args.push('-w', String(Math.min(64, Math.max(1, Math.round(Number(request.workers))))))
  }

  if (request.docker) args.push('--docker')

  if (request.gpu && cap.supportsGpu && !request.docker) {
    args.push('--gpu')
  } else if (request.gpu && !cap.supportsGpu) {
    warnings.push(`${cap.label} 不支持 GPU 编码，已忽略 GPU 选项`)
  } else if (request.gpu && request.docker) {
    warnings.push('Docker 渲染模式下已忽略 GPU 选项')
  }

  if (request.browserGpu === 'on') args.push('--browser-gpu')
  else if (request.browserGpu === 'off') args.push('--no-browser-gpu')

  const crf = request.crf
  const bitrate = (request.videoBitrate ?? '').trim()
  if (crf !== null && crf !== undefined && Number.isFinite(Number(crf))) {
    if (cap.supportsCrf && !bitrate) {
      const value = Math.min(63, Math.max(0, Math.round(Number(crf))))
      args.push('--crf', String(value))
    } else if (!cap.supportsCrf) {
      warnings.push(`${cap.label} 不支持 --crf，已忽略`)
    }
  }
  if (bitrate) {
    if (cap.supportsBitrate && (crf === null || crf === undefined)) {
      args.push('--video-bitrate', bitrate)
    } else if (!cap.supportsBitrate) {
      warnings.push(`${cap.label} 不支持 --video-bitrate，已忽略`)
    }
  }

  if (cap.supportsGifLoop) {
    const loop = Number.isFinite(Number(request.gifLoop)) ? Math.max(0, Math.round(Number(request.gifLoop))) : 0
    args.push('--gif-loop', String(loop))
  }
  if (cap.supportsHlsSegment) {
    const seg = Math.min(60, Math.max(1, Math.round(Number(request.hlsSegmentSeconds) || 4)))
    args.push('--hls-segment-seconds', String(seg))
  }

  if (request.strict) args.push('--strict')

  /* ---------------- 性能引擎写入的高级选项（按 CLI 能力启用） ---------------- */

  const extra = request.extra
  if (extra) {
    const flags = new Set(cli?.render.flags ?? [])
    const features = cli?.features

    if (extra.fastCapture === 'on') {
      if (flags.has('--experimental-fast-capture')) args.push('--experimental-fast-capture')
      else warnings.push('当前 CLI 版本不支持 --experimental-fast-capture，已忽略 fast capture')
    } else if (extra.fastCapture === 'off') {
      if (flags.has('--experimental-fast-capture')) args.push('--experimental-fast-capture=false')
    }

    if (features?.pageSideCompositing) {
      args.push(extra.pageSideCompositing ? '--page-side-compositing' : '--no-page-side-compositing')
    }

    if (features?.lowMemoryMode && extra.lowMemoryMode !== 'auto') {
      args.push(extra.lowMemoryMode === 'on' ? '--low-memory-mode' : '--no-low-memory-mode')
    }

    if (features?.browserTimeout && extra.browserTimeoutSec && extra.browserTimeoutSec > 0) {
      // 兜底：UI / 旧配置 / 手改 JSON 都可能塞进 1s 这类必然失败的值。
      // 该参数实际是 page.goto 导航超时（见 render-limits.ts 的说明），危险值一律不下发。
      const navTimeout = checkBrowserTimeout(extra.browserTimeoutSec)
      if (navTimeout.value) {
        args.push('--browser-timeout', String(navTimeout.value))
      } else if (navTimeout.ignored && navTimeout.reason) {
        warnings.push(navTimeout.reason)
      }
    }

    if (extra.playerReadyTimeoutMs && extra.playerReadyTimeoutMs > 0 && flags.has('--player-ready-timeout')) {
      args.push('--player-ready-timeout', String(Math.round(extra.playerReadyTimeoutMs)))
    }

    if (cli && !features?.fastCapture && extra.fastCapture === 'on') {
      warnings.push('该 CLI 未声明 fast capture 能力，渲染将使用默认截图捕获')
    }
  }

  const composition = (request.composition ?? '').trim()
  if (composition && composition !== 'index.html' && composition !== '.') {
    args.push('-c', composition)
  }

  args.push('-o', outputPath)
  return { args, outputPath, warnings }
}

/* ------------------------------------------------------------------ */
/* 输出解析                                                             */
/* ------------------------------------------------------------------ */

const PROGRESS_CODES: Record<string, string> = {
  compile: '编译合成',
  extract_video: '提取视频素材',
  process_audio: '处理音频',
  start_browsers: '启动渲染浏览器',
  capture: '捕获帧',
  encode: '编码视频',
  assemble: '合成输出',
  done: '完成'
}

export interface ParsedLine {
  progress?: RenderProgress
  /** 结果输出路径 */
  outputPath?: string
  stats?: Partial<RenderStats>
  level?: 'info' | 'warn' | 'error' | 'success' | 'debug'
  /** 该行是否仅供内部解析，不必展示 */
  hidden?: boolean
}

// ANSI 转义序列（CSI / OSC / 双字符），覆盖光标隐藏、清行、颜色等
const ANSI =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** 终端里只有边框/装饰字符的行，直接丢弃 */
export function isDecorationLine(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return /^[│┃┆┇┊┋╎╏|│\s]+$/.test(trimmed)
}

/** CLI 的 TTY 转圈动画帧 */
const SPINNER = /^[◐◓◑◒◜◝◞◟⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

/**
 * 解析单行 CLI 输出。
 * 只使用 CLI 真实打印的信息：@hf-progress JSON 标记与百分比进度条。
 */
export function parseLine(rawLine: string): ParsedLine {
  const line = stripAnsi(rawLine).replace(/\r$/, '')
  const result: ParsedLine = {}

  const marker = line.match(/@hf-progress\s+(\{.*\})\s*$/)
  if (marker) {
    result.hidden = true
    try {
      const data = JSON.parse(marker[1]) as {
        code?: string
        pct?: number
        done?: number
        total?: number
      }
      const pct = typeof data.pct === 'number' ? Math.min(100, Math.max(0, data.pct)) : null
      if (data.code === 'done') {
        result.progress = { pct: 100, code: 'done', label: '完成' }
      } else if (pct !== null && data.code) {
        result.progress = {
          pct,
          code: data.code,
          label: PROGRESS_CODES[data.code] ?? data.code,
          done: data.done,
          total: data.total
        }
      }
    } catch {
      /* 忽略解析失败的标记 */
    }
    return result
  }

  // 进度条兜底：███░░  53%  Streaming frame 76/150
  const bar = line.match(/^\s*[█▓▒░]+\s+(\d{1,3})%\s+(.+?)\s*$/)
  if (bar) {
    result.level = 'debug'
    const pct = Math.min(100, Math.max(0, Number(bar[1])))
    const text = bar[2]
    const frame = text.match(/(\d+)\s*\/\s*(\d+)/)
    result.progress = {
      pct,
      label: text.replace(/\s*\(\d+ workers?\)/, ''),
      done: frame ? Number(frame[1]) : undefined,
      total: frame ? Number(frame[2]) : undefined
    }
    return result
  }

  // 结果行：◇  D:\out\video.mp4
  const out = line.match(/^◇\s+(.+?)\s*$/)
  if (out) {
    result.level = 'success'
    result.outputPath = out[1]
    return result
  }

  // 概要行：12.1 KB · 10.0s video · rendered in 25.1s
  if (/·\s*\d+(\.\d+)?\s*(B|KB|MB|GB)\b/i.test(line) || /rendered in\s+/i.test(line)) {
    result.level = 'info'
    const parts = line.split('·').map((s) => s.trim())
    const stats: Partial<RenderStats> = { summary: line.trim() }
    for (const part of parts) {
      if (/^(B|KB|MB|GB)$/i.test(part.replace(/^[\d.\s]+/, '').trim())) stats.sizeText = part
      else if (/^\d+(\.\d+)?s video$/i.test(part)) stats.durationText = part
      else if (/^rendered in\s+/i.test(part)) stats.elapsedText = part.replace(/^rendered in\s+/i, '')
    }
    result.stats = stats
    return result
  }

  if (/^\s*✗/.test(line) || /\bERROR\b|PAGEERROR|Uncaught|error:/i.test(line)) {
    result.level = 'error'
    return result
  }
  if (/\bWARN\b|warning:|⚠/i.test(line)) {
    result.level = 'warn'
    return result
  }
  // TTY 转圈动画 / 调试追踪，默认隐藏（需要时在日志面板勾选“调试”）
  if (
    SPINNER.test(line.trim()) ||
    /^\[(info|render|hyperframes|browsermanager|browser|initsession)/i.test(line)
  ) {
    result.level = 'debug'
  }
  return result
}

/**
 * 把 CLI 的磁盘捕获空间不足报错翻成可执行的中文提示。
 * 原文示例：
 * "Disk capture may need ~27869.2 MB of temporary frame storage, but only 20788.0 MB is free at C:\...\captured-frames."
 */
export function describeDiskShortfall(line: string): string {
  const match = line.match(
    /may need ~?([\d.]+)\s*MB of temporary frame storage.*?only ([\d.]+)\s*MB is free at (.+?)\./i
  )
  const toGB = (mb: string): string => `${(Number(mb) / 1024).toFixed(1)} GB`
  if (match) {
    const [, needMb, freeMb, dir] = match
    return (
      `临时空间不足：本次渲染会把每一帧先写到磁盘，需要约 ${toGB(needMb)}，` +
      `而 ${dir} 所在盘仅剩 ${toGB(freeMb)}。` +
      `解决办法：① mp4 / mov 把 Workers 改成 1 即可改为流式编码，不再占用临时帧存储；` +
      `② 在「高级参数 → 临时帧存储目录」里把暂存位置改到剩余空间更大的盘；` +
      `③ 或清理该盘后重试。`
    )
  }
  return (
    '临时空间不足：磁盘捕获需要把每一帧先写入临时目录，可用空间不够。' +
    '把 Workers 改成 1（mp4 / mov 会改用流式编码）或更换空间更大的暂存盘后重试。'
  )
}

/**
 * 把并行捕获的「页面就绪超时」报错翻成可执行的中文提示。
 * 原文示例：
 * "[FrameCapture] window.__hf not ready after 45000ms. Page must expose window.__hf = { duration, seek }.
 *  State: __hf=true, seek=true, player=true, renderReady=true, duration=182"
 * duration > 0 说明页面最终是初始化成功的，只是没赶上超时时间——不是页面本身有问题。
 */
export function describeReadyTimeout(line: string): string {
  const match = line.match(/not ready after (\d+)ms/i)
  const state = line.match(/State:\s*(.+)$/im)
  const waitedSec = match ? Math.round(Number(match[1]) / 1000) : null
  const duration = state?.[1].match(/duration=(-?\d+)/)?.[1] ?? null

  if (duration && Number(duration) > 0) {
    return (
      `页面就绪超时：某个 worker 的浏览器没能在 ${waitedSec ?? 45}s 内完成 composition 初始化` +
      `（页面本身是正常的，已经识别到时长 ${duration}s，只是初始化太慢）。` +
      `原因是多个 Chrome 同时启动时争夺 CPU / 内存，单个 worker 迟迟跑不完初始化。` +
      `解决办法：① 减少 Workers 数量；② 首次渲染先跑一小段（Draft 质量）把页面依赖预热；` +
      `③ 本机内存吃紧时先关闭其它占用大的程序。`
    )
  }
  return (
    `页面就绪超时：某个 worker 在 ${waitedSec ?? 45}s 内没有暴露可用的 window.__hf。` +
    `请确认页面能独立打开并完成初始化（是否有无限循环动画、未加载完的视频 / 字体、或 data-duration 缺失）。`
  )
}

/** 从 CLI 错误输出中提取一句人类可读的错误标题 */
export function extractErrorMessage(lines: string[]): string {
  const cleaned = lines.map((l) => stripAnsi(l).trim()).filter(Boolean)
  if (cleaned.length === 0) return ''

  const joined = cleaned.join('\n')

  const diskShortfall = cleaned.find((l) => /Disk capture may need/i.test(l))
  if (diskShortfall) return describeDiskShortfall(diskShortfall)

  const readyTimeoutLine = cleaned.find((l) => /window\.__hf not ready after/i.test(l))
  if (readyTimeoutLine) return describeReadyTimeout(readyTimeoutLine)

  const known: { pattern: RegExp; message: string }[] = [
    { pattern: /Aborting render due to lint issues/i, message: 'lint 检查未通过，已按 --strict 中止渲染' },
    { pattern: /Composition not found/i, message: '找不到指定的 composition 文件' },
    { pattern: /Failed to launch|browser.*not.*launch/i, message: '无法启动渲染浏览器，请检查 Chrome 缓存与 GPU 驱动' },
    { pattern: /ffmpeg.*not found|Cannot find ffmpeg/i, message: '未找到 FFmpeg，请安装并加入 PATH' },
    { pattern: /ENOENT|no such file or directory/i, message: '文件或目录不存在' },
    { pattern: /EACCES|permission denied/i, message: '没有写入权限，请更换输出目录' },
    {
      pattern: /Cannot find module .*[\\/]_npx[\\/]/i,
      message: 'npx 缓存里的 HyperFrames 安装已损坏（安装过程被中断过），请执行 npm cache clean --force 后重试'
    },
    { pattern: /Cannot find module/i, message: 'CLI 依赖缺失，请重新安装 HyperFrames' }
  ]
  for (const item of known) {
    if (item.pattern.test(joined)) return item.message
  }

  const marker = cleaned.find((l) => l.startsWith('✗'))
  if (marker) {
    const idx = cleaned.indexOf(marker)
    const detail = cleaned
      .slice(idx + 1)
      .filter((l) => !l.startsWith('✗'))
      .slice(0, 2)
      .join(' ')
    return detail ? `${marker.replace(/^✗\s*/, '')} — ${detail}`.slice(0, 400) : marker.replace(/^✗\s*/, '')
  }

  const errLine = [...cleaned].reverse().find((l) => /error|failed|invalid|abort/i.test(l))
  if (errLine) return errLine.slice(0, 400)

  return cleaned
    .slice(-2)
    .join(' | ')
    .slice(0, 400)
}

/* ------------------------------------------------------------------ */
/* 执行与返回                                                           */
/* ------------------------------------------------------------------ */

export interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
  display: string
}

/** 执行任意进程并收集输出（不经过 shell） */
export function runProcess(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; display?: string } = {}
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise<CaptureResult>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd: options.cwd && existsSync(options.cwd) ? options.cwd : undefined,
        env: { ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
        windowsHide: true,
        shell: false
      })
    } catch (err) {
      resolvePromise({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
        display: options.display ?? file
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf-8')
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf-8')
    })

    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut, error, display: options.display ?? file })
    }

    child.on('error', (err) => finish(null, err.message))
    child.on('close', (code) => finish(code))
  })
}

/** 一次性执行 CLI 并收集输出（用于 doctor / lint / info / compositions） */
export async function runCliCapture(
  cliArgs: string[],
  cliCommand: string,
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CaptureResult> {
  let invocation: CliInvocation
  try {
    invocation = await buildCliInvocation(cliArgs, cliCommand)
  } catch (err) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: err instanceof Error ? err.message : String(err),
      display: ''
    }
  }

  return runProcess(invocation.file, invocation.args, {
    ...options,
    display: invocation.display
  })
}

/** 直接用 node 执行 npm / npx 的 cli js（用于版本探测，避免 shell） */
export async function runNpmCapture(
  which: 'npm' | 'npx',
  args: string[],
  timeoutMs = 30_000
): Promise<CaptureResult> {
  const binPath = findExecutable(which)
  const node = findNodeExecutable()
  if (binPath && node) {
    const cliJs = await resolveNpmCliJs(binPath)
    if (cliJs) {
      return runProcess(node, [cliJs, ...args], {
        timeoutMs,
        display: `${which} ${args.join(' ')}`
      })
    }
  }
  return {
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    error: `${which} not found`,
    display: `${which} ${args.join(' ')}`
  }
}

/** 结束子进程及其所有子进程（Windows 用 taskkill /T，Unix 用进程组） */
export function killProcessTree(child: ChildProcess): void {
  if (!child || child.killed || child.pid === undefined) return
  const pid = child.pid
  if (WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    return
  }
  try {
    // detached 启动时 pid 即进程组 id
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    if (!child.killed) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  }, 4000)
}

/** 从混合文本中提取第一个完整 JSON 对象（doctor 可能先打印无关信息） */
export function extractJsonObject<T>(text: string): T | null {
  const cleaned = stripAnsi(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    return null
  }
}

export function normalizeDisplayPath(p: string): string {
  return normalize(p)
}
