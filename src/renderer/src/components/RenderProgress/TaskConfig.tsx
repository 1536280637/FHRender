import { Badge } from '../ui'
import { formatClock, formatDuration } from '../../services/api'
import type { RenderHistoryEntry, RenderTaskConfigSnapshot } from '@shared/types/render'
import {
  exportFormatLine,
  exportSpecLine,
  PERFORMANCE_MODE_LABEL,
  performanceDetailLine,
  performanceSourceLabel
} from '@shared/render-labels'

/**
 * 渲染状态里的两个信息模块（进度条下方、耗时统计旁边）。
 *
 * 数据全部来自 `task.config`（RenderTaskConfigSnapshot）：
 * 性能模式在任务启动时冻结，导出配置从真正下发的 CLI 参数反推，
 * 编码器只显示运行时证据（ffmpeg / ffprobe），不显示"请求了什么"。
 */

const HISTORY_STATUS_TEXT: Record<string, string> = {
  succeeded: '完成',
  failed: '失败',
  canceled: '已停止'
}

function encoderBadge(snapshot: RenderTaskConfigSnapshot): JSX.Element | null {
  const { encoder } = snapshot
  if (encoder.hardware === true) return <Badge tone="ok">硬件编码</Badge>
  if (encoder.hardware === false) return <Badge tone="neutral">CPU 编码</Badge>
  return null
}

export function RenderTaskConfig(props: {
  config: RenderTaskConfigSnapshot | null
  /** 历史渲染记录（最新在前） */
  history?: RenderHistoryEntry[]
  /** 是否展示历史列表（渲染结束后更有价值，但一直可展开） */
  showHistory?: boolean
}): JSX.Element | null {
  const config = props.config
  if (!config) return null
  const fallbacks = config.effectivePerformanceConfig.fallbacks
  const browserGpu =
    config.browserGpuEnabled === null
      ? config.effectivePerformanceConfig.browserGpuMode === 'auto'
        ? '浏览器 GPU 自动'
        : '浏览器 GPU 未知'
      : config.browserGpuEnabled
        ? '浏览器 GPU 开'
        : '浏览器 GPU 关'

  return (
    <>
      <div className="task-config">
        <div className="task-config-col">
          <span className="task-config-label">当前渲染性能</span>
          <div className="task-config-value">
            {PERFORMANCE_MODE_LABEL[config.selectedPerformanceMode]}
            <span className="task-config-sub"> · {performanceSourceLabel(config)}</span>
          </div>
          <span className="task-config-detail">{performanceDetailLine(config)}</span>
          {fallbacks.length > 0 && (
            <span className="task-config-detail task-config-fallback" title={fallbacks.join('；')}>
              已回退 {fallbacks.length} 项：{fallbacks.join(' / ')}
            </span>
          )}
        </div>

        <div className="task-config-col">
          <span className="task-config-label">当前导出配置</span>
          <div className="task-config-value">
            {exportSpecLine(config)}
            <span className="task-config-sub"> · 质量 {config.quality}</span>
          </div>
          <span className="task-config-detail">
            {exportFormatLine(config)}
            {encoderBadge(config)}
          </span>
          <span className="task-config-detail">{browserGpu}</span>
        </div>
      </div>

      {props.showHistory && props.history && props.history.length > 0 && (
        <details className="task-history">
          <summary>
            历史渲染配置（{props.history.length}）
            <span className="muted-line"> · 每个任务保存的是它自己启动时的配置快照</span>
          </summary>
          <ul className="task-history-list">
            {props.history.slice(0, 6).map((entry) => (
              <li key={entry.taskId}>
                <span className={`task-history-status status-${entry.status}`}>
                  {HISTORY_STATUS_TEXT[entry.status] ?? entry.status}
                </span>
                <span className="task-history-main">
                  {PERFORMANCE_MODE_LABEL[entry.config.selectedPerformanceMode]} ·{' '}
                  {exportSpecLine(entry.config)} · {entry.config.format.toUpperCase()} ·{' '}
                  {entry.config.encoder.label}
                </span>
                <span className="task-history-meta mono">
                  {formatClock(entry.finishedAt)}
                  {entry.elapsedMs ? ` · ${formatDuration(entry.elapsedMs)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
