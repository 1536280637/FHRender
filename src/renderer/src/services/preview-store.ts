/**
 * 预览服务的前端唯一状态源。
 *
 * 背景：之前预览状态分散在多处——`usePreview` 内部的 state、按钮内部的局部布尔、
 * 以及主进程事件；页面重新挂载或事件时序稍有偏差，就会出现「服务已经起来了，
 * 按钮还显示开启预览」。这里把状态收敛成一个 store：
 *
 * - 唯一数据源：主进程 PreviewManager 的 PreviewRuntimeState（通过 IPC 推送 + 主动查询对账）；
 * - 唯一状态机：idle / starting / running / stopping / error；
 * - 所有组件通过 useSyncExternalStore 读同一份快照；
 * - 事件订阅只建立一次（模块级），不随组件挂载/卸载反复订阅。
 *
 * 传输层通过 PreviewTransport 注入，便于用假 transport 做状态机回归测试。
 */

import type {
  PreviewActionResult,
  PreviewRuntimeState,
  PreviewSession
} from '@shared/types/preview'

export type PreviewPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export type PreviewBusy = 'starting' | 'opening' | 'stopping' | null

export interface PreviewStoreSnapshot {
  phase: PreviewPhase
  /** 主进程返回的完整运行时状态（包含 capabilities / sessions） */
  state: PreviewRuntimeState | null
  /** 当前选中项目的会话（服务未运行时为 null） */
  session: PreviewSession | null
  busy: PreviewBusy
  /** 最近一次操作的错误（成功的操作会清空） */
  error: string | null
  projectPath: string | null
}

export interface PreviewTransport {
  start(projectPath: string): Promise<PreviewActionResult>
  open(projectPath: string): Promise<PreviewActionResult>
  stop(projectPath: string): Promise<PreviewActionResult>
  status(projectPath: string | null): Promise<PreviewRuntimeState>
  onEvent(listener: (state: PreviewRuntimeState) => void): () => void
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 按会话过滤出「当前项目」的那一个，绝不把别的项目的服务当成本项目的 */
export function matchSession(state: PreviewRuntimeState | null, projectPath: string | null): PreviewSession | null {
  if (!state || !projectPath) return null
  if (state.current && samePath(state.current.projectPath, projectPath)) return state.current
  return state.sessions.find((s) => samePath(s.projectPath, projectPath)) ?? null
}

/**
 * 状态机：会话状态 + 操作忙碌态 + 最近错误 → 统一的 5 种界面状态。
 *
 * 关键点：服务在跑（running）优先于历史错误；停止中 / 启动中优先于会话状态，
 * 这样点击后按钮立刻切换，不用等主进程下一个事件。
 */
export function derivePreviewPhase(
  session: PreviewSession | null,
  busy: PreviewBusy,
  lastError: string | null
): PreviewPhase {
  if (busy === 'starting') return 'starting'
  if (busy === 'stopping') return 'stopping'
  if (session) {
    if (session.status === 'running') return 'running'
    if (session.status === 'starting') return 'starting'
    if (session.status === 'stopping') return 'stopping'
    if (session.status === 'error') return 'error'
  }
  if (lastError) return 'error'
  return 'idle'
}

function emptyState(): PreviewStoreSnapshot {
  return { phase: 'idle', state: null, session: null, busy: null, error: null, projectPath: null }
}

export class PreviewStore {
  private transport: PreviewTransport
  private listeners = new Set<() => void>()
  private snap: PreviewStoreSnapshot = emptyState()
  private unsubscribeBridge: (() => void) | null = null
  private refreshSeq = 0

  constructor(transport: PreviewTransport) {
    this.transport = transport
  }

  /* ------------------------------ 订阅 ------------------------------ */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.ensureBridge()
    return () => {
      this.listeners.delete(listener)
      // 说明：IPC 订阅是应用级单例，不随某个组件卸载而断开；
      // 否则「离开页面再回来」时事件可能落空，又回到依赖主动查询的老问题。
    }
  }

  getSnapshot = (): PreviewStoreSnapshot => this.snap

