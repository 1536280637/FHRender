/**
 * 性能测试临时文件清理引擎。
 *
 * 生命周期（对应需求「四、自动清理生命周期」）：
 *
 *   测试结束（成功 / 失败 / 取消）
 *     → 等待 CLI / Chrome / FFmpeg 子进程退出
 *     → 扫描任务目录，把未登记但确实位于本任务独占目录内的文件补登记
 *     → 按策略（保留失败现场 / 保留日志报告）决定删除哪些登记条目
 *     → 逐条过安全守卫，再删除（占用 / 权限问题有限次数重试）
 *     → 清理空目录、写 cleanup.json、回传释放空间
 *
 * 硬性约束：
 * - 只处理 performance-tests/<task-id>/ 下、且带有本应用 manifest 的任务目录；
 * - 只删除 manifest 中登记过的条目（包括扫描阶段补登记的）；
 * - 不按文件名通配符批量删除，绝不 rm -rf 整个 performance-tests；
 * - 任何异常都只记录，不抛出——清理失败不能让已经成功的测试结果丢失。
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  ALL_FILE_KINDS,
  PERF_TEST_ROOT_DIRNAME,
  TEST_CLEANUP_FILENAME,
  TEST_MANIFEST_FILENAME,
  TEST_REPORT_FILENAME,
  isCleanableKind
} from '@shared/types/cleanup'
import type {
  CleanupErrorCode,
  TestCleanupBatchResult,
  TestCleanupPolicy,
  TestCleanupSummary,
  TestFileKind,
  TestManifestEntry,
  TestStorageUsage,
  TestTaskStatus,
  TestTaskUsage
} from '@shared/types/cleanup'
import { guardDeletablePath, isInsideOrEqual, normalizeForCompare } from './path-guard'
import { TestWorkspace, perfTestRoot, parseManifest } from './test-workspace'

/** 单次删除最多重试次数（含首次） */
const MAX_DELETE_ATTEMPTS = 3
const RETRY_DELAY_MS = [180, 520, 1200]
/** 遍历保护：避免异常目录结构把清理拖死 */
const MAX_WALK_ENTRIES = 200_000
const MAX_WALK_DEPTH = 20
/** 判定「上次异常退出留下的任务」的阈值 */
const STALE_RUNNING_MS = 20 * 60_000

const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

export interface CleanupEngineOptions {
  /** Electron userData（或测试用临时目录） */
  userDataDir: string
  /** 日志输出（应用控制台用） */
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void
}

export interface CleanupTaskInput {
  workspace: TestWorkspace
  taskStatus: TestTaskStatus
  policy: TestCleanupPolicy
  /** 额外禁止删除的目录：项目根、用户输出目录、userData 等 */
  forbiddenRoots?: (string | null | undefined)[]
  /** 调用方等待子进程退出的耗时（写入清理记录） */
  waitExitMs?: number
}

export interface CleanupBatchInput {
  policy: TestCleanupPolicy
  /** 正在运行的任务 ID（绝不动它） */
  activeTaskId?: string | null
  forbiddenRoots?: (string | null | undefined)[]
  /** true = 只处理上次遗留的任务（启动扫描），false = 处理全部历史任务 */
  onlyStale?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function errorCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : null
}

function classifyErrorCode(code: string | null): CleanupErrorCode {
  if (!code) return 'unknown'
  if (code === 'ENOENT') return 'missing'
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY') {
    return code === 'EBUSY' || code === 'ENOTEMPTY' ? 'locked' : 'permission'
  }
  return 'io'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Measured {
  bytes: number
  files: number
  dirs: number
  /** 达到遍历上限时置 true（此时体积是下限，不是精确值） */
  truncated: boolean
}

