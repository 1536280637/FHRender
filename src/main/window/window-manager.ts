import { BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { WindowState } from '@shared/ipc'

/** 自定义标题栏高度：与渲染进程 CSS 中的 --titlebar-height 保持一致 */
export const TITLEBAR_HEIGHT = 44

/** 原生窗口按钮（Windows titleBarOverlay）的配色，必须与标题栏背景一致 */
const OVERLAY = {
  light: { color: '#ffffff', symbolColor: '#4a5462' },
  dark: { color: '#1a1d22', symbolColor: '#c3cad4' }
} as const

export interface WindowManagerDeps {
  preloadPath: string
  rendererEntry: string
  devUrl?: string
  /** 关闭前的拦截（例如渲染进行中需要二次确认） */
  onBeforeClose?: (event: Electron.Event) => void
  /** 页面内 window.open 的兜底：一律交给系统浏览器 */
  onExternalUrl?: (url: string) => void
}

/**
 * 窗口管理器。
 *
 * 采用 `titleBarStyle: 'hidden'` + `titleBarOverlay`：
 * - 去掉 Windows 默认标题栏，保留系统原生最小化 / 最大化 / 关闭按钮；
 * - 不使用 frame:false，因此缩放、贴靠、Alt+F4、多显示器与高 DPI 全部由系统负责；
 * - 主题切换时同步 overlay 配色，避免出现浅色按钮压在深色栏上。
 */
export class WindowManager {
  private win: BrowserWindow | null = null
  private theme: 'light' | 'dark' = 'light'
  private deps: WindowManagerDeps

  constructor(deps: WindowManagerDeps) {
    this.deps = deps
  }

  create(): BrowserWindow {
    const overlay = OVERLAY[this.theme]
    this.win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      backgroundColor: this.theme === 'dark' ? '#14161a' : '#f6f7f9',
      title: 'HF Render',
      autoHideMenuBar: true,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 14 } }
        : { titleBarOverlay: { color: overlay.color, symbolColor: overlay.symbolColor, height: TITLEBAR_HEIGHT } }),
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })

    this.win.once('ready-to-show', () => this.showOnce())
    // 兜底：某些软件渲染/远程桌面环境下 ready-to-show 可能不触发，
    // 页面加载完成后主动显示，避免窗口一直处于隐藏状态。
    this.win.webContents.once('did-finish-load', () => {
      setTimeout(() => this.showOnce(), 60)
    })
    this.win.webContents.once('did-fail-load', () => {
      setTimeout(() => this.showOnce(), 300)
    })

    this.win.on('close', (event) => this.deps.onBeforeClose?.(event))

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void (this.deps.onExternalUrl ?? ((target: string) => shell.openExternal(target)))(url)
      return { action: 'deny' }
    })

    this.win.on('maximize', () => this.notifyState())
    this.win.on('unmaximize', () => this.notifyState())
    this.win.on('enter-full-screen', () => this.notifyState())
    this.win.on('leave-full-screen', () => this.notifyState())
    this.win.on('focus', () => this.notifyState())
    this.win.on('blur', () => this.notifyState())

    if (this.deps.devUrl) {
      void this.win.loadURL(this.deps.devUrl)
    } else {
      void this.win.loadFile(this.deps.rendererEntry)
    }

    return this.win
  }

  getWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  /** 只显示一次，避免重复 show 抢焦点 */
  private showOnce(): void {
    const win = this.getWindow()
    if (!win || win.isVisible()) return
    win.show()
  }

  /** 渲染进程解析出实际主题后同步原生按钮配色 */
  setTheme(mode: 'light' | 'dark'): void {
    if (this.theme === mode) return
    this.theme = mode
    const win = this.getWindow()
    if (!win || process.platform === 'darwin') return
    const overlay = OVERLAY[mode]
    try {
      win.setTitleBarOverlay({
        color: overlay.color,
        symbolColor: overlay.symbolColor,
        height: TITLEBAR_HEIGHT
      })
      win.setBackgroundColor(mode === 'dark' ? '#14161a' : '#f6f7f9')
    } catch {
      /* 某些平台/版本没有 titleBarOverlay，忽略即可 */
    }
  }

  getState(): WindowState {
    const win = this.getWindow()
    return {
      maximized: win?.isMaximized() ?? false,
      fullscreen: win?.isFullScreen() ?? false,
      focused: win?.isFocused() ?? false,
      platform: process.platform
    }
  }

  notifyState(): void {
    const win = this.getWindow()
    if (!win) return
    win.webContents.send(IPC.windowStateEvent, this.getState())
  }
}
