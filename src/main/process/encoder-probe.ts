/**
 * 真实编码器探测。
 *
 * 为什么不能直接显示"请求的编码器"：
 * `render --gpu` 只是请求，CLI 可能在运行时回退（NVENC 初始化失败 → libx264），
 * 也可能因为格式 / Docker 限制根本没加 `--gpu`。所以这里只认两类证据：
 *
 * 1. **运行时进程**：渲染期间 ffmpeg 的真实命令行里 `-c:v <encoder>` 是唯一能证明
 *    "到底哪个编码器在跑"的证据（同时能排除 CLI 的试编码探测命令）；
 * 2. **产出文件**：渲染结束后用 ffprobe 读取真实宽高 / 帧率 / 编码格式，
 *    顺带尝试从容器 tag 里找编码器名（找不到就如实空着）。
 *
 * 两条证据都拿不到时，UI 显示"未确认"，绝不拿请求值冒充实际值。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { findExecutable } from './hyperframes'
import { findPowerShell, runBinary } from '../hardware/platform/shell'

/* ------------------------------------------------------------------ */
/* 编码器名称映射                                                       */
/* ------------------------------------------------------------------ */

export interface EncoderDescriptor {
  id: string
  /** 人读名称（界面上直接显示） */
  label: string
  /** 硬件编码为 true，软件为 false，无法判断为 null */
  hardware: boolean | null
  /** 硬件厂商，用于补充说明 */
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'software' | 'other'
}

const ENCODER_TABLE: { pattern: RegExp; make: (id: string) => EncoderDescriptor }[] = [
  {
    pattern: /^(h264|hevc|av1)_nvenc$/i,
    make: (id) => ({ id, label: `NVENC ${codecName(id)}`, hardware: true, vendor: 'nvidia' })
  },
  {
    pattern: /^(h264|hevc|av1)_amf$/i,
    make: (id) => ({ id, label: `AMF ${codecName(id)}`, hardware: true, vendor: 'amd' })
  },
  {
    pattern: /^(h264|hevc|av1)_qsv$/i,
    make: (id) => ({ id, label: `QSV ${codecName(id)}`, hardware: true, vendor: 'intel' })
  },
  {
    pattern: /^(h264|hevc|prores)_videotoolbox$/i,
    make: (id) => ({ id, label: `VideoToolbox ${codecName(id)}`, hardware: true, vendor: 'apple' })
  },
  {
    pattern: /^(h264|hevc|av1|vp8|vp9)_vaapi$/i,
    make: (id) => ({ id, label: `VAAPI ${codecName(id)}`, hardware: true, vendor: 'intel' })
  },
  {
    pattern: /^libx264|^x264/i,
    make: (id) => ({ id, label: 'x264（CPU 软件编码）', hardware: false, vendor: 'software' })
  },
  {
    pattern: /^libx265|^x265/i,
    make: (id) => ({ id, label: 'x265（CPU 软件编码）', hardware: false, vendor: 'software' })
  },
  {
    pattern: /^libvpx(-vp9)?$/i,
    make: (id) => ({ id, label: 'libvpx（CPU 软件编码）', hardware: false, vendor: 'software' })
  },
  {
    pattern: /^libaom-av1$|^libsvtav1$|^av1_svt$/i,
    make: (id) => ({ id, label: 'AV1（CPU 软件编码）', hardware: false, vendor: 'software' })
  },
  {
    pattern: /^gif$/i,
    make: (id) => ({ id, label: 'GIF 调色板编码', hardware: false, vendor: 'software' })
  },
  {
    pattern: /^prores_ks$|^prores$/i,
    make: (id) => ({ id, label: 'ProRes 4444', hardware: false, vendor: 'software' })
  }
]

function codecName(encoderId: string): string {
  const lower = encoderId.toLowerCase()
  if (lower.includes('hevc') || lower.includes('h265')) return 'H.265'
  if (lower.includes('av1')) return 'AV1'
  if (lower.includes('vp9')) return 'VP9'
  if (lower.includes('vp8')) return 'VP8'
  if (lower.includes('prores')) return 'ProRes'
  return 'H.264'
}