/** 统计路径体积（文件 / 目录）；失败不抛出，按已统计部分返回 */
export async function measurePath(target: string): Promise<Measured> {
  const result: Measured = { bytes: 0, files: 0, dirs: 0, truncated: false }
  let stack: { path: string; depth: number }[]
  let first: Awaited<ReturnType<typeof fs.lstat>>
  try {
    first = await fs.lstat(target)
  } catch {
    return result
  }
  if (!first.isDirectory()) {
    result.bytes = first.size
    result.files = 1
    return result
  }
  stack = [{ path: target, depth: 0 }]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > MAX_WALK_DEPTH) continue
    let entries: Dirent[]
    try {
      entries = await fs.readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_WALK_ENTRIES) {
        result.truncated = true
        return result
      }
      const full = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        result.dirs += 1
        stack.push({ path: full, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        result.files += 1
        try {
          result.bytes += (await fs.stat(full)).size
        } catch {
          /* 文件在统计过程中消失：忽略 */
        }
      }
    }
  }
  return result
}

/** 等子进程真正退出（超时后返回 false，由调用方记录，不阻塞清理） */
export async function waitForProcessExit(child: ChildProcess | null, timeoutMs = 8000): Promise<boolean> {
  if (!child) return true
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((done) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      done(ok)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), Math.max(200, timeoutMs))
    child.once('exit', onExit)
  })
}

export class PerformanceTestCleanup {
  readonly userDataDir: string
  private log: (message: string, level?: 'info' | 'warn' | 'error') => void

  constructor(options: CleanupEngineOptions) {
    this.userDataDir = options.userDataDir
    this.log = options.log ?? (() => undefined)
  }

  get root(): string {
    return perfTestRoot(this.userDataDir)
  }

  /* ------------------------------------------------------------------ */
  /* 占用统计                                                             */
  /* ------------------------------------------------------------------ */

  /** 统计 performance-tests 下所有任务目录的占用（只读，不删除任何东西） */
  async usage(activeTaskId?: string | null): Promise<TestStorageUsage> {
    const root = this.root
    const empty: TestStorageUsage = {
      root,
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
    let dirs: string[]
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return empty
    }

    const tasks: TestTaskUsage[] = []
    for (const name of dirs) {
      const taskDir = join(root, name)
      const usage = await this.inspectTask(taskDir, name, activeTaskId ?? null)
      tasks.push(usage)
    }
    tasks.sort((a, b) => b.bytes - a.bytes)
    return {
      root,
      exists: true,
      taskCount: tasks.length,
      ownedTaskCount: tasks.filter((t) => t.owned).length,
      totalBytes: tasks.reduce((sum, t) => sum + t.bytes, 0),
      mediaBytes: tasks.reduce((sum, t) => sum + t.mediaBytes, 0),
      logBytes: tasks.reduce((sum, t) => sum + t.logBytes, 0),
      reportBytes: tasks.reduce((sum, t) => sum + t.reportBytes, 0),
      tasks,
      scannedAt: new Date().toISOString()
    }
  }

