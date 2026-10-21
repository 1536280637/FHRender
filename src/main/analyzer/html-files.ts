import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cacheCounters } from '../cache/counters'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  'renders',
  'dist',
  'build',
  '.hyperframes',
  '.debug'
])

/**
 * 列出项目内的 html 文件（相对路径，正斜杠，index.html 排第一）。
 * 供「composition 选择器」和「项目元数据分析」共用，避免两处各扫一遍目录。
 */
export async function listHtmlFiles(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
      cacheCounters.dirListings += 1
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (/\.html?$/i.test(entry.name)) {
        const rel = full.slice(root.length).replace(/^[\\/]/, '')
        found.push(rel.split(/[\\/]/).join('/'))
      }
    }
  }

  await walk(root, 1)
  return found.sort((a, b) => {
    if (a === 'index.html') return -1
    if (b === 'index.html') return 1
    return a.localeCompare(b)
  })
}
