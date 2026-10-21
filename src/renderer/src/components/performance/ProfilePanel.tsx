import { useState } from 'react'
import { Badge, Button, Panel } from '../ui'
import type { FallbackEvent, HardwareProfile, RenderProfile } from '@shared/types/performance'
import { MODE_LABEL, formatBytes, formatPct, formatSeconds, shortPath } from '../../services/perf-format'

function formatDate(iso: string): string {
  if (!iso) return 'N/A'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'N/A'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ProfilePanel(props: {
  hardwareProfile: HardwareProfile | null
  profiles: RenderProfile[]
  fallbacks: FallbackEvent[]
  onDeleteProfile: (id: string) => void
  onReset: () => void
  busy: boolean
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const hw = props.hardwareProfile

  return (
    <Panel
      title="硬件档案"
      subtitle="全部保存在本机，不上传任何路径或设备信息"
      actions={
        confirming ? (
          <span className="confirm-row">
            <span className="muted-line">确认清空全部档案与历史？</span>
            <Button size="sm" variant="danger" onClick={props.onReset} disabled={props.busy}>
              确认清空
            </Button>
            <button type="button" className="link-btn" onClick={() => setConfirming(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
            重置档案
          </button>
        )
      }
    >
      {!hw ? (
        <div className="empty-line">尚未生成设备档案</div>
      ) : (
        <div className="hw-card">
          <div className="hw-head">
            <strong>{hw.name}</strong>
            {hw.reference && <Badge tone="info">参考档案 {hw.referenceId}</Badge>}
          </div>
          <div className="hw-grid">
            <span>CPU</span>
            <span>{hw.cpuModel}</span>
            <span>核心</span>
            <span>{hw.cpuCores}</span>
            <span>GPU</span>
            <span>{hw.gpuNames.join(' / ') || 'N/A'}</span>
            <span>内存</span>
            <span>{hw.memoryGb} GB</span>
            <span>系统</span>
            <span>{hw.os}</span>
            <span>CLI</span>
            <span>{hw.cliVersion ? `v${hw.cliVersion}` : 'N/A'}</span>
            <span>可用编码器</span>
            <span>{hw.encoders.filter((e) => e.working).map((e) => e.id).join(', ') || 'N/A'}</span>
            <span>首次记录</span>
            <span>{formatDate(hw.firstSeenAt)}</span>
          </div>
          {hw.reference && (
            <p className="muted-line">
              这是开发者实机参考档案，只在本机硬件完全匹配时提供候选建议，不会成为其他设备的默认配置。
            </p>
          )}
        </div>
      )}

      <div className="cap-title" style={{ marginTop: 14 }}>
        渲染档案（{props.profiles.length}）
      </div>
      {props.profiles.length === 0 ? (
        <div className="empty-line">完成一次渲染或性能测试后，这里会记录实测配置。</div>
      ) : (
        <div className="profile-list">
          {props.profiles.slice(0, 8).map((p) => (
            <div className="profile-item" key={p.id}>
              <div className="profile-main">
                <span className="profile-name">
                  {p.scope === 'project' ? shortPath(p.projectName || p.projectPath, 30) : '设备默认'}
                </span>
                <span className="profile-meta">
                  {p.format.toUpperCase()} · {p.fpsLabel} · {p.quality} · {String(p.workers)} worker ·{' '}
                  {p.gpuEncode ? p.encoderId ?? 'GPU 编码' : 'CPU 编码'}
                </span>
              </div>
              <div className="profile-numbers">
                <span>{formatSeconds(p.benchmarkMs ?? null)}</span>
                <span className="muted-line">
                  {p.resourcePeak.vramBytes != null ? `显存 ${formatBytes(p.resourcePeak.vramBytes)}` : ''}
                  {p.resourcePeak.cpuPct != null ? ` · CPU ${formatPct(p.resourcePeak.cpuPct)}` : ''}
                </span>
              </div>
              <button type="button" className="link-btn" onClick={() => props.onDeleteProfile(p.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {props.fallbacks.length > 0 && (
        <>
          <div className="cap-title" style={{ marginTop: 14 }}>
            最近的回退记录
          </div>
          <div className="fallback-list">
            {props.fallbacks.slice(0, 6).map((event, i) => (
              <div className="fallback-item" key={`${event.ts}-${i}`}>
                <span className="fallback-time">{formatDate(event.ts)}</span>
                <span className="fallback-reason">{event.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

export { MODE_LABEL }
