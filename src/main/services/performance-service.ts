import type { HardwareReport } from '@shared/types/hardware'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BenchmarkCandidate,
  BenchmarkPlan,
  BenchmarkSessionState,
  CapabilityReport,
  CliCapabilities,
  FallbackEvent,
  HardwareProfile,
  ModeComparisonPlan,
  OptimizationArchive,
  OptimizationRecommendation,
  PerformanceMode,
  PerformanceReport,
  PerformanceSnapshot,
  ResolvedModePreset,
  RenderProfile,
  SmartArchiveStatus,
  WorkloadProfile
} from '@shared/types/performance'
import type { CacheClearResult, CacheClearScope, CacheEvent, CacheOverview } from '@shared/types/cache'
import type { TestCleanupBatchResult, TestCleanupPolicy, TestStorageUsage } from '@shared/types/cleanup'
import { PerformanceTestCleanup } from '../cleanup/cleanup-engine'
import type { ProjectMetadata } from '@shared/types/project'
import type { RenderRequest, RenderSettings, RenderTaskState } from '@shared/types/render'
import type { AppSettings } from '@shared/types/settings'
import { BenchmarkEngine } from '../benchmark/benchmark-engine'
import { probeNodeEnvironment } from '../process/environment'
import { CapabilityService } from '../capability/capability-service'
import { CliAdapter } from '../cli/cli-adapter'
import { ProjectMetadataAnalyzer } from '../analyzer/project-metadata'
import { listHtmlFiles } from '../analyzer/html-files'
import { FallbackManager } from '../fallback/fallback-manager'
import { HardwareService } from '../hardware/hardware-service'
import { ResourceMonitor } from '../monitor/resource-monitor'
import { optimize } from '../optimizer/optimizer'
import { detectHardwareTier, resolveModePreset } from '../optimizer/mode-presets'
import { generateWorkerCandidates } from '../optimizer/worker-candidates'
import { ProfileStore } from '../profiles/profile-store'
import { matchReference } from '../profiles/reference-profiles'
import { EnvironmentProfileCache } from '../cache/environment-profile-cache'
import { ProjectMetadataCache } from '../cache/project-metadata-cache'
import { resetCacheCounters, snapshotCounters } from '../cache/counters'
import { dirBytes, profilesDir, userDataDir } from '../cache/cache-io'
import {
  PerformanceReportManager,
  buildPerformanceReport,
  fpsLabelOf
} from './performance-report-manager'
import { ProjectMetadataService } from './project-metadata-service'
import type { ProjectManager } from '../services/project-manager'
import type { RenderManager } from '../process/render-manager'
import type { SettingsManager } from '../services/settings-manager'

export interface PerformanceDeps {
  getCliCommand: () => Promise<string>
  /** 保留依赖注入以便未来复用；项目元数据现在统一走 ProjectMetadataService */
  project: ProjectManager
  render: RenderManager
  settings: SettingsManager
}

/* 说明：performance 不再直接调用 ProjectManager.scan()，
   项目元数据 / 负载分析统一由 ProjectMetadataService（带磁盘缓存 + 文件指纹）提供。 */

const WORKLOAD_TTL_MS = 60_000

export class PerformanceService {
  readonly hardware: HardwareService
  readonly capability: CapabilityService
  readonly cli: CliAdapter
  readonly monitor: ResourceMonitor
  readonly store: ProfileStore
  readonly fallback: FallbackManager
  readonly benchmark: BenchmarkEngine
  readonly reports: PerformanceReportManager
  readonly envCache: EnvironmentProfileCache
  readonly projectMetadata: ProjectMetadataService
  /** 性能测试临时文件清理（单任务清理由 BenchmarkEngine 在 finally 中调用） */
  readonly testCleanup: PerformanceTestCleanup

  private deps: PerformanceDeps
  private workloadCache = new Map<string, { profile: WorkloadProfile; at: number }>()
  private recommendation: OptimizationRecommendation | null = null
  private lastStatus: RenderTaskState['status'] = 'idle'
  private monitorActive = false
  /** 谁在驱动监控：渲染或性能测试（两者互斥） */
  private monitorOwner: 'render' | 'benchmark' | null = null
  private activeRequest: RenderRequest | null = null
  private cacheListeners = new Set<(event: CacheEvent) => void>()

  constructor(deps: PerformanceDeps) {
    this.deps = deps
    const envCache = new EnvironmentProfileCache()
    const metadataCache = new ProjectMetadataCache()
    const analyzer = new ProjectMetadataAnalyzer(deps.getCliCommand)

    this.envCache = envCache
    // HardwareService 内部持有自己的 HardwareProfileCache 实例，但文件路径固定，
    // 与状态查询读到的是同一份 profiles/hardware-profile.json
    this.hardware = new HardwareService()
    this.capability = new CapabilityService(this.hardware, envCache)
    this.cli = new CliAdapter(deps.getCliCommand, envCache)
    this.monitor = new ResourceMonitor(this.hardware)
    this.store = new ProfileStore()
    this.fallback = new FallbackManager(this.store)
    this.projectMetadata = new ProjectMetadataService({
      analyzer,
      cache: metadataCache,
      envCache,
      listHtmlFiles,
      getCliCommand: deps.getCliCommand,
      onProjectChanged: (projectPath, reason) => {
        // 项目文件变化：清掉负载内存缓存，并推给界面做后台刷新（不阻塞用户操作）
        this.workloadCache.clear()
        this.emitCacheEvent({ type: 'project-changed', projectPath, reason, at: new Date().toISOString() })
      }
    })
    this.benchmark = new BenchmarkEngine({
      getCliCommand: deps.getCliCommand,
      getCli: async () => this.cli.probe(),
      monitor: this.monitor,
      // 清理策略与受保护目录都来自用户设置，测试引擎不自己猜
      getCleanupPolicy: async () => this.cleanupPolicy(),
      getForbiddenRoots: async () => {
        const settings = await deps.settings.get()
        return [settings.lastOutputDir, ...settings.recentOutputDirs].filter((p) => !!p && p.trim() !== '')
      }
    })
    this.reports = new PerformanceReportManager()
    this.testCleanup = new PerformanceTestCleanup({
      userDataDir: userDataDir(),
      log: (message, level) => {
        if (level === 'error') console.error('[test-cleanup]', message)
        else if (level === 'warn') console.warn('[test-cleanup]', message)
        else console.log('[test-cleanup]', message)
      }
    })

    this.wireRenderEvents()
    // Benchmark 引擎的状态事件只订阅一次：matrix / comparison 两种会话共用
    void this.benchmark.onEvent((event) => {
      if (event.type !== 'state') return
      const status = event.state.status
      if (status === 'done') {
        void this.onBenchmarkDone(event.state)
        return
      }
      // failed / canceled 也要收掉采样，避免监控一直空转
      if (status === 'failed' || status === 'canceled') this.stopMonitorFor('benchmark')
    })
  }