  private async inspectTask(
    taskDir: string,
    dirName: string,
    activeTaskId: string | null
  ): Promise<TestTaskUsage> {
    let manifestRaw: string | null = null
    try {
      manifestRaw = await fs.readFile(join(taskDir, TEST_MANIFEST_FILENAME), 'utf-8')
    } catch {
      manifestRaw = null
    }
    const manifest = manifestRaw ? parseManifest(manifestRaw) : null
    const ownTaskDir = manifest && normalizeForCompare(manifest.outputRoot) === normalizeForCompare(taskDir)
    const logDir = manifest?.logDir ?? join(taskDir, 'logs')
    const reportPath = join(taskDir, TEST_REPORT_FILENAME)

    let total = 0
    let media = 0
    let logs = 0
    let reports = 0

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_WALK_DEPTH) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        let size = 0
        try {
          size = (await fs.stat(full)).size
        } catch {
          continue
        }
        total += size
        if (isInsideOrEqual(logDir, full)) logs += size
        else if (normalizeForCompare(full) === normalizeForCompare(reportPath)) reports += size
        else if (/[\\/]cleanup\.json$/i.test(full) || /[\\/]manifest\.json$/i.test(full)) reports += size
        else media += size
      }
    }
    await walk(taskDir, 0)

    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(taskDir)).mtimeMs
    } catch {
      mtimeMs = 0
    }

    const active = !!activeTaskId && (manifest?.taskId === activeTaskId || dirName === activeTaskId)
    return {
      taskId: manifest?.taskId ?? dirName,
      owned: !!ownTaskDir,
      status: manifest?.status ?? 'unknown',
      createdAt: manifest?.createdAt ?? (mtimeMs ? new Date(mtimeMs).toISOString() : null),
      updatedAt: manifest?.updatedAt ?? null,
      bytes: total,
      mediaBytes: media,
      logBytes: logs,
      reportBytes: reports,
      active,
      note: ownTaskDir
        ? active
          ? '当前正在运行的测试，不会被清理'
          : null
        : '没有 HF Render 任务清单，不属于本应用任务，永远不会自动删除'
    }
  }

  /* ------------------------------------------------------------------ */
  /* 单任务清理                                                           */
  /* ------------------------------------------------------------------ */

  async cleanupTask(input: CleanupTaskInput): Promise<TestCleanupSummary> {
    const startedAt = new Date()
    const started = Date.now()
    const { workspace, taskStatus, policy } = input
    const summary: TestCleanupSummary = {
      taskId: workspace.taskId,
      taskStatus,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      waitExitMs: Math.max(0, input.waitExitMs ?? 0),
      deletedFiles: 0,
      freedBytes: 0,
      keptFiles: 0,
      keptBytes: 0,
      failedFiles: 0,
      missingFiles: 0,
      refusedFiles: 0,
      retries: 0,
      totalBytesBefore: 0,
      remainingBytes: 0,
      skipped: false,
      skipReason: null,
      keptLogDir: policy.keepReports ? workspace.logDir : null,
      keptReportFile: policy.keepReports ? workspace.reportPath : null,
      errors: []
    }

    const finish = async (): Promise<TestCleanupSummary> => {
      summary.finishedAt = new Date().toISOString()
      summary.durationMs = Date.now() - started
      try {
        const after = await measurePath(workspace.root)
        summary.remainingBytes = after.bytes
      } catch {
        summary.remainingBytes = 0
      }
      workspace.setLastCleanup(summary)
      await workspace.flush()
      await this.writeCleanupRecord(workspace, summary)
      return summary
    }

    /* ---------------- 0. 策略：是否清理 ---------------- */
    if (taskStatus === 'running') {
      summary.skipped = true
      summary.skipReason = '测试仍在运行，不允许清理'
      return finish()
    }

    // 清单里的状态必须反映真实结果：启动扫描会把「异常退出遗留」的 running 纠正为 canceled
    await workspace.setStatus(taskStatus)

    if (!policy.autoClean) {
      summary.skipped = true
      summary.skipReason = '自动清理性能测试文件已关闭（设置项）'
      const measured = await measurePath(workspace.root)
      summary.totalBytesBefore = measured.bytes
      summary.keptFiles = measured.files
      summary.keptBytes = measured.bytes
      return finish()
    }
    if (taskStatus === 'failed' && policy.keepFailed) {
      summary.skipped = true
      summary.skipReason = '已按设置保留失败测试现场（含临时视频，便于进一步调试）'
      const measured = await measurePath(workspace.root)
      summary.totalBytesBefore = measured.bytes
      summary.keptFiles = measured.files
      summary.keptBytes = measured.bytes
      return finish()
    }

    /* ---------------- 1. 收集并补登记任务目录内的产物 ---------------- */
    const forbiddenRoots = [workspace.projectPath, ...(input.forbiddenRoots ?? [])]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .map((p) => resolve(p))

    const preserved = this.preservedPaths(workspace, policy)
    try {
      await this.discover(workspace, preserved)
    } catch (err) {
      summary.errors.push({
        path: workspace.root,
        code: 'io',
        message: `扫描任务目录失败：${errorMessage(err)}`,
        attempts: 1,
        refused: false
      })
    }

    const deletableKinds = new Set<TestFileKind>(ALL_FILE_KINDS.filter((kind) => isCleanableKind(kind)))
    if (!policy.keepReports) {
      deletableKinds.add('log')
      deletableKinds.add('report')
    }

    const entries = [...workspace.manifest.entries]
    const candidates: TestManifestEntry[] = []
    const candidatePaths = new Set<string>()
    for (const entry of entries) {
      const preservedHit = preserved.some((p) => isInsideOrEqual(p, entry.path))
      const kindOk = deletableKinds.has(entry.kind)
      // 清单里显式标了 cleanable=false 的条目（日志 / 报告 / 清单）只有在用户关掉「保留报告」时才放行
      const manifestOk = entry.cleanable !== false || (entry.kind === 'log' || entry.kind === 'report')
      if (preservedHit || !kindOk || !manifestOk) continue
      candidates.push(entry)
      candidatePaths.add(normalizeForCompare(entry.path))
    }

    // 删除顺序：路径更深的先删，保证目录最后清理
    candidates.sort((a, b) => b.path.length - a.path.length)

    const before = await measurePath(workspace.root)
    summary.totalBytesBefore = before.bytes
    for (const entry of candidates) {
      const measured = await measurePath(entry.path)
      entry.bytes = measured.bytes
      workspace.setEntryBytes(entry.path, measured.bytes)
    }
    // 保留部分（日志 / 报告 / 清单 / 清理记录）体积与文件数
    for (const path of preserved) {
      const measured = await measurePath(path)
      summary.keptFiles += measured.files
      summary.keptBytes += measured.bytes
    }

    /* ---------------- 2. 逐条守卫 + 删除（有限重试） ---------------- */
    const removed: string[] = []
    for (const entry of candidates) {
      const verdict = guardDeletablePath(entry.path, { taskRoot: workspace.root, forbiddenRoots })
      if (!verdict.ok) {
        summary.refusedFiles += 1
        summary.errors.push({
          path: entry.path,
          code: 'guard',
          message: `安全守卫拒绝清理：${verdict.reason}`,
          attempts: 0,
          refused: true
        })
        continue
      }
      // 兜底：必须是本任务清单里登记过的条目
      const registered = candidatePaths.has(normalizeForCompare(verdict.path))
      if (!registered) {
        summary.refusedFiles += 1
        summary.errors.push({
          path: entry.path,
          code: 'unregistered',
          message: '条目未登记在本任务清单中，拒绝清理',
          attempts: 0,
          refused: true
        })
        continue
      }

      const outcome = await this.deleteWithRetry(verdict.path, entry.entry === 'dir')
      summary.retries += Math.max(0, outcome.attempts - 1)
      if (outcome.ok) {
        removed.push(entry.path)
        summary.deletedFiles += outcome.files
        summary.freedBytes += outcome.bytes
      } else if (outcome.missing) {
        // 文件已经不在了（子进程自己删掉了 / 上次清理已删）：登记一条记录，不当作失败
        removed.push(entry.path)
        summary.missingFiles += 1
        summary.errors.push({
          path: entry.path,
          code: 'missing',
          message: '删除时文件已不存在（可能已被子进程或上次清理删除）',
          attempts: outcome.attempts,
          refused: false
        })
      } else {
        summary.failedFiles += 1
        summary.errors.push({
          path: entry.path,
          code: classifyErrorCode(outcome.code),
          message: outcome.message,
          attempts: outcome.attempts,
          refused: false
        })
      }
    }

    workspace.pruneEntries(removed)

    /* ---------------- 3. 清理空目录（不含日志目录） ---------------- */
    await this.pruneEmptyDirs(workspace.root, preserved)

    return finish()
  }

  /** 保留目录 / 文件（清理时跳过） */
  private preservedPaths(workspace: TestWorkspace, policy: TestCleanupPolicy): string[] {
    const preserved = [workspace.manifestPath, workspace.cleanupPath]
    if (policy.keepReports) {
      preserved.push(workspace.logDir, workspace.reportPath)
    }
    return preserved.map((p) => resolve(p))
  }

  /**
   * 把任务独占目录内「未登记但确实存在」的文件补登记。
   *
   * 说明：这里不是按文件名猜测，而是只在已登记的目录根内部遍历；
   * 遍历到的每个文件都会先写进 manifest（标注 discovered 来源），
   * 之后才可能被删除——满足「拒绝删除未登记的文件」。
   */
  private async discover(workspace: TestWorkspace, preserved: string[]): Promise<void> {
    const roots = workspace.manifest.roots
      .map((r) => resolve(r.path))
      .filter((p) => isInsideOrEqual(workspace.root, p))
    for (const root of roots) {
      let visited = 0
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_WALK_DEPTH || visited > MAX_WALK_ENTRIES) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (visited++ > MAX_WALK_ENTRIES) return
          const full = join(dir, entry.name)
          if (entry.isSymbolicLink()) continue
          if (preserved.some((p) => isInsideOrEqual(p, full))) continue
          if (entry.isDirectory()) {
            await walk(full, depth + 1)
            await workspace.registerPath(full, { source: 'discovered', entry: 'dir' })
          } else if (entry.isFile()) {
            await workspace.registerPath(full, { source: 'discovered', entry: 'file' })
          }
        }
      }
      await walk(root, 0)
    }
    await workspace.flush()
  }

  private async deleteWithRetry(
    target: string,
    isDir: boolean
  ): Promise<{ ok: boolean; missing: boolean; attempts: number; files: number; bytes: number; code: string | null; message: string }> {
    const measured = await measurePath(target)
    let lastCode: string | null = null
    let lastMessage = ''
    for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt += 1) {
      try {
        if (isDir) {
          await fs.rm(target, { recursive: true, force: false, maxRetries: 0 })
        } else {
          await fs.unlink(target)
        }
        return {
          ok: true,
          missing: false,
          attempts: attempt,
          files: Math.max(1, measured.files),
          bytes: measured.bytes,
          code: null,
          message: ''
        }
      } catch (err) {
        const code = errorCode(err)
        lastCode = code
        lastMessage = errorMessage(err)
        if (code === 'ENOENT') {
          return { ok: false, missing: true, attempts: attempt, files: 0, bytes: 0, code, message: lastMessage }
        }
        // 只对「被占用 / 权限 / 非空」这类可能自行恢复的错误重试
        if (!LOCKED_CODES.has(code ?? '') || attempt === MAX_DELETE_ATTEMPTS) break
        await sleep(RETRY_DELAY_MS[Math.min(attempt - 1, RETRY_DELAY_MS.length - 1)])
      }
    }
    return {
      ok: false,
      missing: false,
      attempts: MAX_DELETE_ATTEMPTS,
      files: 0,
      bytes: 0,
      code: lastCode,
      message: lastMessage || '删除失败'
    }
  }

  /** 自底向上清掉空目录（保留日志目录与任务根） */
  private async pruneEmptyDirs(taskRoot: string, preserved: string[]): Promise<void> {
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (depth > MAX_WALK_DEPTH) return false
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return false
      }
      let remaining = 0
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (preserved.some((p) => isInsideOrEqual(p, full) || isInsideOrEqual(full, p))) {
            remaining += 1
            continue
          }
          const empty = await walk(full, depth + 1)
          if (empty) continue
          remaining += 1
        } else {
          remaining += 1
        }
      }
      if (remaining === 0 && normalizeForCompare(dir) !== normalizeForCompare(taskRoot)) {
        try {
          await fs.rmdir(dir)
          return true
        } catch {
          return false
        }
      }
      return false
    }
    await walk(taskRoot, 0)
  }

  /** 写 cleanup.json（长期保留的清理记录） */
  private async writeCleanupRecord(workspace: TestWorkspace, summary: TestCleanupSummary): Promise<void> {
    try {
      const payload = {
        ...summary,
        errors: summary.errors.slice(0, 200),
        note: '由 HF Render 自动生成：记录本次测试清理掉了哪些临时文件、保留了哪些日志与报告、哪些因占用失败'
      }
      await fs.writeFile(workspace.cleanupPath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      /* 记录失败不影响清理结果 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 批量 / 启动扫描                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 批量清理历史任务。
   *
   * @param input.onlyStale true = 仅处理「上次异常退出遗留」的任务（启动扫描）；
   *                        false = 用户点「立即清理历史临时文件」，处理全部历史任务。
   */
  async cleanupHistory(input: CleanupBatchInput): Promise<TestCleanupBatchResult> {
    const startedAt = new Date().toISOString()
    const result: TestCleanupBatchResult = {
      ok: true,
      freedBytes: 0,
      deletedFiles: 0,
      cleanedTasks: [],
      keptTasks: [],
      failedTasks: [],
      skippedTasks: [],
      errors: [],
      usage: this.emptyUsage(),
      startedAt,
      finishedAt: startedAt
    }

    // 启动扫描同样尊重「自动清理」开关：用户关掉后不再删除任何文件
    if (!input.policy.autoClean) {
      result.skipped = true
      result.skipReason = '自动清理已关闭，本次未删除任何文件'
      result.usage = await this.usage(input.activeTaskId ?? null)
      result.finishedAt = new Date().toISOString()
      return result
    }

    let dirs: string[]
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true })
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      result.finishedAt = new Date().toISOString()
      return result
    }

    for (const name of dirs) {
      const taskDir = join(this.root, name)
      if (input.activeTaskId && name === input.activeTaskId) {
        result.keptTasks.push(name)
        continue
      }
      const workspace = await TestWorkspace.open(taskDir)
      if (!workspace) {
        // 没有本应用清单：不是我们的任务目录，永不触碰
        result.skippedTasks.push(name)
        continue
      }
      if (workspace.manifest.status === 'running') {
        const stale = await this.isStale(taskDir)
        if (!stale) {
          result.keptTasks.push(workspace.taskId)
          continue
        }
        // 遗留的 running 状态：按「用户取消」处理
        this.log(`发现上次异常退出遗留的测试任务 ${workspace.taskId}，按取消处理并清理`, 'warn')
      }
      if (input.onlyStale && !(await this.needsCleanup(workspace))) {
        result.keptTasks.push(workspace.taskId)
        continue
      }

      const summary = await this.cleanupTask({
        workspace,
        taskStatus: workspace.manifest.status === 'running' ? 'canceled' : workspace.manifest.status,
        policy: input.policy,
        forbiddenRoots: input.forbiddenRoots
      })
      result.freedBytes += summary.freedBytes
      result.deletedFiles += summary.deletedFiles
      result.errors.push(...summary.errors)
      if (summary.failedFiles > 0) result.failedTasks.push(workspace.taskId)
      else if (summary.deletedFiles > 0) result.cleanedTasks.push(workspace.taskId)
      else result.keptTasks.push(workspace.taskId)
    }

    result.usage = await this.usage(input.activeTaskId ?? null)
    result.finishedAt = new Date().toISOString()
    result.ok = result.failedTasks.length === 0
    return result
  }

  /** 启动扫描：只处理遗留 / 未清理成功的任务 */
  async startupScan(input: Omit<CleanupBatchInput, 'onlyStale'>): Promise<TestCleanupBatchResult> {
    return this.cleanupHistory({ ...input, onlyStale: true })
  }

  private async isStale(taskDir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(taskDir)
      return Date.now() - stat.mtimeMs > STALE_RUNNING_MS
    } catch {
      return true
    }
  }

  /** 该任务是否还有需要清理的大型临时产物 */
  private async needsCleanup(workspace: TestWorkspace): Promise<boolean> {
    if (workspace.manifest.status === 'running') return true
    const summary = workspace.manifest.lastCleanup
    if (!summary) return true
    if (summary.skipped || summary.failedFiles > 0) return true
    // 清理成功过：只有又冒出新的媒体文件（例如崩溃前的半成品）才需要再扫
    return (await this.mediaBytesOf(workspace)) > 0
  }

  private async mediaBytesOf(workspace: TestWorkspace): Promise<number> {
    // 直接按目录结构分类统计（日志 / 报告 / 媒体分开），避免父目录与子文件重复计数
    const usage = await this.inspectTask(workspace.root, workspace.taskId, null)
    return usage.mediaBytes
  }

  private emptyUsage(): TestStorageUsage {
    const root = this.root
    return {
      root,
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
  }

  /** 供界面显示：performance-tests 根目录路径（只读） */
  get rootDirName(): string {
    return PERF_TEST_ROOT_DIRNAME
  }

  /** 任务目录（便于界面「打开目录」） */
  taskDir(taskId: string): string {
    return join(this.root, taskId)
  }

  /** 清理记录文件路径 */
  cleanupRecordPath(taskId: string): string {
    return join(this.taskDir(taskId), TEST_CLEANUP_FILENAME)
  }

  /** 报告文件路径 */
  reportPath(taskId: string): string {
    return join(this.taskDir(taskId), TEST_REPORT_FILENAME)
  }
}
