import { join } from 'node:path'
import type { ProjectMetadata } from '@shared/types/project'
import type { WorkloadProfile } from '@shared/types/performance'
import type { RenderSettings } from '@shared/types/render'
import type { CacheCounters } from '@shared/types/cache'
import { ProjectMetadataAnalyzer } from '../analyzer/project-metadata'
import { analyzeWorkload, resolveExportFps } from '../analyzer/workload'
import { collectProjectFingerprint } from '../analyzer/project-fingerprint'
import { scanAssets } from '../analyzer/project-analyzer'
import { probeMedia } from '../benchmark/output-verify'
import { runCliCapture, stripAnsi } from '../process/hyperframes'
import { ProjectMetadataCache, type ProjectCacheRecord } from '../cache/project-metadata-cache'
import { EnvironmentProfileCache } from '../cache/environment-profile-cache'
import { cacheCounters, snapshotCounters } from '../cache/counters'

/**
 * 项目元数据 + 负载分析的统一入口（带缓存）。
 *
 * 调用顺序（也是缓存策略）：
 * 1. 读项目缓存 → 校验 composition / CLI 版本 / 文件指纹（只 stat，不读内容）；
 * 2. 命中：直接把上次的元数据与负载结果还给界面（毫秒级）；
 * 3. 未命中：调官方 `info --json` / `compositions --json`，再扫素材与入口 HTML；
 * 4. 结果连同新的文件指纹一起写回缓存。
 *
 * 导出 FPS 变化时只重算总帧数，不重新扫项目。
 */

export interface ProjectAnalysis {
  metadata: ProjectMetadata
  workload: WorkloadProfile
  fromCache: boolean
  reason: string
  verifyMs: number
  entryFiles: string[]
  /** 缓存中记录的分析时间（命中时） */
  analyzedAt: string
}

export interface ProjectMetadataServiceDeps {
  analyzer: ProjectMetadataAnalyzer
  cache: ProjectMetadataCache
  envCache: EnvironmentProfileCache
  /** 列出项目内 html 文件（相对路径），由 ProjectManager 提供 */
  listHtmlFiles: (root: string) => Promise<string[]>
  getCliCommand: () => Promise<string>
  /** 项目文件变化时的通知（界面可据此刷新） */
  onProjectChanged?: (projectPath: string, reason: string) => void
}

export class ProjectMetadataService {
  private deps: ProjectMetadataServiceDeps
  private inFlight = new Map<string, Promise<ProjectAnalysis>>()

  constructor(deps: ProjectMetadataServiceDeps) {
    this.deps = deps
  }

  get cache(): ProjectMetadataCache {
    return this.deps.cache
  }

  get counters(): CacheCounters {
    return snapshotCounters()
  }

  /** 当前 CLI 版本：优先读环境缓存（准启动时探测一次），读不到才触发一次能力探测 */
  async currentCliVersion(): Promise<string | null> {
    const command = await this.deps.getCliCommand()
    const cached = await this.deps.envCache.getCliVersion(command)
    if (cached) {
      // 环境缓存里有项目命令能力时先灌进内存，避免再次执行 --help
      const commands = await this.deps.envCache.getProjectCommands(command, cached)
      if (commands) this.deps.analyzer.primeCapability(command, commands)
      return cached
    }
    const capability = await this.deps.analyzer.probeCapability(command)
    if (capability.probedAt) {
      // 版本与能力一起落盘：下次启动（新进程）不用再跑 info --help / compositions --help
      await this.deps.envCache.saveCliVersion(command, capability.cliVersion)
      await this.deps.envCache.saveProjectCommands(command, capability)
    }
    return capability.cliVersion
  }

  async analyze(input: {
    projectPath: string
    /** 当前选择的渲染入口（文件相对路径或 composition id） */
    composition?: string | null
    settings?: RenderSettings | null
    force?: boolean
  }): Promise<ProjectAnalysis> {
    const key = `${input.projectPath}::${input.composition ?? ''}::${input.force ? 'force' : 'normal'}`
    const running = this.inFlight.get(key)
    if (running) return running
    const task = this.run(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, task)
    return task
  }

