import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { HfRenderApi } from '@shared/ipc'
import type { RenderEvent } from '@shared/types/render'
import type { AppSettings } from '@shared/types/settings'
import type { BenchmarkEvent, MonitorState } from '@shared/types/performance'
import type { PreviewRuntimeState } from '@shared/types/preview'
import type { WindowState } from '@shared/ipc'

const api: HfRenderApi & {
  onMenuOpenProject(listener: () => void): () => void
} = {
  project: {
    select: () => ipcRenderer.invoke(IPC.projectSelect),
    scan: (path, composition) => ipcRenderer.invoke(IPC.projectScan, path, composition ?? null),
    recent: () => ipcRenderer.invoke(IPC.projectRecent),
    removeRecent: (path) => ipcRenderer.invoke(IPC.projectRemoveRecent, path),
    compositions: (path) => ipcRenderer.invoke(IPC.projectCompositions, path),
    htmlFiles: (path) => ipcRenderer.invoke(IPC.projectHtmlFiles, path),
    reveal: (path) => ipcRenderer.invoke(IPC.projectReveal, path),
    lint: (path) => ipcRenderer.invoke(IPC.projectLint, path)
  },
  env: {
    check: (projectPath) => ipcRenderer.invoke(IPC.envCheck, projectPath)
  },
  presets: {
    list: () => ipcRenderer.invoke(IPC.presetList),
    save: (input) => ipcRenderer.invoke(IPC.presetSave, input),
    update: (id, input) => ipcRenderer.invoke(IPC.presetUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IPC.presetDelete, id),
    reset: () => ipcRenderer.invoke(IPC.presetReset)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },
  render: {
    start: (request) => ipcRenderer.invoke(IPC.renderStart, request),
    stop: () => ipcRenderer.invoke(IPC.renderStop),
    state: () => ipcRenderer.invoke(IPC.renderState),
    clearLogs: () => ipcRenderer.invoke(IPC.renderClearLogs),
    history: () => ipcRenderer.invoke(IPC.renderHistory),
    onEvent: (listener: (event: RenderEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: RenderEvent): void => listener(payload)
      ipcRenderer.on(IPC.renderEvent, handler)
      return () => ipcRenderer.removeListener(IPC.renderEvent, handler)
    }
  },
  dialog: {
    selectDirectory: (defaultPath) => ipcRenderer.invoke(IPC.dialogSelectDirectory, defaultPath),
    selectComposition: (projectPath) => ipcRenderer.invoke(IPC.dialogSelectComposition, projectPath)
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke(IPC.openPath, path),
    showItem: (path) => ipcRenderer.invoke(IPC.showItem, path)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
  },
  performance: {
    snapshot: (input) => ipcRenderer.invoke(IPC.perfSnapshot, input),
    rescan: () => ipcRenderer.invoke(IPC.perfRescan),
    optimize: (input) => ipcRenderer.invoke(IPC.perfOptimize, input),
    planBenchmark: (input) => ipcRenderer.invoke(IPC.perfPlanBenchmark, input),
    startBenchmark: (input) => ipcRenderer.invoke(IPC.perfBenchmarkStart, input),
    stopBenchmark: () => ipcRenderer.invoke(IPC.perfBenchmarkStop),
    benchmarkState: () => ipcRenderer.invoke(IPC.perfBenchmarkState),
    resetProfiles: () => ipcRenderer.invoke(IPC.perfResetProfiles),
    onBenchmarkEvent: (listener: (event: BenchmarkEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BenchmarkEvent): void => listener(payload)
      ipcRenderer.on(IPC.perfBenchmarkEvent, handler)
      return () => ipcRenderer.removeListener(IPC.perfBenchmarkEvent, handler)
    },
    onMonitor: (listener: (state: MonitorState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: MonitorState): void => listener(payload)
      ipcRenderer.on(IPC.perfMonitorEvent, handler)
      return () => ipcRenderer.removeListener(IPC.perfMonitorEvent, handler)
    },
    modePresets: (input) => ipcRenderer.invoke(IPC.perfModePresets, input),
    planComparison: (input) => ipcRenderer.invoke(IPC.perfComparisonPlan, input),
    startComparison: (input) => ipcRenderer.invoke(IPC.perfComparisonStart, input),
    reports: () => ipcRenderer.invoke(IPC.perfReports),
    cacheStatus: (projectPath) => ipcRenderer.invoke(IPC.perfCacheStatus, projectPath),
    refreshHardware: () => ipcRenderer.invoke(IPC.perfCacheRefreshHardware),
    reanalyzeProject: (input) => ipcRenderer.invoke(IPC.perfCacheReanalyze, input),
    clearCaches: (input) => ipcRenderer.invoke(IPC.perfCacheClear, input),
    onCacheEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: import('@shared/types/cache').CacheEvent): void =>
        listener(payload)
      ipcRenderer.on(IPC.perfCacheEvent, handler)
      return () => ipcRenderer.removeListener(IPC.perfCacheEvent, handler)
    },
    testStorage: () => ipcRenderer.invoke(IPC.perfTestStorage),
    cleanupTestFiles: () => ipcRenderer.invoke(IPC.perfTestCleanup)
  },
  preview: {
    start: (projectPath) => ipcRenderer.invoke(IPC.previewStart, projectPath),
    status: (projectPath) => ipcRenderer.invoke(IPC.previewStatus, projectPath ?? null),
    open: (projectPath) => ipcRenderer.invoke(IPC.previewOpen, projectPath),
    stop: (projectPath) => ipcRenderer.invoke(IPC.previewStop, projectPath),
    list: () => ipcRenderer.invoke(IPC.previewList),
    onEvent: (listener: (state: PreviewRuntimeState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PreviewRuntimeState): void =>
        listener(payload)
      ipcRenderer.on(IPC.previewEvent, handler)
      return () => ipcRenderer.removeListener(IPC.previewEvent, handler)
    }
  },
  window: {
    setTheme: (mode) => ipcRenderer.invoke(IPC.windowSetTheme, mode),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener: (state: WindowState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: WindowState): void => listener(payload)
      ipcRenderer.on(IPC.windowStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowStateEvent, handler)
    }
  },
  onMenuOpenProject: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('menu:open-project', handler)
    return () => ipcRenderer.removeListener('menu:open-project', handler)
  }
}

contextBridge.exposeInMainWorld('hf', api)
