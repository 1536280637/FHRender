/**
 * 性能测试临时文件清理的类型定义。
 *
 * 设计原则（与需求一一对应）：
 * 1. 每次测试都有唯一任务 ID，产物落在 performance-tests/<test-id>/ 下；
 * 2. 每个产物都必须登记到该任务自己的 manifest.json（绝对路径 / 类型 / 创建时间 / 来源 / 任务 / 是否允许清理）；
 * 3. 清理只依据 manifest 与「本任务独占目录」，不靠文件名通配符匹配；
 * 4. 报告与日志长期保留，原始临时视频只服务于本次测试。
 */

/** 任务根目录名（位于 Electron userData 下） */
export const PERF_TEST_ROOT_DIRNAME = 'performance-tests'
/** 每个任务目录内的清单文件名 */
export const TEST_MANIFEST_FILENAME = 'manifest.json'
/** 每个任务目录内的清理记录文件名（属于日志，不会被清理） */
export const TEST_CLEANUP_FILENAME = 'cleanup.json'
/** 每个任务目录内的性能快照文件名（属于报告，默认保留） */
export const TEST_REPORT_FILENAME = 'report.json'

/** 清单 schema 版本：结构变化时用于判断旧清单是否可安全处理 */
export const TEST_MANIFEST_SCHEMA = 1

/* ------------------------------------------------------------------ */
/* 产物类型                                                             */
/* ------------------------------------------------------------------ */

/**
 * 产物类型。前 9 种属于「大型临时产物」，可在测试结束后清理；
 * log / report / manifest / cleanup 属于「长期保留」。
 */
export type TestFileKind =
  | 'video-mp4'
  | 'video-webm'
  | 'video-mov'
  | 'png-sequence'
  | 'rgba-frames'
  | 'screenshot'
  | 'encoded-temp'
  | 'chrome-profile'
  | 'temp-cache'
  | 'log'
  | 'report'
  | 'manifest'
  | 'cleanup'
  | 'other'

/** 默认不参与清理的类型（日志 / 报告 / 清单本身） */
export const PRESERVED_FILE_KINDS: TestFileKind[] = ['log', 'report', 'manifest', 'cleanup']

/** 全部产物类型（清理引擎用来推导可删除集合） */
export const ALL_FILE_KINDS: TestFileKind[] = [
  'video-mp4',
  'video-webm',
  'video-mov',
  'png-sequence',
  'rgba-frames',
  'screenshot',
  'encoded-temp',
  'chrome-profile',
  'temp-cache',
  'log',
  'report',
  'manifest',
  'cleanup',
  'other'
]

export const FILE_KIND_LABEL: Record<TestFileKind, string> = {
  'video-mp4': '临时 MP4',
  'video-webm': '临时 WebM',
  'video-mov': '临时 MOV',
  'png-sequence': 'PNG 序列',
  'rgba-frames': '原始 RGBA 帧',
  screenshot: '临时截图',
  'encoded-temp': '临时编码文件',
  'chrome-profile': 'Chrome 用户数据目录',
  'temp-cache': '临时缓存目录',
  log: '测试日志',
  report: '性能报告',
  manifest: '任务清单',
  cleanup: '清理记录',
  other: '其他中间文件'
}

/** 是否属于可以自动清理的大型临时产物 */
export function isCleanableKind(kind: TestFileKind): boolean {
  return !PRESERVED_FILE_KINDS.includes(kind)
}

/* ------------------------------------------------------------------ */
/* 任务清单                                                             */
/* ------------------------------------------------------------------ */

/** 产物由谁创建：本应用（目录结构 / 报告）或本应用启动的子进程（渲染产物） */
export type TestArtifactOwner = 'hf-render' | 'hf-render-child'

export interface TestManifestEntry {
  /** 规范化后的绝对路径 */
  path: string
  /** 文件还是目录 */
  entry: 'file' | 'dir'
  kind: TestFileKind
  /** 是否允许自动清理（登记时决定，清理前还会再过一遍安全守卫） */
  cleanable: boolean
  /** 创建来源：smoke / balanced / performance / extreme / smart / warmup / workspace / report… */
  source: string
  owner: TestArtifactOwner
  /** 登记时间（ISO） */
  createdAt: string
  /** 最近一次测量到的体积；未知为 null */
  bytes: number | null
  /** 不清理 / 需关注的原因（例如「日志与报告长期保留」） */
  note?: string
}

/** 任务独占的目录根：清理时只在这些根内部逐个登记后删除 */
export interface TestManifestRoot {
  path: string
  kind: TestFileKind
  /** 用途说明，便于人工核对 */
  purpose: string
  createdAt: string
}

