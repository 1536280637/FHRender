import type { EncoderCapability, EncoderCodec, EncoderFamily } from '@shared/types/performance'
import { findExecutable } from '../process/hyperframes'
import { runBinary } from '../hardware/platform/shell'

interface EncoderSpec {
  id: string
  label: string
  family: EncoderFamily
  codec: EncoderCodec
  /** 试编码时需要的额外参数（例如 VAAPI 需要设备） */
  extraArgs?: string[]
}

/** 我们关心的编码器清单；实际是否存在以当前 ffmpeg 的 -encoders 为准 */
const ENCODER_SPECS: EncoderSpec[] = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC (H.264)', family: 'nvidia', codec: 'h264' },
  { id: 'hevc_nvenc', label: 'NVIDIA NVENC (HEVC)', family: 'nvidia', codec: 'hevc' },
  { id: 'av1_nvenc', label: 'NVIDIA NVENC (AV1)', family: 'nvidia', codec: 'av1' },
  { id: 'h264_amf', label: 'AMD AMF (H.264)', family: 'amd', codec: 'h264' },
  { id: 'hevc_amf', label: 'AMD AMF (HEVC)', family: 'amd', codec: 'hevc' },
  { id: 'av1_amf', label: 'AMD AMF (AV1)', family: 'amd', codec: 'av1' },
  { id: 'h264_qsv', label: 'Intel QSV (H.264)', family: 'intel', codec: 'h264' },
  { id: 'hevc_qsv', label: 'Intel QSV (HEVC)', family: 'intel', codec: 'hevc' },
  { id: 'av1_qsv', label: 'Intel QSV (AV1)', family: 'intel', codec: 'av1' },
  { id: 'h264_videotoolbox', label: 'Apple VideoToolbox (H.264)', family: 'apple', codec: 'h264' },
  { id: 'hevc_videotoolbox', label: 'Apple VideoToolbox (HEVC)', family: 'apple', codec: 'hevc' },
  { id: 'prores_videotoolbox', label: 'Apple VideoToolbox (ProRes)', family: 'apple', codec: 'prores' },
  { id: 'h264_vaapi', label: 'VAAPI (H.264)', family: 'vaapi', codec: 'h264', extraArgs: ['-vaapi_device', '/dev/dri/renderD128'] },
  { id: 'hevc_vaapi', label: 'VAAPI (HEVC)', family: 'vaapi', codec: 'hevc', extraArgs: ['-vaapi_device', '/dev/dri/renderD128'] },
  { id: 'libx264', label: 'CPU · libx264', family: 'software', codec: 'h264' },
  { id: 'libx265', label: 'CPU · libx265', family: 'software', codec: 'hevc' },
  { id: 'libvpx-vp9', label: 'CPU · libvpx-VP9', family: 'software', codec: 'vp9' },
  { id: 'gif', label: 'CPU · GIF', family: 'software', codec: 'gif' }
]

/** 该编码器能服务于哪些输出格式（MOV 固定 ProRes，GIF 走 gif 编码器，均不受 --gpu 影响） */
function formatsFor(spec: EncoderSpec): EncoderCapability['formats'] {
  switch (spec.codec) {
    case 'h264':
    case 'hevc':
      return ['mp4']
    case 'av1':
      return ['mp4', 'webm']
    case 'vp9':
      return ['webm']
    case 'prores':
      return ['mov']
    case 'gif':
      return ['gif']
    default:
      return ['mp4']
  }
}

export interface FfmpegEncodersResult {
  found: boolean
  path: string | null
  version: string | null
  /** ffmpeg -encoders 的原始输出 */
  rawList: string
  compiled: Set<string>
  error?: string
}

export function findFfmpeg(): string | null {
  if (process.env.HF_RENDER_FFMPEG) return process.env.HF_RENDER_FFMPEG
  return findExecutable('ffmpeg')
}

export async function readFfmpegEncoders(): Promise<FfmpegEncodersResult> {
  const path = findFfmpeg()
  if (!path) {
    return { found: false, path: null, version: null, rawList: '', compiled: new Set(), error: '未找到 ffmpeg' }
  }

  const [versionRes, listRes] = await Promise.all([
    runBinary(path, ['-hide_banner', '-version'], { timeoutMs: 12_000 }),
    runBinary(path, ['-hide_banner', '-encoders'], { timeoutMs: 20_000 })
  ])

  const version = versionRes.ok ? (versionRes.stdout.split(/\r?\n/)[0] ?? '').trim() : null
  const rawList = listRes.stdout
  const compiled = new Set<string>()
  for (const line of rawList.split(/\r?\n/)) {
    const match = line.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/)
    if (match) compiled.add(match[1])
  }

  return {
    found: true,
    path,
    version,
    rawList,
    compiled,
    error: listRes.ok ? undefined : '无法读取 ffmpeg 编码器列表'
  }
}

