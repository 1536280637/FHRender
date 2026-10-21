import type { ProjectInfo } from '@shared/types/project'
import type { RenderRequest, RenderSettings, VideoFormat } from '@shared/types/render'
import { DEFAULT_SETTINGS } from './constants'

export const api = () => window.hf

export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function dirname(p: string): string {
  const normalized = p.replace(/[\\/]+$/, '')
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '0s'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`
  return `${s}s`
}

export function formatClock(iso?: string): string {
  if (!iso) return '--:--:--'
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function buildRequest(
  settings: RenderSettings,
  projectPath: string,
  composition: string,
  outputDir: string,
  outputName: string,
  project?: ProjectInfo | null
): RenderRequest {
  return {
    ...settings,
    projectPath,
    composition,
    outputDir,
    outputName: outputName.trim(),
    // 原始宽高 / 时长 / 帧率只用于主进程预估帧数与临时空间，不会传给命令行
    projectMeta: project
      ? {
          width: project.width ?? null,
          height: project.height ?? null,
          durationSec: project.duration ?? null,
          fps: project.fps ?? null
        }
      : undefined
  }
}

export function defaultRenderSettings(): RenderSettings {
  return { ...DEFAULT_SETTINGS.render }
}

export const FORMAT_OPTIONS: { value: VideoFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mov', label: 'MOV' },
  { value: 'gif', label: 'GIF' },
  { value: 'png-sequence', label: 'PNG 序列' },
  { value: 'hls', label: 'HLS' }
]

export const EXTENSION_MAP: Record<VideoFormat, string> = {
  mp4: '.mp4',
  webm: '.webm',
  mov: '.mov',
  gif: '.gif',
  'png-sequence': '',
  hls: ''
}

export const DIRECTORY_FORMATS: VideoFormat[] = ['png-sequence', 'hls']

export function isDirectoryFormat(format: VideoFormat): boolean {
  return DIRECTORY_FORMATS.includes(format)
}

export const QUALITY_OPTIONS = [
  { value: 'draft', label: 'Draft', hint: '最快出片，体积最小，用于检查节奏' },
  { value: 'looks', label: 'Looks', hint: 'CLI 默认档位（CRF 16）' },
  { value: 'standard', label: 'Standard', hint: '比 Looks 略低一档的码率' },
  { value: 'high', label: 'High', hint: '更高画质，体积更大' },
  { value: 'delivery', label: 'Delivery', hint: '交付级，等同 high 档' }
] as const

export const RESOLUTION_OPTIONS = [
  { value: 'project', label: '跟随项目原始尺寸' },
  { value: 'landscape', label: '横屏 1920×1080' },
  { value: 'portrait', label: '竖屏 1080×1920' },
  { value: 'square', label: '方形 1080×1080' },
  { value: 'landscape-4k', label: '横屏 4K 3840×2160' },
  { value: 'portrait-4k', label: '竖屏 4K 2160×3840' },
  { value: 'square-4k', label: '方形 4K 2160×2160' }
] as const

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

export function clampNumber(value: string, min: number, max: number): number | null {
  if (value.trim() === '') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(max, Math.max(min, num))
}