  private ensureBridge(): void {
    if (this.unsubscribeBridge) return
    this.unsubscribeBridge = this.transport.onEvent((next) => this.applyEvent(next))
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private patch(patch: Partial<PreviewStoreSnapshot>): void {
    const next: PreviewStoreSnapshot = { ...this.snap, ...patch }
    next.phase = derivePreviewPhase(next.session, next.busy, next.error)
    this.snap = next
    this.notify()
  }

  private applyEvent(state: PreviewRuntimeState): void {
    if (!this.snap.projectPath) return
    const session = matchSession(state, this.snap.projectPath)
    // 事件里显示「运行中」时清掉历史错误；其它情况保留错误，避免按钮闪回 idle
    const error = session?.status === 'running' ? null : this.snap.error
    this.patch({ state, session, error })
  }

  /* ------------------------------ 项目 ------------------------------ */

  /**
   * 切换 / 进入页面时调用。
   * 即使路径没变也会主动向主进程对账一次——页面重新挂载后不能直接恢复默认 idle。
   */
  async setProject(projectPath: string | null): Promise<void> {
    this.ensureBridge()
    if (this.snap.projectPath !== projectPath) {
      const hadSession = this.snap.session !== null || this.snap.phase !== 'idle'
      this.snap = { ...emptyState(), projectPath }
      // 只有界面真的发生了变化才通知，避免无意义的重渲染
      if (hadSession) this.notify()
    }
    await this.refresh()
  }

  /** 主动查询主进程真实状态（唯一权威来源） */
  async refresh(): Promise<void> {
    const path = this.snap.projectPath
    if (!path) {
      this.snap = emptyState()
      this.patch({})
      return
    }
    const seq = ++this.refreshSeq
    try {
      /*
       * 只查 status，不查 list。
       * 主进程的 list() 会与 CLI 对账并剔除"查不到"的会话，属于会改状态的操作；
       * 界面每次挂载/操作后都调一次，等于让 UI 去触发服务状态变更——
       * 实测会出现"预览还在跑，但 list 一次探活抖动就把会话删掉，按钮变回开启预览"。
       * 状态对账统一交给主进程（status + 健康轮询 + 事件推送），渲染进程只读。
       */
      const state = await this.transport.status(path)
      if (seq !== this.refreshSeq) return
      const session = matchSession(state, path)
      // 主进程明确说这个项目的服务在跑 / 启动失败，就采信；查不到会话时才保留本地错误
      const error = session ? (session.status === 'running' ? null : this.snap.error) : this.snap.error
      this.patch({ state, session, error })
    } catch {
      // 查询失败不能把界面卡在"启动中"
      if (seq !== this.refreshSeq) return
      this.patch({ busy: null })
    }
  }

  /* ------------------------------ 操作 ------------------------------ */

  async start(): Promise<PreviewActionResult> {
    const path = this.snap.projectPath
    if (!path) return { ok: false, error: '请先选择项目' }
    this.patch({ busy: 'starting', error: null })
    let result: PreviewActionResult
    try {
      result = await this.transport.start(path)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (result.session) {
      this.patch({ state: applySession(this.snap.state, result.session, path), session: result.session })
    }
    if (!result.ok) this.patch({ error: result.error ?? '开启预览失败' })
    this.patch({ busy: null })
    await this.refresh()
    return result
  }

  async open(): Promise<PreviewActionResult> {
    const path = this.snap.projectPath
    if (!path) return { ok: false, error: '请先选择项目' }
    const phase = this.snap.phase
    // 运行中才走 open；否则按「重新开启」处理（主进程 open 也会自动启动，这里保持一致）
    if (phase === 'running') this.patch({ busy: 'opening' })
    else this.patch({ busy: 'starting', error: null })
    let result: PreviewActionResult
    try {
      result = await this.transport.open(path)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (result.session) {
      this.patch({ state: applySession(this.snap.state, result.session, path), session: result.session })
    }
    if (!result.ok) this.patch({ error: result.error ?? '打开预览失败' })
    this.patch({ busy: null })
    await this.refresh()
    return result
  }

  async stop(): Promise<PreviewActionResult> {
    const path = this.snap.projectPath
    if (!path) return { ok: false, error: '请先选择项目' }
    this.patch({ busy: 'stopping' })
    let result: PreviewActionResult
    try {
      result = await this.transport.stop(path)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.patch({ busy: null })
    await this.refresh()
    // 停止成功后会话已经不存在：清掉错误，回到 idle
    if (result.ok) this.patch({ error: null, session: null })
    return result
  }
}

function applySession(
  prev: PreviewRuntimeState | null,
  session: PreviewSession,
  path: string
): PreviewRuntimeState {
  const base: PreviewRuntimeState = prev ?? {
    current: null,
    sessions: [],
    capabilities: {
      helpAvailable: false,
      background: false,
      noOpen: false,
      json: false,
      status: false,
      stop: false,
      list: false
    },
    cliVersion: session.cliVersion,
    helpError: null
  }
  const sessions = base.sessions.filter((s) => !samePath(s.projectPath, session.projectPath))
  return {
    ...base,
    sessions: [...sessions, session],
    current: samePath(session.projectPath, path) ? session : base.current
  }
}
