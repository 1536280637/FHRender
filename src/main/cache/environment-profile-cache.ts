import { join } from 'node:path'
import type {
  CapabilityReport,
  CliCapabilities
} from '@shared/types/performance'
import type { EnvironmentCacheStatus } from '@shared/types/cache'
import type { EnvironmentReport } from '@shared/types/settings'
import type { ProjectCommandCapability } from '@shared/types/project'
import {
  expiresAtOf,
  isExpired,
  profilesDir,
  readJsonFile,
  removeFiles,
  writeJsonFile
} from './cache-io'

/**
 * 运行环境缓存。
 *
 * 缓存内容：Node / npm / npx 版本与路径、HyperFrames CLI 版本与参数能力、
 * 项目元数据命令能力、FFmpeg / FFprobe / Chrome 路径与版本、已验证的编码器能力、
 * 以及 `doctor` 的整体结果。
 *
 * 失效规则：
 * - CLI 能力按「命令 + 版本」缓存 24 小时；版本号变化立即重新探测；
 * - 编码器验证按「硬件指纹 + ffmpeg 版本」缓存 7 天（试编码要起进程，不能每次进页面都跑）；
 * - doctor 结果按「命令 + CLI 版本 + Node 版本」缓存 12 小时。
 */

const VERSION = 1
const CLI_TTL_HOURS = 24
const ENCODER_TTL_HOURS = 168
const DOCTOR_TTL_HOURS = 12

export interface EnvMediaCache {
  ffmpegPath: string | null
  ffmpegVersion: string | null
  ffprobePath: string | null
  ffprobeVersion: string | null
  chromePath: string | null
  chromeVersion: string | null
  checkedAt: string
}

export interface EnvNodeCache {
  nodeVersion: string | null
  nodePath: string | null
  npmPath: string | null
  npxPath: string | null
  npmVersion: string | null
  npxCliJs: string | null
  checkedAt: string
}

export interface EnvCliCache {
  command: string
  version: string | null
  capabilities: CliCapabilities
  probedAt: string
  ttlHours: number
}

export interface EnvProjectCommandsCache {
  command: string
  version: string | null
  capability: ProjectCommandCapability
  probedAt: string
}

export interface EnvEncoderCache {
  fingerprint: string
  /** 缓存键：ffmpeg 路径（或版本）。ffmpeg 换版本 / 换路径都会失效 */
  mediaKey: string | null
  report: CapabilityReport
  checkedAt: string
  ttlHours: number
}

export interface EnvDoctorCache {
  key: string
  report: EnvironmentReport
  checkedAt: string
  ttlHours: number
}

export interface EnvCliDetected {
  command: string
  version: string | null
  checkedAt: string
}

export interface EnvCacheFile {
  version: number
  node?: EnvNodeCache
  /** 最近一次轻量版本探测（`hyperframes --version`），启动时只需一次 */
  detected?: EnvCliDetected
  cli?: EnvCliCache
  projectCommands?: EnvProjectCommandsCache
  media?: EnvMediaCache
  encoders?: EnvEncoderCache
  doctor?: EnvDoctorCache
}

export class EnvironmentProfileCache {
  private readonly file = join(profilesDir(), 'environment-profile.json')
  private data: EnvCacheFile | null = null
  private loaded = false
  /**
   * 串行写队列。
   * 启动时「CLI 版本 / Node 环境 / 编码器 / media」可能同时落盘，
   * 并发 read-modify-write 会互相覆盖，必须排队。
   */
  private writeChain: Promise<void> = Promise.resolve()

  get path(): string {
    return this.file
  }

  async load(): Promise<EnvCacheFile> {
    if (this.loaded && this.data) return this.data
    const raw = await readJsonFile<EnvCacheFile>(this.file)
    this.data = raw && raw.version === VERSION ? raw : { version: VERSION }
    this.loaded = true
    return this.data
  }

  private async patch(patch: Partial<EnvCacheFile>): Promise<void> {
    const current = await this.load()
    this.data = { ...current, ...patch, version: VERSION }
    await this.flush()
  }

