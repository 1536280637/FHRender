import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { PreviewStore, type PreviewBusy, type PreviewPhase } from './preview-store'
import type { PreviewActionResult, PreviewRuntimeState, PreviewSession } from '@shared/types/preview'

export type { PreviewBusy, PreviewPhase }

export interface PreviewController {
  state: PreviewRuntimeState | null
  session: PreviewSession | null
  busy: PreviewBusy
  /** 统一的 5 态：idle / starting / running / stopping / error */
  phase: PreviewPhase
  error: string | null
  /** 启动（或复用）预览服务并打开浏览器 */
  start: () => Promise<PreviewActionResult>
  /** 打开已保存的 Studio 地址（不会重复启动服务） */
  open: () => Promise<PreviewActionResult>
  /** 停止当前项目的预览服务 */
  stop: () => Promise<PreviewActionResult>
  refresh: () => Promise<void>
}

/**
 * 真实传输层：包一层 IPC。所有系统级操作仍然由主进程 PreviewManager 完成，
 * 这里只做状态转发，避免渲染进程自己"猜"服务状态。
 */
const transport = {
  start: (path: string) => api().preview.start(path),
  open: (path: string) => api().preview.open(path),
  stop: (path: string) => api().preview.stop(path),
  status: (path: string | null) => api().preview.status(path),
  onEvent: (listener: (state: PreviewRuntimeState) => void) => api().preview.onEvent(listener)
}

/** 应用级单例：所有组件读同一份状态，事件订阅也只建立一次 */
export const previewStore = new PreviewStore(transport)

/**
 * 预览状态 hook（保持原有返回结构，内部改为读统一 store）。
 *
 * - 进入页面 / 切换项目时主动向主进程查询真实状态，不会默认回到 idle；
 * - 渲染进程只订阅一次 IPC 事件，组件卸载不会丢失后续更新；
 * - phase 是唯一的状态判断依据，按钮不再各自维护布尔值。
 */
export function usePreview(projectPath: string | null): PreviewController {
  const snapshot = useSyncExternalStore(previewStore.subscribe, previewStore.getSnapshot, previewStore.getSnapshot)

  useEffect(() => {
    void previewStore.setProject(projectPath)
  }, [projectPath])

  return {
    state: snapshot.state,
    session: snapshot.session,
    busy: snapshot.busy,
    phase: snapshot.phase,
    error: snapshot.error,
    start: () => previewStore.start(),
    open: () => previewStore.open(),
    stop: () => previewStore.stop(),
    refresh: () => previewStore.refresh()
  }
}
