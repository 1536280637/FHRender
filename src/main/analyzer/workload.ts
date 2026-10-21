import type {
  WorkloadClass,
  WorkloadProfile,
  WorkloadScorePart
} from '@shared/types/performance'
import type { MetadataSource, ProjectMetadata } from '@shared/types/project'
import type { FpsMode } from '@shared/types/render'
import { analyzeEntry, scanAssets, type AssetScan, type EntryAnalysis } from './project-analyzer'

/**
 * 项目负载分析。
 *
 * 这次重写的关键点：
 * 1. 时长不再决定等级——4 秒的 WebGL 项目可以比 5 分钟的文字动画更重；
 * 2. 每个得分项都写进 `scoreBreakdown`，界面可以解释「为什么是较高负载」；
 * 3. 读不到的维度写进 `unknownFields`，并降级置信度，不编造数值；
 * 4. 时长 / FPS 只使用真实来源（官方 info、composition、根元素 data-*），
 *    拿不到就是 null —— 不再出现 `?? 30` / `?? 4` 这类默认值。
 */

export interface WorkloadInput {
  projectPath: string
  metadata: ProjectMetadata
  /** 本次导出参数解析出的 FPS（项目 fps 或 --fps 覆盖值） */
  exportFps: number | null
  assets: AssetScan
  entry: EntryAnalysis
  /** 最大视频素材的真实分辨率（ffprobe 探测；未知为 null） */
  videoProbe?: { width: number; height: number; durationSec: number | null } | null
}

export interface ExportFpsResolution {
  fps: number | null
  source: MetadataSource
  /** 说明文字，用于界面 / 报告 */
  note: string
}

/** 把 `30000/1001` 这类有理数转成小数；非法返回 null */
export function parseFpsText(text: string | null | undefined): number | null {
  const value = (text ?? '').trim()
  if (!value) return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value)
    return n >= 1 && n <= 240 ? n : null
  }
  const m = value.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    const fps = Number(m[1]) / Number(m[2])
    return fps >= 1 && fps <= 240 ? Number(fps.toFixed(3)) : null
  }
  return null
}

/**
 * 解析「本次导出实际使用的 FPS」。
 * 与项目原始 FPS 分开：`-f 60` 只是导出覆盖，不会改写项目 data-fps。
 */
export function resolveExportFps(
  meta: Pick<ProjectMetadata, 'projectFps' | 'cliDefaultFps'>,
  settings: { fpsMode: FpsMode; customFps: string } | null
): ExportFpsResolution {
  const override = settings ? normalizeFps(settings) : null
  if (override !== null) {
    return { fps: override, source: 'entry-html', note: `导出参数 --fps ${override}（不改变项目原始帧率）` }
  }
  if (meta.projectFps && meta.projectFps > 0) {
    return {
      fps: meta.projectFps,
      source: 'entry-html',
      note: `跟随项目根元素 data-fps=${meta.projectFps}`
    }
  }
  if (meta.cliDefaultFps && meta.cliDefaultFps > 0) {
    return {
      fps: meta.cliDefaultFps,
      source: 'cli-default',
      note: `根元素未声明 data-fps，按当前 CLI 默认 ${meta.cliDefaultFps}fps`
    }
  }
  return { fps: null, source: 'unknown', note: '未能确定导出帧率（项目未声明 data-fps，也未读到 CLI 默认值）' }
}

function normalizeFps(settings: { fpsMode: FpsMode; customFps: string }): number | null {
  if (settings.fpsMode === 'project') return null
  if (settings.fpsMode === 'custom') return parseFpsText(settings.customFps)
  return parseFpsText(settings.fpsMode)
}

