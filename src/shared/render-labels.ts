/**
 * 渲染配置的展示文案（主进程日志 / 渲染进程 UI 共用，避免两边各写一份）。
 * 纯函数，不依赖 Node API，可以安全地被渲染进程引用。
 */

import type { RenderTaskConfigSnapshot } from './types/render'
import type { PerformanceMode } from './types/performance'

export const PERFORMANCE_MODE_LABEL: Record<PerformanceMode, string> = {
  smart: '智能模式',
  balanced: '平衡模式',
  performance: '性能模式',
  extreme: '极限模式'
}

/** 第二行说明：智能模式强调"自动优化配置"，固定模式强调"固定预设" */
export function performanceSourceLabel(snapshot: RenderTaskConfigSnapshot): string {
  return snapshot.effectivePerformanceConfig.source === 'smart-auto' ? '自动优化配置' : '固定预设'
}

/** 右侧第一行：4K · 30 FPS */
export function exportSpecLine(snapshot: RenderTaskConfigSnapshot): string {
  return `${snapshot.resolution.label} · ${snapshot.fps.label}`
}

/** 右侧第二行：MP4 · NVENC H.264 · 3 Workers */
export function exportFormatLine(snapshot: RenderTaskConfigSnapshot): string {
  const format = snapshot.format.toUpperCase()
  const encoder = snapshot.encoder.label
  const workers = snapshot.workers === 'auto' ? 'Workers auto' : `${snapshot.workers} Workers`
  return `${format} · ${encoder} · ${workers}`
}

/** 左侧第二行：Worker / GPU / 捕获路径 */
export function performanceDetailLine(snapshot: RenderTaskConfigSnapshot): string {
  const parts = [
    snapshot.workers === 'auto' ? 'Workers auto' : `${snapshot.workers} Workers`,
    snapshot.gpuEncodingEnabled ? 'GPU 编码请求已下发' : 'CPU 编码',
    snapshot.captureMode === 'parallel-stream'
      ? '并行流捕获'
      : snapshot.captureMode === 'fast-capture'
        ? 'Fast Capture'
        : '默认截图捕获'
  ]
  return parts.join(' · ')
}