  /** 排队写入当前内存快照（内存里始终是最新合并结果） */
  private flush(): Promise<void> {
    const snapshot = this.data
    const run = async (): Promise<void> => {
      if (snapshot) await writeJsonFile(this.file, snapshot)
    }
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }

  /* ----------------------------- Node / npm ----------------------------- */

  async getNode(): Promise<EnvNodeCache | null> {
    const data = await this.load()
    return data.node ?? null
  }

  async saveNode(value: Omit<EnvNodeCache, 'checkedAt'>): Promise<void> {
    await this.patch({ node: { ...value, checkedAt: new Date().toISOString() } })
  }

  /* ------------------------------- CLI 能力 ------------------------------- */

  /**
   * 记录一次轻量版本探测。版本发生变化时，同时清掉依赖版本的 CLI 能力缓存，
   * 保证「CLI 升级后参数能力会重新探测」。
   */
  async saveCliVersion(command: string, version: string | null): Promise<{ changed: boolean }> {
    const data = await this.load()
    const previous = data.detected
    const changed = !previous || previous.command !== command || (previous.version ?? '') !== (version ?? '')
    this.data = {
      ...data,
      version: VERSION,
      detected: { command, version, checkedAt: new Date().toISOString() }
    }
    if (changed) {
      this.data.cli = undefined
      this.data.projectCommands = undefined
    }
    await this.flush()
    return { changed }
  }

  async getCliVersion(command: string): Promise<string | null> {
    const data = await this.load()
    if (data.detected && data.detected.command === command) return data.detected.version
    if (data.cli && data.cli.command === command) return data.cli.version
    return null
  }

  /** 命中时返回缓存的 CLI 能力（并且版本号一致） */
  async getCliCapabilities(command: string, version?: string | null): Promise<CliCapabilities | null> {
    const data = await this.load()
    const cached = data.cli
    if (!cached) return null
    if (cached.command !== command) return null
    if (isExpired(cached.probedAt, cached.ttlHours || CLI_TTL_HOURS)) return null
    if (version && cached.version && version !== cached.version) return null
    return cached.capabilities
  }

  async saveCliCapabilities(command: string, capabilities: CliCapabilities): Promise<void> {
    const data = await this.load()
    this.data = {
      ...data,
      version: VERSION,
      detected: {
        command,
        version: capabilities.version,
        checkedAt: new Date().toISOString()
      },
      cli: {
        command,
        version: capabilities.version,
        capabilities,
        probedAt: new Date().toISOString(),
        ttlHours: CLI_TTL_HOURS
      }
    }
    await this.flush()
  }

  /* --------------------------- 项目元数据命令能力 --------------------------- */

  async getProjectCommands(command: string, version?: string | null): Promise<ProjectCommandCapability | null> {
    const data = await this.load()
    const cached = data.projectCommands
    if (!cached || cached.command !== command) return null
    if (isExpired(cached.probedAt, CLI_TTL_HOURS)) return null
    // 版本必须一致：CLI 升级后参数能力可能变化，不能复用旧结论
    const known = version ?? (data.detected?.command === command ? data.detected.version : null)
    if (known && cached.version && known !== cached.version) return null
    return cached.capability
  }

  async saveProjectCommands(command: string, capability: ProjectCommandCapability): Promise<void> {
    await this.patch({
      projectCommands: {
        command,
        version: capability.cliVersion,
        capability,
        probedAt: new Date().toISOString()
      }
    })
  }

  /* ------------------------------- 编码器 ------------------------------- */

  async getEncoders(fingerprint: string, mediaKey: string | null): Promise<CapabilityReport | null> {
    const data = await this.load()
    const cached = data.encoders
    if (!cached) return null
    if (cached.fingerprint !== fingerprint) return null
    if ((cached.mediaKey ?? '') !== (mediaKey ?? '')) return null
    if (isExpired(cached.checkedAt, cached.ttlHours || ENCODER_TTL_HOURS)) return null
    return cached.report
  }

