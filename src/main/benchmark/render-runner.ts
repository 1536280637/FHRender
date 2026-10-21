/**
 * 单次渲染执行器（性能对比测试的唯一子进程入口）。
 *
 * 为什么单独抽出来：
 * 1. Windows 上真正可执行的是 npx-cli.js（由 node 启动），参数以数组传递，不经过 shell；
 *    buildCliInvocation 本身可能抛错，必须当场捕获，否则 Promise 永远不 settle；
 * 2. 子进程的失败有三种形态：spawn 同步抛错、'error' 事件、'close' 带非零退出码 / 信号，
 *    只 try/catch 同步异常是抓不到后两种的；
 * 3. 所有原始输出都要落盘，不能只回传最后一行。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { RenderRequest } from '@shared/types/render'
import type {
  CliCapabilities,
  ComparisonFailure,
  ComparisonStage,
  OutputFileCheck
} from '@shared/types/performance'
import { buildCliInvocation, buildRenderArgs, killProcessTree, stripAnsi } from '../process/hyperframes'
import type { ComparisonLog } from './comparison-log'
import { describeArgFailure, validateRenderArgs } from './arg-check'
import { classifyFailure } from './failure'
import { verifyOutputFile } from './output-verify'

export interface RenderRunSpec {
  /** 日志分组，例如 'balanced' / 'smoke' */
  group: string
  /** 日志子目录，例如 'run-1'；为空表示直接放在 group 下 */
  subdir?: string
  projectPath: string
  request: RenderRequest
  cliCommand: string
  cli: CliCapabilities | null
  log: ComparisonLog
  timeoutMs: number
  /** 供调用方登记当前子进程，用于「停止测试」 */
  onChild?: (child: ChildProcess | null) => void
  /** 逐行回调（进度解析用） */
  onStdoutLine?: (line: string) => void
  isCanceled?: () => boolean
  /**
   * 任务沙箱环境变量：TMP / TEMP / TMPDIR 指向本次测试的 tmp/，
   * 让 Chrome 用户数据目录、帧缓存、编码中间文件全部落在任务目录内。
   */
  env?: Record<string, string>
  /** 期望产出校验参数 */
  verify?: {
    expectedFps?: number | null
    expectedWidth?: number | null
    expectedHeight?: number | null
    expectedDurationSec?: number | null
    directoryOutput?: boolean
  }
}

export interface RenderRunOutcome {
  status: 'ok' | 'failed' | 'canceled'
  startedAt: string
  endedAt: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  pid: number | null
  command: string
  execFile: string
  execArgs: string[]
  cwd: string
  args: string[]
  outputPath: string
  outputBytes: number | null
  fileCheck: OutputFileCheck | null
  stdoutTail: string
  stderrTail: string
  /** 子进程 'error' 事件的原始内容（没有则为 null） */
  spawnError: string | null
  failure: ComparisonFailure | null
  /** 停止在哪个阶段（成功的运行是 'none'） */
  stage: ComparisonStage
}

function tail(text: string, size = 8000): string {
  return text.length > size ? text.slice(text.length - size) : text
}

/**
 * 执行一次渲染并返回完整诊断。
 * 无论成功、失败、超时、被取消、spawn 抛错，这个 Promise 一定会 settle。
 */
