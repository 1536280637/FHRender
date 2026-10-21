import { Icon, Spinner } from '../ui'
import type { PreviewBusy, PreviewPhase } from '../../services/use-preview'

interface Props {
  /** 统一的预览状态（主进程 PreviewManager 为唯一来源） */
  phase: PreviewPhase
  busy: PreviewBusy
  /** 最近一次操作失败的原因（用于 title，不改变按钮语义） */
  error?: string | null
  /** 未选择项目 / 页面未就绪时禁用 */
  disabled?: boolean
  onStart: () => void
  onOpen: () => void
}

/**
 * 「开启预览」次级按钮（浅绿色填充，与主按钮「开始渲染」区分）。
 *
 * - idle：开启预览
 * - starting：正在启动…（禁用，防重复点击）
 * - running：打开预览（带绿色运行指示，直接打开已保存的 Studio URL）
 * - stopping：正在停止…
 * - error：重新开启预览（点击重新启动）
 */
export function PreviewButton(props: Props): JSX.Element {
  const { phase, busy } = props
  const disabled = props.disabled === true

  if (phase === 'starting') {
    return (
      <button type="button" className="btn btn-preview is-busy" disabled title="正在启动 HyperFrames Preview">
        <Spinner />
        正在启动…
      </button>
    )
  }

  if (phase === 'stopping') {
    return (
      <button type="button" className="btn btn-preview is-busy" disabled title="正在停止预览服务">
        <Spinner />
        正在停止…
      </button>
    )
  }

  if (phase === 'running') {
    return (
      <button
        type="button"
        className="btn btn-preview is-running"
        onClick={props.onOpen}
        disabled={disabled || busy === 'opening'}
        title={
          props.error
            ? `在浏览器中打开 HyperFrames Studio（${props.error}）`
            : '在浏览器中打开已运行的 HyperFrames Studio（不会重复启动服务）'
        }
      >
        {busy === 'opening' ? <Spinner /> : <span className="preview-dot" aria-hidden />}
        打开预览
      </button>
    )
  }

  if (phase === 'error') {
    return (
      <button
        type="button"
        className="btn btn-preview is-error"
        onClick={props.onStart}
        disabled={disabled}
        title={props.error ? `上次启动失败：${props.error}` : '重新启动 HyperFrames Preview'}
      >
        <Icon.Refresh />
        重新开启预览
      </button>
    )
  }

  return (
    <button
      type="button"
      className="btn btn-preview"
      onClick={props.onStart}
      disabled={disabled}
      title="启动 HyperFrames Preview 并在浏览器中打开 Studio"
    >
      <Icon.Eye />
      开启预览
    </button>
  )
}
