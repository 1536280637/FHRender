/**
 * 单次性能测试的独立工作区（performance-tests/<test-id>/）。
 *
 * 目录结构：
 *
 *   performance-tests/<test-id>/
 *     manifest.json          任务清单：本任务创建/登记的每一个产物
 *     report.json            本次测试的性能数据（默认长期保留）
 *     cleanup.json           清理记录（默认长期保留）
 *     logs/                  诊断日志（session.log / session.json / 每轮 stdout/stderr，长期保留）
 *     smoke/                 基础渲染预检产物（临时）
 *     balanced/ performance/ extreme/ smart/   各模式独立输出（临时）
 *     tmp/                   本任务专属临时目录（子进程 TMP/TEMP/TMPDIR 指向这里）
 *       chrome-profile/      测试专属 Chrome 用户数据目录
 *       screenshots/         临时截图
 *
 * 关键约束：
 * - 所有路径都在任务根目录内，绝不写入用户项目；
 * - 每个产物都要登记（绝对路径 / 类型 / 时间 / 来源 / 任务 / 是否可清理）；
 * - 只有登记过的路径才允许清理，清理前还会再做一次安全守卫。
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PERF_TEST_ROOT_DIRNAME,
  TEST_CLEANUP_FILENAME,
  TEST_MANIFEST_FILENAME,
  TEST_MANIFEST_SCHEMA,
  TEST_REPORT_FILENAME
} from '@shared/types/cleanup'
import type {
  TestArtifactOwner,
  TestFileKind,
  TestManifest,
  TestManifestEntry,
  TestTaskStatus
} from '@shared/types/cleanup'

export interface CreateWorkspaceInput {
  /** Electron userData 根目录（测试里可注入临时目录） */
  userDataDir: string
  taskId: string
  taskKind: 'comparison' | 'matrix'
  projectPath: string
}

/** 各模式输出子目录名（固定，避免出现随机的“差不多”目录） */
export const MODE_OUTPUT_DIRS = ['smoke', 'warmup', 'balanced', 'performance', 'extreme', 'smart', 'matrix'] as const
export type ModeOutputDir = (typeof MODE_OUTPUT_DIRS)[number]

export function perfTestRoot(userDataDir: string): string {
  return join(userDataDir, PERF_TEST_ROOT_DIRNAME)
}

export function taskDirOf(userDataDir: string, taskId: string): string {
  return join(perfTestRoot(userDataDir), taskId)
}

/** 只允许安全字符做目录名，防止任务 ID 被污染成路径 */
export function safeTaskId(taskId: string): string {
  return (taskId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'task'
}

function sanitizeSegment(text: string): string {
  return text.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'run'
}

const VIDEO_EXT_KIND: Record<string, TestFileKind> = {
  '.mp4': 'video-mp4',
  '.webm': 'video-webm',
  '.mov': 'video-mov',
  '.gif': 'encoded-temp',
  '.m4v': 'video-mp4',
  '.mkv': 'encoded-temp',
  '.ts': 'encoded-temp',
  '.m3u8': 'encoded-temp',
  '.png': 'screenshot',
  '.jpg': 'screenshot',
  '.jpeg': 'screenshot',
  '.webp': 'screenshot',
  '.log': 'log',
  '.json': 'other',
  '.tmp': 'encoded-temp',
  '.part': 'encoded-temp',
  '.y4m': 'rgba-frames',
  '.rgba': 'rgba-frames',
  '.raw': 'rgba-frames'
}

/**
 * 推断产物类型。
 *
 * 注意：这一步只用于「登记时准确标注类型」，不参与删除判定；
 * 删除判定永远看 manifest + 所在目录归属，不做文件名匹配。
 */
export function inferFileKind(path: string, hint?: TestFileKind | null): TestFileKind {
  if (hint) return hint
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const ext = lower.slice(dot)
    const kind = VIDEO_EXT_KIND[ext]
    if (kind) return kind
  }
  if (/[\\/]chrome-profile([\\/]|$)/i.test(path)) return 'chrome-profile'
  if (/[\\/]tmp([\\/]|$)/i.test(path)) return 'temp-cache'
  if (/[\\/]logs?([\\/]|$)/i.test(path)) return 'log'
  return 'other'
}