  /** 订阅缓存事件（项目文件变化 / 缓存清除 / 设备刷新） */
  onCacheEvent(listener: (event: CacheEvent) => void): () => void {
    this.cacheListeners.add(listener)
    return () => this.cacheListeners.delete(listener)
  }

  private emitCacheEvent(event: CacheEvent): void {
    for (const listener of this.cacheListeners) {
      try {
        listener(event)
      } catch {
        /* 单个订阅者出错不影响其他订阅者 */
      }
    }
  }

  /** 让 RenderManager 在构造参数时能拿到当前 CLI 能力 */
  wireRenderManager(): void {
    this.deps.render.setCliProvider(() => this.cli.probe().catch(() => null))
    // 渲染失败后交给 RenderManager 按回退规则自动降载重试（不再需要用户手工点「分析失败原因」）
    this.deps.render.setFallbackProvider((errorText, ctx) => this.fallback.analyze(errorText, ctx))
  }

  /** 启动资源采样；同一时刻只有一个驱动方（渲染或性能测试） */
  private startMonitorFor(owner: 'render' | 'benchmark'): void {
    this.monitorOwner = owner
    if (this.monitorActive) return
    this.monitorActive = true
    void this.monitor.start()
  }

  /** 只有当前驱动方才有权停止采样，避免渲染结束误杀测试中的采样 */
  private stopMonitorFor(owner: 'render' | 'benchmark'): void {
    if (this.monitorOwner !== owner) return
    this.monitorOwner = null
    if (owner === 'benchmark') this.monitor.setProfile('full')
    if (!this.monitorActive) return
    this.monitorActive = false
    this.monitor.stop()
  }

  private wireRenderEvents(): void {
    this.deps.render.onEvent((event) => {
      if (event.type !== 'task') return
      const task = event.task
      if (task.status === this.lastStatus) {
        if (task.status === 'running') this.updateProgress(task)
        return
      }
      const previous = this.lastStatus
      this.lastStatus = task.status

      if (task.status === 'running' || task.status === 'preparing') {
        this.activeRequest = task.request
        this.startMonitorFor('render')
        this.updateProgress(task)
        return
      }

      if (previous === 'running' || previous === 'preparing') {
        this.stopMonitorFor('render')
        if (task.status === 'succeeded') void this.recordSuccessfulRender(task)
        if (task.status === 'failed') void this.handleRenderFailure(task)
      }
    })
  }

  private updateProgress(task: RenderTaskState): void {
    const progress = task.progress
    this.monitor.setProgress({
      frameDone: progress.done ?? null,
      frameTotal: progress.total ?? null,
      workerCount: typeof task.request?.workers === 'number' ? task.request.workers : null
    })
  }

  private async recordSuccessfulRender(task: RenderTaskState): Promise<void> {
    const request = task.request ?? this.activeRequest
    if (!request || !task.elapsedMs) return
    try {
      const hw = await this.hardware.scan()
      const cap = await this.capability.scan()
      const peaks = this.monitor.getPeaks()
      const encoder = cap.encoders.find(
        (e) => e.working && e.family !== 'software' && e.formats.includes(request.format)
      )
      const profile: RenderProfile = {
        id: `rp_${Date.now().toString(36)}`,
        hardwareFingerprint: hw.fingerprint,
        scope: 'project',
        projectPath: request.projectPath,
        projectName: request.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '',
        format: request.format,
        resolution: request.resolution,
        fpsLabel: request.fpsMode === 'project' ? '跟随项目' : request.fpsMode === 'custom' ? request.customFps : `${request.fpsMode}fps`,
        quality: request.quality,
        workers: request.workers,
        browserGpu: request.browserGpu,
        gpuEncode: request.gpu,
        encoderId: request.gpu ? (encoder?.id ?? null) : null,
        capturePath: request.extra?.fastCapture === 'on' ? 'fast-capture' : 'default',
        pageSideCompositing: request.extra?.pageSideCompositing ?? true,
        benchmarkMs: task.elapsedMs,
        resourcePeak: {
          cpuPct: peaks.cpuPct,
          memoryBytes: peaks.memoryBytes,
          vramBytes: peaks.vramBytes,
          gpuPct: peaks.gpuPct
        },
        testedAt: new Date().toISOString(),
        cliVersion: this.cli.cached?.version ?? null,
        notes: ['来自一次真实渲染的耗时记录']
      }
      await this.store.upsertRenderProfile(profile)
    } catch {
      /* 档案记录失败不影响渲染结果 */
    }
  }

  private async handleRenderFailure(task: RenderTaskState): Promise<void> {
    const request = task.request ?? this.activeRequest
    const errorText = [task.error, ...(task.error ? [] : [])].filter(Boolean).join(' ')
    if (!errorText) return
    const actions = this.fallback.analyze(errorText, {
      workers: request?.workers ?? 'auto',
      gpuEncode: request?.gpu ?? false,
      capturePath: request?.extra?.fastCapture === 'on' ? 'fast-capture' : 'default',
      browserGpu: request?.browserGpu ?? 'auto'
    })
    if (actions.length === 0) return
    await this.fallback.record(actions, `render:${task.id}`)
    this.recommendation = null
  }

  /* ---------------------------- 扫描 ---------------------------- */

  async ensureAll(force = false): Promise<{
    hardware: HardwareReport
    capabilities: CapabilityReport
    cli: CliCapabilities
    hardwareProfile: HardwareProfile | null
  }> {
    const [hardware, cli] = await Promise.all([this.hardware.scan(force), this.cli.probe(force)])
    const capabilities = await this.capability.scan(force)
    const reference = matchReference(hardware)
    const profile = await this.store.upsertHardwareProfile(hardware, {
      cliVersion: cli.version,
      encoders: capabilities.encoders.filter((e) => e.working).map((e) => ({ id: e.id, family: e.family, working: e.working })),
      referenceId: reference?.id
    })
    return { hardware, capabilities, cli, hardwareProfile: profile }
  }

