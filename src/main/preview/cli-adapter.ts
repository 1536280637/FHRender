import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  buildCliInvocation,
  extractErrorMessage,
  killProcessTree,
  runCliCapture,
  stripAnsi
} from '../process/hyperframes'
import type { PreviewCapabilities } from '@shared/types/preview'

/* ------------------------------------------------------------------ */
/* CLI 返回结构                                                        */
/* ------------------------------------------------------------------ */

export interface PreviewLifecycleResult {
  state?: string
  mode?: string
  projectName?: string
  projectDir?: string
  host?: string
  port?: number
  pid?: number
  serverUrl?: string
  studioUrl?: string
  ready?: boolean
  logPath?: string
  sessions?: PreviewLifecycleResult[]
  [key: string]: unknown
}

interface LifecyclePayload {
  schemaVersion?: number
  operation?: string
  ok?: boolean
  error?: string
  result?: PreviewLifecycleResult
}

export interface CliRunResult {
  ok: boolean
  /** 解析出的 JSON 结果 */
  result: PreviewLifecycleResult | null
  /** stdout 原文（未解析出 JSON 时用于报错） */
  raw: string
  /** stderr 原文 */
  stderr: string
  error?: string
  timedOut?: boolean
  /** 面向用户的命令回显 */
  command: string
}

const ALL_CAPABILITIES: PreviewCapabilities = {
  helpAvailable: false,
  background: false,
  noOpen: false,
  json: false,
  status: false,
  stop: false,
  list: false
}

/**
 * 从混合输出里取最后一条合法 JSON。
 * npx 首次运行会先打印 npm 的安装日志，因此不能假定 stdout 只有一行 JSON。
 */