export class TestWorkspace {
  readonly taskId: string
  readonly taskKind: 'comparison' | 'matrix'
  readonly projectPath: string
  readonly root: string
  readonly logDir: string
  readonly manifestPath: string
  readonly reportPath: string
  readonly cleanupPath: string
  readonly tmpDir: string
  readonly chromeProfileDir: string
  readonly screenshotsDir: string

  private manifestData: TestManifest
  /** 已登记的路径集合（规范化小写，避免重复登记） */
  private registered = new Set<string>()
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(input: CreateWorkspaceInput, manifest: TestManifest) {
    this.taskId = manifest.taskId
    this.taskKind = manifest.taskKind
    this.projectPath = input.projectPath
    this.root = manifest.outputRoot
    this.logDir = manifest.logDir
    this.manifestPath = join(this.root, TEST_MANIFEST_FILENAME)
    this.reportPath = join(this.root, TEST_REPORT_FILENAME)
    this.cleanupPath = join(this.root, TEST_CLEANUP_FILENAME)
    this.tmpDir = join(this.root, 'tmp')
    this.chromeProfileDir = join(this.tmpDir, 'chrome-profile')
    this.screenshotsDir = join(this.tmpDir, 'screenshots')
    this.manifestData = manifest
    for (const entry of manifest.entries) this.registered.add(this.keyOf(entry.path))
  }

  get manifest(): TestManifest {
    return this.manifestData
  }

  private keyOf(path: string): string {
    const unified = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }

  /** 创建任务目录、登记根目录与保留文件 */
  static async create(input: CreateWorkspaceInput): Promise<TestWorkspace> {
    const taskId = safeTaskId(input.taskId)
    const root = taskDirOf(input.userDataDir, taskId)
    const logDir = join(root, 'logs')
    const now = new Date().toISOString()

    const manifest: TestManifest = {
      schema: TEST_MANIFEST_SCHEMA,
      app: 'hf-render',
      taskId,
      taskKind: input.taskKind,
      projectPath: input.projectPath,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      outputRoot: root,
      logDir,
      roots: [],
      entries: []
    }

    const workspace = new TestWorkspace({ ...input, taskId }, manifest)

    await fs.mkdir(root, { recursive: true })
    for (const dir of [logDir, workspace.tmpDir, workspace.chromeProfileDir, workspace.screenshotsDir]) {
      await fs.mkdir(dir, { recursive: true })
    }

    // 保留类文件先登记（即使还没生成，清理时也会跳过）
    await workspace.registerPath(workspace.manifestPath, {
      kind: 'manifest',
      source: 'workspace',
      owner: 'hf-render',
      cleanable: false,
      note: '任务清单，长期保留'
    })
    await workspace.registerPath(workspace.reportPath, {
      kind: 'report',
      source: 'report',
      owner: 'hf-render',
      cleanable: false,
      note: '本次测试的性能数据，默认长期保留'
    })
    await workspace.registerPath(workspace.cleanupPath, {
      kind: 'cleanup',
      source: 'cleanup',
      owner: 'hf-render',
      cleanable: false,
      note: '清理记录，长期保留'
    })
    await workspace.addRoot(logDir, 'log', '诊断日志（长期保留）')
    await workspace.addRoot(workspace.tmpDir, 'temp-cache', '本任务专属临时目录（子进程 TMP/TEMP）')

    await workspace.flush()
    return workspace
  }

