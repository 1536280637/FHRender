import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 缓存文件读写的公共实现。
 *
 * 约束：
 * - 全部落在 Electron userData 下，只读写缓存文件，绝不触碰用户项目目录；
 * - 缓存损坏（JSON 截断、字段类型不对）时把坏文件改名存档并当作「无缓存」，
 *   让上层重新检测，而不是让应用启动失败；
 * - 写入使用临时文件 + rename，避免半截文件。
 */

export function userDataDir(): string {
  return app.getPath('userData')
}

export function profilesDir(): string {
  return join(userDataDir(), 'profiles')
}

export function projectMetadataDir(): string {
  return join(userDataDir(), 'project-metadata')
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    // 缓存损坏：留档一份便于排查，然后由上层重建
    const backup = `${file}.corrupt-${Date.now()}`
    await fs.rename(file, backup).catch(() => undefined)
    return null
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<boolean> {
  try {
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
    await fs.rename(tmp, file)
    return true
  } catch {
    // 缓存写失败不影响功能：下次重新检测即可
    return false
  }
}

export async function removeFiles(files: string[]): Promise<string[]> {
  const removed: string[] = []
  for (const file of files) {
    try {
      await fs.rm(file, { force: true })
      removed.push(file)
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** 目录占用（只统计一层 + 子目录里的 json），失败按 0 计 */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else {
        try {
          total += (await fs.stat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(dir, 0)
  return total
}

/** 项目路径 -> 缓存文件名（可读前缀 + 路径哈希，避免不同项目互相覆盖） */
export function projectCacheFileName(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath)
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12)
  const tail = normalized.split('/').filter(Boolean).pop() ?? 'project'
  const safe = tail.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40) || 'project'
  return `${safe}-${hash}.json`
}

/** 统一的项目路径规范化：正斜杠、去尾斜杠、Windows 下小写用于比较 */
export function normalizeProjectPath(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function sameProjectPath(a: string, b: string): boolean {
  return normalizeProjectPath(a) === normalizeProjectPath(b)
}

export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

export function isExpired(checkedAt: string | null | undefined, ttlHours: number): boolean {
  if (!checkedAt) return true
  const time = Date.parse(checkedAt)
  if (!Number.isFinite(time)) return true
  return Date.now() - time > ttlHours * 3600_000
}

export function expiresAtOf(checkedAt: string | null, ttlHours: number): string | null {
  if (!checkedAt) return null
  const time = Date.parse(checkedAt)
  if (!Number.isFinite(time)) return null
  return new Date(time + ttlHours * 3600_000).toISOString()
}
