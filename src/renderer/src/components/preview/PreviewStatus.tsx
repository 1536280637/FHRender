import { Badge, Button, Icon, Spinner } from '../ui'
import { copyText, formatClock } from '../../services/api'
import type { PreviewBusy } from '../../services/use-preview'
import type { PreviewRuntimeState, PreviewSession } from '@shared/types/preview'

interface Props {
  state: PreviewRuntimeState | null
  session: PreviewSession | null
  busy: PreviewBusy
  hasProject: boolean
  onStart: () => void
  onOpen: () => void
  onStop: () => void
  onToast: (message: string, tone?: 'ok' | 'error') => void
}

function statusText(session: PreviewSession | null): {
  label: string
  tone: 'neutral' | 'ok' | 'warn' | 'error' | 'info'
} {
  if (!session) return { label: '未启动', tone: 'neutral' }
  switch (session.status) {
    case 'starting':
      return { label: '启动中', tone: 'info' }
    case 'running':
      return session.healthy
        ? { label: '运行中', tone: 'ok' }
        : { label: '无响应', tone: 'error' }
    case 'stopping':
      return { label: '停止中', tone: 'warn' }
    case 'error':
      return { label: '启动失败', tone: 'error' }
    default:
      return { label: '未启动', tone: 'neutral' }
  }
}

/**
 * 预览服务状态面板。
 * 只展示 CLI 实际返回的信息（端口、Studio URL、启动时间、来源），不做任何猜测。
 */
export function PreviewStatus(props: Props): JSX.Element {
  const { session, state } = props
  const status = statusText(session)
  const caps = state?.capabilities
  const unsupported = state && !state.capabilities.helpAvailable

  return (
    <section className="panel preview-panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>预览服务</h2>
          <p>在浏览器中打开 HyperFrames Studio，实时预览并热更新；不会生成视频文件。</p>
        </div>
        <div className="panel-head-actions">
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </header>

      <div className="panel-body">
        {unsupported && (
          <div className="alert alert-error">
            {state?.helpError ?? '当前 HyperFrames CLI 不支持 preview 子命令'}
            <div className="preview-hint">
              请先安装 Node.js 18+ 与 HyperFrames CLI：<code>npm i -g hyperframes</code>，然后在环境检测中确认版本。
            </div>
          </div>
        )}

        {!session && !unsupported && (
          <div className="preview-idle">
            <div className="preview-idle-icon">
              <Icon.Server />
            </div>
            <div>
              <strong>预览服务未运行</strong>
              <p>
                点击「开启预览」会自动启动本地 Preview 服务，并用系统默认浏览器打开 Studio。
                不需要打开终端，也不需要手动输入命令。
              </p>
            </div>
          </div>
        )}

        {session?.status === 'starting' && (
          <div className="preview-idle">
            <Spinner />
            <div>
              <strong>正在启动 HyperFrames Preview…</strong>
              <p>首次调用或新版 CLI 安装时可能需要几十秒，请稍候。</p>
            </div>
          </div>
        )}

        {session && session.status !== 'starting' && (
          <>
            <div className="preview-grid">
              <div className="preview-item">
                <span className="preview-label">项目</span>
                <strong className="preview-value" title={session.projectPath}>
                  {session.projectName}
                </strong>
              </div>
              <div className="preview-item">
                <span className="preview-label">端口</span>
                <strong className="preview-value mono">{session.port ?? 'N/A'}</strong>
              </div>
              <div className="preview-item">
                <span className="preview-label">启动时间</span>
                <strong className="preview-value">
                  {session.startedAt ? formatClock(session.startedAt) : '未知（非本应用启动）'}
                </strong>
              </div>
              <div className="preview-item">
                <span className="preview-label">服务来源</span>
                <strong className="preview-value">
                  {session.owned ? 'HF Render 启动' : '外部启动（复用）'}
                </strong>
              </div>
            </div>

            <div className="preview-url">
              <span className="preview-label">Studio</span>
              <div className="preview-url-row">
                <code className="preview-url-text" title={session.studioUrl ?? ''}>
                  {session.studioUrl ?? 'CLI 未返回 Studio 地址'}
                </code>
                <button
                  type="button"
                  className="icon-btn"
                  title="复制 Studio 地址"
                  disabled={!session.studioUrl}
                  onClick={async () => {
                    if (!session.studioUrl) return
                    const ok = await copyText(session.studioUrl)
                    props.onToast(ok ? 'Studio 地址已复制' : '复制失败', ok ? 'ok' : 'error')
                  }}
                >
                  <Icon.Copy />
                </button>
              </div>
            </div>

            {session.error && (
              <div className="alert alert-error preview-error">{session.error}</div>
            )}

            {!session.owned && session.status === 'running' && (
              <p className="preview-note">
                该服务不是 HF Render 启动的，退出应用不会关闭它；点击「停止预览服务」会通过 CLI 停止这个项目的服务。
              </p>
            )}

            <div className="preview-actions">
              {session.status === 'error' && (
                <Button
                  variant="subtle"
                  onClick={props.onStart}
                  disabled={props.busy !== null}
                  title="重新启动预览服务"
                >
                  {props.busy === 'starting' ? <Spinner /> : <Icon.Refresh />}
                  重试
                </Button>
              )}
              <Button
                variant="subtle"
                onClick={props.onOpen}
                disabled={props.busy !== null || session.status !== 'running'}
              >
                {props.busy === 'opening' ? <Spinner /> : <Icon.External />}
                打开预览
              </Button>
              <Button
                variant="danger"
                onClick={props.onStop}
                disabled={props.busy !== null || session.status === 'stopping'}
              >
                {props.busy === 'stopping' ? <Spinner /> : <Icon.Stop />}
                停止预览服务
              </Button>
            </div>
          </>
        )}

        {!session && !unsupported && (
          <div className="preview-actions">
            <Button variant="subtle" onClick={props.onStart} disabled={!props.hasProject || props.busy !== null}>
              {props.busy === 'starting' ? <Spinner /> : <Icon.Eye />}
              开启预览
            </Button>
          </div>
        )}

        <div className="preview-meta">
          <span>
            CLI{' '}
            <span className="mono">{state?.cliVersion ? `v${state.cliVersion}` : '版本未知'}</span>
          </span>
          {caps && (
            <span>
              能力：{caps.background ? '后台启动' : '前台兜底'} · {caps.json ? 'JSON' : '文本输出'} ·{' '}
              {caps.stop ? '可停止' : '不可停止'}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
