import { useCallback, useEffect, useRef, useState } from 'react'
import { TitleBar } from '../../components/TitleBar'
import { Badge, Icon, Spinner } from '../../components/ui'
import { CachePanel } from '../../components/performance/CachePanel'
import { CleanupPanel } from '../../components/performance/CleanupPanel'
import { DevicePanel, MonitorStrip, WorkloadPanel } from '../../components/performance/DevicePanel'
import { ProfilePanel } from '../../components/performance/ProfilePanel'
import { RecommendationPanel } from '../../components/performance/RecommendationPanel'
import {
  ComparisonDiagnostics,
  ComparisonRunner,
  FastestRenderTime,
  PerformanceModeSelector,
  ReportHistory,
  ResourceComparison,
  SpeedComparison
} from '../../components/performance/ModeComparison'
import { api } from '../../services/api'
import { formatBytes, MODE_LABEL, shortPath } from '../../services/perf-format'
import type { PageId, ResolvedTheme } from '../types'
import type {
  BenchmarkSessionState,
  ModeComparisonPlan,
  MonitorState,
  OptimizationRecommendation,
  PerformanceMode,
  PerformanceSnapshot
} from '@shared/types/performance'
import type { CacheClearScope, CacheOverview } from '@shared/types/cache'
import type { TestStorageUsage } from '@shared/types/cleanup'
import type { RenderSettings } from '@shared/types/render'

interface PerformanceProps {
  theme: ResolvedTheme
  onToggleTheme: () => void
  page: PageId
  onNavigate: (page: PageId) => void
}