export async function runRenderProcess(spec: RenderRunSpec): Promise<RenderRunOutcome> {
  const startedAt = new Date()
  const started = Date.now()
  const streamKey = spec.subdir ? `${spec.group}/${spec.subdir}` : spec.group

  const base: RenderRunOutcome = {
    status: 'failed',
    startedAt: startedAt.toISOString(),
    endedAt: startedAt.toISOString(),
    durationMs: 0,
    exitCode: null,
    signal: null,
    pid: null,
    command: '',
    execFile: '',
    execArgs: [],
    cwd: spec.projectPath,
    args: [],
    outputPath: '',
    outputBytes: null,
    fileCheck: null,
    stdoutTail: '',
    stderrTail: '',
    spawnError: null,
    failure: null,
    stage: 'none'
  }

  const done = (patch: Partial<RenderRunOutcome>): RenderRunOutcome => {
    const ended = new Date()
    const outcome: RenderRunOutcome = {
      ...base,
      ...patch,
      endedAt: ended.toISOString(),
      durationMs: Date.now() - started,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
      spawnError: spawnError ?? base.spawnError
    }
    if (outcome.failure) outcome.stage = outcome.failure.stage
    return outcome
  }

  /* ---------------- 1. 参数构建 + 兼容性校验 ---------------- */

  let stdout = ''
  let stderr = ''
  /** 子进程 'error' 事件内容（例如 ENOENT / EACCES） */
  let spawnError: string | null = null
  let args: string[] = []
  let outputPath = ''

  try {
    const built = buildRenderArgs(spec.request, spec.cli ?? undefined)
    args = built.args
    outputPath = built.outputPath
    base.args = args
    base.outputPath = outputPath
    for (const warning of built.warnings) {
      await spec.log.info(`参数提示：${warning}`)
      stderr += `[warn] ${warning}\n`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return done({
      stage: 'args',
      failure: {
        stage: 'args',
        errorType: 'unknown',
        detail: `构建渲染参数失败：${message}`,
        hint: '请检查项目路径与导出参数（输出目录是否可写、格式是否受支持）'
      }
    })
  }

  const validation = validateRenderArgs(args, spec.cli)
  for (const warning of validation.warnings) {
    await spec.log.info(`参数校验提示：${warning}`)
    stderr += `[warn] ${warning}\n`
  }
  if (!validation.ok) {
    const detail = `当前 CLI 不支持的参数：${describeArgFailure(validation)}`
    await spec.log.info(`参数校验失败：${detail}`, { args })
    return done({
      stage: 'args',
      failure: {
        stage: 'args',
        errorType: 'unsupported-arg',
        detail,
        hint: '这些选项会出现在命令行里但当前版本不认识，CLI 会直接以 unknown option 退出。请升级 CLI 或调整高级参数后重试'
      }
    })
  }

  /* ---------------- 2. 构造真实调用（可能抛错） ---------------- */

  let invocation: Awaited<ReturnType<typeof buildCliInvocation>>
  try {
    invocation = await buildCliInvocation(args, spec.cliCommand)
    base.command = invocation.display
    base.execFile = invocation.file
    base.execArgs = invocation.args
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return done({
      stage: 'spawn',
      failure: {
        stage: 'spawn',
        errorType: 'command-not-found',
        detail: `无法构造 CLI 调用：${message}`,
        hint: '确认 Node.js / npm 已安装且 PATH 正确，或把「CLI 命令」改成可执行文件的绝对路径'
      }
    })
  }

  /* ---------------- 3. 输出目录 ---------------- */

  try {
    await fs.mkdir(dirname(outputPath), { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return done({
      stage: 'file',
      failure: {
        stage: 'file',
        errorType: 'file-write',
        detail: `无法创建输出目录 ${dirname(outputPath)}：${message}`,
        hint: '检查输出目录所在磁盘的空间与权限'
      }
    })
  }

  await spec.log.info(`启动渲染进程`, {
    group: spec.group,
    subdir: spec.subdir ?? null,
    cwd: spec.projectPath,
    command: invocation.display,
    exec: invocation.realCommand,
    output: outputPath
  })

  /* ---------------- 4. spawn ---------------- */

  let child: ChildProcess
  try {
    child = spawn(invocation.file, invocation.args, {
      cwd: spec.projectPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
        ...(spec.request.env ?? {}),
        // 沙箱放最后：确保 TMP/TEMP 不会被上层参数覆盖回来
        ...(spec.env ?? {})
      },
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32'
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return done({
      stage: 'spawn',
      failure: {
        stage: 'spawn',
        errorType: 'command-not-found',
        detail: `子进程启动失败：${message}\n执行文件：${invocation.file}\n参数：${invocation.args.join(' ')}`,
        hint: '确认 Node.js 路径存在且可执行；若路径含中文或空格，检查是否被截断'
      }
    })
  }

  base.pid = child.pid ?? null
  spec.onChild?.(child)
  if (base.pid) await spec.log.info(`子进程已启动 pid=${base.pid}`, { pid: base.pid, cwd: spec.projectPath })

  /** 超时标记（超时后 kill 进程树） */
  let timedOut = false

  const outcome = await new Promise<Partial<RenderRunOutcome>>((resolve) => {
    let settled = false

    const finalize = (patch: Partial<RenderRunOutcome>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.onChild?.(null)
      resolve(patch)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      // 兜底：即使 close 事件没来，也不能让 Promise 永远挂着
      setTimeout(() => {
        finalize({
          stage: 'render',
          exitCode: null,
          failure: {
            stage: 'render',
            errorType: 'timeout',
            detail: `渲染超过 ${Math.round(spec.timeoutMs / 60000)} 分钟仍未结束，已强制结束进程树`,
            hint: '项目可能过大或机器负载过高；建议缩小测试项目或提高超时时间'
          }
        })
      }, 8000)
    }, spec.timeoutMs)

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8')
      stdout += text
      spec.log.appendStream(`${streamKey}/stdout`, text)
      if (spec.onStdoutLine) {
        for (const line of stripAnsi(text).split(/\r?\n/)) {
          if (line.trim()) spec.onStdoutLine(line)
        }
      }
    })

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8')
      stderr += text
      spec.log.appendStream(`${streamKey}/stderr`, text)
    })

    child.on('error', (err) => {
      spawnError = `${err.name}: ${err.message}`
      finalize({ stage: 'spawn', exitCode: null, signal: null })
    })

    child.on('close', (code, signal) => {
      finalize({
        stage: 'render',
        exitCode: code,
        signal: signal ? String(signal) : null
      })
    })
  })

  if (spawnError) {
    return done({
      ...outcome,
      stage: 'spawn',
      failure: {
        stage: 'spawn',
        errorType: 'command-not-found',
        detail: `子进程 error 事件：${spawnError}\n执行文件：${invocation.file}\n参数：${invocation.args.join(' ')}`,
        hint: '这通常表示可执行文件不存在或没有执行权限（与 CLI 本身是否可用无关）'
      }
    })
  }

  if (timedOut) {
    const flushed = await spec.log.flushStream(`${streamKey}/stdout`, false)
    await spec.log.flushStream(`${streamKey}/stderr`, false)
    await spec.log.info('超时终止', { stdoutLog: flushed })
    const failure = outcome.failure as ComparisonFailure
    return done({ ...outcome, failure })
  }

  if (spec.isCanceled?.()) {
    await spec.log.flushStream(`${streamKey}/stdout`, false)
    await spec.log.flushStream(`${streamKey}/stderr`, false)
    return done({ ...outcome, status: 'canceled', stage: 'none', failure: null })
  }

  const exitCode = outcome.exitCode ?? null
  const signalText = outcome.signal ?? null
  await spec.log.flushStream(`${streamKey}/stdout`, false)
  await spec.log.flushStream(`${streamKey}/stderr`, false)

  /* ---------------- 5. 退出码判定 ---------------- */

  if (exitCode !== 0) {
    const raw = `${stderr}\n${stdout}`
    const failure = classifyFailure('render', raw)
    await spec.log.info('渲染进程非零退出', {
      exitCode,
      signal: signalText,
      errorType: failure.errorType
    })
    return done({ ...outcome, stage: 'render', failure })
  }

  /* ---------------- 6. 产出文件验证 ---------------- */

  const check = await verifyOutputFile(outputPath, {
    expectedFps: spec.verify?.expectedFps ?? null,
    expectedWidth: spec.verify?.expectedWidth ?? null,
    expectedHeight: spec.verify?.expectedHeight ?? null,
    expectedDurationSec: spec.verify?.expectedDurationSec ?? null,
    directoryOutput: spec.verify?.directoryOutput ?? false
  })

  await spec.log.info('产出文件验证', {
    outputPath,
    exists: check.exists,
    bytes: check.bytes,
    writeSettled: check.writeSettled,
    probe: check.probe,
    problems: check.problems
  })

  if (!check.exists || check.problems.length > 0) {
    const detail = [
      `exit code 为 0，但产出文件未通过验证：`,
      `文件：${outputPath}`,
      `存在：${check.exists ? '是' : '否'} · 体积：${check.bytes ?? 'N/A'} 字节 · 已停止写入：${
        check.writeSettled ? '是' : '否'
      }`,
      check.probe
        ? `ffprobe：${check.probe.available ? (check.probe.ok ? '正常' : '读取失败') : '不可用'}${
            check.probe.error ? ` · ${check.probe.error}` : ''
          }`
        : 'ffprobe：未执行',
      `未通过项：${check.problems.join('；')}`,
      '',
      'CLI 原始输出（尾部）：',
      tail(stripAnsi(`${stderr}\n${stdout}`), 3000)
    ].join('\n')
    return done({
      ...outcome,
      stage: 'file',
      outputBytes: check.bytes,
      fileCheck: check,
      failure: {
        stage: 'file',
        errorType: check.probe && check.probe.available && !check.probe.ok ? 'ffmpeg' : 'file-write',
        detail,
        hint: '命令成功退出但没有可用产物：优先检查是否为残留浏览器进程 / 磁盘空间 / 输出目录权限问题'
      }
    })
  }

  return done({
    ...outcome,
    status: 'ok',
    stage: 'none',
    failure: null,
    outputBytes: check.bytes,
    fileCheck: check
  })
}
