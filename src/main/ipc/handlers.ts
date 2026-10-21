import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { IPC } from '@shared/ipc'
import type { ProjectManager } from '../services/project-manager'
import type { PresetManager } from '../services/preset-manager'
import type { SettingsManager } from '../services/settings-manager'
import type { RenderManager } from '../process/render-manager'
import type { RenderHistoryManager } from '../services/render-history'
import type { EnvironmentService } from '../process/environment'
import type { PerformanceService } from '../services/performance-service'
import type { PreviewManager } from '../preview/preview-manager'
import type { WindowManager } from '../window/window-manager'
import { buildProjectCheckItem } from '../process/environment'
import type { RenderRequest, RenderSettings } from '@shared/types/render'
import type { AppSettings } from '@shared/types/settings'
import type { BenchmarkStartInput, PerformanceMode } from '@shared/types/performance'
import type { CacheClearScope } from '@shared/types/cache'

export interface IpcContext {
  project: ProjectManager
  presets: PresetManager
  settings: SettingsManager
  render: RenderManager
  renderHistory: RenderHistoryManager
  environment: EnvironmentService
  performance: PerformanceService
  preview: PreviewManager
  window: WindowManager
  getWindow: () => BrowserWindow | null
}

function anchorWindow(ctx: IpcContext): BrowserWindow | undefined {
  const win = ctx.getWindow()
  return win && !win.isDestroyed() ? win : undefined
}