export type TestTaskStatus = 'running' | 'done' | 'failed' | 'canceled'

export interface TestManifest {
  schema: number
  /** 固定标记：只有带此标记的目录才被视为 HF Render 自己的任务目录 */
  app: 'hf-render'
  taskId: string
  taskKind: 'comparison' | 'matrix'
  projectPath: string
  createdAt: string
  updatedAt: string
  status: TestTaskStatus
  /** 任务根目录绝对路径 */
  outputRoot: string
  /** 日志目录绝对路径（长期保留） */
  logDir: string
  roots: TestManifestRoot[]
  entries: TestManifestEntry[]
  /** 最近一次清理的简要结果（完整记录在 cleanup.json） */
  lastCleanup?: TestCleanupSummary
}

/* ------------------------------------------------------------------ */
/* 清理策略与结果                                                        */
/* ------------------------------------------------------------------ */

export interface TestCleanupPolicy {
  /** 自动清理性能测试临时文件（设置项，默认开启） */
  autoClean: boolean
  /** 保留失败测试文件（设置项，默认关闭） */
  keepFailed: boolean
  /** 保留性能测试报告与日志（设置项，默认开启） */
  keepReports: boolean
}

export const DEFAULT_CLEANUP_POLICY: TestCleanupPolicy = {
  autoClean: true,
  keepFailed: false,
  keepReports: true
}

export type CleanupErrorCode =
  | 'locked'
  | 'permission'
  | 'missing'
  | 'guard'
  | 'unregistered'
  | 'io'
  | 'unknown'

export interface TestCleanupError {
  path: string | null
  code: CleanupErrorCode
  message: string
  attempts: number
  /** true = 该文件来自安全守卫拒绝，绝不是「删除失败」 */
  refused: boolean
}

/** 一次任务清理的完整结果（同时写入 cleanup.json 并回传界面） */
export interface TestCleanupSummary {
  taskId: string
  /** 触发清理时任务的结果 */
  taskStatus: TestTaskStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  /** 等待子进程退出的耗时 */
  waitExitMs: number
  /** 实际删除的文件数 */
  deletedFiles: number
  /** 删除释放的字节 */
  freedBytes: number
  /** 按策略保留的文件数 / 字节 */
  keptFiles: number
  keptBytes: number
  /** 因占用 / 权限未能删除的文件数 */
  failedFiles: number
  /** 删除时发现已经不存在的条目数（记录，但不算失败） */
  missingFiles: number
  /** 安全守卫拒绝删除的条目数 */
  refusedFiles: number
  /** 累计重试次数 */
  retries: number
  /** 本次清理过程中测到的总体积（删除前） */
  totalBytesBefore: number
  /** 清理后任务目录剩余体积 */
  remainingBytes: number
  /** 整体是否被设置 / 策略跳过 */
  skipped: boolean
  skipReason: string | null
  /** 保留的日志目录 / 报告文件（绝对路径） */
  keptLogDir: string | null
  keptReportFile: string | null
  errors: TestCleanupError[]
}

/* ------------------------------------------------------------------ */
/* 占用统计与批量清理                                                     */
/* ------------------------------------------------------------------ */

export interface TestTaskUsage {
  taskId: string
  /** 有 manifest 且 app 标记正确 = 本应用任务目录 */
  owned: boolean
  status: TestTaskStatus | 'unknown'
  createdAt: string | null
  updatedAt: string | null
  bytes: number
  mediaBytes: number
  logBytes: number
  reportBytes: number
  /** 是否属于当前正在运行的测试 */
  active: boolean
  /** 不可清理的原因（未登记 / 未结束） */
  note: string | null
}

export interface TestStorageUsage {
  /** performance-tests 根目录绝对路径 */
  root: string
  exists: boolean
  taskCount: number
  ownedTaskCount: number
  totalBytes: number
  mediaBytes: number
  logBytes: number
  reportBytes: number
  tasks: TestTaskUsage[]
  scannedAt: string
}

export interface TestCleanupBatchResult {
  ok: boolean
  /** 本次批量清理释放的总字节 */
  freedBytes: number
  deletedFiles: number
  cleanedTasks: string[]
  keptTasks: string[]
  failedTasks: string[]
  /** 未登记、因此没有触碰的目录 */
  skippedTasks: string[]
  errors: TestCleanupError[]
  usage: TestStorageUsage
  skipped?: boolean
  skipReason?: string | null
  startedAt: string
  finishedAt: string
}
