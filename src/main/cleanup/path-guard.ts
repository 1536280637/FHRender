/**
 * 清理安全守卫：所有删除动作都必须先通过这里。
 *
 * 规则（逐条对应需求「五、安全保护」）：
 * 1. 规范化绝对路径（resolve + 统一分隔符 + Windows 小写比较）；
 * 2. 必须位于当前任务的临时根目录内部；
 * 3. 拒绝删除项目根目录及其上级目录、用户正式输出目录、依赖目录、公共 Chrome 数据目录；
 * 4. 拒绝文件系统根、userData 根、performance-tests 根、任务根本身；
 * 5. 拒绝任何 `..` 段（防路径穿越），规范化后仍越界的一样拒绝。
 *
 * 这里只做判断，不做删除；删除逻辑在 cleanup-engine.ts。
 */

import { isAbsolute, normalize, parse, resolve, sep } from 'node:path'

export type GuardCode =
  | 'ok'
  | 'empty'
  | 'not-absolute'
  | 'traversal'
  | 'filesystem-root'
  | 'outside-task'
  | 'task-root'
  | 'forbidden-root'
  | 'protected-segment'

export interface GuardVerdict {
  ok: boolean
  code: GuardCode
  /** 人读原因（拒绝时用于日志与界面） */
  reason: string
  /** 规范化后的绝对路径（使用系统分隔符） */
  path: string
}

export interface GuardOptions {
  /** 当前任务的临时根目录（绝对路径） */
  taskRoot: string
  /** 额外禁止的目录：项目根、用户输出目录、userData 等 */
  forbiddenRoots?: (string | null | undefined)[]
  /** 仅当确认任务目录内只剩本任务产物时，才允许删除任务根本身 */
  allowTaskRoot?: boolean
}

/** 依赖 / 版本库目录：永远不属于测试临时文件 */
const PROTECTED_SEGMENTS = ['node_modules', '.git', '.hg', '.svn']

/** 规范化路径用于比较：正斜杠、无尾斜杠、Windows 小写 */
export function normalizeForCompare(input: string): string {
  const unified = normalize(resolve(input)).split(sep).join('/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 判断 child 是否严格位于 parent 内部（不含相等） */
export function isStrictlyInside(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent)
  const c = normalizeForCompare(child)
  if (!p || !c) return false
  if (c === p) return false
  return c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/** 判断 child 是否等于 parent 或位于其内部 */
export function isInsideOrEqual(parent: string, child: string): boolean {
  return normalizeForCompare(parent) === normalizeForCompare(child) || isStrictlyInside(parent, child)
}

/** 判断 candidate 是否是 root 的上级（candidate 包含 root） */
export function isAncestorOf(candidate: string, root: string): boolean {
  return isStrictlyInside(candidate, root)
}

function hasTraversalSegment(input: string): boolean {
  // 用原始输入判断：resolve 会把 ".." 吃掉，安全判定必须看用户/清单给的原文
  return input.split(/[\\/]+/).some((segment) => segment === '..')
}

function hasProtectedSegment(input: string): string | null {
  const segments = input.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean)
  for (const segment of segments) {
    const lower = process.platform === 'win32' ? segment.toLowerCase() : segment
    if (PROTECTED_SEGMENTS.includes(lower)) return segment
  }
  return null
}

/** 文件系统根（"/" 或 "C:\"） */
function isFilesystemRoot(input: string): boolean {
  const normalized = normalize(resolve(input))
  return parse(normalized).root === normalized
}

/**
 * 判定一个路径是否允许被清理。
 *
 * 注意：`ok: true` 只代表「路径层面安全」，是否登记在 manifest 里由调用方再校验一次。
 */
export function guardDeletablePath(rawPath: string, options: GuardOptions): GuardVerdict {
  const reject = (code: GuardCode, reason: string, path = rawPath): GuardVerdict => ({
    ok: false,
    code,
    reason,
    path
  })

  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return reject('empty', '路径为空')
  }
  const raw = rawPath.trim()
  if (!isAbsolute(raw)) {
    return reject('not-absolute', '不是绝对路径，拒绝清理')
  }
  if (hasTraversalSegment(raw)) {
    return reject('traversal', '路径包含 ".." 段，疑似路径穿越，拒绝清理')
  }
  if (isFilesystemRoot(raw)) {
    return reject('filesystem-root', '路径是文件系统根目录，拒绝清理')
  }

  const normalized = resolve(raw)
  const taskRoot = resolve(options.taskRoot)

  const protectedSegment = hasProtectedSegment(raw)
  if (protectedSegment) {
    return reject('protected-segment', `路径包含受保护的依赖目录「${protectedSegment}」`, normalized)
  }

  // 任务根（及其上级）一律不许作为“文件”删除；只有 allowTaskRoot 时才放行任务根本身
  if (!options.allowTaskRoot && !isStrictlyInside(taskRoot, normalized)) {
    if (normalizeForCompare(normalized) === normalizeForCompare(taskRoot)) {
      return reject('task-root', '拒绝删除任务根目录本身（只清理它内部的本任务产物）', normalized)
    }
    if (isAncestorOf(normalized, taskRoot)) {
      return reject('task-root', '路径是任务根目录的上级，拒绝清理', normalized)
    }
  }
  if (!isInsideOrEqual(taskRoot, normalized)) {
    return reject('outside-task', '路径不在当前测试任务的临时目录内，拒绝清理', normalized)
  }

  for (const forbidden of options.forbiddenRoots ?? []) {
    if (!forbidden || typeof forbidden !== 'string' || forbidden.trim() === '') continue
    const root = resolve(forbidden)
    if (isInsideOrEqual(root, normalized)) {
      return reject('forbidden-root', `路径位于受保护目录「${root}」内，拒绝清理`, normalized)
    }
    if (isAncestorOf(normalized, root)) {
      return reject('forbidden-root', `路径是受保护目录「${root}」的上级，拒绝清理`, normalized)
    }
  }

  return { ok: true, code: 'ok', reason: '', path: normalized }
}