  /** 打开已存在的任务目录（启动扫描 / 历史清理用）；不是本应用任务则返回 null */
  static async open(taskDir: string): Promise<TestWorkspace | null> {
    const manifestPath = join(taskDir, TEST_MANIFEST_FILENAME)
    let raw: string
    try {
      raw = await fs.readFile(manifestPath, 'utf-8')
    } catch {
      return null
    }
    const parsed = parseManifest(raw)
    if (!parsed) return null
    if (parsed.outputRoot && resolve(parsed.outputRoot) !== resolve(taskDir)) {
      // 清单里的根目录与所在目录不一致：可能被整体移动过，拒绝处理，避免误删
      return null
    }
    return new TestWorkspace(
      {
        userDataDir: resolve(taskDir, '..', '..'),
        taskId: parsed.taskId,
        taskKind: parsed.taskKind,
        projectPath: parsed.projectPath
      },
      parsed
    )
  }

  /* ------------------------------ 目录 ------------------------------ */

  /** 取（并登记）某个模式 / 分组的独立输出目录 */
  async ensureModeDir(name: ModeOutputDir | string): Promise<string> {
    const dir = join(this.root, sanitizeSegment(name))
    await fs.mkdir(dir, { recursive: true })
    const manifest = this.manifestData.roots.find((r) => this.keyOf(r.path) === this.keyOf(dir))
    if (!manifest) {
      await this.addRoot(dir, 'temp-cache', `「${name}」输出目录`)
      await this.flush()
    }
    return dir
  }

  async addRoot(path: string, kind: TestFileKind, purpose: string): Promise<void> {
    if (this.manifestData.roots.some((r) => this.keyOf(r.path) === this.keyOf(path))) return
    this.manifestData.roots.push({
      path: resolve(path),
      kind,
      purpose,
      createdAt: new Date().toISOString()
    })
    this.manifestData.updatedAt = new Date().toISOString()
  }

  /* ------------------------------ 登记 ------------------------------ */

  /**
   * 登记一个本任务产物。
   * @param path 绝对路径
   * @param options.kind 明确类型；不传则按扩展名推断
   * @param options.cleanable 是否允许自动清理（日志 / 报告必须为 false）
   */
  async registerPath(
    path: string,
    options: {
      kind?: TestFileKind | null
      source: string
      owner?: TestArtifactOwner
      cleanable?: boolean
      note?: string
      entry?: 'file' | 'dir'
    }
  ): Promise<TestManifestEntry | null> {
    if (!path) return null
    const abs = resolve(path)
    const key = this.keyOf(abs)
    if (this.registered.has(key)) {
      const existing = this.manifestData.entries.find((e) => this.keyOf(e.path) === key)
      return existing ?? null
    }
    const kind = inferFileKind(abs, options.kind ?? null)
    let entryKind: 'file' | 'dir' = options.entry ?? 'file'
    if (!options.entry) {
      try {
        entryKind = (await fs.stat(abs)).isDirectory() ? 'dir' : 'file'
      } catch {
        entryKind = 'file'
      }
    }
    const entry: TestManifestEntry = {
      path: abs,
      entry: entryKind,
      kind,
      cleanable: options.cleanable ?? !['log', 'report', 'manifest', 'cleanup'].includes(kind),
      source: options.source,
      owner: options.owner ?? 'hf-render-child',
      createdAt: new Date().toISOString(),
      bytes: null,
      ...(options.note ? { note: options.note } : {})
    }
    this.manifestData.entries.push(entry)
    this.manifestData.updatedAt = entry.createdAt
    this.registered.add(key)
    return entry
  }

  /** 更新条目的实测体积（清理前统计用） */
  setEntryBytes(path: string, bytes: number | null): void {
    const key = this.keyOf(path)
    const entry = this.manifestData.entries.find((e) => this.keyOf(e.path) === key)
    if (entry) entry.bytes = bytes
  }

  async setStatus(status: TestTaskStatus): Promise<void> {
    this.manifestData.status = status
    this.manifestData.updatedAt = new Date().toISOString()
    await this.flush()
  }

  /** 移除已删除条目的登记 */
  pruneEntries(paths: string[]): void {
    if (paths.length === 0) return
    const keys = new Set(paths.map((p) => this.keyOf(p)))
    this.manifestData.entries = this.manifestData.entries.filter((e) => !keys.has(this.keyOf(e.path)))
    for (const key of keys) this.registered.delete(key)
    this.manifestData.updatedAt = new Date().toISOString()
  }