export function parseLifecyclePayload(stdout: string): LifecyclePayload | null {
  const text = stripAnsi(stdout)
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line) as LifecyclePayload
      if (parsed && typeof parsed === 'object' && ('operation' in parsed || 'schemaVersion' in parsed)) {
        return parsed
      }
    } catch {
      /* 继续往前找 */
    }
  }
  // 有些版本会把 JSON 打在同一行日志里，兜底用首尾大括号截取
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as LifecyclePayload
      if (parsed && typeof parsed === 'object' && ('operation' in parsed || 'schemaVersion' in parsed)) {
        return parsed
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 从 `preview --help` 文本里解析真实支持的参数 */
export function parsePreviewCapabilities(helpText: string): PreviewCapabilities {
  const text = stripAnsi(helpText)
  const has = (flag: string): boolean => new RegExp(`(^|[\\s,])${flag}([\\s,=]|$)`, 'm').test(text)
  const caps: PreviewCapabilities = {
    helpAvailable: /\bhyperframes\s+preview\b/i.test(text) || /--background/.test(text),
    background: has('--background'),
    noOpen: has('--no-open'),
    json: has('--json'),
    status: has('--status'),
    stop: has('--stop'),
    list: has('--list')
  }
  return caps
}

export function parseCliVersion(helpText: string): string | null {
  const match = stripAnsi(helpText).match(/\bv?(\d+\.\d+\.\d+)\b/)
  return match ? match[1] : null
}

function summarizeFailure(run: { stdout: string; stderr: string; error?: string; timedOut?: boolean }): string {
  if (run.error) return run.error
  if (run.timedOut) return '调用 HyperFrames CLI 超时'
  const parsed = parseLifecyclePayload(run.stdout)
  if (parsed?.error) return String(parsed.error)
  const message = extractErrorMessage([run.stderr, run.stdout])
  return message || 'HyperFrames CLI 未返回可解析的结果'
}

/* ------------------------------------------------------------------ */
/* 适配器                                                              */
/* ------------------------------------------------------------------ */

/**
 * HyperFrames CLI 的 preview 适配层。
 * - 所有调用都通过参数数组启动子进程，不经过 shell，路径中的中文 / 空格 / & 不会被解释。
 * - 参数支持情况一律以真实 `preview --help` 为准，不对 CLI 版本做假设。
 */
export class PreviewCliAdapter {
  private getCliCommand: () => Promise<string>

  constructor(getCliCommand: () => Promise<string>) {
    this.getCliCommand = getCliCommand
  }

  /** 探测当前 CLI 的 preview 能力 */
  async probe(): Promise<{
    capabilities: PreviewCapabilities
    version: string | null
    helpText: string
    error?: string
  }> {
    const run = await this.run(['preview', '--help'], { timeoutMs: 60_000 })
    const helpText = run.raw.trim() ? run.raw : run.stderr
    if (!run.ok && !helpText.trim()) {
      return { capabilities: { ...ALL_CAPABILITIES }, version: null, helpText, error: run.error }
    }
    const capabilities = parsePreviewCapabilities(helpText)
    if (!capabilities.helpAvailable) {
      return {
        capabilities,
        version: null,
        helpText,
        error: '当前 HyperFrames CLI 不支持 preview 子命令，请升级 HyperFrames 后重试'
      }
    }
    return { capabilities, version: parseCliVersion(helpText), helpText }
  }

  /** 后台启动（推荐） */
  async startBackground(projectPath: string): Promise<CliRunResult> {
    return this.run(['preview', projectPath, '--background', '--no-open', '--json'], {
      timeoutMs: 240_000,
      cwd: projectPath
    })
  }

  async status(projectPath: string): Promise<CliRunResult> {
    return this.run(['preview', projectPath, '--status', '--json'], { timeoutMs: 60_000 })
  }

  async stop(projectPath: string): Promise<CliRunResult> {
    return this.run(['preview', projectPath, '--stop', '--json'], { timeoutMs: 90_000 })
  }

  async list(): Promise<CliRunResult> {
    return this.run(['preview', '--list', '--json'], { timeoutMs: 60_000 })
  }

  /**
   * 前台兜底：旧版 CLI 没有 --background 时，由本应用持有一个前台子进程。
   * 返回的子进程需要调用方负责结束（killProcessTree）。
   */
  async spawnForeground(
    projectPath: string,
    onLine: (line: string) => void
  ): Promise<{ child: ChildProcess | null; display: string; error?: string }> {
    const cliCommand = await this.getCliCommand()
    let invocation
    try {
      invocation = await buildCliInvocation(['preview', projectPath, '--no-open'], cliCommand)
    } catch (err) {
      return { child: null, display: '', error: err instanceof Error ? err.message : String(err) }
    }
    if (!existsSync(projectPath)) {
      return { child: null, display: invocation.display, error: '项目目录不存在' }
    }
    try {
      const child = spawn(invocation.file, invocation.args, {
        cwd: projectPath,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
      const pump = (buf: Buffer): void => {
        for (const line of stripAnsi(buf.toString('utf-8')).split(/\r?\n/)) {
          if (line.trim()) onLine(line)
        }
      }
      child.stdout?.on('data', pump)
      child.stderr?.on('data', pump)
      return { child, display: invocation.display }
    } catch (err) {
      return {
        child: null,
        display: invocation.display,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  killForeground(child: ChildProcess): void {
    killProcessTree(child)
  }

  private async run(
    cliArgs: string[],
    options: { timeoutMs?: number; cwd?: string } = {}
  ): Promise<CliRunResult> {
    const cliCommand = await this.getCliCommand()
    const run = await runCliCapture(cliArgs, cliCommand, {
      timeoutMs: options.timeoutMs,
      cwd: options.cwd
    })
    const payload = parseLifecyclePayload(run.stdout)
    const ok = run.code === 0 && !run.error && !run.timedOut && (payload ? payload.ok !== false : false)
    if (payload && payload.ok === false) {
      return {
        ok: false,
        result: payload.result ?? null,
        raw: run.stdout,
        stderr: run.stderr,
        error: payload.error || 'HyperFrames CLI 返回失败',
        timedOut: run.timedOut,
        command: run.display
      }
    }
    if (payload) {
      return {
        ok: ok || (payload.ok === true && run.code === 0),
        result: payload.result ?? null,
        raw: run.stdout,
        stderr: run.stderr,
        error: run.code === 0 ? undefined : summarizeFailure(run),
        timedOut: run.timedOut,
        command: run.display
      }
    }
    return {
      ok: false,
      result: null,
      raw: run.stdout,
      stderr: run.stderr,
      error: summarizeFailure(run),
      timedOut: run.timedOut,
      command: run.display
    }
  }
}
