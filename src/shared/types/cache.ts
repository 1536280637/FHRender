/**
 * 缓存状态类型（主进程 -> 渲染进程，只读）。
 *
 * 设计原则：
 * - 静态硬件 / 环境 / 项目元数据才缓存；CPU 占用、GPU 占用、显存占用等动态指标
 *   永远来自实时采样，绝不写入缓存（见 ResourceMonitor）。
 * - 每个缓存都带 checkedAt / expiresAt / staleReason，界面可以如实告诉用户
 *   「这是什么时候的数据」「为什么需要重新检测」，不假装新鲜。
 */

export interface CacheEntryStatus {
  /** 当前是否有一份可直接使用的缓存 */
  available: boolean
  /** 最后一次真实检测完成的时间（ISO） */
  checkedAt: string | null
  /** 缓存文件绝对路径 */
  file: string | null
  /** 过期时间（ISO）；null 表示长期有效（依赖指纹校验） */
  expiresAt: string | null
  /** 被判为不可用 / 需要刷新的原因；可用时为空 */
  staleReason: string | null
  /** 缓存键（CLI 命令 + 版本 / 硬件指纹等），用于解释失效原因 */
  key: string | null
}

export interface HardwareCacheStatus extends CacheEntryStatus {
  fingerprint: string | null
  cpuModel: string | null
  gpuNames: string[]
  totalMemoryBytes: number | null
  driverVersions: Record<string, string>
  /** 静态档案有效期（小时） */
  ttlHours: number
}

export interface EnvironmentCacheStatus extends CacheEntryStatus {
  nodeVersion: string | null
  npmVersion: string | null
  cliCommand: string | null
  cliVersion: string | null
  ffmpegPath: string | null
  ffmpegVersion: string | null
  ffprobePath: string | null
  chromePath: string | null
  /** 已验证可用的编码器数量 */
  encoderCount: number | null
  /** 当前 CLI 探测到的 render 参数数量 */
  cliFlagCount: number | null
  ttlHours: number
}

export interface ProjectCacheStatus extends CacheEntryStatus {
  projectPath: string | null
  projectName: string | null
  compositionId: string | null
  cliVersion: string | null
  /** 登记用于失效判断的文件 / 素材数量 */
  trackedFiles: number
  /** 最近一次指纹校验耗时（毫秒），用于证明「没有重新解析整个项目」 */
  verifyMs: number | null
}

/** 进程内累计计数：用于证明重复进入页面不会重复执行检测 */
export interface CacheCounters {
  hardwareScans: number
  hardwareCacheHits: number
  /** CLI `--help` 能力探测次数 */
  envProbes: number
  /** 编码器试编码（真实起 ffmpeg）次数 */
  encoderProbes: number
  envCacheHits: number
  /** `hyperframes info` 实际执行次数 */
  cliInfoCalls: number
  /** `hyperframes compositions` 实际执行次数 */
  cliCompositionCalls: number
  projectScans: number
  projectCacheHits: number
  /** 指纹校验时 stat 的文件数 */
  assetFileStats: number
  /** 目录遍历次数（全量扫描才会增加） */
  dirListings: number
}

export interface CacheOverview {
  userDataDir: string
  cacheDir: string
  hardware: HardwareCacheStatus
  environment: EnvironmentCacheStatus
  project: ProjectCacheStatus | null
  counters: CacheCounters
  /** 缓存目录占用字节 */
  cacheBytes: number
}

export type CacheClearScope = 'hardware' | 'environment' | 'project' | 'all'

/** 项目文件变化事件（用于界面后台刷新，不阻塞操作） */
export interface CacheEvent {
  type: 'project-changed' | 'cache-cleared' | 'hardware-refreshed'
  projectPath: string | null
  reason: string
  at: string
}

export interface CacheClearResult {
  ok: boolean
  cleared: string[]
  error?: string
}
