/**
 * 运行环境快照：主进程（Electron）里的 PATH / node / npx 与终端里可能是两套。
 * 把真实解析结果写进日志，才能在「PowerShell 能跑、Electron 跑不了」时定位差异。
 */

import { existsSync } from 'node:fs'
import { findExecutable, findNodeExecutable, parseCliCommand, resolveNpmCliJs } from '../process/hyperframes'

export interface CliEnvironmentSnapshot {
  nodeVersion: string
  electronVersion: string | null
  platform: string
  arch: string
  /** 从设置里解析出的 CLI 命令 token */
  tokens: string[]
  /** 第一个 token 的真实解析路径（找不到为 null） */
  resolvedBin: string | null
  /** 实际会执行的 node.exe */
  nodePath: string | null
  /** npx / npm 的 cli js（Windows 上真正执行的是它） */
  npmCliJs: string | null
  /** PATH 条目数量与其中包含 nodejs 的条目 */
  pathEntries: number
  nodePathEntries: string[]
  cwd: string
}

export async function describeCliEnvironment(cliCommand: string): Promise<CliEnvironmentSnapshot> {
  const tokens = parseCliCommand(cliCommand || 'npx --yes hyperframes@latest')
  const bin = tokens[0] ?? 'npx'
  const resolvedBin = findExecutable(bin)
  const npmCliJs = resolvedBin ? await resolveNpmCliJs(resolvedBin) : null
  const pathEntries = (process.env.PATH ?? '').split(';').filter(Boolean)
  const nodePathEntries = pathEntries.filter((entry) => /nodejs|node\\?$/i.test(entry))

  return {
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? null,
    platform: process.platform,
    arch: process.arch,
    tokens,
    resolvedBin: resolvedBin && existsSync(resolvedBin) ? resolvedBin : null,
    nodePath: findNodeExecutable(),
    npmCliJs,
    pathEntries: pathEntries.length,
    nodePathEntries,
    cwd: process.cwd()
  }
}
