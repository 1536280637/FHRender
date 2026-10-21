/**
 * 产出文件验证。
 *
 * 结论只能来自磁盘上的真实文件，不能只看 exit code，也不能看 stderr 是否为空
 * （CLI 在成功时也会往 stderr 写 WARN / 版本提示）。
 */

import { promises as fs, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OutputFileCheck, OutputProbeResult } from '@shared/types/performance'
import { findExecutable } from '../process/hyperframes'
import { runBinary } from '../hardware/platform/shell'

/* ------------------------------------------------------------------ */
/* ffprobe 定位                                                        */
/* ------------------------------------------------------------------ */

let cachedProbe: string | null | undefined

export function findFfprobe(): string | null {
  if (cachedProbe !== undefined) return cachedProbe
  const fromEnv = process.env.HF_RENDER_FFPROBE
  if (fromEnv && existsSync(fromEnv)) {
    cachedProbe = fromEnv
    return cachedProbe
  }
  const direct = findExecutable('ffprobe')
  if (direct) {
    cachedProbe = direct
    return cachedProbe
  }
  // 常见布局：ffprobe 与 ffmpeg 同目录
  const ffmpeg =
    process.env.HF_RENDER_FFMPEG && existsSync(process.env.HF_RENDER_FFMPEG)
      ? process.env.HF_RENDER_FFMPEG
      : findExecutable('ffmpeg')
  if (ffmpeg) {
    const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const sibling = join(dirname(ffmpeg), exe)
    if (existsSync(sibling)) {
      cachedProbe = sibling
      return cachedProbe
    }
  }
  cachedProbe = null
  return null
}

/* ------------------------------------------------------------------ */
/* ffprobe 探测                                                        */
/* ------------------------------------------------------------------ */

interface FfprobeJson {
  streams?: {
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    duration?: string
  }[]
  format?: { duration?: string; size?: string }
}

function parseRate(text: string | undefined): number | null {
  if (!text) return null
  const m = text.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (b > 0 && a > 0) return Math.round((a / b) * 100) / 100
    return null
  }
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** 用 ffprobe 读取真实容器信息；ffprobe 不可用时返回 available=false（不伪造结果） */
export async function probeMedia(path: string): Promise<OutputProbeResult> {
  const probe = findFfprobe()
  if (!probe) {
    return {
      available: false,
      ok: false,
      durationSec: null,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      error: '未找到 ffprobe（可用 HF_RENDER_FFPROBE 环境变量指定路径）'
    }
  }

  const res = await runBinary(
    probe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 30_000 }
  )

  if (!res.ok) {
    return {
      available: true,
      ok: false,
      durationSec: null,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      error: `${res.error ?? ''} ${res.stderr}`.trim().slice(0, 800) || 'ffprobe 执行失败'
    }
  }

  let json: FfprobeJson | null = null
  try {
    json = JSON.parse(res.stdout) as FfprobeJson
  } catch {
    return {
      available: true,
      ok: false,
      durationSec: null,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      error: 'ffprobe 输出无法解析为 JSON'
    }
  }

  const video = json.streams?.find((s) => s.codec_type === 'video')
  if (!video) {
    return {
      available: true,
      ok: false,
      durationSec: null,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      error: '文件中没有视频流'
    }
  }

  const duration = Number(video.duration ?? json.format?.duration ?? NaN)
  const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)
  return {
    available: true,
    ok: Number.isFinite(duration) && duration > 0 && !!video.width && !!video.height,
    durationSec: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
    width: video.width ?? null,
    height: video.height ?? null,
    fps,
    videoCodec: video.codec_name ?? null,
    error: null
  }
}

/* ------------------------------------------------------------------ */
/* 文件验证                                                            */
/* ------------------------------------------------------------------ */