/** 把 ffmpeg 的编码器名翻译成人读信息；未知编码器如实标为「未识别」 */
export function describeEncoder(id: string | null): EncoderDescriptor {
  if (!id) {
    return { id: '', label: '尚未确认', hardware: null, vendor: 'other' }
  }
  for (const row of ENCODER_TABLE) {
    if (row.pattern.test(id)) return row.make(id)
  }
  return { id, label: id, hardware: null, vendor: 'other' }
}

/* ------------------------------------------------------------------ */
/* 从 ffmpeg 命令行里取 -c:v                                            */
/* ------------------------------------------------------------------ */

/**
 * 从一条 ffmpeg 命令行中提取真实的视频编码器。
 *
 * 返回 null 的情况：
 * - CLI 的编码器能力探测（`-f lavfi -i color=... -f null -`、`ffmpeg -version`）；
 * - 没有 `-c:v` / `-codec:v`（使用 ffmpeg 默认编码器，无法从命令行判断）；
 * - `-c:v copy`（不编码）。
 */
export function pickEncoderFromCommandLine(command: string): string | null {
  if (!command) return null
  const cmd = command.trim()
  // 能力探测 / 试编码：不是真正的渲染进程
  if (/(^|\s)-version(\s|$)/i.test(cmd)) return null
  if (/(^|\s)-f\s+lavfi(\s|$)/i.test(cmd)) return null
  if (/(^|\s)-f\s+null(\s|$)/i.test(cmd)) return null
  // 没有输入 / 只是查询
  if (!/(^|\s)-i\s+/i.test(cmd)) return null

  const match = cmd.match(/(?:^|\s)-c:v\s+([^\s'"]+)/i) ?? cmd.match(/(?:^|\s)-vcodec\s+([^\s'"]+)/i)
  if (!match) return null
  const encoder = match[1].trim()
  if (!encoder || /^copy$/i.test(encoder)) return null
  return encoder
}

/* ------------------------------------------------------------------ */
/* 运行时监听                                                           */
/* ------------------------------------------------------------------ */

export interface EncoderWatchHandle {
  stop(): void
  /** 已经拿到的编码器（没有则为 null） */
  current(): string | null
}

export interface EncoderWatchOptions {
  onEncoder: (encoderId: string, command: string) => void
  /** 最长监听时长（毫秒），默认 10 分钟 */
  timeoutMs?: number
  /** 轮询间隔（毫秒），默认 1200 */
  intervalMs?: number
  onError?: (message: string) => void
}

function windowsWatcherScript(timeoutMs: number, intervalMs: number): string {
  const loops = Math.max(1, Math.round(timeoutMs / intervalMs))
  return [
    '$OutputEncoding=[System.Text.Encoding]::UTF8;',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    `$n=${loops};`,
    'for($i=0;$i -lt $n;$i++){',
    "  $p=Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" -ErrorAction SilentlyContinue;",
    '  foreach($x in $p){ if($x.CommandLine){ Write-Output ("HFENC:"+$x.CommandLine) } };',
    `  Start-Sleep -Milliseconds ${intervalMs};`,
    '}'
  ].join(' ')
}

function posixWatcherScript(timeoutMs: number, intervalMs: number): string {
  const loops = Math.max(1, Math.round(timeoutMs / intervalMs))
  return [
    `i=0;`,
    `while [ $i -lt ${loops} ]; do`,
    `  ps -axo command= 2>/dev/null | grep -i ffmpeg | sed 's/^/HFENC:/';`,
    `  i=$((i+1)); sleep ${(intervalMs / 1000).toFixed(3)};`,
    `done`
  ].join(' ')
}

/**
 * 启动一个"编码器监听器"：在渲染期间持续读取 ffmpeg 进程命令行，
 * 一旦看到真实渲染进程的 `-c:v` 就回调并自行停止。
 *
 * 用一个常驻子进程轮询（而不是每次 setInterval 起一个 PowerShell），
 * 避免每次查询都付几百毫秒的进程启动开销。
 */
export function startEncoderWatch(options: EncoderWatchOptions): EncoderWatchHandle {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const intervalMs = Math.max(400, options.intervalMs ?? 800)
  let encoder: string | null = null
  let child: ChildProcess | null = null
  let stopped = false

  const finish = (): void => {
    if (stopped) return
    stopped = true
    if (child) {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      child = null
    }
  }

  try {
    if (process.platform === 'win32') {
      const ps = findPowerShell()
      if (!ps) {
        options.onError?.('未找到 PowerShell，无法监听 ffmpeg 编码器')
        return { stop: finish, current: () => encoder }
      }
      child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsWatcherScript(timeoutMs, intervalMs)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } else {
      child = spawn('sh', ['-c', posixWatcherScript(timeoutMs, intervalMs)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    }
  } catch (err) {
    options.onError?.(err instanceof Error ? err.message : String(err))
    return { stop: finish, current: () => encoder }
  }

  let buffer = ''
  child.stdout?.on('data', (buf: Buffer) => {
    buffer += buf.toString('utf-8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const idx = line.indexOf('HFENC:')
      if (idx < 0) continue
      const command = line.slice(idx + 'HFENC:'.length)
      const found = pickEncoderFromCommandLine(command)
      if (!found) continue
      encoder = found
      options.onEncoder(found, command)
      finish()
      return
    }
  })
  child.on('error', (err) => options.onError?.(err.message))
  child.on('close', () => {
    child = null
  })
  child.unref?.()

  return { stop: finish, current: () => encoder }
}

/* ------------------------------------------------------------------ */
/* 产出文件探测（结束后确认实际分辨率 / 帧率 / 编码器）                     */
/* ------------------------------------------------------------------ */

export interface OutputMediaProbe {
  available: boolean
  ok: boolean
  codec: string | null
  width: number | null
  height: number | null
  fps: number | null
  /** 容器 / 流里能读到的编码器名（通常是 Lavf 版本号，不可用则为 null） */
  encoderTag: string | null
  error: string | null
}

interface FfprobeJson {
  streams?: {
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    tags?: Record<string, string>
  }[]
  format?: { tags?: Record<string, string> }
}

function parseRate(text: string | undefined): number | null {
  if (!text) return null
  const rational = text.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (rational) {
    const a = Number(rational[1])
    const b = Number(rational[2])
    if (b > 0 && a > 0) return Math.round((a / b) * 100) / 100
    return null
  }
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** 用 ffprobe 读取产出文件的真实规格；目录型输出（PNG / HLS）直接返回 available=false */
export async function probeOutputMedia(path: string): Promise<OutputMediaProbe> {
  const empty: OutputMediaProbe = {
    available: false,
    ok: false,
    codec: null,
    width: null,
    height: null,
    fps: null,
    encoderTag: null,
    error: null
  }
  const probe = findExecutable('ffprobe')
  if (!probe) return { ...empty, error: '未找到 ffprobe' }

  const res = await runBinary(
    probe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_tags=encoder:format_tags=encoder',
      path
    ],
    { timeoutMs: 20_000 }
  )
  if (!res.ok) {
    return { ...empty, available: true, error: `${res.error ?? ''} ${res.stderr}`.trim().slice(0, 500) || 'ffprobe 执行失败' }
  }
  let json: FfprobeJson
  try {
    json = JSON.parse(res.stdout) as FfprobeJson
  } catch {
    return { ...empty, available: true, error: 'ffprobe 输出无法解析' }
  }
  const video = (json.streams ?? []).find((s) => s.codec_type === 'video')
  if (!video) {
    return { ...empty, available: true, error: '产出文件里没有视频流' }
  }
  const tag =
    video.tags?.encoder?.trim() ||
    (json.format?.tags?.encoder && /nvenc|x264|x265|qsv|amf|videotoolbox|vaapi|svt|aom|vpx/i.test(json.format.tags.encoder)
      ? json.format.tags.encoder.trim()
      : null)

  return {
    available: true,
    ok: true,
    codec: video.codec_name ?? null,
    width: typeof video.width === 'number' ? video.width : null,
    height: typeof video.height === 'number' ? video.height : null,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    encoderTag: tag,
    error: null
  }
}

/** 从 ffprobe 的 encoder tag 里识别编码器名（识别不到就返回 null） */
export function encoderFromTag(tag: string | null): string | null {
  if (!tag) return null
  const candidates = [
    /(h264|hevc|av1)_(nvenc|amf|qsv|vaapi|videotoolbox)/i,
    /libx264|libx265|libvpx-vp9|libaom-av1|libsvtav1|prores_ks|gif/i
  ]
  for (const pattern of candidates) {
    const m = tag.match(pattern)
    if (m) return m[0]
  }
  return null
}