  private async run(input: {
    projectPath: string
    composition?: string | null
    settings?: RenderSettings | null
    force?: boolean
  }): Promise<ProjectAnalysis> {
    const cliVersion = await this.currentCliVersion()
    const lookup = await this.deps.cache.lookup({
      projectPath: input.projectPath,
      composition: input.composition ?? null,
      cliVersion,
      force: input.force
    })

    if (lookup.record) {
      cacheCounters.projectCacheHits += 1
      const record = lookup.record
      this.deps.cache.watchProject(input.projectPath, this.deps.onProjectChanged)
      const fresh = this.withExportSettings(record, input.settings)
      return {
        metadata: fresh.metadata,
        workload: fresh.workload,
        fromCache: true,
        reason: lookup.reason,
        verifyMs: lookup.verifyMs,
        entryFiles: record.entryFiles,
        analyzedAt: record.analyzedAt
      }
    }

    /* ---------------- 缓存未命中：真实分析 ---------------- */

    cacheCounters.projectScans += 1
    const entryFiles = await this.deps.listHtmlFiles(input.projectPath)
    const metadata = await this.deps.analyzer.analyze({
      projectPath: input.projectPath,
      composition: input.composition ?? null,
      entryFiles
    })

    const fingerprint = await collectProjectFingerprint(input.projectPath)
    const exportFps = resolveExportFps(metadata, input.settings ?? null).fps

    const workload = await analyzeWorkload({
      projectPath: input.projectPath,
      metadata,
      exportFps,
      entryFiles,
      videoProbe: await this.probeLargestVideo(input.projectPath, entryFiles)
    })

    const record = await this.deps.cache.save({
      projectPath: input.projectPath,
      projectName: metadata.name,
      compositionKey: (input.composition ?? '').trim() || null,
      cliVersion: metadata.cliVersion ?? cliVersion,
      analyzedAt: new Date().toISOString(),
      metadata,
      workload,
      fingerprint,
      exportFps,
      entryFiles,
      verifyMs: lookup.verifyMs,
      stats: 0
    })

    this.deps.cache.watchProject(input.projectPath, this.deps.onProjectChanged)

    return {
      metadata: record.metadata,
      workload: record.workload,
      fromCache: false,
      reason: lookup.reason,
      verifyMs: lookup.verifyMs,
      entryFiles,
      analyzedAt: record.analyzedAt
    }
  }

  /**
   * 导出参数变化：只需重算 `exportFps` 与总帧数，不必重新扫描项目。
   * 这是「用户切 fps 不该触发全量分析」的关键。
   */
  private withExportSettings(
    record: ProjectCacheRecord,
    settings: RenderSettings | null | undefined
  ): ProjectCacheRecord {
    if (!settings) return record
    const nextFps = resolveExportFps(record.metadata, settings).fps
    if (nextFps === record.exportFps) return record
    const frameCount =
      record.metadata.durationSec !== null && nextFps !== null
        ? Math.round(record.metadata.durationSec * nextFps)
        : null
    const workload: WorkloadProfile = {
      ...record.workload,
      exportFps: nextFps,
      frameCount,
      frameCountSource: frameCount === null ? 'unknown' : 'cli-info',
      scoreBreakdown: record.workload.scoreBreakdown.map((part) =>
        part.key === 'duration' && frameCount !== null
          ? { ...part, detail: `${record.metadata.durationSec}s × ${nextFps}fps ≈ ${frameCount} 帧` }
          : part
      ),
      notes: record.workload.notes.map((note) =>
        /≈\s*\d+\s*帧/.test(note) ? `${record.metadata.durationSec}s × ${nextFps}fps ≈ ${frameCount} 帧` : note
      )
    }
    record.workload = workload
    record.exportFps = nextFps
    // 只更新轻量字段，不重新分析
    void this.deps.cache.touch(record.projectPath, { workload, exportFps: nextFps })
    return record
  }

  /** 只探测「最大的那个视频素材」的分辨率，避免为统计去读几百个文件 */
  private async probeLargestVideo(
    projectPath: string,
    entryFiles: string[]
  ): Promise<{ width: number; height: number; durationSec: number | null } | null> {
    try {
      const scan = await scanAssets(projectPath, 400, 4)
      if (scan.videoCount === 0 || !scan.largestAssetPath) return null
      if (!/\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(scan.largestAssetPath)) return null
      const probe = await probeMedia(join(projectPath, scan.largestAssetPath))
      if (!probe.available || !probe.ok || !probe.width || !probe.height) return null
      void entryFiles
      return { width: probe.width, height: probe.height, durationSec: probe.durationSec }
    } catch {
      return null
    }
  }

  async invalidate(projectPath: string, reason = '手动刷新'): Promise<void> {
    this.deps.cache.invalidate(projectPath, reason)
  }

  async status(projectPath?: string | null) {
    return this.deps.cache.status(projectPath)
  }

  /** 主进程启动预热：只做一次轻量版本探测，不跑 doctor、不扫项目 */
  async warmup(): Promise<{ cliVersion: string | null; changed: boolean }> {
    const command = await this.deps.getCliCommand()
    const res = await runCliCapture(['--version'], command, { timeoutMs: 90_000 })
    const text = stripAnsi(`${res.stdout}\n${res.stderr}`)
    const version = (text.match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null
    if (!version) return { cliVersion: null, changed: false }
    const { changed } = await this.deps.envCache.saveCliVersion(command, version)
    if (changed) this.deps.analyzer.invalidateCapability()
    return { cliVersion: version, changed }
  }
}
