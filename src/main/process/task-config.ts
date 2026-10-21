/**
 * 渲染任务配置快照的构建与更新（纯函数，便于测试）。
 *
 * 数据来源只有两个：**真正下发给 CLI 的参数**（args）与**运行时证据**（ffmpeg / ffprobe）。
 * 绝不使用默认设置、也不使用"请求的编码器"来填充"实际执行的编码器"。
 */

import type { PerformanceMode } from '@shared/types/performance'
import type {
  EffectivePerformanceConfig,
  EncoderEvidenceSource,
  RenderRequest,
  RenderTaskConfigSnapshot,
  ResolutionPreset,
  TaskCaptureMode,
  VideoFormat
} from '@shared/types/render'
import type { OutputMediaProbe } from './encoder-probe'
import { describeEncoder, encoderFromTag } from './encoder-probe'

/* ------------------------------------------------------------------ */
/* 分辨率                                                              */
/* ------------------------------------------------------------------ */

interface Size {
  width: number
  height: number
  label: string
}

const RESOLUTION_SIZES: Partial<Record<ResolutionPreset, Size>> = {
  landscape: { width: 1920, height: 1080, label: '1080p' },
  portrait: { width: 1080, height: 1920, label: '竖屏 1080p' },
  square: { width: 1080, height: 1080, label: '方形 1080p' },
  'landscape-4k': { width: 3840, height: 2160, label: '4K' },
  'portrait-4k': { width: 2160, height: 3840, label: '竖屏 4K' },
  'square-4k': { width: 2160, height: 2160, label: '方形 4K' }
}

