/**
 * HyperFrames Preview 服务相关类型
 *
 * 说明：Preview 与 Render 是两条独立链路。
 * - Preview：启动 HyperFrames Studio 本地服务，浏览器里实时预览（热更新），不产出视频文件。
 * - Render：逐帧捕获 + FFmpeg 编码，产出最终视频。
 */

export type PreviewServiceStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

/** 服务的来源：由 HF Render 启动，还是外部（终端 / 其他工具）已经在跑 */
export type PreviewSource = 'app' | 'external'

/** 当前 CLI 版本实际支持的 preview 能力（由 `preview --help` 探测） */
export interface PreviewCapabilities {
  helpAvailable: boolean
  background: boolean
  noOpen: boolean
  json: boolean
  status: boolean
  stop: boolean
  list: boolean
}

export interface PreviewSession {
  /** 项目绝对路径 */
  projectPath: string
  projectName: string
  status: PreviewServiceStatus
  port: number | null
  /** HyperFrames Studio 页面地址（CLI 返回的 studioUrl） */
  studioUrl: string | null
  /** 预览服务器根地址（CLI 返回的 serverUrl） */
  serverUrl: string | null
  /** 本次观测到的启动时间（ISO） */
  startedAt: string | null
  cliVersion: string | null
  source: PreviewSource
  /** 是否由当前 HF Render 实例启动（决定退出时是否停止） */
  owned: boolean
  /** 最近一次健康检查结果 */
  healthy: boolean
  /**
   * 启动方式。
   * background：CLI 后台守护进程（推荐）；foreground：本应用持有的前台子进程（旧版 CLI 兜底）
   */
  mode: 'background' | 'foreground' | null
  pid: number | null
  logPath: string | null
  error: string | null
  /** 最近一次健康检查时间（ISO） */
  checkedAt: string | null
}

export interface PreviewRuntimeState {
  /** 当前项目对应的会话；未运行时为 null */
  current: PreviewSession | null
  /** 本应用已知的所有预览会话 */
  sessions: PreviewSession[]
  /** CLI 能力探测结果 */
  capabilities: PreviewCapabilities
  cliVersion: string | null
  /** 能力探测失败的原始原因（用于 UI 提示安装 Node / CLI） */
  helpError: string | null
}

export interface PreviewActionResult {
  ok: boolean
  error?: string
  session?: PreviewSession | null
  /** 是否调用系统默认浏览器打开了 Studio */
  opened?: boolean
  /** 复用了已存在的服务（没有重复启动） */
  reused?: boolean
}
