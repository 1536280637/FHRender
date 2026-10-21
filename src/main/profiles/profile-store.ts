import type {
  BenchmarkSessionState,
  FallbackEvent,
  HardwareProfile,
  OptimizationArchive,
  OptimizationRecommendation,
  RenderProfile
} from '@shared/types/performance'
import type { HardwareReport } from '@shared/types/hardware'
import { JsonStore } from '../services/store'

interface ProfileData {
  hardwareProfiles: HardwareProfile[]
  renderProfiles: RenderProfile[]
  fallbacks: FallbackEvent[]
  recommendations: OptimizationRecommendation[]
  optimizationArchives: OptimizationArchive[]
  benchmarks: BenchmarkSessionState[]
  lastBenchmark: BenchmarkSessionState | null
}

const DEFAULTS: ProfileData = {
  hardwareProfiles: [],
  renderProfiles: [],
  fallbacks: [],
  recommendations: [],
  optimizationArchives: [],
  benchmarks: [],
  lastBenchmark: null
}

const MAX_RENDER_PROFILES = 60
const MAX_FALLBACKS = 80
const MAX_RECOMMENDATIONS = 20
const MAX_ARCHIVES = 12
const MAX_BENCHMARKS = 10

function sameProject(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 设备档案 / 渲染档案 / 回退记录 的本地存储。
 * 全部写入 userData，不涉及任何网络上传。
 */
export class ProfileStore {
  private store = new JsonStore<ProfileData>('profiles.json', DEFAULTS)

  async read(): Promise<ProfileData> {
    const data = await this.store.read()
    return {
      hardwareProfiles: Array.isArray(data.hardwareProfiles) ? data.hardwareProfiles : [],
      renderProfiles: Array.isArray(data.renderProfiles) ? data.renderProfiles : [],
      fallbacks: Array.isArray(data.fallbacks) ? data.fallbacks : [],
      recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
      optimizationArchives: Array.isArray(data.optimizationArchives) ? data.optimizationArchives : [],
      benchmarks: Array.isArray(data.benchmarks) ? data.benchmarks : [],
      lastBenchmark: data.lastBenchmark ?? null
    }
  }

  async upsertHardwareProfile(hw: HardwareReport, extras: {
    cliVersion: string | null
    encoders: { id: string; family: string; working: boolean }[]
    referenceId?: string
  }): Promise<HardwareProfile> {
    const data = await this.read()
    const id = hw.fingerprint
    const existing = data.hardwareProfiles.find((p) => p.id === id)
    const now = new Date().toISOString()

    const gpuNames = hw.gpus.filter((g) => g.kind !== 'virtual').map((g) => g.name)
    const name =
      [hw.cpu.model.replace(/\(R\)|\(TM\)/gi, '').replace(/\s+/g, ' ').trim(), gpuNames[0]]
        .filter(Boolean)
        .join(' · ') || '当前设备'

    const profile: HardwareProfile = {
      id,
      name: existing?.name && existing.name !== name ? existing.name : name,
      fingerprint: hw.fingerprint,
      cpuModel: hw.cpu.model,
      cpuCores: `${hw.cpu.physicalCores ?? '?'}C/${hw.cpu.logicalCores ?? '?'}T`,
      gpuNames,
      memoryGb: Math.round((hw.memory.totalBytes / 1024 ** 3) * 10) / 10,
      os: `${hw.os.name} ${hw.os.arch}`,
      arch: hw.os.arch,
      driverVersions: Object.fromEntries(
        hw.gpus.filter((g) => g.driverVersion).map((g) => [g.name, g.driverVersion as string])
      ),
      encoders: extras.encoders.map((e) => ({ id: e.id, family: e.family as never, working: e.working })),
      cliVersion: extras.cliVersion,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      reference: !!extras.referenceId,
      referenceId: extras.referenceId
    }

    const others = data.hardwareProfiles.filter((p) => p.id !== id)
    await this.store.write({ ...data, hardwareProfiles: [profile, ...others].slice(0, 12) })
    return profile
  }

  async upsertRenderProfile(profile: RenderProfile): Promise<RenderProfile> {
    const data = await this.read()
    const key = this.renderKeyOf(profile)
    const others = data.renderProfiles.filter((p) => this.renderKeyOf(p) !== key)
    await this.store.write({
      ...data,
      renderProfiles: [profile, ...others].slice(0, MAX_RENDER_PROFILES)
    })
    return profile
  }

  private renderKeyOf(profile: RenderProfile): string {
    return [
      profile.hardwareFingerprint,
      profile.scope,
      profile.scope === 'project' ? profile.projectPath.toLowerCase() : '',
      profile.format,
      profile.resolution,
      profile.fpsLabel,
      profile.quality
    ].join('|')
  }

  async findRenderProfiles(input: {
    hardwareFingerprint: string
    projectPath: string
    format: string
  }): Promise<RenderProfile[]> {
    const data = await this.read()
    return data.renderProfiles
      .filter(
        (p) =>
          p.hardwareFingerprint === input.hardwareFingerprint &&
          p.format === input.format &&
          (p.scope === 'device' || sameProject(p.projectPath, input.projectPath))
      )
      .sort((a, b) => (a.benchmarkMs ?? Number.MAX_SAFE_INTEGER) - (b.benchmarkMs ?? Number.MAX_SAFE_INTEGER))
  }

  async listAll(): Promise<RenderProfile[]> {
    return (await this.read()).renderProfiles
  }

  async deleteRenderProfile(id: string): Promise<RenderProfile[]> {
    const data = await this.read()
    const next = data.renderProfiles.filter((p) => p.id !== id)
    await this.store.write({ ...data, renderProfiles: next })
    return next
  }

  async recordFallback(event: FallbackEvent): Promise<void> {
    const data = await this.read()
    await this.store.write({ ...data, fallbacks: [event, ...data.fallbacks].slice(0, MAX_FALLBACKS) })
  }

  async listFallbacks(): Promise<FallbackEvent[]> {
    return (await this.read()).fallbacks
  }

  async saveRecommendation(rec: OptimizationRecommendation): Promise<void> {
    const data = await this.read()
    const others = data.recommendations.filter((r) => r.id !== rec.id)
    await this.store.write({ ...data, recommendations: [rec, ...others].slice(0, MAX_RECOMMENDATIONS) })
  }

  async lastRecommendation(): Promise<OptimizationRecommendation | null> {
    const data = await this.read()
    return data.recommendations[0] ?? null
  }

  async saveBenchmark(state: BenchmarkSessionState): Promise<void> {
    const data = await this.read()
    await this.store.write({
      ...data,
      lastBenchmark: state,
      benchmarks: [state, ...data.benchmarks.filter((b) => b.id !== state.id)].slice(0, MAX_BENCHMARKS)
    })
  }

  async lastBenchmark(): Promise<BenchmarkSessionState | null> {
    return (await this.read()).lastBenchmark
  }

  async listBenchmarks(): Promise<BenchmarkSessionState[]> {
    return (await this.read()).benchmarks
  }

  /* ------------------------- 智能模式优化档案 ------------------------- */

  /**
   * 查找智能模式优化档案。档案按「设备指纹（含驱动）+ 项目 + 输出参数」定位；
   * CLI 版本不一致时仍返回档案，但由调用方标注为失效。
   */
  async findSmartArchive(input: {
    hardwareFingerprint: string
    projectPath: string
    format: string
    resolution: string
    fpsLabel: string
    quality: string
  }): Promise<OptimizationArchive | null> {
    const data = await this.read()
    return (
      data.optimizationArchives.find(
        (a) =>
          a.hardwareFingerprint === input.hardwareFingerprint &&
          sameProject(a.projectPath, input.projectPath) &&
          a.format === input.format &&
          a.resolution === input.resolution &&
          a.fpsLabel === input.fpsLabel &&
          a.quality === input.quality
      ) ?? null
    )
  }

  async upsertSmartArchive(archive: OptimizationArchive): Promise<void> {
    const data = await this.read()
    const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    const sameKey = (a: OptimizationArchive): boolean =>
      a.hardwareFingerprint === archive.hardwareFingerprint &&
      norm(a.projectPath) === norm(archive.projectPath) &&
      a.format === archive.format &&
      a.resolution === archive.resolution &&
      a.fpsLabel === archive.fpsLabel &&
      a.quality === archive.quality
    const others = data.optimizationArchives.filter((a) => !sameKey(a))
    await this.store.write({
      ...data,
      optimizationArchives: [archive, ...others].slice(0, MAX_ARCHIVES)
    })
  }

  async clearSmartArchives(): Promise<void> {
    const data = await this.read()
    await this.store.write({ ...data, optimizationArchives: [] })
  }

  /** 清空本机学习到的档案与历史（硬件信息会在下次扫描时重新写入） */
  async reset(): Promise<void> {
    await this.store.write({ ...DEFAULTS })
  }
}
