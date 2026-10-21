import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 切换该值（例如切换页面）时自动清除错误状态 */
  resetKey: string
}

interface State {
  message: string | null
  stack: string | null
}

/**
 * 页面级错误边界：任何一页渲染出错时，显示可读的错误信息，
 * 而不是让整个窗口变成白屏。渲染失败不影响已经完成的渲染任务。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null, stack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { message: error.message || String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只输出到控制台，不写入磁盘，不上报
    console.error('[hf-render] 页面渲染出错', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? null })
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null, stack: null })
    }
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children
    return (
      <div className="error-screen">
        <div className="error-card">
          <h2>这个页面出错了</h2>
          <p className="error-msg">{this.state.message}</p>
          <p className="muted-line">
            已完成的渲染任务不受影响。可以切换页面重试；如果反复出现，请把下面的信息反馈给开发者。
          </p>
          {this.state.stack && <pre className="error-stack">{this.state.stack.trim().slice(0, 1200)}</pre>}
          <button type="button" className="link-btn" onClick={() => this.setState({ message: null, stack: null })}>
            重试
          </button>
        </div>
      </div>
    )
  }
}
