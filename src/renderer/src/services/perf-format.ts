import type { PerformanceMode, WorkloadClass } from '@shared/types/performance'

export const NA = 'N/A'

export function formatBytes(bytes: number | null | undefined, fraction = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return NA
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(fraction)} ${units[unit]}`
}

export function formatGb(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return NA
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return NA
  return `${value.toFixed(digits)}%`
}

export function formatSeconds(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return NA
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const min = Math.floor(seconds / 60)
  return `${min}m ${Math.round(seconds - min * 60)}s`
}

export function formatMbPerSec(bytes: number | null | undefined, ms: number | null | undefined): string {
  if (!bytes || !ms) return NA
  return `${(bytes / 1024 ** 2 / (ms / 1000)).toFixed(2)} MB/s`
}

export const MODE_LABEL: Record<PerformanceMode, string> = {
  smart: '智能',
  balanced: '平衡',
  performance: '性能',
  extreme: '极限'
}

/** 对比测试阶段的显示名，与主进程 PHASE_LABELS 保持一致 */
export { PHASE_LABELS } from '@shared/types/performance'

/** 失败阶段的中文名（与主进程 stageLabel 保持一致，界面与日志用词统一） */
export const STAGE_LABEL: Record<string, string> = {
  environment: '环境检查',
  project: '项目检查',
  args: '参数构建',
  spawn: '子进程启动',
  render: '视频渲染',
  file: '文件验证',
  parse: '结果解析',
  none: '无'
}

/** 错误类型的中文名 */
export const ERROR_TYPE_LABEL: Record<string, string> = {
  'command-not-found': '命令不存在',
  'unsupported-arg': '参数不支持',
  'invalid-project': '项目无效',
  'file-write': '文件写入失败',
  chrome: 'Chrome 异常',
  ffmpeg: 'FFmpeg 异常',
  'out-of-memory': '内存不足',
  timeout: '超时',
  unknown: '未知错误',
  none: '无'
}

export function stageText(stage: string | null | undefined): string {
  if (!stage) return NA
  return STAGE_LABEL[stage] ?? stage
}

export function errorTypeText(type: string | null | undefined): string {
  if (!type) return NA
  return ERROR_TYPE_LABEL[type] ?? type
}

export const WORKLOAD_LABEL: Record<WorkloadClass, string> = {
  light: '轻量负载',
  normal: '普通负载',
  'multi-asset': '较高负载',
  high: '高复杂度负载',
  '4k-heavy': '高复杂度负载（4K）',
  unknown: '负载未知'
}

export const PRESSURE_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '偏高',
  critical: '紧张',
  unknown: NA
}

export function shortPath(path: string, max = 46): string {
  if (!path) return ''
  if (path.length <= max) return path
  const head = path.slice(0, Math.floor(max * 0.45))
  const tail = path.slice(-Math.floor(max * 0.45))
  return `${head}…${tail}`
}