/** 按真实像素给出人读标签；像素未知时仍如实说明来源 */
export function resolutionLabel(preset: ResolutionPreset, width: number | null, height: number | null): string {
  if (preset !== 'project') {
    const size = RESOLUTION_SIZES[preset]
    return size ? size.label : preset
  }
  if (!width || !height) return '项目尺寸'
  if (width >= 3840 || height >= 3840) return '项目尺寸（4K）'
  if (width >= 1920 || height >= 1920) return '项目尺寸（高清）'
  return '项目尺寸'
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/** 取 `--flag value` 或 `-f value` 的值 */
export function argValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag) return args[i + 1]
  }
  return null
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function parseWorkers(args: string[], fallback: number | 'auto'): number | 'auto' {
  const raw = argValue(args, '-w') ?? argValue(args, '--workers')
  if (!raw) return fallback
  if (raw.toLowerCase() === 'auto') return 'auto'
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseFps(args: string[]): number | null {
  const raw = argValue(args, '-f') ?? argValue(args, '--fps')
  if (!raw) return null
  const rational = raw.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (rational) {
    const a = Number(rational[1])
    const b = Number(rational[2])
    return b > 0 ? Math.round((a / b) * 100) / 100 : null
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** 捕获模式完全由真实参数决定：并行流 env 优先，其次 fast-capture 开关 */
export function captureModeOf(args: string[], env?: Record<string, string>): TaskCaptureMode {
  if (env?.HF_CAPTURE_PARALLEL_STREAM === 'true') return 'parallel-stream'
  if (hasFlag(args, '--experimental-fast-capture')) return 'fast-capture'
  return 'default'
}

const NO_ENCODER_FORMATS: VideoFormat[] = ['png-sequence']

/* ------------------------------------------------------------------ */
/* 快照构建                                                            */
/* ------------------------------------------------------------------ */

export interface BuildSnapshotInput {
  taskId: string
  request: RenderRequest
  /** 真正下发给 CLI 的完整参数（含 `render` 子命令） */
  args: string[]
  performanceMode: PerformanceMode
  createdAt?: string
}

/**
 * 构建任务配置快照。
 *
 * 所有"生效值"都从 args 反推，因此界面显示与真实命令行天然一致；
 * 编码器此时还不知道，状态是「确认中」——等运行时证据。
 */
export function buildTaskConfigSnapshot(input: BuildSnapshotInput): RenderTaskConfigSnapshot {
  const { request, args } = input
  const preset = request.resolution
  const presetSize = RESOLUTION_SIZES[preset] ?? null
  const projectWidth = request.projectMeta?.width ?? null
  const projectHeight = request.projectMeta?.height ?? null
  const width = presetSize ? presetSize.width : projectWidth
  const height = presetSize ? presetSize.height : projectHeight

  const fpsFromArgs = parseFps(args)
  const projectFps = request.projectMeta?.fps ?? null
  const fpsValue = fpsFromArgs ?? (request.fpsMode === 'project' ? projectFps : null)
  const fpsLabel = fpsFromArgs
    ? `${trimNum(fpsFromArgs)} FPS`
    : fpsValue
      ? `跟随项目 ${trimNum(fpsValue)} FPS`
      : '跟随项目'

  const workers = parseWorkers(args, request.workers)
  const gpuEncodingEnabled = hasFlag(args, '--gpu')
  const browserGpuExplicit = hasFlag(args, '--browser-gpu')
    ? true
    : hasFlag(args, '--no-browser-gpu')
      ? false
      : null
  const captureMode = captureModeOf(args, request.env)

  const effective: EffectivePerformanceConfig = {
    workers,
    gpuEncodingEnabled,
    browserGpuMode: request.browserGpu,
    browserGpuEnabled: browserGpuExplicit,
    captureMode,
    pageSideCompositing: hasFlag(args, '--page-side-compositing')
      ? true
      : hasFlag(args, '--no-page-side-compositing')
        ? false
        : request.extra?.pageSideCompositing !== false,
    lowMemoryMode: hasFlag(args, '--low-memory-mode')
      ? 'on'
      : hasFlag(args, '--no-low-memory-mode')
        ? 'off'
        : 'auto',
    source: input.performanceMode === 'smart' ? 'smart-auto' : 'fixed-preset',
    fallbacks: []
  }

  const noEncoder = NO_ENCODER_FORMATS.includes(request.format)

  return {
    version: 1,
    taskId: input.taskId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    selectedPerformanceMode: input.performanceMode,
    effectivePerformanceConfig: effective,
    resolution: {
      preset,
      width: width ?? null,
      height: height ?? null,
      label: resolutionLabel(preset, width ?? null, height ?? null),
      confirmed: false
    },
    fps: {
      mode: request.fpsMode,
      value: fpsValue,
      label: fpsLabel,
      confirmed: false
    },
    format: request.format,
    quality: request.quality,
    encoder: noEncoder
      ? { id: null, label: '无（PNG 序列不编码）', hardware: null, source: 'none', confirmedAt: null }
      : { id: null, label: '确认中…', hardware: null, source: 'none', confirmedAt: null },
    workers,
    gpuEncodingEnabled,
    browserGpuEnabled: browserGpuExplicit,
    captureMode,
    cliArgs: [...args],
    attempt: 0
  }
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

/* ------------------------------------------------------------------ */
/* 运行时更新                                                          */
/* ------------------------------------------------------------------ */

/** 写入真实编码器证据（进程 / ffprobe）；同一任务重复调用会覆盖成最新证据 */
export function applyEncoderEvidence(
  snapshot: RenderTaskConfigSnapshot,
  encoderId: string,
  source: EncoderEvidenceSource,
  at = new Date().toISOString()
): RenderTaskConfigSnapshot {
  const descriptor = describeEncoder(encoderId)
  return {
    ...snapshot,
    encoder: {
      id: descriptor.id,
      label: descriptor.label,
      hardware: descriptor.hardware,
      source,
      confirmedAt: at
    }
  }
}

/** 运行时观测到浏览器 GPU 合成状态（来自 CLI 自己的输出） */
export function applyBrowserGpuEvidence(
  snapshot: RenderTaskConfigSnapshot,
  enabled: boolean
): RenderTaskConfigSnapshot {
  return {
    ...snapshot,
    browserGpuEnabled: enabled,
    effectivePerformanceConfig: { ...snapshot.effectivePerformanceConfig, browserGpuEnabled: enabled }
  }
}

/** 用产出文件的真实规格校正分辨率 / 帧率（并以 ffprobe 作为编码器兜底证据） */
export function applyOutputProbe(
  snapshot: RenderTaskConfigSnapshot,
  probe: OutputMediaProbe,
  at = new Date().toISOString()
): RenderTaskConfigSnapshot {
  if (!probe.available || !probe.ok) return snapshot
  const width = probe.width ?? snapshot.resolution.width
  const height = probe.height ?? snapshot.resolution.height
  const fpsValue = probe.fps ?? snapshot.fps.value

  let encoder = snapshot.encoder
  if (!encoder.id || encoder.source === 'none') {
    const fromTag = encoderFromTag(probe.encoderTag)
    if (fromTag) {
      const descriptor = describeEncoder(fromTag)
      encoder = {
        id: descriptor.id,
        label: descriptor.label,
        hardware: descriptor.hardware,
        source: 'ffprobe',
        confirmedAt: at
      }
    } else if (probe.codec) {
      // 只拿到编码格式，不知道具体编码器：如实说明，不猜 NVENC / x264
      encoder = {
        id: null,
        label: `${probe.codec.toUpperCase()}（编码器未暴露）`,
        hardware: null,
        source: 'ffprobe',
        confirmedAt: at
      }
    }
  }

  return {
    ...snapshot,
    resolution: {
      ...snapshot.resolution,
      width: width ?? null,
      height: height ?? null,
      label: resolutionLabel(snapshot.resolution.preset, width ?? null, height ?? null),
      confirmed: probe.width != null && probe.height != null
    },
    fps: {
      ...snapshot.fps,
      value: fpsValue ?? null,
      label: fpsValue ? `${trimNum(fpsValue)} FPS` : snapshot.fps.label,
      confirmed: probe.fps != null
    },
    encoder
  }
}

/** 记录一次自动回退（worker 降载 / GPU 编码回退 / 捕获路径回退…） */
export function applyFallback(
  snapshot: RenderTaskConfigSnapshot,
  labels: string[],
  attempt: number
): RenderTaskConfigSnapshot {
  if (labels.length === 0) return snapshot
  const fallbacks = [...snapshot.effectivePerformanceConfig.fallbacks]
  for (const label of labels) {
    if (!fallbacks.includes(label)) fallbacks.push(label)
  }
  return {
    ...snapshot,
    attempt,
    effectivePerformanceConfig: { ...snapshot.effectivePerformanceConfig, fallbacks }
  }
}

/** 重试后重新对齐"实际生效"的配置（args 已经变了） */
export function refreshEffectiveFromArgs(
  snapshot: RenderTaskConfigSnapshot,
  request: RenderRequest,
  args: string[]
): RenderTaskConfigSnapshot {
  const next = buildTaskConfigSnapshot({
    taskId: snapshot.taskId,
    request,
    args,
    performanceMode: snapshot.selectedPerformanceMode,
    createdAt: snapshot.createdAt
  })
  // GPU 编码开关变化（例如回退到 CPU）时必须重新确认编码器，不能沿用旧证据
  const gpuChanged = next.effectivePerformanceConfig.gpuEncodingEnabled !== snapshot.effectivePerformanceConfig.gpuEncodingEnabled
  const encoder = gpuChanged
    ? { id: null, label: '确认中…', hardware: null, source: 'none' as const, confirmedAt: null }
    : snapshot.encoder
  return {
    ...next,
    encoder,
    resolution: {
      ...next.resolution,
      confirmed: snapshot.resolution.confirmed,
      width: snapshot.resolution.width,
      height: snapshot.resolution.height,
      label: snapshot.resolution.label
    },
    fps: { ...next.fps, confirmed: snapshot.fps.confirmed, value: snapshot.fps.value, label: snapshot.fps.label },
    attempt: snapshot.attempt,
    effectivePerformanceConfig: {
      ...next.effectivePerformanceConfig,
      fallbacks: snapshot.effectivePerformanceConfig.fallbacks
    }
  }
}

/* ------------------------------------------------------------------ */
/* 展示文案                                                            */
/* ------------------------------------------------------------------ */

// 文案与渲染进程共用同一份实现（src/shared/render-labels.ts），避免日志和界面说法不一致
export {
  PERFORMANCE_MODE_LABEL,
  performanceSourceLabel,
  exportSpecLine,
  exportFormatLine,
  performanceDetailLine
} from '@shared/render-labels'