  /**
   * 项目负载分析（走 ProjectMetadataCache）。
   *
   * 命中缓存时只做一次文件指纹校验（stat 已登记文件），不会重新执行
   * `hyperframes info` / 目录递归扫描；导出 FPS 变化只重算总帧数。
   */
  async analyzeProject(
    projectPath: string,
    options: {
      force?: boolean
      composition?: string | null
      settings?: RenderSettings | null
    } = {}
  ): Promise<WorkloadProfile | null> {
    if (!projectPath) return null
    const key = `${projectPath}::${options.composition ?? ''}`
    const cached = this.workloadCache.get(key)
    if (!options.force && cached && Date.now() - cached.at < WORKLOAD_TTL_MS) return cached.profile

    try {
      const result = await this.projectMetadata.analyze({
        projectPath,
        composition: options.composition ?? null,
        settings: options.settings ?? null,
        force: options.force
      })
      const profile: WorkloadProfile = {
        ...result.workload,
        fromCache: result.fromCache,
        analyzedAt: result.analyzedAt
      }
      this.workloadCache.set(key, { profile, at: Date.now() })
      return profile
    } catch (err) {
      console.warn('[performance] 项目分析失败：', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** 项目元数据（含来源说明），供界面展示「数据怎么来的」 */
  async projectMetadataOf(input: {
    projectPath: string
    composition?: string | null
    settings?: RenderSettings | null
    force?: boolean
  }): Promise<{ metadata: ProjectMetadata; fromCache: boolean; reason: string; verifyMs: number } | null> {
    if (!input.projectPath) return null
    try {
      const result = await this.projectMetadata.analyze({
        projectPath: input.projectPath,
        composition: input.composition ?? null,
        settings: input.settings ?? null,
        force: input.force
      })
      return {
        metadata: result.metadata,
        fromCache: result.fromCache,
        reason: result.reason,
        verifyMs: result.verifyMs
      }
    } catch {
      return null
    }
  }

  async snapshot(input: {
    projectPath?: string | null
    settings?: RenderSettings | null
    composition?: string | null
  }): Promise<PerformanceSnapshot> {
    const { hardware, capabilities, cli, hardwareProfile } = await this.ensureAll()
    const settingsForProject = input.settings ?? (await this.deps.settings.get()).lastSettings ?? null
    const composition = input.composition ?? (await this.deps.settings.get()).lastComposition ?? null
    const workload = input.projectPath
      ? await this.analyzeProject(input.projectPath, { composition, settings: settingsForProject })
      : null
    const [profiles, fallbacks, benchmarkState] = await Promise.all([
      this.store.listAll(),
      this.store.listFallbacks(),
      this.store.lastBenchmark()
    ])

    // 性能中心扩展信息：失败时降级为空值，不影响基础面板
    let modePresets: ResolvedModePreset[] = []
    let smartArchive: SmartArchiveStatus = {
      exists: false,
      valid: false,
      testedAt: null,
      reason: '尚未生成优化档案'
    }
    let reports: PerformanceReport[] = []
    let currentReport: PerformanceReport | null = null
    let testStorage: TestStorageUsage = {
      root: '',
      exists: false,
      taskCount: 0,
      ownedTaskCount: 0,
      totalBytes: 0,
      mediaBytes: 0,
      logBytes: 0,
      reportBytes: 0,
      tasks: [],
      scannedAt: new Date().toISOString()
    }
    try {
      testStorage = await this.testStorage()
    } catch {
      /* 统计失败不影响基础面板 */
    }
    const settings = input.settings ?? (await this.deps.settings.get()).lastSettings ?? null
    try {
      if (settings) {
        modePresets = await this.resolveModePresets({ settings })
      }
      smartArchive = await this.smartArchiveStatus({
        projectPath: input.projectPath,
        settings
      })
      reports = await this.reports.list()
      if (input.projectPath && settings) {
        currentReport = await this.reports.findMatching({
          hardwareFingerprint: hardware.fingerprint,
          projectPath: input.projectPath,
          format: settings.format,
          resolution: settings.resolution,
          fpsLabel: fpsLabelOf(settings),
          quality: settings.quality
        })
      }
    } catch {
      /* 扩展信息获取失败时保持空值 */
    }

    return {
      hardware,
      capabilities,
      cli,
      workload,
      hardwareProfile,
      profiles: profiles.slice(0, 20),
      recommendation: this.recommendation,
      monitor: this.monitor.getState(),
      fallbacks: fallbacks.slice(0, 12),
      benchmark: this.pickBenchmarkState(benchmarkState ?? null),
      modePresets,
      smartArchive,
      reports: reports.slice(0, 20),
      currentReport,
      cache: await this.cacheStatus(input.projectPath ?? null),
      testStorage
    }
  }

  /* --------------------------- 缓存管理 --------------------------- */

  /** 缓存概览：最后检测时间、文件位置、本次会话的检测次数 */
  async cacheStatus(projectPath?: string | null): Promise<CacheOverview> {
    const [hardware, environment, project] = await Promise.all([
      this.hardware.profileCache.status(),
      this.envCache.status(),
      this.projectMetadata.status(projectPath ?? null)
    ])
    const [hwBytes, envBytes, projectBytes] = await Promise.all([
      dirBytes(profilesDir()),
      Promise.resolve(0),
      this.projectMetadata.cache.bytes()
    ])
    void envBytes
    return {
      userDataDir: userDataDir(),
      cacheDir: profilesDir(),
      hardware,
      environment,
      project,
      counters: snapshotCounters(),
      cacheBytes: hwBytes + projectBytes
    }
  }

  /** 手动刷新设备信息：强制重新完整识别硬件 + 重新验证编码器 */
  async refreshHardware(): Promise<CacheOverview> {
    this.hardware.invalidate()
    this.capability.invalidate()
    await this.ensureAll(true)
    this.emitCacheEvent({
      type: 'hardware-refreshed',
      projectPath: null,
      reason: '手动刷新设备信息',
      at: new Date().toISOString()
    })
    return this.cacheStatus(null)
  }

  /** 重新分析当前项目（忽略缓存与指纹） */
  async reanalyzeProject(projectPath: string, composition?: string | null): Promise<WorkloadProfile | null> {
    if (!projectPath) return null
    await this.projectMetadata.invalidate(projectPath, '用户手动重新分析')
    this.workloadCache.clear()
    return this.analyzeProject(projectPath, { force: true, composition: composition ?? null })
  }

  /** 清除本地缓存（只删缓存文件，绝不触碰用户项目） */
  async clearCaches(scope: CacheClearScope, projectPath?: string | null): Promise<CacheClearResult> {
    void projectPath
    const cleared: string[] = []
    try {
      if (scope === 'hardware' || scope === 'all') {
        cleared.push(...(await this.hardware.profileCache.clear()))
        this.hardware.invalidate()
        this.capability.invalidate()
      }
      if (scope === 'environment' || scope === 'all') {
        cleared.push(...(await this.envCache.clear()))
        this.cli.invalidate()
        this.capability.invalidate()
      }
      if (scope === 'project' || scope === 'all') {
        cleared.push(...(await this.projectMetadata.cache.clear()))
        this.workloadCache.clear()
      }
      resetCacheCounters()
      this.emitCacheEvent({
        type: 'cache-cleared',
        projectPath: projectPath ?? null,
        reason: `已清除：${scope}`,
        at: new Date().toISOString()
      })
      return { ok: true, cleared }
    } catch (err) {
      return { ok: false, cleared, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 启动预热：只做一件很轻的事——探测一次 CLI 版本并写入环境缓存。
   * 不跑 doctor、不扫项目、不读编码器，避免拖慢启动。
   * 版本变化时，CLI 能力缓存会一起失效，下次使用自动重新探测参数。
   */
  async warmup(): Promise<{ cliVersion: string | null; changed: boolean; ms: number }> {
    const started = Date.now()
    try {
      const result = await this.projectMetadata.warmup()
      // 顺带把 Node / npm 路径与版本记下来（几十毫秒），供「缓存与检测」面板展示
      void this.ensureNodeProfile()
      return { ...result, ms: Date.now() - started }
    } catch {
      return { cliVersion: null, changed: false, ms: Date.now() - started }
    }
  }

  /** Node / npm / npx 版本与路径：只探测一次，之后长期复用 */
  private nodeInFlight: Promise<void> | null = null
  private async ensureNodeProfile(): Promise<void> {
    if (this.nodeInFlight) return this.nodeInFlight
    this.nodeInFlight = (async () => {
      const existing = await this.envCache.getNode()
      if (existing?.nodeVersion) return
      await this.envCache.saveNode(await probeNodeEnvironment())
    })()
      .catch(() => undefined)
      .finally(() => {
        this.nodeInFlight = null
      })
    return this.nodeInFlight
  }

  /* --------------------------- 优化决策 --------------------------- */

  /**
   * 选择要展示给界面的测试状态。
   *
   * 规则：正在跑就用内存里的实时状态；跑完但内存状态比持久化记录更新（例如本次
   * 对比测试有失败，不会被 saveBenchmark 保存），仍然返回内存状态，
   * 否则界面上刚跑完的失败明细会被上一次的矩阵测试结果顶掉。
   */
  private pickBenchmarkState(stored: BenchmarkSessionState | null): BenchmarkSessionState {
    const live = this.benchmark.getState()
    if (this.benchmark.isRunning()) return live
    if (!live.id) return stored ?? live
    if (!stored?.startedAt) return live
    const liveAt = live.startedAt ? Date.parse(live.startedAt) : 0
    const storedAt = Date.parse(stored.startedAt)
    return liveAt >= storedAt ? live : stored
  }

  async optimizeNow(input: {
    mode: PerformanceMode
    projectPath?: string | null
    settings?: RenderSettings | null
    allowExperimental?: boolean
  }): Promise<OptimizationRecommendation> {
    const appSettings = await this.deps.settings.get()
    const settings = input.settings ?? appSettings.lastSettings ?? (await this.deps.settings.get()).lastSettings!
    const { hardware, capabilities, cli } = await this.ensureAll()

    /* -------------- 智能模式：优先复用有效优化档案，不重复测试 -------------- */
    if (input.mode === 'smart' && input.projectPath) {
      const archive = await this.findSmartArchiveRaw(hardware, input.projectPath, settings)
      if (archive && this.archiveValid(archive, cli)) {
        this.recommendation = archive.recommendation
        return archive.recommendation
      }
    }

    const workload = input.projectPath
      ? await this.analyzeProject(input.projectPath, {
          settings,
          composition: appSettings.lastComposition ?? null
        })
      : null
    const reference = matchReference(hardware)
    const history = input.projectPath
      ? await this.store.findRenderProfiles({
          hardwareFingerprint: hardware.fingerprint,
          projectPath: input.projectPath,
          format: settings.format
        })
      : []
    const benchmarkState = await this.store.lastBenchmark()

    const recommendation = optimize({
      mode: input.mode,
      hardware,
      capability: capabilities,
      cli,
      workload,
      settings,
      history,
      benchmark: benchmarkState,
      reference,
      allowExperimental:
        input.allowExperimental ?? (input.mode === 'extreme' && appSettings.allowExperimental),
      platformSupport: this.hardware.activeAdapter.captureSupport()
    })

    this.recommendation = recommendation
    // 落盘失败（例如 profiles.json.tmp 被占用）不能阻断测试：内存里的推荐配置已经可用
    try {
      await this.store.saveRecommendation(recommendation)
    } catch (err) {
      console.warn(
        '[performance] 推荐配置保存失败（不影响本次测试）：',
        err instanceof Error ? err.message : String(err)
      )
    }
    return recommendation
  }

  /* --------------------------- Benchmark --------------------------- */

  async planBenchmark(input: {
    mode: PerformanceMode
    projectPath: string
    settings: RenderSettings
    allowExperimental?: boolean
    runsPerCandidate?: number
  }): Promise<BenchmarkPlan> {
    const { hardware, capabilities, cli } = await this.ensureAll()
    const workload = await this.analyzeProject(input.projectPath, { settings: input.settings })
    const reference = matchReference(hardware)
    const runs = Math.max(1, input.runsPerCandidate ?? 1)

    const workers = generateWorkerCandidates({
      mode: input.mode === 'smart' ? 'extreme' : input.mode,
      cli,
      hardware,
      cpu: capabilities.cpu,
      workload,
      historyWorkers: null,
      reference
    })

    const hardwareEncoder = capabilities.encoders.find(
      (e) => e.working && e.family !== 'software' && e.formats.includes(input.settings.format)
    )

    const candidates: BenchmarkCandidate[] = []
    for (const worker of workers) {
      candidates.push({
        id: `w${worker}-gpu${hardwareEncoder ? 1 : 0}`,
        label: `${worker === 'auto' ? 'auto' : `${worker} worker`}${hardwareEncoder ? ' · GPU 编码' : ' · CPU 编码'}`,
        workers: worker,
        gpuEncode: !!hardwareEncoder,
        encoderId: hardwareEncoder?.id ?? null,
        browserGpu: 'auto',
        capturePath: 'default',
        pageSideCompositing: true
      })
    }

    const notes: string[] = []
    // 有硬件编码器时，补一个 CPU 编码对照组，验证 GPU 编码是否真的更快
    if (hardwareEncoder) {
      const bestWorker = workers[workers.length - 1] ?? 2
      candidates.push({
        id: `w${bestWorker}-cpu`,
        label: `${bestWorker === 'auto' ? 'auto' : `${bestWorker} worker`} · CPU 编码（对照）`,
        workers: bestWorker,
        gpuEncode: false,
        encoderId: null,
        browserGpu: 'auto',
        capturePath: 'default',
        pageSideCompositing: true
      })
      notes.push('包含 1 组 CPU 编码对照，用于验证 GPU 编码的真实收益')
      notes.push(
        '注意：硬件编码器与 libx264 在相同 CRF 下的码率与画质并不完全等价，该对照只用于判断速度收益，不作为画质等价比对'
      )
    }

    // 极限模式 + 允许实验时，追加并行流捕获候选
    if (input.mode === 'extreme' && input.allowExperimental && hardware.platform === 'win32' && workers.length > 0) {
      const worker = workers[workers.length - 1]
      candidates.push({
        id: `w${worker}-parallel`,
        label: `${worker === 'auto' ? 'auto' : `${worker} worker`} · 并行流捕获（实验）`,
        workers: worker,
        gpuEncode: !!hardwareEncoder,
        encoderId: hardwareEncoder?.id ?? null,
        browserGpu: 'auto',
        capturePath: 'parallel-stream',
        pageSideCompositing: true,
        env: { HF_CAPTURE_PARALLEL_STREAM: 'true' }
      })
      notes.push('实验性并行流捕获：若不稳定或更慢，会在结果中体现，不会被推荐')
    }

    const totalRuns = candidates.length * runs
    if (runs === 1 && candidates.length > 1) {
      notes.push('每组只跑 1 次时，机器负载波动可能盖过配置差异；要下结论请用 2~3 次取中位数')
    }
    return {
      candidates,
      workerCandidates: workers,
      totalRuns,
      estimatedMinutes: Math.max(1, Math.round((totalRuns * Math.max(20, (workload?.durationSec ?? 10) * 2.2)) / 60)),
      notes
    }
  }

  async startBenchmark(input: {
    mode: PerformanceMode
    projectPath: string
    settings: RenderSettings
    runsPerCandidate?: number
    includeOfficial?: boolean
    officialRuns?: number
    allowExperimental?: boolean
    confirmBest?: boolean
  }): Promise<{ ok: boolean; error?: string; plan?: BenchmarkPlan }> {
    if (this.benchmark.isRunning()) return { ok: false, error: '已有性能测试在运行' }
    if (this.deps.render.isBusy()) return { ok: false, error: '渲染进行中，无法同时进行性能测试' }

    const plan = await this.planBenchmark(input)
    // 先开采样，测试引擎才能拿到峰值资源数据；light 档避免测量本身拖慢被测渲染
    this.monitor.setProfile('light')
    this.startMonitorFor('benchmark')
    const result = await this.benchmark.start({
      projectPath: input.projectPath,
      settings: input.settings,
      candidates: plan.candidates,
      runsPerCandidate: Math.max(1, input.runsPerCandidate ?? 1),
      includeOfficial: !!input.includeOfficial,
      officialRuns: Math.max(1, input.officialRuns ?? 1),
      confirmBest: input.confirmBest ?? input.mode === 'extreme'
    })

    if (!result.ok) {
      this.stopMonitorFor('benchmark')
      return { ...result, plan }
    }
    return { ...result, plan }
  }

  private async onBenchmarkDone(state: BenchmarkSessionState): Promise<void> {
    this.stopMonitorFor('benchmark')
    const ok = state.results.filter((r) => r.status === 'ok')
    if (ok.length === 0) return
    const best = [...ok].sort((a, b) => a.durationMs - b.durationMs)[0]
    const candidate = state.candidates.find((c) => c.id === best.candidateId)
    if (!candidate) return

    // 把实测结果写入渲染档案，供智能模式直接复用
    const hw = await this.hardware.scan()
    await this.store.upsertRenderProfile({
      id: `rp_bench_${Date.now().toString(36)}`,
      hardwareFingerprint: hw.fingerprint,
      scope: 'project',
      projectPath: state.projectPath,
      projectName: state.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '',
      format: state.format,
      resolution: state.resolution,
      fpsLabel: state.fpsLabel,
      quality: state.quality,
      workers: candidate.workers,
      browserGpu: candidate.browserGpu,
      gpuEncode: candidate.gpuEncode,
      encoderId: candidate.encoderId,
      capturePath: candidate.capturePath,
      pageSideCompositing: candidate.pageSideCompositing,
      benchmarkMs: best.durationMs,
      resourcePeak: {
        cpuPct: best.peak.cpuPct,
        memoryBytes: best.peak.memoryBytes,
        vramBytes: best.peak.vramBytes,
        gpuPct: best.peak.gpuPct
      },
      testedAt: new Date().toISOString(),
      cliVersion: this.cli.cached?.version ?? null,
      notes: [`Benchmark 最优：${candidate.label}`]
    })

    await this.store.saveBenchmark(state)

    // 四模式对比测试：生成并保存性能报告 + 刷新智能模式优化档案
    if (state.kind === 'comparison') {
      await this.saveComparisonReport(state, hw)
      await this.refreshSmartArchiveFromComparison(state)
    }

    // 依据实测结果重新生成推荐
    const mode = (await this.deps.settings.get()).performanceMode
    try {
      await this.optimizeNow({ mode, projectPath: state.projectPath })
    } catch {
      /* 推荐失败不影响测试结果 */
    }
  }

  /** 对比测试结束后生成性能报告（数据全部来自本次真实执行） */
  private async saveComparisonReport(state: BenchmarkSessionState, hw: HardwareReport): Promise<void> {
    try {
      const report = buildPerformanceReport({
        state,
        candidates: state.candidates,
        hardware: hw,
        cliVersion: this.cli.cached?.version ?? null,
        kind: state.comparisonKind ?? 'quick'
      })
      await this.reports.save(report)
    } catch {
      /* 报告生成失败不影响测试数据本身 */
    }
  }

  /**
   * 智能模式优化档案：用对比测试中智能候选的实测结果刷新档案。
   * 只有智能候选真实跑完才更新 testedAt，失败时保留旧档案。
   */
  private async refreshSmartArchiveFromComparison(state: BenchmarkSessionState): Promise<void> {
    const smartCandidate = state.candidates.find((c) => c.mode === 'smart')
    if (!smartCandidate) return
    const smartResult = state.results.find((r) => r.candidateId === smartCandidate.id)
    if (!smartResult || smartResult.status !== 'ok') return
    const rec =
      this.recommendation?.mode === 'smart'
        ? this.recommendation
        : ((await this.store.lastRecommendation())?.mode === 'smart'
            ? await this.store.lastRecommendation()
            : null)
    if (!rec) return
    await this.writeSmartArchive(rec, state, 1)
  }

  private async writeSmartArchive(
    rec: OptimizationRecommendation,
    state: Pick<BenchmarkSessionState, 'projectPath' | 'format' | 'resolution' | 'fpsLabel' | 'quality'>,
    runCount: number
  ): Promise<void> {
    const archive: OptimizationArchive = {
      id: `arch_${Date.now().toString(36)}`,
      hardwareFingerprint: (await this.hardware.scan()).fingerprint,
      projectPath: state.projectPath,
      format: state.format,
      resolution: state.resolution,
      fpsLabel: state.fpsLabel,
      quality: state.quality,
      cliVersion: this.cli.cached?.version ?? null,
      recommendation: rec,
      runCount,
      testedAt: new Date().toISOString()
    }
    await this.store.upsertSmartArchive(archive)
  }

  /** 查找智能档案（按设备指纹 + 项目 + 输出参数定位；CLI 版本有效性由调用方判定） */
  private async findSmartArchiveRaw(
    hardware: HardwareReport,
    projectPath: string,
    settings: RenderSettings
  ): Promise<OptimizationArchive | null> {
    return this.store.findSmartArchive({
      hardwareFingerprint: hardware.fingerprint,
      projectPath,
      format: settings.format,
      resolution: settings.resolution,
      fpsLabel: fpsLabelOf(settings),
      quality: settings.quality
    })
  }

  /** 智能档案是否仍然有效（硬件指纹已由 store 匹配，这里核对 CLI 版本） */
  private archiveValid(
    archive: OptimizationArchive | null,
    cli: CliCapabilities
  ): boolean {
    if (!archive) return false
    if (!archive.cliVersion || !cli.version) return true // 任一方未知时不轻易判失效
    return archive.cliVersion === cli.version
  }

  /** 智能模式优化档案状态（供性能中心展示） */
  async smartArchiveStatus(input: {
    projectPath?: string | null
    settings?: RenderSettings | null
  }): Promise<SmartArchiveStatus> {
    const empty: SmartArchiveStatus = { exists: false, valid: false, testedAt: null, reason: '尚无优化档案，首次使用智能模式时执行一次自动优化即可生成' }
    if (!input.projectPath) return { ...empty, reason: '尚未选择项目，无法定位优化档案' }
    const settings = input.settings ?? (await this.deps.settings.get()).lastSettings
    if (!settings) return { ...empty, reason: '尚无渲染参数记录，先在「渲染」页确认导出参数' }
    const { hardware, cli } = await this.ensureAll()
    const archive = await this.findSmartArchiveRaw(hardware, input.projectPath, settings)
    if (!archive) return empty
    const valid = this.archiveValid(archive, cli)
    return {
      exists: true,
      valid,
      testedAt: archive.testedAt,
      reason: valid
        ? `档案有效（${new Date(archive.testedAt).toLocaleString('zh-CN')} 实测，共 ${archive.runCount} 次有效测试）`
        : `CLI 版本已从 ${archive.cliVersion ?? '未知'} 变为 ${cli.version ?? '未知'}，档案失效，建议重新优化`
    }
  }

  stopBenchmark(): { ok: boolean } {
    const result = this.benchmark.stop()
    this.stopMonitorFor('benchmark')
    return result
  }

  /* --------------------- 四模式性能对比测试 --------------------- */

  private static readonly COMPARISON_LABEL: Record<PerformanceMode, string> = {
    smart: '智能',
    balanced: '平衡',
    performance: '性能',
    extreme: '极限'
  }

  /** 解析四种模式的参数展示（固定三模式走静态预设；智能模式来自当前推荐） */
  async resolveModePresets(input: {
    settings: RenderSettings
    allowExperimental?: boolean
  }): Promise<ResolvedModePreset[]> {
    const { hardware, capabilities, cli } = await this.ensureAll()
    const allowExperimental =
      input.allowExperimental ?? (await this.deps.settings.get()).allowExperimental
    const platformSupport = this.hardware.activeAdapter.captureSupport()

    const fixed = (['balanced', 'performance', 'extreme'] as const).map((mode) =>
      resolveModePreset({
        mode,
        hardware,
        capability: capabilities,
        cli,
        format: input.settings.format,
        settings: input.settings,
        allowExperimental,
        platformSupport
      })
    )

    const rec =
      this.recommendation?.mode === 'smart'
        ? this.recommendation
        : (await this.store.lastRecommendation())?.mode === 'smart'
          ? await this.store.lastRecommendation()
          : null
    const tier = detectHardwareTier(hardware)
    const smart: ResolvedModePreset = rec
      ? {
          mode: 'smart',
          tier,
          workers: rec.chosen.workers,
          gpuEncode: rec.chosen.gpuEncode,
          encoderId: rec.chosen.encoderId,
          encoderLabel: rec.chosen.encoderLabel,
          browserGpu: rec.chosen.browserGpu,
          capturePath: rec.chosen.capturePath,
          lowMemoryMode: rec.chosen.extra.lowMemoryMode === 'on' ? 'on' : 'auto',
          allowExperimental: false,
          fallbacks: [],
          notes: [
            rec.basedOn === 'benchmark'
              ? '来自本机实测 Benchmark 的最优配置'
              : rec.basedOn === 'history'
                ? '复用同项目历史最优配置'
                : '基于硬件识别与项目分析的推荐，尚未实测验证'
          ]
        }
      : {
          mode: 'smart',
          tier,
          workers: 'auto',
          gpuEncode: false,
          encoderId: null,
          encoderLabel: null,
          browserGpu: 'auto',
          capturePath: 'default',
          lowMemoryMode: 'auto',
          allowExperimental: false,
          fallbacks: [],
          notes: ['尚未生成智能推荐；点击「开始自动优化」生成配置']
        }

    return [smart, ...fixed]
  }

  /** 生成四模式对比测试计划（只展示，不启动） */
  async planComparison(input: {
    projectPath: string
    settings: RenderSettings
    kind: 'quick' | 'precise'
  }): Promise<ModeComparisonPlan> {
    const runsPerMode = input.kind === 'precise' ? 3 : 1
    const warmupRuns = input.kind === 'precise' ? 1 : 0
    const modes: PerformanceMode[] = ['balanced', 'performance', 'extreme', 'smart']
    const notes: string[] = [
      '四种模式使用相同项目、相同分辨率 / FPS / 格式 / 质量与素材，只允许模式本身的性能参数不同',
      '每种模式写入 performance-tests/<测试ID>/<模式>/ 独立目录，互不覆盖；日志在 logs/performance-comparison/<测试ID>/',
      '执行顺序：基础渲染冒烟预检 → 平衡 → 性能 → 极限 → 智能；冒烟预检失败会立即停止并给出原始 CLI 错误',
      '四种模式统一放宽页面就绪等待（180s）；该值只影响失败容忍度，不影响渲染速度，因此对比仍然公平'
    ]
    if (input.kind === 'precise') {
      notes.push('精确对比：先预热 1 次（不计成绩），每种模式重复 3 次，取中位数作为稳定参考')
    } else {
      notes.push('快速对比：每种模式只跑 1 次，成绩受机器瞬时负载影响，下结论建议用精确对比')
    }
    // 智能模式是否有可直接复用的推荐配置（没有也能测：startComparison 会先跑一次真实的优化流程）
    const smartRec = this.recommendation ?? (await this.store.lastRecommendation())
    if (!smartRec) {
      notes.push(
        '智能模式还没有可复用的推荐配置：开始测试时会先执行一次真实的智能优化流程（扫描项目 + 识别硬件）再按该配置测试，不会传空参数'
      )
    }
    /* 高级参数的地雷要提前讲清楚：过小的导航超时会让每一次渲染必然失败 */
    const navTimeout = input.settings.extra?.browserTimeoutSec
    if (navTimeout != null && navTimeout > 0 && navTimeout < 10) {
      notes.push(
        `⚠ 当前高级参数「浏览器导航超时」只有 ${navTimeout}s，Chrome 打开页面本身往往就要 1s 以上，` +
          '四种模式都会在「视频渲染 / Chrome 异常」阶段失败。若不想让它影响对比测试，请到「渲染 → 高级参数」把它清空。'
      )
    }

    const workload = await this.analyzeProject(input.projectPath, { settings: input.settings })
    const perRun = Math.max(12, (workload?.durationSec ?? 15) * 2.2)
    // 冒烟预检 1 次 + 预热 + 四模式正式测试
    const smokeRuns = 1
    const totalRuns = modes.length * runsPerMode + warmupRuns + smokeRuns
    return {
      modes,
      runsPerMode,
      warmupRuns,
      totalRuns,
      estimatedMinutes: Math.max(1, Math.round((perRun * totalRuns) / 60)),
      notes,
      missingSmartConfig: !smartRec
    }
  }

  /**
   * 启动四模式对比测试：复用 BenchmarkEngine 逐个真实渲染并计时。
   * 不修改固定预设本身，也不动态改参数——只测试已定义好的配置。
   */
  async startComparison(input: {
    projectPath: string
    settings: RenderSettings
    kind: 'quick' | 'precise'
    allowExperimental?: boolean
  }): Promise<{ ok: boolean; error?: string; plan?: ModeComparisonPlan }> {
    if (this.benchmark.isRunning()) return { ok: false, error: '已有性能测试在运行' }
    if (this.deps.render.isBusy()) return { ok: false, error: '渲染进行中，无法同时进行性能测试' }
    if (!input.projectPath) return { ok: false, error: '请先选择项目' }
    if (!input.settings) return { ok: false, error: '请先在「渲染」页确认导出参数' }

    const { hardware, capabilities, cli } = await this.ensureAll()
    const appSettings = await this.deps.settings.get()
    const allowExperimental = input.allowExperimental ?? appSettings.allowExperimental
    const platformSupport = this.hardware.activeAdapter.captureSupport()

    /* ---------------- 环境 / 项目前置检查（失败在阶段上就能定位） ---------------- */
    if (!cli.render.ok) {
      return {
        ok: false,
        error: `环境检查失败 · 命令不存在：CLI「${cli.command}」不可用（${
          cli.render.error ?? 'render --help 探测失败'
        }）。请先在「环境」里修复 CLI 配置后重试`
      }
    }
    if (!existsSync(input.projectPath)) {
      return { ok: false, error: `项目检查失败 · 项目无效：目录不存在 ${input.projectPath}` }
    }
    if (!existsSync(join(input.projectPath, 'index.html'))) {
      return {
        ok: false,
        error: `项目检查失败 · 项目无效：${input.projectPath} 下没有 index.html，HyperFrames 无法渲染`
      }
    }

    const candidates: BenchmarkCandidate[] = []
    for (const mode of ['balanced', 'performance', 'extreme'] as const) {
      const resolved = resolveModePreset({
        mode,
        hardware,
        capability: capabilities,
        cli,
        format: input.settings.format,
        settings: input.settings,
        allowExperimental,
        platformSupport
      })
      candidates.push({
        id: `cmp-${mode}`,
        label: `${PerformanceService.COMPARISON_LABEL[mode]}模式 · ${resolved.workers} worker · ${resolved.gpuEncode ? 'GPU 编码' : 'CPU 编码'}`,
        mode,
        workers: resolved.workers,
        gpuEncode: resolved.gpuEncode,
        encoderId: resolved.encoderId,
        browserGpu: resolved.browserGpu,
        capturePath: resolved.capturePath,
        pageSideCompositing: true,
        // 实验性开关只属于极限模式预设意图，且需平台与 CLI 均支持
        env:
          mode === 'extreme' && resolved.allowExperimental && platformSupport.parallelStream
            ? { HF_CAPTURE_PARALLEL_STREAM: 'true' }
            : undefined
      })
    }

    // 智能模式：使用已保存的最优配置（无档案时按启发式生成，不在此处跑 Benchmark）
    let rec: OptimizationRecommendation
    try {
      rec = await this.optimizeNow({
        mode: 'smart',
        projectPath: input.projectPath,
        settings: input.settings
      })
    } catch (err) {
      return {
        ok: false,
        error: `智能模式配置生成失败（环境检查 / 项目检查）：${err instanceof Error ? err.message : String(err)}`
      }
    }
    candidates.push({
      id: 'cmp-smart',
      label: `智能模式 · ${rec.chosen.workers === 'auto' ? 'auto' : `${rec.chosen.workers} worker`} · ${rec.chosen.gpuEncode ? 'GPU 编码' : 'CPU 编码'}`,
      mode: 'smart',
      workers: rec.chosen.workers,
      gpuEncode: rec.chosen.gpuEncode,
      encoderId: rec.chosen.encoderId,
      browserGpu: rec.chosen.browserGpu,
      capturePath: rec.chosen.capturePath,
      pageSideCompositing: true
    })

    const runsPerMode = input.kind === 'precise' ? 3 : 1
    const warmupRuns = input.kind === 'precise' ? 1 : 0
    const plan = await this.planComparison({
      projectPath: input.projectPath,
      settings: input.settings,
      kind: input.kind
    })

    this.monitor.setProfile('light')
    this.startMonitorFor('benchmark')
    const workload = await this.analyzeProject(input.projectPath, { settings: input.settings })
    const result = await this.benchmark.start({
      projectPath: input.projectPath,
      settings: input.settings,
      candidates,
      runsPerCandidate: runsPerMode,
      includeOfficial: false,
      officialRuns: 1,
      confirmBest: false,
      kind: 'comparison',
      comparisonKind: input.kind,
      warmupRuns,
      // 产出文件验证需要项目原始时长 / 尺寸 / 帧率，全部来自真实扫描结果
      projectMeta: workload
        ? {
            width: workload.width,
            height: workload.height,
            durationSec: workload.durationSec,
            // 产出文件的帧率是「本次导出的帧率」，不是项目 data-fps
            fps: workload.exportFps ?? workload.fps
          }
        : null
    })
    if (!result.ok) {
      this.stopMonitorFor('benchmark')
      return { ...result, plan }
    }
    return { ok: true, plan }
  }

  /**
   * 硬件档案预热：命中缓存时只是 stat / 签名比对（毫秒级）；
   * 没有缓存才在后台跑一次完整识别。
   *
   * 注意：这里**不**预热编码器试编码——那要起多个 ffmpeg 进程，
   * 放在启动后台会明显占用 CPU，改为用户真正打开性能页时再按需验证。
   */
  async warmupHardware(): Promise<{ fromCache: boolean; ms: number }> {
    const started = Date.now()
    try {
      const report = await this.hardware.scan()
      return { fromCache: report.fromCache === true, ms: Date.now() - started }
    } catch {
      return { fromCache: false, ms: Date.now() - started }
    }
  }

  /* --------------------- 性能测试临时文件清理 --------------------- */

  /** 当前设置对应的清理策略（设置项 → 引擎策略） */
  private async cleanupPolicy(): Promise<TestCleanupPolicy> {
    const settings = await this.deps.settings.get()
    return {
      autoClean: settings.autoCleanPerfTests !== false,
      keepFailed: settings.keepFailedPerfTests === true,
      keepReports: settings.keepPerfReports !== false
    }
  }

  /** 本地测试文件占用空间（只读统计，绝不删除） */
  async testStorage(): Promise<TestStorageUsage> {
    const active = this.benchmark.isRunning() ? this.benchmark.getState().id : null
    return this.testCleanup.usage(active)
  }

  /**
   * 立即清理历史临时文件。
   * 只处理 performance-tests 下带本应用 manifest 的任务目录；
   * 运行中的任务、未登记目录、用户项目与正式输出目录都不会被触碰。
   */
  async cleanupTestFiles(): Promise<TestCleanupBatchResult> {
    const policy = await this.cleanupPolicy()
    const settings = await this.deps.settings.get()
    const forbidden = [settings.lastOutputDir, ...settings.recentOutputDirs].filter((p) => !!p && p.trim() !== '')
    const active = this.benchmark.isRunning() ? this.benchmark.getState().id : null
    const result = await this.testCleanup.cleanupHistory({
      policy,
      activeTaskId: active,
      forbiddenRoots: forbidden
    })
    this.emitCacheEvent({
      type: 'cache-cleared',
      projectPath: null,
      reason: `清理性能测试临时文件：释放 ${result.freedBytes} 字节`,
      at: new Date().toISOString()
    })
    return result
  }

  /**
   * 启动扫描：安全清理上次异常退出（或清理失败）留下的过期任务目录。
   * 不扫描用户其他目录，只处理 performance-tests 下带本应用清单的目录。
   */
  async startupCleanup(): Promise<TestCleanupBatchResult | null> {
    try {
      const policy = await this.cleanupPolicy()
      if (!policy.autoClean) return null
      const settings = await this.deps.settings.get()
      const forbidden = [settings.lastOutputDir, ...settings.recentOutputDirs].filter((p) => !!p && p.trim() !== '')
      const active = this.benchmark.isRunning() ? this.benchmark.getState().id : null
      return await this.testCleanup.startupScan({ policy, activeTaskId: active, forbiddenRoots: forbidden })
    } catch (err) {
      console.warn('[test-cleanup] 启动扫描失败：', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async listReports(): Promise<PerformanceReport[]> {
    return this.reports.list()
  }

  async resetProfiles(): Promise<void> {
    await this.store.reset()
    await this.reports.clear()
    this.recommendation = null
    this.workloadCache.clear()
  }

  async listFallbacks(): Promise<FallbackEvent[]> {
    return this.store.listFallbacks()
  }

  async currentRecommendation(): Promise<OptimizationRecommendation | null> {
    if (this.recommendation) return this.recommendation
    return this.store.lastRecommendation()
  }

  get settings(): SettingsManager {
    return this.deps.settings
  }

  async appSettings(): Promise<AppSettings> {
    return this.deps.settings.get()
  }
}
