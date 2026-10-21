/**
 * 项目相关类型定义
 */

export interface CompositionInfo {
  id: string
  duration?: number
  width?: number
  height?: number
  elementCount?: number
}

/**
 * 元数据取值来源。界面据此说明「这个数字是怎么来的」，
 * 无法确定时一律为 'unknown'，不允许用默认值冒充真实值。
 */
export type MetadataSource =
  | 'cli-info' // `hyperframes info --json`
  | 'composition' // `hyperframes compositions --json` 中对应条目
  | 'entry-html' // 根元素 data-duration / data-fps 等属性
  | 'cli-default' // 当前 CLI 版本明确声明的默认值（例如 fps 未声明时按 30）
  | 'unknown'

/** 当前 CLI 是否提供项目元数据命令（按 --help 实测，不按版本号猜） */
export interface ProjectCommandCapability {
  info: boolean
  compositions: boolean
  /** 两个命令都支持 --json 时才为 true */
  json: boolean
  /** 探测失败时的原始原因 */
  error: string | null
  /** 从 `render --help` 读到的默认帧率（例如 "Defaults to ... else 30"） */
  defaultFps: number | null
  cliVersion: string | null
  probedAt: string | null
}

/** 一个项目的真实元数据（官方 CLI 优先，结构解析兜底） */
export interface ProjectMetadata {
  /** 规范化后的绝对路径 */
  path: string
  name: string
  /** 当前渲染入口对应的 Composition ID；无法确定时为 null */
  compositionId: string | null
  width: number | null
  height: number | null
  /** 项目时长（秒）；无法可靠确定时为 null（界面显示「时长待检测」） */
  durationSec: number | null
  durationSource: MetadataSource
  /**
   * 项目原始 FPS（根元素 data-fps）。
   * 未声明时为 null——不要用 CLI 默认值覆盖这个字段，两者语义不同。
   */
  projectFps: number | null
  projectFpsSource: MetadataSource
  /** 当前 CLI 在未声明 data-fps 时使用的默认帧率 */
  cliDefaultFps: number | null
  /** info 返回的元素数量 */
  elements: number | null
  /** info 返回的轨道数量 */
  tracks: number | null
  /** info 返回的元素类型分布，例如 { text: 18, audio: 1 } */
  types: Record<string, number>
  /** info 返回的项目总体积（字节） */
  projectBytes: number | null
  compositions: CompositionInfo[]
  capability: ProjectCommandCapability
  cliVersion: string | null
  detectedAt: string
  /** 解析过程中的降级说明（例如 info 失败后改用 HTML 解析） */
  warnings: string[]
}

export interface ProjectIssue {
  /** info 仅作提示，不阻止预览 / 渲染 */
  level: 'error' | 'warning' | 'info'
  message: string
  hint?: string
}

export interface ProjectInfo {
  /** 项目绝对路径 */
  path: string
  /** 项目名（目录名或 package.json name） */
  name: string
  /** 是否可用于渲染 */
  valid: boolean
  /** 是否为 HyperFrames 项目（含 hyperframes.json 或 index.html） */
  isHyperframesProject: boolean
  hasIndexHtml: boolean
  hasPackageJson: boolean
  hasHyperframesConfig: boolean
  packageName?: string
  width?: number
  height?: number
  /** 时长（秒）——只来自官方 info / composition 或根元素 data-duration */
  duration?: number
  /** 项目原始 FPS——只来自根元素 data-fps */
  fps?: number
  compositions: CompositionInfo[]
  /** 完整元数据（含来源说明与降级警告） */
  metadata?: ProjectMetadata
  issues: ProjectIssue[]
  /** 检测时间 ISO 字符串 */
  checkedAt: string
  /** 本次结果是否直接来自缓存（未重新执行 CLI / 目录扫描） */
  fromCache?: boolean
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface ProjectScanResult {
  info: ProjectInfo | null
  error?: string
}