/** 真实试编码：0.4 秒 320x240 黑场，输出到 null，只验证编码器能否启动 */
async function testEncoder(
  ffmpegPath: string,
  spec: EncoderSpec
): Promise<{ ok: boolean; reason?: string; latencyMs: number }> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(spec.extraArgs ?? []),
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=10:d=0.4',
    '-c:v',
    spec.id,
    '-f',
    'null',
    '-'
  ]
  const res = await runBinary(ffmpegPath, args, { timeoutMs: 25_000 })
  if (res.ok) return { ok: true, latencyMs: res.ms }
  const message = `${res.stderr}\n${res.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /error|failed|cannot|unable|not supported|not found|device/i.test(l))
    .slice(0, 2)
    .join(' ')
  return {
    ok: false,
    reason: message || `ffmpeg 退出码 ${res.code ?? 'unknown'}`,
    latencyMs: res.ms
  }
}

export interface ProbeEncodersOptions {
  /** 只测试这些家族的硬件编码器（由平台适配器给出） */
  families: EncoderFamily[]
  /** 是否测试软件编码器（默认 true，但只测 libx264 以节省时间） */
  includeSoftware?: boolean
  timeoutBudgetMs?: number
}

/**
 * 能力矩阵：先看 ffmpeg 是否编译了该编码器，再做真实试编码。
 * 不因为"有 NVIDIA 显卡"就断言 NVENC 可用。
 */
export async function probeEncoders(options: ProbeEncodersOptions): Promise<{
  encoders: EncoderCapability[]
  ffmpeg: FfmpegEncodersResult
}> {
  const ffmpeg = await readFfmpegEncoders()
  const families = new Set<EncoderFamily>(options.families)
  const includeSoftware = options.includeSoftware !== false
  const started = Date.now()
  const budget = options.timeoutBudgetMs ?? 60_000

  const results: EncoderCapability[] = []

  const candidates = ENCODER_SPECS.filter((spec) => {
    if (spec.family === 'software') {
      return includeSoftware ? spec.id === 'libx264' || spec.id === 'gif' : false
    }
    return families.has(spec.family)
  })

  for (const spec of candidates) {
    const compiled = ffmpeg.compiled.has(spec.id)
    if (!compiled) {
      results.push({
        id: spec.id,
        label: spec.label,
        family: spec.family,
        codec: spec.codec,
        compiled: false,
        tested: false,
        working: false,
        formats: formatsFor(spec),
        reason: '当前 ffmpeg 未编译该编码器'
      })
      continue
    }

    if (!ffmpeg.path) {
      results.push({
        id: spec.id,
        label: spec.label,
        family: spec.family,
        codec: spec.codec,
        compiled: true,
        tested: false,
        working: false,
        formats: formatsFor(spec),
        reason: '未找到 ffmpeg，无法验证'
      })
      continue
    }

    if (Date.now() - started > budget) {
      results.push({
        id: spec.id,
        label: spec.label,
        family: spec.family,
        codec: spec.codec,
        compiled: true,
        tested: false,
        working: false,
        formats: formatsFor(spec),
        reason: '探测时间预算用尽，未验证'
      })
      continue
    }

    const test = await testEncoder(ffmpeg.path, spec)
    results.push({
      id: spec.id,
      label: spec.label,
      family: spec.family,
      codec: spec.codec,
      compiled: true,
      tested: true,
      working: test.ok,
      formats: formatsFor(spec),
      reason: test.ok ? undefined : test.reason,
      latencyMs: test.latencyMs
    })
  }

  // 完整列出硬件编码器（未被候选覆盖的也标出来，便于排查）
  return { encoders: results, ffmpeg }
}

export function pickBestEncoder(
  encoders: EncoderCapability[],
  format: string
): EncoderCapability | null {
  const usable = encoders.filter((e) => e.working && e.formats.includes(format as never))
  if (usable.length === 0) return null
  const priority: EncoderFamily[] = ['nvidia', 'apple', 'intel', 'amd', 'vaapi', 'software', 'other']
  return usable.sort((a, b) => priority.indexOf(a.family) - priority.indexOf(b.family))[0]
}
