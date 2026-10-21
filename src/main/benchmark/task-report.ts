/**
 * 任务级性能快照（performance-tests/<task-id>/report.json）。
 *
 * 这份文件是「清理之后仍然长期保留」的数据：媒体文件会被删掉，
 * 但模式耗时、Worker 数、输出体积、视频时长、设备信息与失败原因都留在这里，
 * 另外还有一份更完整的报告由 PerformanceReportManager 持久化到应用档案里。
 */

import { cpus, release, totalmem } from 'node:os'

export interface TaskReportRun {
  mode: string | null
  label: string
  isWarmup: boolean
  /** 该模式使用的 worker 数量（auto 表示交给 CLI 校准） */
  workers: number | 'auto' | null
  status: 'ok' | 'failed' | 'canceled'
  stage: string
  errorType: string
  error: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  sizeBytes: number | null
  videoDurationSec: number | null
  width: number | null
  height: number | null
  fps: number | null
  /** 相对任务目录的产物路径（媒体被清理后仍能说明当时产出了什么） */
  output: string | null
  execFile: string
  exitCode: number | null
}

export interface TaskReport {
  app: 'hf-render'
  schema: 1
  testId: string
  taskKind: 'comparison' | 'matrix'
  status: string
  error: string | null
  startedAt: string | null
  endedAt: string | null
  project: { path: string; name: string }
  output: {
    format: string
    quality: string
    resolution: string
    fpsLabel: string
  }
  device: {
    platform: string
    arch: string
    osRelease: string
    cpuModel: string
    logicalCores: number
    totalMemoryBytes: number
    node: string
    electron: string | null
    cliVersion: string | null
  }
  runs: TaskReportRun[]
  modes: {
    mode: string | null
    workers: number | 'auto' | null
    runs: number
    okRuns: number
    medianMs: number | null
    bestMs: number | null
    avgBytes: number | null
    status: 'ok' | 'failed' | 'canceled'
  }[]
  totals: {
    runCount: number
    okCount: number
    failedCount: number
    mediaBytes: number
    videoSeconds: number | null
  }
  note: string
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function relativeTo(root: string, target: string | null): string | null {
  if (!target) return null
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normTarget = target.replace(/\\/g, '/')
  return normTarget.startsWith(`${normRoot}/`) ? normTarget.slice(normRoot.length + 1) : normTarget
}

export function buildTaskReport(input: {
  testId: string
  taskKind: 'comparison' | 'matrix'
  status: string
  error?: string | null
  startedAt?: string | null
  endedAt?: string | null
  projectPath: string
  outputRoot: string
  format: string
  quality: string
  resolution: string
  fpsLabel: string
  cliVersion: string | null
  /** 本次测试用到的候选配置（用于记录 Worker 数量） */
  candidates?: { mode?: string | null; workers: number | 'auto' }[]
  runs: {
    mode: string | null
    label: string
    status: 'ok' | 'failed' | 'canceled'
    stage: string
    errorType: string
    failureDetail?: string | null
    startedAt: string
    endedAt: string
    durationMs: number
    outputBytes: number | null
    outputPath: string
    execFile: string
    exitCode: number | null
    probe?: {
      durationSec: number | null
      width: number | null
      height: number | null
      fps: number | null
    } | null
  }[]
}): TaskReport {
  const workerOf = (mode: string | null): number | 'auto' | null => {
    const hit = (input.candidates ?? []).find((c) => (c.mode ?? null) === mode)
    return hit ? hit.workers : null
  }

  const runs: TaskReportRun[] = input.runs.map((run) => ({
    mode: run.mode,
    label: run.label,
    isWarmup: /run-0$/.test(run.label),
    workers: workerOf(run.mode),
    status: run.status,
    stage: run.stage,
    errorType: run.errorType,
    error: run.failureDetail ? run.failureDetail.slice(0, 2000) : null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    sizeBytes: run.outputBytes,
    videoDurationSec: run.probe?.durationSec ?? null,
    width: run.probe?.width ?? null,
    height: run.probe?.height ?? null,
    fps: run.probe?.fps ?? null,
    output: relativeTo(input.outputRoot, run.outputPath),
    execFile: run.execFile,
    exitCode: run.exitCode
  }))

  const byMode = new Map<string, TaskReportRun[]>()
  for (const run of runs) {
    const key = run.mode ?? 'matrix'
    byMode.set(key, [...(byMode.get(key) ?? []), run])
  }

  const modes = [...byMode.entries()].map(([mode, group]) => {
    const ok = group.filter((r) => r.status === 'ok')
    const durations = ok.map((r) => r.durationMs).filter((v) => v > 0)
    const sizes = ok.map((r) => r.sizeBytes).filter((v): v is number => v != null && v > 0)
    return {
      mode: mode === 'matrix' ? null : mode,
      workers: workerOf(mode === 'matrix' ? null : mode),
      runs: group.length,
      okRuns: ok.length,
      medianMs: median(durations),
      bestMs: durations.length > 0 ? Math.min(...durations) : null,
      avgBytes: sizes.length > 0 ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : null,
      status: ok.length > 0 ? ('ok' as const) : group.some((r) => r.status === 'canceled') ? ('canceled' as const) : ('failed' as const)
    }
  })

  const cpuList = cpus()
  const okRuns = runs.filter((r) => r.status === 'ok')
  const videoSeconds = okRuns
    .map((r) => r.videoDurationSec)
    .filter((v): v is number => v != null && v > 0)

  return {
    app: 'hf-render',
    schema: 1,
    testId: input.testId,
    taskKind: input.taskKind,
    status: input.status,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    project: {
      path: input.projectPath,
      name: input.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? ''
    },
    output: {
      format: input.format,
      quality: input.quality,
      resolution: input.resolution,
      fpsLabel: input.fpsLabel
    },
    device: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
      logicalCores: cpuList.length,
      totalMemoryBytes: totalmem(),
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      cliVersion: input.cliVersion
    },
    runs,
    modes,
    totals: {
      runCount: runs.length,
      okCount: okRuns.length,
      failedCount: runs.length - okRuns.length,
      mediaBytes: runs.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
      videoSeconds: videoSeconds.length > 0 ? Math.round(videoSeconds.reduce((a, b) => a + b, 0) * 10) / 10 : null
    },
    note:
      '临时视频 / PNG 序列 / 原始帧 / Chrome 配置会在测试结束后自动清理；' +
      '这份报告与 logs/ 目录长期保留。'
  }
}
