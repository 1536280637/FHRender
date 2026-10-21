import { promises as fs } from 'node:fs'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import type { DiskInfo, MemoryInfo } from '@shared/types/hardware'

interface CpuTimes {
  idle: number
  total: number
}

function snapshot(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** 用 os.cpus() 的累计时间差计算真实 CPU 占用，跨平台 */
export function sampleCpuUsage(intervalMs = 300): Promise<number | null> {
  const first = snapshot()
  return new Promise((resolve) => {
    setTimeout(() => {
      const second = snapshot()
      const idleDelta = second.idle - first.idle
      const totalDelta = second.total - first.total
      if (totalDelta <= 0) {
        resolve(null)
        return
      }
      const usage = (1 - idleDelta / totalDelta) * 100
      resolve(Math.min(100, Math.max(0, Number(usage.toFixed(1)))))
    }, intervalMs)
  })
}

/** 磁盘可用空间（Node 18.15+ 的 statfs，跨平台） */
export async function readDiskInfo(targetDir = tmpdir()): Promise<DiskInfo> {
  try {
    const stats = await fs.statfs(targetDir)
    const total = Number(stats.blocks) * Number(stats.bsize)
    const free = Number(stats.bavail) * Number(stats.bsize)
    return {
      tempDir: targetDir,
      tempFreeBytes: Number.isFinite(free) ? free : null,
      tempTotalBytes: Number.isFinite(total) ? total : null
    }
  } catch {
    return { tempDir: targetDir, tempFreeBytes: null, tempTotalBytes: null }
  }
}

export function basicMemoryInfo(renderProcessBytes: number | null = null): MemoryInfo {
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePct: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0,
    renderProcessBytes
  }
}

/**
 * 系统区域设置。
 * 优先用 ICU 解析结果（跨平台且不受 Git Bash 注入的 LANG 影响），
 * 其次回落到环境变量，最后给一个中性值。
 */
export function resolvedLocale(fallback = 'en-US'): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    if (locale) return locale
  } catch {
    // 忽略：ICU 数据缺失时走环境变量
  }
  return process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? fallback
}