export function Performance(props: PerformanceProps): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [mode, setMode] = useState<PerformanceMode>('smart')
  const [settings, setSettings] = useState<RenderSettings | null>(null)
  const [projectPath, setProjectPath] = useState('')
  const [recommendation, setRecommendation] = useState<OptimizationRecommendation | null>(null)
  const [benchmark, setBenchmark] = useState<BenchmarkSessionState | null>(null)
  const [monitor, setMonitor] = useState<MonitorState | null>(null)
  const [allowExperimental, setAllowExperimental] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [benchmarkBusy, setBenchmarkBusy] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string; tone: 'ok' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /* ------- 性能中心：四模式对比测试 ------- */
  const [comparisonKind, setComparisonKind] = useState<'quick' | 'precise'>('quick')
  const [comparisonPlan, setComparisonPlan] = useState<ModeComparisonPlan | null>(null)
  /* ------- 缓存与检测 ------- */
  const [cache, setCache] = useState<CacheOverview | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [composition, setComposition] = useState('')
  const [analyzeMs, setAnalyzeMs] = useState<number | null>(null)
  /* ------- 性能测试临时文件清理 ------- */
  const [testStorage, setTestStorage] = useState<TestStorageUsage | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [storageRefreshing, setStorageRefreshing] = useState(false)
  const [cleanupSettings, setCleanupSettings] = useState({
    autoClean: true,
    keepFailed: false,
    keepReports: true
  })

  const showToast = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({ id: Date.now(), text, tone })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  const refreshSnapshot = useCallback(
    async (path?: string, current?: RenderSettings | null, comp?: string) => {
      setLoading(true)
      const started = performance.now()
      try {
        const snap = await api().performance.snapshot({
          projectPath: path ?? projectPath,
          settings: current ?? settings,
          // 项目元数据必须按「当前渲染入口」解析，不能把子 composition 当成整个项目
          composition: comp ?? composition
        })
        setSnapshot(snap)
        setBenchmark(snap.benchmark)
        setMonitor(snap.monitor)
        setCache(snap.cache)
        setTestStorage(snap.testStorage)
        setAnalyzeMs(Math.round(performance.now() - started))
        if (snap.recommendation) setRecommendation(snap.recommendation)
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setLoading(false)
      }
    },
    [projectPath, settings, composition, showToast]
  )

  useEffect(() => {
    let cancelled = false
    const boot = async (): Promise<void> => {
      const appSettings = await api().settings.get()
      if (cancelled) return
      setMode(appSettings.performanceMode ?? 'smart')
      setAllowExperimental(appSettings.allowExperimental ?? false)
      setCleanupSettings({
        autoClean: appSettings.autoCleanPerfTests !== false,
        keepFailed: appSettings.keepFailedPerfTests === true,
        keepReports: appSettings.keepPerfReports !== false
      })
      setSettings(appSettings.lastSettings)
      setComposition(appSettings.lastComposition ?? '')
      const path = appSettings.recentProjects[0]?.path ?? ''
      setProjectPath(path)
      await refreshSnapshot(path, appSettings.lastSettings, appSettings.lastComposition ?? '')
    }
    void boot()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const offBench = api().performance.onBenchmarkEvent((event) => {
      if (event.type === 'state') {
        setBenchmark(event.state)
        // 对比测试结束后刷新快照，取回新生成的性能报告与档案状态
        if (event.state.status === 'done') void refreshSnapshot()
      }
    })
    const offMonitor = api().performance.onMonitor((state) => setMonitor(state))
    return () => {
      offBench()
      offMonitor()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------- 项目文件变化：后台刷新（不打断当前操作） ------- */
  const refreshRef = useRef(refreshSnapshot)
  useEffect(() => {
    refreshRef.current = refreshSnapshot
  }, [refreshSnapshot])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api().performance.onCacheEvent((event) => {
      if (event.type !== 'project-changed') return
      if (timer) clearTimeout(timer)
      // 防抖：连续保存只刷新一次；刷新走缓存，命中时只是指纹校验
      timer = setTimeout(() => void refreshRef.current(), 800)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  const changeMode = (next: PerformanceMode): void => {
    setMode(next)
    void api().settings.update({ performanceMode: next })
  }

  const handleRescan = async (): Promise<void> => {
    setLoading(true)
    try {
      const snap = await api().performance.rescan()
      setSnapshot(snap)
      setBenchmark(snap.benchmark)
      setMonitor(snap.monitor)
      showToast('已重新检测硬件与编码器能力')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  const selectProject = async (): Promise<void> => {
    try {
      const result = await api().project.select()
      if (!result.info) return
      setProjectPath(result.info.path)
      await refreshSnapshot(result.info.path)
      showToast(`已分析项目 ${result.info.name}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleOptimize = async (): Promise<void> => {
    if (!settings) return
    setOptimizing(true)
    try {
      const rec = await api().performance.optimize({
        mode,
        projectPath,
        settings,
        allowExperimental: mode === 'extreme' ? allowExperimental : false
      })
      setRecommendation(rec)
      showToast(`已生成${MODE_LABEL[mode]}模式推荐配置`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setOptimizing(false)
    }
  }

  const handleStopBenchmark = async (): Promise<void> => {
    await api().performance.stopBenchmark()
    showToast('已停止测试')
  }

  /* ---------------- 缓存与检测 ---------------- */

  const handleRefreshHardware = async (): Promise<void> => {
    setCacheBusy(true)
    try {
      const overview = await api().performance.refreshHardware()
      setCache(overview)
      await refreshSnapshot()
      showToast('已重新识别设备信息并重新验证编码器')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setCacheBusy(false)
    }
  }

  const handleReanalyzeProject = async (): Promise<void> => {
    if (!projectPath) {
      showToast('请先选择项目', 'error')
      return
    }
    setReanalyzing(true)
    try {
      const result = await api().performance.reanalyzeProject({
        projectPath,
        composition: composition || null
      })
      if (!result.ok) {
        showToast(result.error ?? '重新分析失败', 'error')
        return
      }
      await refreshSnapshot(projectPath, settings, composition)
      showToast('已重新分析项目元数据与负载')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setReanalyzing(false)
    }
  }

  const handleClearCache = async (scope: CacheClearScope): Promise<void> => {
    setCacheBusy(true)
    try {
      const result = await api().performance.clearCaches({ scope, projectPath })
      if (!result.ok) {
        showToast(result.error ?? '清除缓存失败', 'error')
        return
      }
      await refreshSnapshot()
      showToast(`已清除 ${result.cleared.length} 个缓存文件，项目文件未受影响`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setCacheBusy(false)
    }
  }

  /* ---------------- 性能测试临时文件清理 ---------------- */

  const handleRefreshStorage = async (): Promise<void> => {
    setStorageRefreshing(true)
    try {
      setTestStorage(await api().performance.testStorage())
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setStorageRefreshing(false)
    }
  }

  const handleCleanupTestFiles = async (): Promise<void> => {
    setCleanupBusy(true)
    try {
      const result = await api().performance.cleanupTestFiles()
      setTestStorage(result.usage)
      if (result.skipped) {
        showToast(result.skipReason ?? '当前策略不清理任何文件', 'error')
        return
      }
      const parts = [`已删除 ${result.deletedFiles} 个文件，释放 ${formatBytes(result.freedBytes)}`]
      if (result.cleanedTasks.length > 0) parts.push(`${result.cleanedTasks.length} 个任务已清理`)
      if (result.skippedTasks.length > 0) parts.push(`${result.skippedTasks.length} 个未登记目录未触碰`)
      if (result.failedTasks.length > 0) parts.push(`${result.failedTasks.length} 个任务有文件被占用`)
      showToast(parts.join('；'), result.failedTasks.length > 0 ? 'error' : 'ok')
      await refreshSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setCleanupBusy(false)
    }
  }

  const handleCleanupToggle = (patch: {
    autoClean?: boolean
    keepFailed?: boolean
    keepReports?: boolean
  }): void => {
    setCleanupSettings((prev) => ({ ...prev, ...patch }))
    void api().settings.update({
      ...(patch.autoClean !== undefined ? { autoCleanPerfTests: patch.autoClean } : {}),
      ...(patch.keepFailed !== undefined ? { keepFailedPerfTests: patch.keepFailed } : {}),
      ...(patch.keepReports !== undefined ? { keepPerfReports: patch.keepReports } : {})
    })
  }

  /* ---------------- 性能中心：四模式对比测试 ---------------- */

  const handlePlanComparison = async (): Promise<void> => {
    if (!settings || !projectPath) {
      showToast('请先选择项目', 'error')
      return
    }
    setBenchmarkBusy(true)
    try {
      const nextPlan = await api().performance.planComparison({
        projectPath,
        settings,
        kind: comparisonKind
      })
      setComparisonPlan(nextPlan)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBenchmarkBusy(false)
    }
  }

  const handleStartComparison = async (): Promise<void> => {
    if (!settings || !projectPath) {
      showToast('请先选择项目', 'error')
      return
    }
    setBenchmarkBusy(true)
    try {
      const result = await api().performance.startComparison({
        projectPath,
        settings,
        kind: comparisonKind,
        allowExperimental: mode === 'extreme' ? allowExperimental : false
      })
      if (!result.ok) {
        showToast(result.error ?? '无法开始对比测试', 'error')
        return
      }
      if (result.plan) setComparisonPlan(result.plan)
      showToast('性能对比测试已开始，请保持应用在前台')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBenchmarkBusy(false)
    }
  }

  const handleApply = async (): Promise<void> => {
    if (!recommendation || !settings) return
    setApplying(true)
    try {
      const merged: RenderSettings = { ...settings, ...recommendation.settingsPatch }
      await api().settings.update({ lastSettings: merged })
      setSettings(merged)
      const latest = await api().performance.optimize({ mode, projectPath, settings: merged })
      setRecommendation(latest)
      showToast('已应用到渲染参数，返回「渲染」页即可使用')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setApplying(false)
    }
  }

  const handleDeleteProfile = async (id: string): Promise<void> => {
    try {
      await api().performance.resetProfiles()
      await refreshSnapshot(projectPath, settings)
      showToast('档案已重置')
      void id
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleReset = async (): Promise<void> => {
    try {
      await api().performance.resetProfiles()
      setRecommendation(null)
      await refreshSnapshot(projectPath, settings)
      showToast('已清空本机档案与历史')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const running = benchmark?.status === 'running'

  return (
    <>
      <TitleBar
        theme={props.theme}
        onToggleTheme={props.onToggleTheme}
        page={props.page}
        onNavigate={props.onNavigate}
        projectName={projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() ?? null : null}
        projectPath={projectPath || null}
      />

      <div className="perf-page">
        <section className="perf-hero">
          <div className="perf-hero-text">
            <h1>性能优化</h1>
            <p>
              识别本机硬件与 CLI 能力，按当前项目负载给出可验证的渲染配置。
              {analyzeMs != null && (
                <span className="muted-line"> · 本次加载 {analyzeMs} ms（缓存优先）</span>
              )}
            </p>
          </div>
          <div className="perf-project">
            <span className="metric-label">当前项目</span>
            <span className="perf-project-path mono" title={projectPath}>
              {projectPath ? shortPath(projectPath, 54) : '尚未选择项目'}
            </span>
            <button type="button" className="link-btn" onClick={() => void selectProject()}>
              更换
            </button>
          </div>
        </section>

        {/* 四种性能模式：全页唯一的模式选择区域（选择 + 当前模式参数详情） */}
        <PerformanceModeSelector
          presets={snapshot?.modePresets ?? []}
          active={mode}
          busy={loading || running}
          optimizing={optimizing}
          allowExperimental={allowExperimental}
          onAllowExperimentalChange={(value) => {
            setAllowExperimental(value)
            void api().settings.update({ allowExperimental: value })
          }}
          onSelect={(next) => changeMode(next)}
          onOptimize={() => void handleOptimize()}
        />

        {loading && !snapshot ? (
          <div className="perf-loading big">
            <Spinner />
            <span>正在识别硬件、验证编码器与浏览器 GPU…</span>
            <span className="muted-line">首次检测约 10–20 秒，之后会使用缓存结果</span>
          </div>
        ) : (
          <>
            <div className="perf-grid">
              <DevicePanel
                hardware={snapshot?.hardware ?? null}
                capabilities={snapshot?.capabilities ?? null}
                loading={loading}
                cliVersion={snapshot?.cli.version ?? null}
                onRescan={() => void handleRescan()}
              />
              <div className="perf-col">
                <RecommendationPanel
                  mode={mode}
                  recommendation={recommendation}
                  currentProjectPath={projectPath}
                  applying={applying}
                  disabled={loading || running}
                  onApply={() => void handleApply()}
                />
                <MonitorStrip monitor={monitor} intervalHint={monitor?.active ? '每 2 秒' : undefined} />
              </div>
            </div>

            <WorkloadPanel
              workload={snapshot?.workload ?? null}
              projectName={projectPath}
              compositionId={composition || null}
            />

            {/* ---------------- 性能中心：四模式对比 ---------------- */}
            <ComparisonRunner
              plan={comparisonPlan}
              state={benchmark}
              running={running}
              busy={benchmarkBusy || loading}
              kind={comparisonKind}
              archiveValid={snapshot?.smartArchive.valid ?? false}
              archiveReason={snapshot?.smartArchive.reason ?? '尚未生成优化档案'}
              onKindChange={setComparisonKind}
              onPlan={() => void handlePlanComparison()}
              onStart={() => void handleStartComparison()}
              onStop={() => void handleStopBenchmark()}
            />

            <SpeedComparison report={snapshot?.currentReport ?? null} live={benchmark} />

            <ComparisonDiagnostics state={benchmark} />

            <FastestRenderTime report={snapshot?.currentReport ?? null} />

            <ResourceComparison report={snapshot?.currentReport ?? null} />

            <ReportHistory reports={snapshot?.reports ?? []} />

            <CachePanel
              cache={cache}
              busy={loading || running || cacheBusy}
              reanalyzing={reanalyzing}
              onRefreshHardware={() => void handleRefreshHardware()}
              onReanalyze={() => void handleReanalyzeProject()}
              onClear={(scope) => void handleClearCache(scope)}
            />

            <CleanupPanel
              usage={testStorage}
              lastCleanup={benchmark?.cleanup ?? null}
              busy={loading || storageRefreshing}
              cleaning={cleanupBusy}
              settings={cleanupSettings}
              onToggle={handleCleanupToggle}
              onRefresh={() => void handleRefreshStorage()}
              onCleanup={() => void handleCleanupTestFiles()}
            />

            <ProfilePanel
              hardwareProfile={snapshot?.hardwareProfile ?? null}
              profiles={snapshot?.profiles ?? []}
              fallbacks={snapshot?.fallbacks ?? []}
              onDeleteProfile={(id) => void handleDeleteProfile(id)}
              onReset={() => void handleReset()}
              busy={loading || running}
            />

            <div className="perf-note">
              <Badge tone="neutral">说明</Badge>
              <span>
                所有检测与测试都在本机完成，档案只保存在应用数据目录；硬件型号相同不代表环境相同，
                推荐值始终以本机实测为准。
              </span>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === 'ok' ? <Icon.Check /> : <Icon.Close />}
          {toast.text}
        </div>
      )}
    </>
  )
}
