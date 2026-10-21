import type { RenderPreset, PresetSaveInput, AppSettings, EnvironmentReport } from './types/settings'
import type { ProjectInfo, RecentProject, ProjectScanResult } from './types/project'
import type {
  BenchmarkEvent,
  BenchmarkPlan,
  BenchmarkSessionState,
  BenchmarkStartInput,
  ModeComparisonPlan,
  MonitorState,
  OptimizationRecommendation,
  PerformanceMode,
  PerformanceReport,
  PerformanceSnapshot,
  ResolvedModePreset,
  WorkloadProfile
} from './types/performance'
import type { CacheClearResult, CacheClearScope, CacheEvent, CacheOverview } from './types/cache'
import type { TestCleanupBatchResult, TestStorageUsage } from './types/cleanup'
import type {
  RenderRequest,
  RenderStartResult,
  RenderSettings,
  RenderTaskState,
  RenderEvent,
  RenderHistoryEntry,
  StoppedResult
} from './types/render'
import type {
  PreviewActionResult,
  PreviewRuntimeState,
  PreviewSession
} from './types/preview'

export const IPC = {
  // 项目
  projectSelect: 'project:select',
  projectScan: 'project:scan',
  projectRecent: 'project:recent',
  projectRemoveRecent: 'project:remove-recent',
  projectCompositions: 'project:compositions',
  projectHtmlFiles: 'project:html-files',
  projectReveal: 'project:reveal',
  projectLint: 'project:lint',
  // 环境
  envCheck: 'env:check',
  // 预设
  presetList: 'preset:list',
  presetSave: 'preset:save',
  presetUpdate: 'preset:update',
  presetDelete: 'preset:delete',
  presetReset: 'preset:reset',
  // 设置
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  // 渲染
  renderStart: 'render:start',
  renderStop: 'render:stop',
  renderState: 'render:state',
  renderEvent: 'render:event',
  renderClearLogs: 'render:clear-logs',
  renderHistory: 'render:history',
  // 系统
  dialogSelectDirectory: 'dialog:select-directory',
  dialogSelectComposition: 'dialog:select-composition',
  openPath: 'shell:open-path',
  showItem: 'shell:show-item',
  appInfo: 'app:info',
  // 性能优化
  perfSnapshot: 'perf:snapshot',
  perfRescan: 'perf:rescan',
  perfOptimize: 'perf:optimize',
  perfPlanBenchmark: 'perf:plan-benchmark',
  perfBenchmarkStart: 'perf:benchmark-start',
  perfBenchmarkStop: 'perf:benchmark-stop',
  perfBenchmarkState: 'perf:benchmark-state',
  perfBenchmarkEvent: 'perf:benchmark-event',
  perfMonitorEvent: 'perf:monitor-event',
  perfResetProfiles: 'perf:reset-profiles',
  // 性能中心扩展：固定模式预设 / 四模式对比测试 / 性能报告
  perfModePresets: 'perf:mode-presets',
  perfComparisonPlan: 'perf:comparison-plan',
  perfComparisonStart: 'perf:comparison-start',
  perfReports: 'perf:reports',
  perfCacheStatus: 'perf:cache-status',
  perfCacheRefreshHardware: 'perf:cache-refresh-hardware',
  perfCacheReanalyze: 'perf:cache-reanalyze',
  perfCacheClear: 'perf:cache-clear',
  perfCacheEvent: 'perf:cache-event',
  // 性能测试临时文件清理
  perfTestStorage: 'perf:test-storage',
  perfTestCleanup: 'perf:test-cleanup',
  // 预览服务（HyperFrames Preview）
  previewStart: 'preview:start',
  previewStatus: 'preview:status',
  previewOpen: 'preview:open',
  previewStop: 'preview:stop',
  previewList: 'preview:list',
  previewEvent: 'preview:event',
  // 窗口（自定义标题栏）
  windowSetTheme: 'window:set-theme',
  windowGetState: 'window:get-state',
  windowStateEvent: 'window:state-event'
} as const

export interface LintFinding {
  level: 'error' | 'warning' | 'info'
  message: string
  file?: string
  line?: number
}

export interface LintResult {
  ok: boolean
  findings: LintFinding[]
  error?: string
  raw?: string
}

/** 窗口状态（自定义标题栏需要跟随最大化 / 全屏变化） */
export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
  platform: string
}