function openDialog(
  ctx: IpcContext,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const win = anchorWindow(ctx)
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 参数类型错误`)
  return value
}

/** 把用户选择的 composition 转成相对项目根目录的路径 */
function toProjectRelative(projectPath: string, filePath: string): string {
  const abs = resolve(filePath)
  if (!isAbsolute(filePath)) return filePath.replace(/\\/g, '/')
  const rel = relative(resolve(projectPath), abs)
  if (!rel.startsWith('..') && !rel.includes(`..${sep}`)) {
    return rel.split(sep).join('/')
  }
  return abs.split(sep).join('/')
}

export function registerIpcHandlers(ctx: IpcContext): void {
  /* ------------------------------ 项目 ------------------------------ */

  ipcMain.handle(IPC.projectSelect, async () => {
    const settings = await ctx.settings.get()
    const result = await openDialog(ctx, {
      title: '选择 HyperFrames 项目目录',
      properties: ['openDirectory'],
      defaultPath: settings.recentProjects[0]?.path
    })
    if (result.canceled || result.filePaths.length === 0) return { info: null }
    const scan = await ctx.project.scan(result.filePaths[0])
    if (scan.info) {
      await ctx.settings.rememberProject(scan.info.path, scan.info.name)
    }
    return scan
  })

  ipcMain.handle(IPC.projectScan, async (_event, path: unknown, composition?: unknown) => {
    const target = asString(path, 'path')
    const comp = typeof composition === 'string' && composition.trim() ? composition : null
    const scan = await ctx.project.scan(target, { composition: comp })
    if (scan.info) {
      await ctx.settings.rememberProject(scan.info.path, scan.info.name)
    }
    return scan
  })

  ipcMain.handle(IPC.projectRecent, async () => {
    const settings = await ctx.settings.get()
    return settings.recentProjects
  })

  ipcMain.handle(IPC.projectRemoveRecent, async (_event, path: unknown) => {
    const target = asString(path, 'path')
    const settings = await ctx.settings.forgetProject(target)
    return settings.recentProjects
  })

  ipcMain.handle(IPC.projectCompositions, async (_event, path: unknown) => {
    return ctx.project.compositions(asString(path, 'path'))
  })

  ipcMain.handle(IPC.projectHtmlFiles, async (_event, path: unknown) => {
    return ctx.project.htmlFiles(asString(path, 'path'))
  })

  ipcMain.handle(IPC.projectReveal, async (_event, path: unknown) => {
    const target = asString(path, 'path')
    if (existsSync(target)) shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.projectLint, async (_event, path: unknown) => {
    return ctx.project.lint(asString(path, 'path'))
  })

  /* ------------------------------ 环境 ------------------------------ */

  ctx.environment.setProjectProbe(async (projectPath: string) => {
    const scan = await ctx.project.scan(projectPath)
    if (!scan.info) {
      return {
        id: 'project',
        label: '当前项目',
        status: 'error' as const,
        detail: scan.error ?? '项目无效'
      }
    }
    return buildProjectCheckItem({
      path: scan.info.path,
      valid: scan.info.valid,
      hasIndexHtml: scan.info.hasIndexHtml,
      width: scan.info.width,
      height: scan.info.height,
      issues: scan.info.issues
    })
  })

  ipcMain.handle(IPC.envCheck, async (_event, projectPath?: unknown) => {
    const path = typeof projectPath === 'string' && projectPath ? projectPath : undefined
    const force = (projectPath as { force?: boolean } | undefined)?.force === true
    return ctx.environment.check(path, { force })
  })

  /* ------------------------------ 预设 ------------------------------ */

  ipcMain.handle(IPC.presetList, async () => ctx.presets.list())

  ipcMain.handle(IPC.presetSave, async (_event, input: unknown) => {
    const data = input as { name?: string; settings?: RenderSettings }
    if (!data?.settings) throw new Error('预设参数缺失')
    return ctx.presets.save({ name: String(data.name ?? ''), settings: data.settings })
  })

  ipcMain.handle(IPC.presetUpdate, async (_event, id: unknown, input: unknown) => {
    const data = input as { name?: string; settings?: RenderSettings }
    if (!data?.settings) throw new Error('预设参数缺失')
    return ctx.presets.update(asString(id, 'id'), {
      name: String(data.name ?? ''),
      settings: data.settings
    })
  })

  ipcMain.handle(IPC.presetDelete, async (_event, id: unknown) => {
    return ctx.presets.remove(asString(id, 'id'))
  })

  ipcMain.handle(IPC.presetReset, async () => ctx.presets.reset())

  /* ------------------------------ 设置 ------------------------------ */

  ipcMain.handle(IPC.settingsGet, async () => ctx.settings.get())

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) throw new Error('设置参数无效')
    return ctx.settings.update(patch as Partial<AppSettings>)
  })

  /* ------------------------------ 渲染 ------------------------------ */

  ipcMain.handle(IPC.renderStart, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) return { ok: false, error: '渲染参数无效' }
    // 单一任务管理：性能测试与普通渲染不能同时启动（否则会互相抢资源、成绩也不可信）
    if (ctx.performance.benchmark.isRunning()) {
      return { ok: false, error: '性能测试进行中，请等待测试结束或先停止测试' }
    }
    const settings = await ctx.settings.get()
    const req = request as RenderRequest
    const result = await ctx.render.start(req, settings.cliCommand, {
      scratchDir: settings.scratchDir,
      autoScratch: settings.autoScratch !== false,
      // 性能模式在任务启动时冻结进配置快照：之后用户切模式不会影响正在跑的任务
      performanceMode: settings.performanceMode
    })
    if (result.ok) {
      await ctx.settings.update({
        lastSettings: stripLocation(req),
        lastOutputDir: req.outputDir,
        lastComposition: req.composition ?? ''
      })
      await ctx.settings.rememberOutputDir(req.outputDir)
    }
    return result
  })

  ipcMain.handle(IPC.renderStop, async () => ctx.render.stop())
  ipcMain.handle(IPC.renderState, async () => ctx.render.getState())
  ipcMain.handle(IPC.renderHistory, async () => ctx.renderHistory.list())
  ipcMain.handle(IPC.renderClearLogs, async () => {
    ctx.render.clearLogs()
  })

  /* ------------------------------ 系统 ------------------------------ */

  ipcMain.handle(IPC.dialogSelectDirectory, async (_event, defaultPath?: unknown) => {
    const result = await openDialog(ctx, {
      title: '选择输出文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    await ctx.settings.rememberOutputDir(dir)
    return dir
  })

  ipcMain.handle(IPC.dialogSelectComposition, async (_event, projectPath: unknown) => {
    const project = asString(projectPath, 'projectPath')
    const result = await openDialog(ctx, {
      title: '选择 composition 文件',
      properties: ['openFile'],
      defaultPath: project,
      filters: [{ name: 'HTML Composition', extensions: ['html', 'htm'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return toProjectRelative(project, result.filePaths[0])
  })

  ipcMain.handle(IPC.openPath, async (_event, path: unknown) => {
    const target = asString(path, 'path')
    if (!existsSync(target)) throw new Error('路径不存在')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.showItem, async (_event, path: unknown) => {
    const target = asString(path, 'path')
    if (existsSync(target)) shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.appInfo, async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }))

  /* ------------------------------ 性能 ------------------------------ */

  ipcMain.handle(IPC.perfSnapshot, async (_event, input?: unknown) => {
    const data = (input ?? {}) as {
      projectPath?: string | null
      settings?: RenderSettings | null
      composition?: string | null
    }
    return ctx.performance.snapshot({
      projectPath: typeof data.projectPath === 'string' ? data.projectPath : null,
      settings: data.settings ?? null,
      composition: typeof data.composition === 'string' ? data.composition : null
    })
  })

  ipcMain.handle(IPC.perfRescan, async () => {
    ctx.performance.cli.invalidate()
    await ctx.performance.ensureAll(true)
    return ctx.performance.snapshot({})
  })

  ipcMain.handle(IPC.perfOptimize, async (_event, input: unknown) => {
    const data = (input ?? {}) as {
      mode?: PerformanceMode
      projectPath?: string | null
      settings?: RenderSettings | null
      allowExperimental?: boolean
    }
    const mode: PerformanceMode =
      data.mode === 'balanced' || data.mode === 'performance' || data.mode === 'extreme'
        ? data.mode
        : 'smart'
    return ctx.performance.optimizeNow({
      mode,
      projectPath: typeof data.projectPath === 'string' ? data.projectPath : null,
      settings: data.settings ?? null,
      allowExperimental: data.allowExperimental
    })
  })

  ipcMain.handle(IPC.perfPlanBenchmark, async (_event, input: unknown) => {
    const data = input as BenchmarkStartInput
    return ctx.performance.planBenchmark({
      mode: data?.mode ?? 'extreme',
      projectPath: String(data?.projectPath ?? ''),
      settings: data?.settings as RenderSettings,
      allowExperimental: data?.allowExperimental,
      runsPerCandidate: data?.runsPerCandidate
    })
  })

  ipcMain.handle(IPC.perfBenchmarkStart, async (_event, input: unknown) => {
    const data = input as BenchmarkStartInput
    if (!data?.projectPath || !data?.settings) return { ok: false, error: '测试参数不完整' }
    return ctx.performance.startBenchmark(data)
  })

  ipcMain.handle(IPC.perfBenchmarkStop, async () => ctx.performance.stopBenchmark())

  ipcMain.handle(IPC.perfBenchmarkState, async () => ctx.performance.benchmark.getState())

  ipcMain.handle(IPC.perfResetProfiles, async () => {
    await ctx.performance.resetProfiles()
  })

  /* ------------------------ 性能中心扩展 ------------------------ */

  ipcMain.handle(IPC.perfModePresets, async (_event, input: unknown) => {
    const data = (input ?? {}) as { settings?: RenderSettings; allowExperimental?: boolean }
    if (!data.settings) throw new Error('缺少渲染参数')
    return ctx.performance.resolveModePresets({
      settings: data.settings,
      allowExperimental: data.allowExperimental
    })
  })

  ipcMain.handle(IPC.perfComparisonPlan, async (_event, input: unknown) => {
    const data = (input ?? {}) as { projectPath?: string; settings?: RenderSettings; kind?: 'quick' | 'precise' }
    if (!data.projectPath || !data.settings) throw new Error('对比测试参数不完整')
    return ctx.performance.planComparison({
      projectPath: data.projectPath,
      settings: data.settings,
      kind: data.kind === 'precise' ? 'precise' : 'quick'
    })
  })

  ipcMain.handle(IPC.perfComparisonStart, async (_event, input: unknown) => {
    const data = (input ?? {}) as {
      projectPath?: string
      settings?: RenderSettings
      kind?: 'quick' | 'precise'
      allowExperimental?: boolean
    }
    if (!data.projectPath || !data.settings) return { ok: false, error: '对比测试参数不完整' }
    return ctx.performance.startComparison({
      projectPath: data.projectPath,
      settings: data.settings,
      kind: data.kind === 'precise' ? 'precise' : 'quick',
      allowExperimental: data.allowExperimental
    })
  })

  ipcMain.handle(IPC.perfReports, async () => ctx.performance.listReports())

  /* ------------------------ 缓存与检测 ------------------------ */

  ipcMain.handle(IPC.perfCacheStatus, async (_event, projectPath?: unknown) => {
    return ctx.performance.cacheStatus(typeof projectPath === 'string' ? projectPath : null)
  })

  ipcMain.handle(IPC.perfCacheRefreshHardware, async () => ctx.performance.refreshHardware())

  ipcMain.handle(IPC.perfCacheReanalyze, async (_event, input: unknown) => {
    const data = (input ?? {}) as { projectPath?: string; composition?: string | null }
    if (!data.projectPath) return { ok: false, workload: null, error: '缺少项目路径' }
    try {
      const workload = await ctx.performance.reanalyzeProject(
        data.projectPath,
        data.composition ?? null
      )
      return { ok: !!workload, workload }
    } catch (err) {
      return {
        ok: false,
        workload: null,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(IPC.perfCacheClear, async (_event, input: unknown) => {
    const data = (input ?? {}) as { scope?: CacheClearScope; projectPath?: string | null }
    const scope: CacheClearScope =
      data.scope === 'hardware' || data.scope === 'environment' || data.scope === 'project'
        ? data.scope
        : 'all'
    return ctx.performance.clearCaches(scope, data.projectPath ?? null)
  })

  /* ------------------------ 性能测试临时文件 ------------------------ */

  ipcMain.handle(IPC.perfTestStorage, async () => ctx.performance.testStorage())

  ipcMain.handle(IPC.perfTestCleanup, async () => ctx.performance.cleanupTestFiles())

  /* ------------------------------ 预览服务 ------------------------------ */

  /**
   * 安全边界：渲染进程只能传「项目路径」。
   * Studio 地址一律由主进程从 CLI 返回值中读取，渲染进程无法让主进程打开任意 URL。
   */
  ipcMain.handle(IPC.previewStart, async (_event, projectPath: unknown) => {
    return ctx.preview.start(asString(projectPath, 'projectPath'))
  })

  ipcMain.handle(IPC.previewStatus, async (_event, projectPath?: unknown) => {
    const path = typeof projectPath === 'string' && projectPath ? projectPath : null
    return ctx.preview.getState(path)
  })

  ipcMain.handle(IPC.previewOpen, async (_event, projectPath: unknown) => {
    return ctx.preview.open(asString(projectPath, 'projectPath'))
  })

  ipcMain.handle(IPC.previewStop, async (_event, projectPath: unknown) => {
    return ctx.preview.stop(asString(projectPath, 'projectPath'))
  })

  ipcMain.handle(IPC.previewList, async () => ctx.preview.list())

  /* ------------------------------ 窗口 ------------------------------ */

  ipcMain.handle(IPC.windowSetTheme, async (_event, mode: unknown) => {
    if (mode !== 'light' && mode !== 'dark') return
    ctx.window.setTheme(mode)
  })

  ipcMain.handle(IPC.windowGetState, async () => ctx.window.getState())
}

function stripLocation(request: RenderRequest): RenderSettings {
  const {
    projectPath: _projectPath,
    composition: _composition,
    outputDir: _outputDir,
    outputName: _outputName,
    projectMeta: _projectMeta,
    ...rest
  } = request
  return rest
}
