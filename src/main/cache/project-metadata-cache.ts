import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { ProjectCacheStatus } from '@shared/types/cache'
import type { ProjectMetadata } from '@shared/types/project'
import type { WorkloadProfile } from '@shared/types/performance'
import type { ProjectFingerprint } from '../analyzer/project-fingerprint'
import { verifyProjectFingerprint, type FingerprintDiff } from '../analyzer/project-fingerprint'
import {
  expiresAtOf,
  normalizeProjectPath,
  projectCacheFileName,
  projectMetadataDir,
  readJsonFile,
  removeFiles,
  writeJsonFile
} from './cache-io'

/**
 * 项目元数据缓存。
 *
 * 每个项目一个文件：`<userData>/project-metadata/<名称>-<路径哈希>.json`，
 * 不同项目互不覆盖。缓存了元数据、负载分析结果与文件指纹。
 *
 * 命中条件（全部满足）：
 * 1. 缓存文件存在且可解析；
 * 2. 分析的 composition 与当前选择一致；
 * 3. 记录的 CLI 版本与当前一致；
 * 4. 指纹校验通过（只 stat 已登记文件，不读内容、不遍历目录）；
 * 5. 文件监听器没有报告「有新增/批量变化」。
 */

const VERSION = 1
/** 元数据本身的软过期时间：硬件/项目都没变时依然可用，只用于界面提示「很久没查了」 */
const SOFT_TTL_HOURS = 24 * 7

/** 文件监听时需要忽略的目录（渲染产物 / 依赖 / CLI 运行时） */
const WATCH_SKIP = new Set([
  'renders',
  'node_modules',
  'dist',
  'build',
  'out',
  'cache',
  'performance-tests'
])

export interface ProjectCacheRecord {
  version: number
  projectPath: string
  projectName: string
  /** 分析时使用的 composition（文件相对路径或 id），用于判断是否需要重算 */
  compositionKey: string | null
  cliVersion: string | null
  analyzedAt: string
  metadata: ProjectMetadata
  workload: WorkloadProfile
  fingerprint: ProjectFingerprint
  /** 分析时使用的导出 FPS */
  exportFps: number | null
  /** 项目内 html 文件列表（供 composition 选择器复用，避免再次遍历） */
  entryFiles: string[]
  /** 最近一次指纹校验耗时 / stat 次数 */
  verifyMs: number | null
  stats: number
}

export interface ProjectCacheLookup {
  record: ProjectCacheRecord | null
  fromCache: boolean
  reason: string
  verifyMs: number
  diff: FingerprintDiff | null
}

export class ProjectMetadataCache {
  private watcher: FSWatcher | null = null
  private watchedPath: string | null = null
  private dirty = new Set<string>()
  private debounceTimer: NodeJS.Timeout | null = null
  private onDirty: ((projectPath: string, reason: string) => void) | null = null
  /** 最近一次指纹校验的真实耗时（不落盘，避免为了展示一行数字反复写文件） */
  private lastVerify = new Map<string, number>()

  get dir(): string {
    return projectMetadataDir()
  }

  fileOf(projectPath: string): string {
    return join(this.dir, projectCacheFileName(projectPath))
  }

  /**
   * 查询缓存。
   * `force` 为 true 时跳过所有判断，直接返回 null 让上层重新分析。
   */
  async lookup(input: {
    projectPath: string
    composition?: string | null
    cliVersion?: string | null
    force?: boolean
  }): Promise<ProjectCacheLookup> {
    if (input.force) {
      return { record: null, fromCache: false, reason: '用户要求重新分析', verifyMs: 0, diff: null }
    }
    const raw = await readJsonFile<ProjectCacheRecord>(this.fileOf(input.projectPath))
    if (!raw || raw.version !== VERSION) {
      return { record: null, fromCache: false, reason: '还没有这个项目的缓存', verifyMs: 0, diff: null }
    }
    if (normalizeProjectPath(raw.projectPath) !== normalizeProjectPath(input.projectPath)) {
      return { record: null, fromCache: false, reason: '缓存路径不匹配', verifyMs: 0, diff: null }
    }

    const compositionKey = (input.composition ?? '').trim() || null
    if ((raw.compositionKey ?? null) !== compositionKey) {
      return {
        record: null,
        fromCache: false,
        reason: `渲染入口变化（缓存：${raw.compositionKey ?? '默认'}）`,
        verifyMs: 0,
        diff: null
      }
    }

    if (input.cliVersion && raw.cliVersion && input.cliVersion !== raw.cliVersion) {
      return {
        record: null,
        fromCache: false,
        reason: `HyperFrames CLI 版本变化（${raw.cliVersion} → ${input.cliVersion}）`,
        verifyMs: 0,
        diff: null
      }
    }

    // 监听器报告过变化：直接重算，不再依赖 stat
    if (this.dirty.has(normalizeProjectPath(input.projectPath))) {
      return { record: null, fromCache: false, reason: '文件监听器检测到项目变化', verifyMs: 0, diff: null }
    }

    // 项目目录整体消失：缓存失效
    try {
      await fs.access(input.projectPath)
    } catch {
      return { record: null, fromCache: false, reason: '项目目录不存在', verifyMs: 0, diff: null }
    }

    const diff = await verifyProjectFingerprint(input.projectPath, raw.fingerprint)
    if (!diff.ok) {
      return {
        record: null,
        fromCache: false,
        reason: diff.reason ?? '项目文件发生变化',
        verifyMs: diff.verifyMs,
        diff
      }
    }

    this.dirty.delete(normalizeProjectPath(input.projectPath))
    raw.verifyMs = diff.verifyMs
    raw.stats = diff.stats
    this.lastVerify.set(normalizeProjectPath(input.projectPath), diff.verifyMs)
    return { record: raw, fromCache: true, reason: '缓存有效（文件指纹未变化）', verifyMs: diff.verifyMs, diff }
  }

