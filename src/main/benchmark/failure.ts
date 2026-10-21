/**
 * 失败分类：把真实原始输出归类成「失败阶段 + 错误类型」，供界面精确定位。
 * 判断只依据 CLI 的原始文本，不在无法判断时瞎猜（归为 unknown 并保留原文）。
 */

import type { ComparisonErrorType, ComparisonFailure, ComparisonStage } from '@shared/types/performance'

interface Rule {
  type: ComparisonErrorType
  pattern: RegExp
  hint: string
}

const RULES: Rule[] = [
  {
    type: 'unsupported-arg',
    pattern: /unknown option|Unknown argument|Unexpected extra argument|unexpected argument|invalid option/i,
    hint: '当前 CLI 版本不支持该参数：请升级 HyperFrames，或在「高级参数」里清掉该选项后重试'
  },
  {
    type: 'command-not-found',
    pattern:
      /ENOENT|not recognized as an internal or external command|command not found|Cannot find module|is not recognized/i,
    hint: '可执行文件或 npm 缓存缺失：确认 Node.js 已安装并在 PATH 中，必要时执行 npm cache clean --force'
  },
  {
    type: 'out-of-memory',
    pattern: /JavaScript heap out of memory|Out of memory|ENOMEM|allocation failed|memory limit/i,
    hint: '内存不足：减少 worker 数量、关闭其他占用大的程序，或改用低内存模式'
  },
  {
    type: 'file-write',
    pattern:
      /ENOSPC|no space left|Disk capture may need|EACCES|EPERM|permission denied|EBUSY|read-only file system/i,
    hint: '磁盘或写入权限问题：更换输出目录 / 临时目录，或清理磁盘空间后重试'
  },
  {
    type: 'chrome',
    pattern:
      /Navigation timeout of \d+ ms exceeded|window\.__hf not ready|page\.goto failed|Failed to launch|browser.*not.*launch|could not find chrome|Target closed|Protocol error|Capture failed/i,
    hint: '渲染浏览器异常：检查是否残留无头浏览器进程、GPU 驱动是否正常；可先把 worker 数降到 1 重试'
  },
  {
    type: 'ffmpeg',
    pattern: /ffmpeg|ffprobe|encoder .* not|Error while opening encoder|Invalid data found when processing input/i,
    hint: 'FFmpeg / 编码器异常：确认 ffmpeg 可用，或把 GPU 编码关掉改用 CPU 编码重试'
  },
  {
    type: 'invalid-project',
    pattern:
      /Composition not found|No composition found|Composition has zero duration|index\.html not found|not a HyperFrames project|Aborting render due to lint issues/i,
    hint: '项目内容不是可渲染的 HyperFrames 合成：确认目录里有 index.html，且根元素带 data-composition-id / data-duration（或存在可推断时长的动画）'  },
  {
    type: 'timeout',
    pattern: /测试超时|timed out after|Timeout of \d+ ?ms exceeded|ETIMEDOUT/i,
    hint: '执行超时：项目可能过大或机器负载过高，先用小项目验证链路，再排查渲染耗时'
  }
]

export function classifyFailure(stage: ComparisonStage, raw: string): ComparisonFailure {
  // ANSI 颜色码是终端装饰，不属于错误信息本身；去掉它不会丢失任何内容，
  // 但能让界面里的 <pre> 和日志文件保持可读。
  const detail = stripAnsi(raw ?? '').trim()
  for (const rule of RULES) {
    if (rule.pattern.test(detail)) {
      return {
        stage,
        errorType: rule.type,
        detail,
        highlight: extractHighlight(detail, rule.pattern),
        hint: rule.hint
      }
    }
  }
  return {
    stage,
    errorType: 'unknown',
    detail: detail || '未获得任何可用的错误输出（进程可能被外部结束）',
    highlight: detail ? extractHighlight(detail, null) : '（CLI 没有输出任何内容）',
    hint: '请打开日志目录查看 stdout / stderr 原始记录，以及该次运行的 runs/*.json'
  }
}

/* eslint-disable no-control-regex */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** 进度条刷屏行（`███░░ 53% Capturing frame 76/112`），不作为错误上下文 */
const PROGRESS_RE = /^[\s█░▓▒|>#*-]*\d{1,3}\s*%/

const LINE_CAP = 400
const HIGHLIGHT_CAP = 1600

/**
 * 摘出关键错误行：
 * - 命中规则时，取命中行 + 其前后少量上下文（跳过进度条刷屏行）；
 * - 没有命中规则时，取最后几行非空内容（CLI 通常把致命错误打在最后）。
 * 只做「定位」，不改变 detail 的完整性。
 */
function extractHighlight(detail: string, pattern: RegExp | null): string {
  const lines = detail.split(/\r?\n/)
  let anchor = -1
  if (pattern) {
    // 命中行可能有好几处（CLI 会把同一错误写进 trace / failure summary / 最终错误块），
    // 取「最短的那条」——长行往往是把错误塞进 JSON 的 trace 记录，短行才是人读的报错。
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line || PROGRESS_RE.test(line)) continue
      pattern.lastIndex = 0
      if (!pattern.test(line)) continue
      if (line.length < best) {
        best = line.length
        anchor = i
      }
    }
  }
  if (anchor < 0) {
    // 取尾部最后 4 行有效内容
    const tailLines: string[] = []
    for (let i = lines.length - 1; i >= 0 && tailLines.length < 4; i -= 1) {
      const line = lines[i].trim()
      if (line && !PROGRESS_RE.test(line)) tailLines.unshift(line)
    }
    return clamp(tailLines.join('\n'), HIGHLIGHT_CAP)
  }

  const picked: string[] = []
  // 命中行的上一行（若是有信息量的上下文）
  const prev = lines[anchor - 1]?.trim()
  if (prev && !PROGRESS_RE.test(prev)) picked.push(prev)
  picked.push(lines[anchor].trim())
  for (let i = anchor + 1; i < lines.length && picked.length < 5; i += 1) {
    const line = lines[i].trim()
    if (!line || PROGRESS_RE.test(line)) continue
    picked.push(line)
  }
  return clamp(picked.map((l) => clamp(l, LINE_CAP)).join('\n'), HIGHLIGHT_CAP)
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断，完整内容见原始输出）` : text
}

/** 依据阶段给出兜底错误类型（当原始输出里没有可识别特征时） */
export function stageFallbackType(stage: ComparisonStage): ComparisonErrorType {
  switch (stage) {
    case 'environment':
    case 'spawn':
      return 'command-not-found'
    case 'project':
      return 'invalid-project'
    case 'args':
      return 'unsupported-arg'
    case 'file':
      return 'file-write'
    case 'render':
      return 'unknown'
    default:
      return 'none'
  }
}
