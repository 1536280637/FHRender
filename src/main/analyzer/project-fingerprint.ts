/**
 * 项目文件指纹。
 *
 * 目的：判断「项目有没有变」时，不去重读所有文件内容，也不每次递归遍历整个目录。
 * - 首次分析时建立清单（相对路径 + 大小 + mtime）；
 * - 之后只用 stat 校验已登记文件（不改内容、不 readdir）；
 * - 新增文件 / 批量变化由文件监听器标记失效（见 project-metadata-cache.ts），
 *   监听失效时才重新建立清单。
 */

import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { cacheCounters } from '../cache/counters'

/** 参与指纹的文件（相对路径统一用 /） */
export interface TrackedFile {
  path: string
  size: number
  mtimeMs: number
}

export interface ProjectFingerprint {
  files: TrackedFile[]
  /** 触达文件上限，清单不完整 */
  truncated: boolean
  totalBytes: number
  collectedAt: string
  /** 目录遍历次数（验收用） */
  dirListings: number
}

export interface FingerprintDiff {
  ok: boolean
  /** 内容/大小/时间戳变化的文件 */
  changed: string[]
  missing: string[]
  verifyMs: number
  stats: number
  /** 变化原因（给界面看） */
  reason: string | null
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'renders',
  'dist',
  'build',
  'out',
  '.hf-segments',
  '.debug',
  'cache',
  '.cache'
])

/** 与素材扫描保持一致的跳过规则；但指纹要覆盖 html / js / css / 配置 */
const DEFAULT_MAX_FILES = 4000
const DEFAULT_MAX_DEPTH = 6

export async function collectProjectFingerprint(
  root: string,
  options: { maxFiles?: number; maxDepth?: number } = {}
): Promise<ProjectFingerprint> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const files: TrackedFile[] = []
  let totalBytes = 0
  let truncated = false
  let dirListings = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || truncated) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
      dirListings += 1
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(join(dir, name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const full = join(dir, name)
      try {
        const stat = await fs.stat(full)
        files.push({
          path: full.slice(root.length).replace(/^[\\/]/, '').split(/[\\/]/).join('/'),
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs)
        })
        totalBytes += stat.size
      } catch {
        /* 读不到就跳过，不阻断分析 */
      }
    }
  }

  await walk(root, 0)
  return { files, truncated, totalBytes, collectedAt: new Date().toISOString(), dirListings }
}

/**
 * 快速校验：只 stat 已登记文件，不读内容、不遍历目录。
 * 返回第一个变化原因即可用于界面说明。
 */
export async function verifyProjectFingerprint(
  root: string,
  fingerprint: ProjectFingerprint
): Promise<FingerprintDiff> {
  const started = Date.now()
  const changed: string[] = []
  const missing: string[] = []
  let stats = 0

  for (const file of fingerprint.files) {
    if (changed.length >= 8 && missing.length >= 8) break
    stats += 1
    cacheCounters.assetFileStats += 1
    const full = join(root, file.path)
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) {
        missing.push(file.path)
        continue
      }
      if (stat.size !== file.size || Math.round(stat.mtimeMs) !== file.mtimeMs) changed.push(file.path)
    } catch {
      missing.push(file.path)
    }
  }

  const ok = changed.length === 0 && missing.length === 0
  const reason = !ok
    ? [
        changed.length > 0 ? `${changed.length} 个文件被修改（如 ${changed[0]}）` : null,
        missing.length > 0 ? `${missing.length} 个文件被删除（如 ${missing[0]}）` : null
      ]
        .filter(Boolean)
        .join('；')
    : null

  return { ok, changed, missing, verifyMs: Date.now() - started, stats, reason }
}

/** 项目里最值得优先跟踪的文件（用于日志 / 提示，不影响命中判定） */
export function hotFiles(fingerprint: ProjectFingerprint): string[] {
  const priority = (path: string): number => {
    if (/^index\.html?$/i.test(path)) return 0
    if (/\.html?$/i.test(path)) return 1
    if (/hyperframes\.json$/i.test(path)) return 2
    if (/package\.json$/i.test(path)) return 3
    if (/\.(js|mjs|cjs|ts)$/i.test(path)) return 4
    if (/\.(css|scss)$/i.test(path)) return 5
    return 6
  }
  return [...fingerprint.files]
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map((f) => f.path)
}

/** 简单扩展名统计，供报告使用 */
export function countByExtension(fingerprint: ProjectFingerprint): Record<string, number> {
  const result: Record<string, number> = {}
  for (const file of fingerprint.files) {
    const ext = extname(file.path).toLowerCase() || '(none)'
    result[ext] = (result[ext] ?? 0) + 1
  }
  return result
}