  async save(record: Omit<ProjectCacheRecord, 'version'>): Promise<ProjectCacheRecord> {
    const full: ProjectCacheRecord = { ...record, version: VERSION }
    await writeJsonFile(this.fileOf(record.projectPath), full)
    this.dirty.delete(normalizeProjectPath(record.projectPath))
    return full
  }

  /** 仅更新分析时间等轻量字段（例如导出 FPS 变了但项目没变） */
  async touch(projectPath: string, patch: Partial<ProjectCacheRecord>): Promise<void> {
    const raw = await readJsonFile<ProjectCacheRecord>(this.fileOf(projectPath))
    if (!raw) return
    await writeJsonFile(this.fileOf(projectPath), { ...raw, ...patch, version: VERSION })
  }

  invalidate(projectPath: string, reason = '手动失效'): void {
    this.dirty.add(normalizeProjectPath(projectPath))
    this.onDirty?.(projectPath, reason)
  }

  async remove(projectPath: string): Promise<string[]> {
    this.dirty.delete(normalizeProjectPath(projectPath))
    return removeFiles([this.fileOf(projectPath)])
  }

  /**
   * 监听当前项目：只用于「有新增文件 / 批量变化」这类纯 stat 发现不了的情况。
   * 防抖 1.2 秒，事件本身不会触发重新分析，只标记 dirty，等下一次读取时判定。
   */
  watchProject(projectPath: string, onDirty?: (projectPath: string, reason: string) => void): void {
    if (onDirty) this.onDirty = onDirty
    const normalized = normalizeProjectPath(projectPath)
    if (this.watchedPath === normalized && this.watcher) return
    this.unwatch()
    this.watchedPath = normalized
    try {
      this.watcher = watch(projectPath, { recursive: true, persistent: false }, (_event, filename) => {
        const name = String(filename ?? '')
        // 只有「项目内容」变化才算失效：
        // - 渲染产物目录（renders / out / dist ...）
        // - CLI 自己的运行时目录（.hyperframes / .hf-segments / .debug ...）
        // - 依赖目录
        // 否则一次渲染就会把自己刚建好的缓存判成失效。
        const segments = name.split(/[\\/]/).filter(Boolean)
        const ignored = segments.some(
          (segment) => segment.startsWith('.') || WATCH_SKIP.has(segment.toLowerCase())
        )
        if (ignored) return
        this.scheduleDirty(projectPath, name || '文件变化')
      })
      this.watcher.on('error', () => {
        // 监听不可用（目录被删除 / 超出手柄限制）时静默降级为纯指纹校验
        this.unwatch()
      })
    } catch {
      this.watcher = null
    }
  }

  private scheduleDirty(projectPath: string, name: string): void {
    this.dirty.add(normalizeProjectPath(projectPath))
    const reason = `文件监听：${name}`
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.onDirty?.(projectPath, reason)
    }, 1200)
    this.debounceTimer.unref?.()
  }

  unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
    this.watchedPath = null
  }

  async status(projectPath?: string | null): Promise<ProjectCacheStatus | null> {
    if (!projectPath) return null
    const raw = await readJsonFile<ProjectCacheRecord>(this.fileOf(projectPath))
    if (!raw) {
      return {
        available: false,
        checkedAt: null,
        file: this.fileOf(projectPath),
        expiresAt: null,
        staleReason: '还没有这个项目的分析缓存',
        key: null,
        projectPath,
        projectName: null,
        compositionId: null,
        cliVersion: null,
        trackedFiles: 0,
        verifyMs: null
      }
    }
    return {
      available: true,
      checkedAt: raw.analyzedAt,
      file: this.fileOf(projectPath),
      expiresAt: expiresAtOf(raw.analyzedAt, SOFT_TTL_HOURS),
      staleReason: null,
      key: `${raw.projectName}@${raw.cliVersion ?? 'unknown'}`,
      projectPath: raw.projectPath,
      projectName: raw.projectName,
      compositionId: raw.metadata.compositionId,
      cliVersion: raw.cliVersion,
      trackedFiles: raw.fingerprint.files.length,
      verifyMs: this.lastVerify.get(normalizeProjectPath(projectPath)) ?? raw.verifyMs ?? null
    }
  }

  async bytes(): Promise<number> {
    let total = 0
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        try {
          total += (await fs.stat(join(this.dir, entry.name))).size
        } catch {
          /* ignore */
        }
      }
    } catch {
      return 0
    }
    return total
  }

  async clear(): Promise<string[]> {
    this.unwatch()
    this.dirty.clear()
    const files: string[] = []
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(join(this.dir, entry.name))
      }
    } catch {
      return []
    }
    return removeFiles(files)
  }
}
