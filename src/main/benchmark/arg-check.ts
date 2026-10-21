/**
 * CLI 参数兼容性校验。
 *
 * 目的：当前安装的 HyperFrames 版本支持哪些参数，只以真实 `render --help` 的输出为准。
 * 参数模板里出现一个当前版本不认识的选项，CLI 会直接以
 * "unknown option" 退出，而这类错误在很多情况下不会被当成"渲染失败"显示出来，
 * 表现就是「四种模式全部失败但没有有效错误日志」。
 *
 * 因此所有下发给 CLI 的参数必须在 spawn 之前逐个校验，不通过就直接报告「参数构建」阶段失败，
 * 并把不支持的选项列出来，而不是带着无效参数去启动子进程。
 */

import type { CliCapabilities } from '@shared/types/performance'

export interface ArgValidationIssue {
  flag: string
  reason: string
}

export interface ArgValidationResult {
  ok: boolean
  /** 所有被识别的选项（规范化后） */
  recognized: string[]
  /** 未被当前 CLI 声明支持的选项 */
  unsupported: ArgValidationIssue[]
  /** 通过校验但需要提示的情况（例如通过 --no- 形式反用的选项） */
  warnings: string[]
}

/** 形如 `--flag=value` 的选项名（保留前导 - / --） */
function flagName(token: string): string | null {
  if (!token.startsWith('-')) return null
  if (token === '-' || token === '--') return null
  // 纯负数（例如 -1）不是选项
  if (/^-\d/.test(token)) return null
  return token.replace(/=.*$/, '')
}

/**
 * 判断某个选项是否被 CLI 声明。
 * 兼容三种写法：
 * 1. 直接命中（--gpu）
 * 2. --no-xxx 形式：`--no-browser-gpu` 只要 CLI 声明了 `--browser-gpu` 就算支持
 * 3. `--experimental-fast-capture=false` 归一化为 `--experimental-fast-capture`
 */
function isSupported(flag: string, flags: Set<string>): boolean {
  if (flags.has(flag)) return true
  if (flag.startsWith('--no-')) {
    return flags.has(`--${flag.slice('--no-'.length)}`)
  }
  return false
}

/**
 * 校验参数数组。
 * 只把「看起来是选项」的 token 作为选项校验，选项的取值（路径、数字）跳过。
 */
export function validateRenderArgs(args: string[], cli: CliCapabilities | null): ArgValidationResult {
  const flags = new Set(cli?.render.flags ?? [])
  const recognized: string[] = []
  const unsupported: ArgValidationIssue[] = []
  const warnings: string[] = []

  // CLI 能力探测失败时无法校验，明确说明而不是假装通过
  if (!cli || !cli.render.ok || flags.size === 0) {
    return {
      ok: true,
      recognized: [],
      unsupported: [],
      warnings: [
        '未获得 CLI 参数清单（render --help 探测失败），本次跳过参数兼容性校验；' +
          '若 CLI 报 unknown option，请先修复 CLI 安装或命令配置'
      ]
    }
  }

  for (const token of args) {
    const flag = flagName(token)
    if (!flag) continue
    recognized.push(flag)
    if (isSupported(flag, flags)) {
      if (flag.startsWith('--no-') && !flags.has(flag)) {
        const positive = `--${flag.slice('--no-'.length)}`
        warnings.push(`${flag} 未在帮助中单独列出，已按 ${positive} 的否定形式下发`)
      }
      continue
    }
    unsupported.push({
      flag,
      reason: `当前 CLI（${cli.version ?? '未知版本'}）的 render --help 未声明该选项`
    })
  }

  return { ok: unsupported.length === 0, recognized, unsupported, warnings }
}

/** 把校验失败结果转成一句可直接展示的说明 */
export function describeArgFailure(result: ArgValidationResult): string {
  if (result.unsupported.length === 0) return ''
  return result.unsupported
    .map((item) => `${item.flag}（${item.reason}）`)
    .join('；')
}