function resolutionLabel(width: number | null, height: number | null): string {
  if (!width || !height) return '未知分辨率'
  const pixels = width * height
  if (pixels >= 3840 * 2160 * 0.9) return `${width}×${height} (4K)`
  if (pixels >= 2560 * 1440 * 0.9) return `${width}×${height} (2K)`
  if (pixels >= 1920 * 1080 * 0.9) return `${width}×${height} (1080p)`
  if (height > width) return `${width}×${height} (竖屏)`
  return `${width}×${height}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function buildWorkloadProfile(input: WorkloadInput): WorkloadProfile {
  const meta = input.metadata
  const width = meta.width
  const height = meta.height
  const durationSec = meta.durationSec
  const exportFps = input.exportFps
  const projectFps = meta.projectFps

  const unknownFields: string[] = []
  if (!width || !height) unknownFields.push('分辨率')
  if (durationSec === null) unknownFields.push('时长')
  if (projectFps === null) unknownFields.push('项目 FPS')
  if (meta.elements === null) unknownFields.push('元素数量')
  if (meta.tracks === null) unknownFields.push('轨道数量')
  if (input.assets.truncated) unknownFields.push('素材规模（扫描上限）')

  /** 预计总帧数：只有时长与导出帧率都真实可用时才计算 */
  const frameCount =
    durationSec !== null && exportFps !== null ? Math.round(durationSec * exportFps) : null
  const frameCountSource: MetadataSource = frameCount === null ? 'unknown' : 'cli-info'

  const pixels = width && height ? width * height : null
  const parts: WorkloadScorePart[] = []
  const push = (key: string, label: string, points: number, detail: string): void => {
    parts.push({ key, label, points: Number(points.toFixed(1)), detail })
  }

  /* 1. 画布像素（0–28）：4K 单帧像素是 1080p 的 4 倍 */
  if (pixels) {
    const ratio = pixels / (3840 * 2160)
    push('canvas', '画布像素', clamp(ratio * 28, 0, 28), `${resolutionLabel(width, height)}`)
  }

  /* 2. 元素规模（0–16）：官方 info 的 elements 优先，其次静态 HTML 标签数 */
  const elementCount = meta.elements ?? input.entry.domElements
  if (elementCount !== null) {
    push(
      'elements',
      '元素规模',
      clamp((elementCount / 220) * 16, 0, 16),
      meta.elements !== null
        ? `info 报告 ${elementCount} 个元素`
        : `入口 HTML 静态标签约 ${elementCount} 个（不含动态节点）`
    )
  }

  /* 3. 轨道 / 合成层级（0–10） */
  if (meta.tracks !== null) {
    push('tracks', '轨道数量', clamp((meta.tracks / 8) * 10, 0, 10), `${meta.tracks} 条轨道`)
  }

  /* 4. 图片素材（0–10） */
  if (input.assets.imageCount > 0) {
    const points = clamp(input.assets.imageCount * 1.1 + (input.assets.assetBytes / 1024 ** 3) * 2, 0, 10)
    push('images', '图片素材', points, `${input.assets.imageCount} 个图片素材`)
  }

  /* 5. 视频素材（0–14）：数量 + 体积 + 真实分辨率 */
  if (input.assets.videoCount > 0) {
    let points = clamp(input.assets.videoCount * 3.2, 0, 9)
    const probe = input.videoProbe
    if (probe) points += clamp(((probe.width * probe.height) / (3840 * 2160)) * 5, 0, 5)
    push(
      'videos',
      '视频素材',
      points,
      `${input.assets.videoCount} 个视频素材${probe ? `（最大 ${probe.width}×${probe.height}）` : '（未解析分辨率）'}`
    )
  }

  /* 6. WebGL / Canvas / Three.js（0–12） */
  const gpuSynthetic = input.entry.webgl || input.entry.canvasCount > 0
  if (gpuSynthetic) {
    const points = (input.entry.webgl ? 8 : 0) + clamp(input.entry.canvasCount * 1.5, 0, 4)
    push(
      'gpu',
      'GPU 合成',
      points,
      [input.entry.webgl ? 'WebGL / Shader' : null, input.entry.canvasCount > 0 ? `${input.entry.canvasCount} 个 canvas` : null]
        .filter(Boolean)
        .join(' · ')
    )
  }

  /* 7. 动画复杂度（0–8）：只统计能在源码里确认的库/特性 */
  const hints = input.entry.animationHints
  if (hints.length > 0) {
    push('animation', '动画复杂度', clamp(hints.length * 1.6, 0, 8), hints.join(' / '))
  }

  /* 8. 时长与帧数（0–8）：权重刻意压低，时长不能主导等级 */
  if (frameCount !== null) {
    push(
      'duration',
      '时长 × 帧数',
      clamp((frameCount / 1800) * 8, 0, 8),
      `${durationSec}s × ${exportFps}fps ≈ ${frameCount} 帧`
    )
  } else if (durationSec !== null) {
    push('duration', '时长', clamp((durationSec / 120) * 4, 0, 4), `${durationSec}s（帧率未知，未计算总帧数）`)
  }

  /* 9. 素材总规模（0–6） */
  if (input.assets.assetBytes > 0) {
    push(
      'assets',
      '素材规模',
      clamp((input.assets.assetBytes / 1024 ** 3) * 6, 0, 6),
      `${(input.assets.assetBytes / 1024 ** 2).toFixed(1)}MB`
    )
  }

  const score = Math.round(clamp(parts.reduce((sum, p) => sum + p.points, 0), 0, 100))

  /* ---------------- 等级判定 ---------------- */

  // 连项目结构都读不到：不猜，直接标未知
  const structuralSignals = [
    meta.elements,
    meta.tracks,
    pixels,
    durationSec,
    input.assets.imageCount > 0 ? input.assets.imageCount : null,
    input.assets.videoCount > 0 ? input.assets.videoCount : null,
    input.entry.found ? 1 : null
  ].filter((v) => v !== null).length

  let complexity: WorkloadClass
  if (structuralSignals === 0 && !meta.capability.json && input.entry.animationHints.length === 0) {
    complexity = 'unknown'
  } else if (pixels && pixels >= 3840 * 2160 * 0.9 && score >= 45) {
    complexity = '4k-heavy'
  } else if (score >= 60) {
    complexity = 'high'
  } else if (input.assets.videoCount >= 1 || input.assets.imageCount >= 10 || score >= 34) {
    complexity = 'multi-asset'
  } else if (score < 14) {
    complexity = 'light'
  } else {
    complexity = 'normal'
  }

  const knownFields = 9 - Math.min(9, unknownFields.length)
  const confidence: WorkloadProfile['confidence'] =
    meta.capability.json && unknownFields.length <= 1 ? 'high' : knownFields >= 5 ? 'medium' : 'low'

  /* ---------------- 说明 ---------------- */

  const notes: string[] = []
  if (complexity === '4k-heavy') notes.push('4K 输出，单帧像素约为 1080p 的 4 倍，捕获与编码压力最大')
  if (input.assets.videoCount > 0) notes.push(`含 ${input.assets.videoCount} 个视频素材，需要额外的解码与帧提取开销`)
  if (input.assets.imageCount > 0) notes.push(`含 ${input.assets.imageCount} 个图片素材`)
  if (input.assets.assetBytes > 200 * 1024 ** 2) {
    notes.push(`素材总计 ${(input.assets.assetBytes / 1024 ** 2).toFixed(0)}MB，磁盘读写与缓存命中影响较大`)
  }
  if (input.entry.webgl) notes.push('检测到 WebGL / Shader 合成，浏览器 GPU 影响明显')
  if (meta.elements !== null) notes.push(`官方 info：${meta.elements} 个元素 · ${meta.tracks ?? '未知'} 条轨道`)
  if (durationSec === null) notes.push('时长无法可靠确定，界面显示「时长待检测」，不使用默认值代替')
  if (projectFps === null) {
    notes.push(
      meta.cliDefaultFps
        ? `项目未声明 data-fps，按当前 CLI 默认 ${meta.cliDefaultFps}fps；项目原始帧率未知`
        : '项目未声明 data-fps，且未读到 CLI 默认帧率'
    )
  }
  if (input.assets.truncated) notes.push('素材数量超过扫描上限，统计值偏低')
  for (const warning of meta.warnings) notes.push(warning)

  return {
    projectPath: input.projectPath,
    projectName: meta.name,
    width,
    height,
    fps: projectFps,
    exportFps,
    durationSec,
    frameCount,
    frameCountSource,
    durationSource: meta.durationSource,
    fpsSource: meta.projectFpsSource,
    cliDefaultFps: meta.cliDefaultFps,
    resolutionLabel: resolutionLabel(width, height),
    imageCount: input.assets.imageCount,
    videoCount: input.assets.videoCount,
    assetBytes: input.assets.assetBytes,
    largestAssetBytes: input.assets.largestAssetBytes,
    webgl: input.entry.webgl,
    canvasCount: input.entry.canvasCount,
    domElements: input.entry.domElements,
    animationHints: input.entry.animationHints,
    elements: meta.elements,
    tracks: meta.tracks,
    projectBytes: meta.projectBytes,
    compositionId: meta.compositionId,
    complexity,
    score,
    confidence,
    unknownFields,
    scoreBreakdown: parts,
    notes,
    analyzedAt: new Date().toISOString()
  }
}

/** 完整分析：素材扫描 + 入口 HTML 分析 + 负载分级（元数据由调用方缓存后传入） */
export async function analyzeWorkload(input: {
  projectPath: string
  metadata: ProjectMetadata
  exportFps: number | null
  entryFiles: string[]
  videoProbe?: { width: number; height: number; durationSec: number | null } | null
}): Promise<WorkloadProfile> {
  const [assets, entry] = await Promise.all([
    scanAssets(input.projectPath),
    analyzeEntry(input.projectPath, input.entryFiles.length > 0 ? input.entryFiles : ['index.html'])
  ])
  return buildWorkloadProfile({
    projectPath: input.projectPath,
    metadata: input.metadata,
    exportFps: input.exportFps,
    assets,
    entry,
    videoProbe: input.videoProbe ?? null
  })
}