  async saveEncoders(input: {
    fingerprint: string
    mediaKey: string | null
    report: CapabilityReport
  }): Promise<void> {
    await this.patch({
      encoders: {
        ...input,
        checkedAt: new Date().toISOString(),
        ttlHours: ENCODER_TTL_HOURS
      }
    })
  }

  /* -------------------------------- doctor -------------------------------- */

  async getDoctor(key: string): Promise<EnvironmentReport | null> {
    const data = await this.load()
    const cached = data.doctor
    if (!cached || cached.key !== key) return null
    if (isExpired(cached.checkedAt, cached.ttlHours || DOCTOR_TTL_HOURS)) return null
    return cached.report
  }

  async saveDoctor(key: string, report: EnvironmentReport): Promise<void> {
    await this.patch({
      doctor: { key, report, checkedAt: new Date().toISOString(), ttlHours: DOCTOR_TTL_HOURS }
    })
  }

  /* ------------------------------ 媒体工具链 ------------------------------ */

  async getMedia(): Promise<EnvMediaCache | null> {
    const data = await this.load()
    return data.media ?? null
  }

  async saveMedia(value: Omit<EnvMediaCache, 'checkedAt'>): Promise<void> {
    await this.patch({ media: { ...value, checkedAt: new Date().toISOString() } })
  }

  /** 探测到更完整的媒体信息时增量合并，不覆盖已知路径 */
  async mergeMedia(patch: Partial<Omit<EnvMediaCache, 'checkedAt'>>): Promise<void> {
    const data = await this.load()
    const current = data.media ?? {
      ffmpegPath: null,
      ffmpegVersion: null,
      ffprobePath: null,
      ffprobeVersion: null,
      chromePath: null,
      chromeVersion: null,
      checkedAt: new Date().toISOString()
    }
    const merged: EnvMediaCache = { ...current, checkedAt: new Date().toISOString() }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && value !== undefined && value !== '') {
        ;(merged as unknown as Record<string, string | null>)[key] = value as string
      }
    }
    await this.patch({ media: merged })
  }

  /* -------------------------------- 状态 -------------------------------- */

  async status(): Promise<EnvironmentCacheStatus> {
    const data = await this.load()
    const cli = data.cli
    const media = data.media
    const encoders = data.encoders
    const available = !!(cli || media || data.node)
    const ttl = cli?.ttlHours ?? CLI_TTL_HOURS
    const staleReasons: string[] = []
    if (!cli) staleReasons.push('尚未缓存 CLI 能力')
    else if (isExpired(cli.probedAt, ttl)) staleReasons.push('CLI 能力缓存已过期')
    if (encoders && isExpired(encoders.checkedAt, encoders.ttlHours || ENCODER_TTL_HOURS)) {
      staleReasons.push('编码器验证结果已过期')
    }
    return {
      available,
      checkedAt: cli?.probedAt ?? media?.checkedAt ?? data.node?.checkedAt ?? null,
      file: this.file,
      expiresAt: expiresAtOf(cli?.probedAt ?? null, ttl),
      staleReason: available ? (staleReasons.length > 0 ? staleReasons.join('；') : null) : '尚未建立环境缓存',
      key: cli ? `${cli.command}@${cli.version ?? 'unknown'}` : null,
      nodeVersion: data.node?.nodeVersion ?? null,
      npmVersion: data.node?.npmVersion ?? null,
      cliCommand: cli?.command ?? null,
      cliVersion: cli?.version ?? null,
      ffmpegPath: media?.ffmpegPath ?? null,
      ffmpegVersion: media?.ffmpegVersion ?? null,
      ffprobePath: media?.ffprobePath ?? null,
      chromePath: media?.chromePath ?? null,
      encoderCount: encoders ? encoders.report.encoders.filter((e) => e.working).length : null,
      cliFlagCount: cli ? cli.capabilities.render.flags.length : null,
      ttlHours: ttl
    }
  }

  async clear(): Promise<string[]> {
    this.data = { version: VERSION }
    this.loaded = true
    return removeFiles([this.file])
  }
}
