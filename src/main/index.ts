import { app, dialog, Menu, shell } from 'electron'
import { join } from 'node:path'
import { ProjectManager } from './services/project-manager'
import { PresetManager } from './services/preset-manager'
import { SettingsManager } from './services/settings-manager'
import { EnvironmentService } from './process/environment'
import { RenderManager } from './process/render-manager'
import { RenderHistoryManager } from './services/render-history'
import { PerformanceService } from './services/performance-service'
import { PreviewManager } from './preview/preview-manager'
import { WindowManager } from './window/window-manager'
import { registerIpcHandlers } from './ipc/handlers'
import { IPC } from '@shared/ipc'

app.setAppUserModelId('com.hfrender.app')

const settingsManager = new SettingsManager()
const getCliCommand = async (): Promise<string> => {
  const settings = await settingsManager.get()
  return settings.cliCommand || 'npx --yes hyperframes'
}

const projectManager = new ProjectManager(getCliCommand)
const presetManager = new PresetManager()
const environmentService = new EnvironmentService(getCliCommand)
const renderManager = new RenderManager()
const renderHistoryManager = new RenderHistoryManager()
// 任务结束（成功 / 失败 / 取消）都会写入历史：保存的是本次任务真正使用的配置快照
renderManager.setHistorySink((entry) => renderHistoryManager.save(entry))

const performanceService = new PerformanceService({
  getCliCommand,
  project: projectManager,
  render: renderManager,
  settings: settingsManager
})
performanceService.wireRenderManager()

/**
 * 项目元数据统一走 ProjectMetadataService（带磁盘缓存 + 文件指纹校验）：
 * 渲染页打开项目时不再每次都执行 info / compositions 与目录递归扫描。
 */
projectManager.setMetadataProvider(async (input) => {
  const result = await performanceService.projectMetadata.analyze({
    projectPath: input.projectPath,
    composition: input.composition ?? null
  })
  return { metadata: result.metadata, fromCache: result.fromCache }
})

const windowManager = new WindowManager({
  preloadPath: join(__dirname, '../preload/index.js'),
  rendererEntry: join(__dirname, '../renderer/index.html'),
  devUrl: process.env.VITE_DEV_SERVER_URL,
  onBeforeClose: (event) => {
    if (!renderManager.isBusy()) return
    const win = windowManager.getWindow()
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: ['退出并停止渲染', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '渲染进行中',
      message: '当前有渲染任务正在运行，退出会终止该任务。',
      detail: '确定要退出吗？'
    }
    const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)
    if (choice !== 0) {
      event.preventDefault()
      return
    }
    renderManager.dispose()
  }
})

/**
 * 预览服务管理器。
 * - 只使用 HyperFrames CLI 自己的生命周期管理，不自行实现 Studio；
 * - 打开浏览器走 shell.openExternal（系统默认浏览器），不在应用内建 BrowserWindow / WebView。
 */
const previewManager = new PreviewManager({
  getCliCommand,
  openExternal: (url) => shell.openExternal(url),
  onState: (state) => {
    const win = windowManager.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.previewEvent, state)
  },
  log: (message, level) => {
    if (level === 'error') console.error('[preview]', message)
    else console.log('[preview]', message)
  }
})

renderManager.onEvent((event) => {
  const win = windowManager.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.renderEvent, event)
})

performanceService.benchmark.onEvent((event) => {
  const win = windowManager.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.perfBenchmarkEvent, event)
})

performanceService.onCacheEvent((event) => {
  const win = windowManager.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.perfCacheEvent, event)
})

performanceService.monitor.onState((state) => {
  const win = windowManager.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.perfMonitorEvent, state)
})

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开项目…',
          accelerator: 'CmdOrCtrl+O',
          click: () => windowManager.getWindow()?.webContents.send('menu:open-project')
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'HyperFrames 文档',
          click: () => void shell.openExternal('https://hyperframes.heygen.com')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = windowManager.getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    // 用户再次启动应用时，把已有窗口提到最前
    win.moveTop()
    win.focus()
  })

  app.whenReady().then(() => {
    registerIpcHandlers({
      project: projectManager,
      presets: presetManager,
      settings: settingsManager,
      render: renderManager,
      renderHistory: renderHistoryManager,
      environment: environmentService,
      performance: performanceService,
      preview: previewManager,
      window: windowManager,
      getWindow: () => windowManager.getWindow()
    })
    buildMenu()
    windowManager.create()

    /* ---------------- 缓存预热（不阻塞窗口） ---------------- */
    // 1) 轻量版本探测：只跑一次 `hyperframes --version`，版本变化时让 CLI 能力缓存失效
    void performanceService
      .warmup()
      .then((result) => {
        if (result.changed) {
          console.log(`[cache] CLI 版本变化 → ${result.cliVersion ?? 'unknown'}，能力缓存已失效（${result.ms}ms）`)
        }
      })
      .catch(() => undefined)
    // 2) 硬件档案：命中缓存时只是签名比对；没有缓存才在后台跑一次完整识别（不含编码器试编码）
    void performanceService
      .warmupHardware()
      .then((result) => {
        console.log(
          `[cache] 硬件档案预热完成：${result.fromCache ? '命中缓存' : '完整识别'} ${result.ms}ms`
        )
      })
      .catch(() => undefined)

    // 3) 性能测试临时文件：扫描上次异常退出 / 清理失败留下的过期任务目录（只碰本应用自己的目录）
    void performanceService
      .startupCleanup()
      .then((result) => {
        if (!result) return
        if (result.deletedFiles > 0) {
          console.log(
            `[test-cleanup] 启动扫描清理了 ${result.cleanedTasks.length} 个过期任务，释放 ${result.freedBytes} 字节`
          )
        }
        if (result.failedTasks.length > 0) {
          console.warn(`[test-cleanup] ${result.failedTasks.length} 个任务存在被占用的文件，已保留待下次清理`)
        }
      })
      .catch(() => undefined)

    app.on('activate', () => {
      if (!windowManager.getWindow()) windowManager.create()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * 退出清理：
   * 只停止由当前 HF Render 实例启动的预览服务；
   * 外部（终端或其他工具）启动的服务不会被关闭。
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      const cleanup = (async () => {
        try {
          await previewManager.dispose()
        } catch (err) {
          console.error('[preview] 退出清理失败', err)
        }
        try {
          renderManager.dispose()
        } catch {
          /* ignore */
        }
      })()
      // 退出不能被 CLI 卡住：最多等 12 秒，之后强制退出
      await Promise.race([cleanup, new Promise((done) => setTimeout(done, 12_000))])
      app.exit(0)
    })()
  })
}