/** preload 暴露给渲染进程的 API 形状 */
export interface HfRenderApi {
  project: {
    select(): Promise<ProjectScanResult>
    /** 扫描项目；传 composition 时按该入口解析时长 / 分辨率 / FPS */
    scan(path: string, composition?: string | null): Promise<ProjectScanResult>
    recent(): Promise<RecentProject[]>
    removeRecent(path: string): Promise<RecentProject[]>
    compositions(path: string): Promise<ProjectInfo['compositions']>
    htmlFiles(path: string): Promise<string[]>
    reveal(path: string): Promise<void>
    lint(path: string): Promise<LintResult>
  }
  env: {
    check(projectPath?: string): Promise<EnvironmentReport>
  }
  presets: {
    list(): Promise<RenderPreset[]>
    save(input: PresetSaveInput): Promise<RenderPreset[]>
    update(id: string, input: PresetSaveInput): Promise<RenderPreset[]>
    remove(id: string): Promise<RenderPreset[]>
    reset(): Promise<RenderPreset[]>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  render: {
    start(request: RenderRequest): Promise<RenderStartResult>
    stop(): Promise<StoppedResult>
    state(): Promise<RenderTaskState>
    clearLogs(): Promise<void>
    /** 历史渲染记录（含每次任务真正使用的配置快照） */
    history(): Promise<RenderHistoryEntry[]>
    onEvent(listener: (event: RenderEvent) => void): () => void
  }
  dialog: {
    selectDirectory(defaultPath?: string): Promise<string | null>
    selectComposition(projectPath: string): Promise<string | null>
  }
  shell: {
    openPath(path: string): Promise<void>
    showItem(path: string): Promise<void>
  }
  app: {
    info(): Promise<{ version: string; electron: string; node: string; platform: string }>
  }
  performance: {
    snapshot(input: {
      projectPath?: string | null
      settings?: RenderSettings | null
      composition?: string | null
    }): Promise<PerformanceSnapshot>
    rescan(): Promise<PerformanceSnapshot>
    optimize(input: {
      mode: PerformanceMode
      projectPath?: string | null
      settings?: RenderSettings | null
      allowExperimental?: boolean
    }): Promise<OptimizationRecommendation>
    planBenchmark(input: BenchmarkStartInput): Promise<BenchmarkPlan>
    startBenchmark(input: BenchmarkStartInput): Promise<{
      ok: boolean
      error?: string
      plan?: BenchmarkPlan
    }>
    stopBenchmark(): Promise<{ ok: boolean }>
    benchmarkState(): Promise<BenchmarkSessionState>
    resetProfiles(): Promise<void>
    onBenchmarkEvent(listener: (event: BenchmarkEvent) => void): () => void
    onMonitor(listener: (state: MonitorState) => void): () => void
    /* --------- 性能中心扩展 --------- */
    /** 解析四种模式的参数展示（固定三模式走静态预设，智能模式来自当前推荐） */
    modePresets(input: { settings: RenderSettings; allowExperimental?: boolean }): Promise<ResolvedModePreset[]>
    /** 生成四模式对比测试计划（只展示，不启动） */
    planComparison(input: {
      projectPath: string
      settings: RenderSettings
      kind: 'quick' | 'precise'
    }): Promise<ModeComparisonPlan>
    /** 启动四模式对比测试（状态通过 onBenchmarkEvent 推送） */
    startComparison(input: {
      projectPath: string
      settings: RenderSettings
      kind: 'quick' | 'precise'
      allowExperimental?: boolean
    }): Promise<{ ok: boolean; error?: string; plan?: ModeComparisonPlan }>
    /** 历史性能报告 */
    reports(): Promise<PerformanceReport[]>
    /* --------- 缓存与检测 --------- */
    /** 缓存状态：最后检测时间、文件位置、本次会话的检测次数 */
    cacheStatus(projectPath?: string | null): Promise<CacheOverview>
    /** 手动刷新设备信息（强制完整识别 + 重新验证编码器） */
    refreshHardware(): Promise<CacheOverview>
    /** 重新分析当前项目（忽略缓存与文件指纹） */
    reanalyzeProject(input: { projectPath: string; composition?: string | null }): Promise<{
      ok: boolean
      workload: WorkloadProfile | null
      error?: string
    }>
    /** 清除本地缓存（不会触碰用户项目文件） */
    clearCaches(input: { scope: CacheClearScope; projectPath?: string | null }): Promise<CacheClearResult>
    /** 项目文件变化（监听器 / 指纹失效）时推送，界面据此后台刷新 */
    onCacheEvent(listener: (event: CacheEvent) => void): () => void
    /* --------- 性能测试临时文件 --------- */
    /** 本地测试文件占用空间（performance-tests 下各任务） */
    testStorage(): Promise<TestStorageUsage>
    /** 立即清理历史临时文件：只处理带本应用 manifest 的任务目录 */
    cleanupTestFiles(): Promise<TestCleanupBatchResult>
  }
  preview: {
    /** 启动（或复用）指定项目的预览服务，并在就绪后打开系统默认浏览器 */
    start(projectPath: string): Promise<PreviewActionResult>
    /** 读取运行时状态；传入项目路径时以该项目为“当前项目” */
    status(projectPath?: string | null): Promise<PreviewRuntimeState>
    /** 重新打开已保存的 Studio 地址（不会重复启动服务） */
    open(projectPath: string): Promise<PreviewActionResult>
    /** 停止指定项目的预览服务（调用 CLI 的服务生命周期管理） */
    stop(projectPath: string): Promise<PreviewActionResult>
    /** 列出所有活跃的预览服务（含外部启动的） */
    list(): Promise<PreviewSession[]>
    onEvent(listener: (state: PreviewRuntimeState) => void): () => void
  }
  window: {
    /** 主进程据此同步原生窗口按钮（titleBarOverlay）的配色 */
    setTheme(mode: 'light' | 'dark'): Promise<void>
    getState(): Promise<WindowState>
    onState(listener: (state: WindowState) => void): () => void
  }
}
