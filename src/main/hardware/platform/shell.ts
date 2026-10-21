import { existsSync } from 'node:fs'
import { runProcess } from '../../process/hyperframes'

export interface ShellResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  error?: string
  ms: number
}

/** 执行一个可执行文件（参数数组，不经过 shell） */
export async function runBinary(
  file: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ShellResult> {
  const started = Date.now()
  const res = await runProcess(file, args, {
    timeoutMs: options.timeoutMs ?? 20_000,
    cwd: options.cwd
  })
  return {
    ok: res.code === 0 && !res.error,
    stdout: res.stdout,
    stderr: res.stderr,
    code: res.code,
    error: res.error ?? (res.timedOut ? '执行超时' : undefined),
    ms: Date.now() - started
  }
}

let cachedPowerShell: string | null | undefined

/** 找到 PowerShell 可执行文件（Windows） */
export function findPowerShell(): string | null {
  if (cachedPowerShell !== undefined) return cachedPowerShell
  const candidates = [
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    'powershell.exe',
    'powershell'
  ]
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue
    cachedPowerShell = candidate
    return candidate
  }
  cachedPowerShell = null
  return null
}

/**
 * 强制 PowerShell 用 UTF-8 写 stdout。
 * 默认情况下 PowerShell 5.1 按控制台代码页（简体中文系统为 936/GBK）输出，
 * 主进程按 UTF-8 解码会得到乱码（例如 "专业版" → "רҵ��"）。
 */
const UTF8_PREAMBLE =
  '$OutputEncoding=[System.Text.Encoding]::UTF8;' +
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'

/**
 * 执行 PowerShell 脚本。
 * 脚本内容全部来自本应用内置常量，不拼接任何用户输入。
 */
export async function runPowerShell(script: string, timeoutMs = 25_000): Promise<ShellResult> {
  const ps = findPowerShell()
  if (!ps) {
    return { ok: false, stdout: '', stderr: '', code: null, error: '未找到 PowerShell', ms: 0 }
  }
  return runBinary(
    ps,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', UTF8_PREAMBLE + script],
    { timeoutMs }
  )
}

/** 解析数字；空值 / N/A 返回 null */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /^\[?n\/?a\]?$/i.test(trimmed)) return null
  const parsed = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** 解析 "6144 MiB" / "12.7 GB" / "1024 KB" 这类带单位的文本为字节 */
export function parseSizeToBytes(text: string | undefined | null): number | null {
  if (!text) return null
  const match = text.trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i)
  if (!match) return null
  const value = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const unit = match[2].toUpperCase()
  const factors: Record<string, number> = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4
  }
  return Math.round(value * (factors[unit] ?? 1))
}

export function parseJson<T>(text: string): T | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // 输出里可能混有警告行，截取首尾大括号再试一次
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T
    } catch {
      return null
    }
  }
}
