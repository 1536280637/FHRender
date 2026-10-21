import { randomUUID } from 'node:crypto'
import type { HardwareReport } from '@shared/types/hardware'
import type {
  BenchmarkCandidate,
  BenchmarkSessionState,
  PerformanceMode,
  PerformanceReport,
  PerformanceReportEntry
} from '@shared/types/performance'
import type { RenderSettings } from '@shared/types/render'
import { JsonStore } from './store'

const MAX_REPORTS = 30

interface ReportFile {
  reports: PerformanceReport[]
}

/**
 * 性能报告管理：四模式对比测试结束后自动生成报告并持久化。
 * 所有数据来自真实执行结果，绝不虚构；报告按设备 + 项目 + 输出参数区分，
 * 不同条件的结果不会互相冒充。
 */
export class PerformanceReportManager {
  private store = new JsonStore<ReportFile>('performance-reports.json', { reports: [] })

  async list(): Promise<PerformanceReport[]> {
    const data = await this.store.read()
    return Array.isArray(data.reports) ? data.reports : []
  }

  async save(report: PerformanceReport): Promise<void> {
    const data = await this.store.read()
    const reports = [report, ...(data.reports ?? []).filter((r) => r.id !== report.id)].slice(0, MAX_REPORTS)
    await this.store.write({ reports })
  }

  async clear(): Promise<void> {
    await this.store.write({ reports: [] })
  }

  /**
   * 查找与当前条件（设备 + 项目 + 导出参数）匹配的最新报告。
   * 没有匹配就返回 null——不允许拿其他项目的成绩冒充当前项目。
   */
  async findMatching(input: {
    hardwareFingerprint: string
    projectPath: string
    format: string
    resolution: string
    fpsLabel: string
    quality: string
  }): Promise<PerformanceReport | null> {
    const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    const reports = await this.list()
    return (
      reports.find(
        (r) =>
          r.device.fingerprint === input.hardwareFingerprint &&
          norm(r.project.path) === norm(input.projectPath) &&
          r.project.format === input.format &&
          r.project.resolution === input.resolution &&
          r.project.fpsLabel === input.fpsLabel &&
          r.project.quality === input.quality &&
          r.entries.filter((e) => e.status === 'ok').length >= 2
      ) ?? null
    )
  }
}

/* ------------------------------------------------------------------ */
/* 报告生成（纯函数，供 PerformanceService 调用）                          */
/* ------------------------------------------------------------------ */

export interface BuildReportInput {
  state: BenchmarkSessionState
  candidates: BenchmarkCandidate[]
  hardware: HardwareReport
  cliVersion: string | null
  kind: 'quick' | 'precise'
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function fpsLabelOf(settings: RenderSettings): string {
  if (settings.fpsMode === 'project') return '跟随项目'
  if (settings.fpsMode === 'custom') return settings.customFps || '自定义'
  return `${settings.fpsMode}fps`
}

/** 从一次对比测试会话生成性能报告 */
export function buildPerformanceReport(input: BuildReportInput): PerformanceReport {
  const { state, candidates, hardware, kind } = input
  const gpuNames = hardware.gpus.filter((g) => g.kind !== 'virtual').map((g) => g.name)

  const entries: PerformanceReportEntry[] = candidates
    .filter((c) => c.mode)
    .map((candidate) => {
      const runs = state.results.filter(
        (r) => r.candidateId === candidate.id && r.status === 'ok' && r.durationMs > 0
      )
      const medianMs = median(runs.map((r) => r.durationMs))
      const totalBytes = runs.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
      const totalMs = runs.reduce((sum, r) => sum + r.durationMs, 0)
      const failed = state.results.find((r) => r.candidateId === candidate.id && r.status !== 'ok')
      const peak = runs[0]?.peak
      const avgCpuSamples = runs.map((r) => r.avgCpuPct).filter((v): v is number => v != null)
      return {
        mode: candidate.mode as PerformanceMode,
        label: candidate.label,
        status: runs.length > 0 ? ('ok' as const) : ('failed' as const),
        workers: candidate.workers,
        gpuEncode: candidate.gpuEncode,
        encoderId: candidate.encoderId,
        encoderLabel: null,
        capturePath: candidate.capturePath,
        runs: runs.map((r) => r.durationMs),
        medianMs,
        bestMs: runs.length > 0 ? Math.min(...runs.map((r) => r.durationMs)) : null,
        avgSpeedBytesPerSec: totalMs > 0 && totalBytes > 0 ? totalBytes / (totalMs / 1000) : null,
        peak: {
          cpuPct: peak?.cpuPct ?? null,
          memoryBytes: peak?.memoryBytes ?? null,
          vramBytes: peak?.vramBytes ?? null,
          gpuPct: peak?.gpuPct ?? null,
          videoEncodePct: peak?.videoEncodePct ?? null
        },
        avgCpuPct:
          avgCpuSamples.length > 0
            ? avgCpuSamples.reduce((a, b) => a + b, 0) / avgCpuSamples.length
            : null,
        error: failed?.error
      }
    })

  /* ---------------- 基准与提升比例（平衡模式为基准） ---------------- */
  const balanced = entries.find((e) => e.mode === 'balanced' && e.status === 'ok' && e.medianMs)
  const timeSavedPct: PerformanceReport['timeSavedPct'] = {}
  const throughputGainPct: PerformanceReport['throughputGainPct'] = {}
  if (balanced?.medianMs) {
    for (const entry of entries) {
      if (entry.status !== 'ok' || !entry.medianMs) continue
      // 耗时缩短率：(平衡耗时 - 当前耗时) / 平衡耗时 × 100%
      timeSavedPct[entry.mode] =
        Math.round(((balanced.medianMs - entry.medianMs) / balanced.medianMs) * 1000) / 10
      // 渲染吞吐提升率：平衡耗时 / 当前耗时 × 100% - 100%
      throughputGainPct[entry.mode] =
        Math.round((balanced.medianMs / entry.medianMs - 1) * 1000) / 10
    }
  }

  /* ---------------- 最快模式（至少两种模式有效才认定） ---------------- */
  const okEntries = entries.filter((e) => e.status === 'ok' && e.medianMs)
  const sorted = [...okEntries].sort((a, b) => (a.medianMs as number) - (b.medianMs as number))
  const fastest = sorted.length >= 2 ? sorted[0] : null

  return {
    id: `report_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    kind,
    cliVersion: input.cliVersion,
    device: {
      fingerprint: hardware.fingerprint,
      cpuModel: hardware.cpu.model,
      gpuNames,
      memoryGb: Math.round((hardware.memory.totalBytes / 1024 ** 3) * 10) / 10,
      os: `${hardware.os.name} ${hardware.os.arch}`
    },
    project: {
      path: state.projectPath,
      name: state.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '',
      format: state.format,
      resolution: state.resolution,
      fpsLabel: state.fpsLabel,
      quality: state.quality
    },
    entries,
    fastestMode: fastest?.mode ?? null,
    fastestMedianMs: fastest?.medianMs ?? null,
    fastestStableMs: fastest?.medianMs ?? null,
    timeSavedPct,
    throughputGainPct,
    failures: entries
      .filter((e) => e.status === 'failed')
      .map((e) => ({ mode: e.mode, label: e.label, error: e.error ?? '未知错误' }))
  }
}

export { fpsLabelOf }
