import { Badge, Button, Panel, Spinner } from '../ui'
import type { OptimizationRecommendation, PerformanceMode } from '@shared/types/performance'
import { MODE_LABEL, formatSeconds } from '../../services/perf-format'

const SOURCE_LABEL: Record<string, string> = {
  benchmark: '实测数据',
  history: '历史记录',
  heuristic: '规则推导'
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export function RecommendationPanel(props: {
  mode: PerformanceMode
  recommendation: OptimizationRecommendation | null
  currentProjectPath: string
  applying: boolean
  disabled: boolean
  onApply: () => void
}): JSX.Element {
  const rec = props.recommendation
  const staleProject =
    !!rec?.projectPath &&
    !!props.currentProjectPath &&
    rec.projectPath.replace(/[\\/]+/g, '/').toLowerCase() !==
      props.currentProjectPath.replace(/[\\/]+/g, '/').toLowerCase()
  return (
    <Panel
      title="推荐配置"
      subtitle={
        rec
          ? `${MODE_LABEL[rec.mode]}模式 · 依据：${SOURCE_LABEL[rec.basedOn]}${rec.sampleCount > 0 ? ` · ${rec.sampleCount} 组实测样本` : ''}`
          : '运行自动优化后给出当前设备的最优参数'
      }
    >
      {!rec ? (
        <div className="empty-line">
          还没有推荐结果。点击上方「开始自动优化」会根据当前硬件、CLI 能力与项目负载给出配置。
        </div>
      ) : (
        <>
          {staleProject && (
            <p className="reco-stale">
              这份推荐基于项目「{rec.projectPath.split(/[\\/]/).filter(Boolean).pop()}」测算，当前项目已切换，建议重新优化。
            </p>
          )}
          <div className="reco-grid">
            <div className="reco-item">
              <span className="reco-label">Workers</span>
              <strong>{String(rec.chosen.workers)}</strong>
            </div>
            <div className="reco-item">
              <span className="reco-label">GPU 编码</span>
              <strong>{rec.chosen.gpuEncode ? '开启' : '关闭'}</strong>
              <span className="reco-sub">{rec.chosen.encoderLabel ?? 'CPU 编码'}</span>
            </div>
            <div className="reco-item">
              <span className="reco-label">Browser GPU</span>
              <strong>{rec.chosen.browserGpu === 'on' ? '强制开启' : rec.chosen.browserGpu === 'off' ? '关闭' : 'auto'}</strong>
            </div>
            <div className="reco-item">
              <span className="reco-label">捕获路径</span>
              <strong>
                {rec.chosen.capturePath === 'fast-capture'
                  ? 'fast capture'
                  : rec.chosen.capturePath === 'parallel-stream'
                    ? '并行流（实验）'
                    : '默认截图'}
              </strong>
            </div>
            <div className="reco-item">
              <span className="reco-label">低内存模式</span>
              <strong>{rec.chosen.extra.lowMemoryMode === 'on' ? '开启' : rec.chosen.extra.lowMemoryMode === 'off' ? '关闭' : 'auto'}</strong>
            </div>
            <div className="reco-item">
              <span className="reco-label">实测耗时</span>
              <strong>
                {rec.expectedMs
                  ? formatSeconds(rec.expectedMs)
                  : rec.mode === 'extreme'
                    ? '待实测'
                    : '未实测'}
              </strong>
            </div>
          </div>

          <div className="reason-list">
            {rec.reasons.map((reason) => (
              <div className="reason-row" key={reason.key}>
                <span className="reason-label">{reason.label}</span>
                <span className="reason-value">{reason.value}</span>
                <span className="reason-text">{reason.reason}</span>
                <Badge tone={reason.confidence === 'high' ? 'ok' : reason.confidence === 'medium' ? 'info' : 'warn'}>
                  可信度 {CONFIDENCE_LABEL[reason.confidence]}
                </Badge>
              </div>
            ))}
          </div>

          {rec.workerCandidates.length > 1 && (
            <p className="muted-line">
              候选 Worker：{rec.workerCandidates.map((w) => String(w)).join(' / ')}
              {rec.mode === 'extreme' ? '（将在测试中逐一实测）' : ''}
            </p>
          )}

          {rec.warnings.length > 0 && (
            <ul className="warn-list">
              {rec.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div className="panel-foot">
            <Button variant="primary" onClick={props.onApply} disabled={props.disabled || props.applying}>
              {props.applying ? <Spinner /> : null}
              应用推荐配置
            </Button>
            <span className="muted-line">只修改渲染参数，不会修改项目文件，也不会改变输出格式与质量。</span>
          </div>
        </>
      )}
    </Panel>
  )
}