  setLastCleanup(summary: TestManifest['lastCleanup']): void {
    this.manifestData.lastCleanup = summary
    this.manifestData.updatedAt = new Date().toISOString()
  }

  /* --------------------------- 子进程沙箱 --------------------------- */

  /**
   * 给子进程的临时目录环境变量。
   *
   * 为什么要覆盖：HyperFrames / Puppeteer 会把 Chrome 用户数据目录、
   * 帧缓存、编码中间文件写到 os.tmpdir()；把 TMP/TEMP/TMPDIR 指向本任务的
   * tmp/ 之后，这些文件全部落在任务目录内，既能登记也能安全清理，
   * 又不会碰到用户的 %TEMP% 里其他软件的文件。
   */
  sandboxEnv(): Record<string, string> {
    return {
      TMP: this.tmpDir,
      TEMP: this.tmpDir,
      TMPDIR: this.tmpDir,
      // 显式提示（非标准变量，仅用于诊断日志），便于确认 Chrome 配置落点
      HF_RENDER_TEST_TMP: this.tmpDir,
      HF_RENDER_TEST_CHROME_DIR: this.chromeProfileDir
    }
  }

  /* ------------------------------ 落盘 ------------------------------ */

  /** 串行写清单，避免并发写坏文件 */
  async flush(): Promise<void> {
    const payload = JSON.stringify(this.manifestData, null, 2)
    const target = this.manifestPath
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(this.root, { recursive: true })
        const tmp = `${target}.tmp`
        await fs.writeFile(tmp, payload, 'utf-8')
        await fs.rename(tmp, target)
      } catch {
        /* 清单写失败不能阻断测试；下一次登记会重试 */
      }
    })
    await this.writeChain
  }

  /** 写本次测试的性能快照（默认长期保留） */
  async writeReport(report: unknown): Promise<string | null> {
    try {
      await fs.mkdir(this.root, { recursive: true })
      await fs.writeFile(this.reportPath, JSON.stringify(report, null, 2), 'utf-8')
      await this.registerPath(this.reportPath, {
        kind: 'report',
        source: 'report',
        owner: 'hf-render',
        cleanable: false,
        note: '本次测试的性能数据，默认长期保留'
      })
      return this.reportPath
    } catch {
      return null
    }
  }
}

/** 解析清单：字段不合法时返回 null（宁可不清理，也不冒险） */
export function parseManifest(raw: string): TestManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const data = parsed as Partial<TestManifest>
  if (data.app !== 'hf-render') return null
  if (typeof data.taskId !== 'string' || !data.taskId) return null
  if (data.schema !== TEST_MANIFEST_SCHEMA) return null
  if (typeof data.outputRoot !== 'string' || !data.outputRoot) return null
  if (!Array.isArray(data.entries) || !Array.isArray(data.roots)) return null
  const roots = data.roots.filter(
    (r): r is TestManifest['roots'][number] => typeof r?.path === 'string' && !!r.path
  )
  const entries = data.entries.filter((e): e is TestManifestEntry => typeof e?.path === 'string' && !!e.path)
  return {
    schema: TEST_MANIFEST_SCHEMA,
    app: 'hf-render',
    taskId: data.taskId,
    taskKind: data.taskKind === 'matrix' ? 'matrix' : 'comparison',
    projectPath: typeof data.projectPath === 'string' ? data.projectPath : '',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    status: normalizeStatus(data.status),
    outputRoot: data.outputRoot,
    logDir: typeof data.logDir === 'string' ? data.logDir : join(data.outputRoot, 'logs'),
    roots,
    entries,
    lastCleanup: data.lastCleanup ?? undefined
  }
}

function normalizeStatus(status: unknown): TestTaskStatus {
  return status === 'done' || status === 'failed' || status === 'canceled' || status === 'running'
    ? status
    : 'running'
}