export interface VerifyOptions {
  /** 最小可接受体积（字节）；低于它视为没有真正写出视频 */
  minBytes?: number
  /** 期望帧率（由渲染参数推导，无法推导时为 null） */
  expectedFps?: number | null
  /** 期望分辨率（project 时为 null，不校验） */
  expectedWidth?: number | null
  expectedHeight?: number | null
  /** 期望时长（项目时长，秒）；用于判断产出是否明显不完整 */
  expectedDurationSec?: number | null
  /** 目录型输出（png-sequence / hls）只校验体积 */
  directoryOutput?: boolean
}

async function pathBytes(target: string): Promise<number | null> {
  try {
    const stat = await fs.stat(target)
    if (stat.isFile()) return stat.size
    let total = 0
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      const size = await pathBytes(join(target, entry.name))
      if (size) total += size
    }
    return total
  } catch {
    return null
  }
}

/**
 * 验证产出文件：
 * 1) 是否存在；
 * 2) 体积是否合理；
 * 3) 两次采样大小是否一致（避免在仍写入时误判成功）；
 * 4) ffprobe 能否读取，时长 / 分辨率 / 帧率是否符合本次测试要求。
 */
export async function verifyOutputFile(path: string, options: VerifyOptions = {}): Promise<OutputFileCheck> {
  const minBytes = options.minBytes ?? 4096
  const problems: string[] = []

  const first = await pathBytes(path)
  if (first === null) {
    return {
      exists: false,
      bytes: null,
      writeSettled: false,
      stillGrowing: false,
      probe: null,
      problems: ['输出文件不存在（CLI 未生成任何产物）']
    }
  }

  // 采样两次确认文件已经停止写入
  await new Promise((resolve) => setTimeout(resolve, 700))
  const second = await pathBytes(path)
  const stillGrowing = first !== null && second !== null && second > first
  const writeSettled = !stillGrowing && second !== null
  const bytes = second ?? first

  if (stillGrowing) problems.push('文件仍在写入，稍后复测')
  if (bytes !== null && bytes < minBytes) {
    problems.push(`文件体积 ${bytes} 字节，小于最小可接受值 ${minBytes} 字节`)
  }

  let probe: OutputProbeResult | null = null
  // 目录型输出（png-sequence / hls）没有单一容器可探测，体积校验通过即视为可用
  if (options.directoryOutput) {
    return { exists: true, bytes, writeSettled, stillGrowing, probe: null, problems }
  }

  probe = await probeMedia(path)
  if (!probe.available) {
    problems.push(probe.error ?? 'ffprobe 不可用，无法验证视频信息')
  } else if (!probe.ok) {
    problems.push(`ffprobe 无法读取视频：${probe.error ?? '未知原因'}`)
  } else {
    if (options.expectedDurationSec && probe.durationSec) {
      const diff = Math.abs(probe.durationSec - options.expectedDurationSec)
      // 允许 1.5s 或 5% 的偏差（尾部静止帧 / 容器时间戳差异）
      const tolerance = Math.max(1.5, options.expectedDurationSec * 0.05)
      if (diff > tolerance) {
        problems.push(
          `视频时长 ${probe.durationSec}s 与项目时长 ${options.expectedDurationSec}s 相差 ${diff.toFixed(2)}s（阈值 ${tolerance.toFixed(1)}s）`
        )
      }
    }
    if (options.expectedWidth && options.expectedHeight && probe.width && probe.height) {
      if (probe.width !== options.expectedWidth || probe.height !== options.expectedHeight) {
        problems.push(
          `分辨率 ${probe.width}×${probe.height} 与期望 ${options.expectedWidth}×${options.expectedHeight} 不一致`
        )
      }
    }
    if (options.expectedFps && probe.fps) {
      const diff = Math.abs(probe.fps - options.expectedFps)
      if (diff > Math.max(0.5, options.expectedFps * 0.02)) {
        problems.push(`帧率 ${probe.fps} 与期望 ${options.expectedFps} 不一致`)
      }
    }
  }

  return { exists: true, bytes, writeSettled, stillGrowing, probe, problems }
}
