import { promises as fs, existsSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { runCliCapture, extractJsonObject, stripAnsi } from '../process/hyperframes'
import { listHtmlFiles } from '../analyzer/html-files'
import type { ProjectInfo, ProjectIssue, ProjectScanResult, CompositionInfo, ProjectMetadata } from '@shared/types/project'

interface InfoJson {
  name?: string
  resolution?: string
  width?: number
  height?: number
  duration?: number
  elements?: number
}

interface CompositionsJson {
  compositions?: CompositionInfo[]
}

/**
 * 项目元数据来源。
 * 由 ProjectMetadataService 提供（带磁盘缓存与文件指纹校验），
 * ProjectManager 不再自己每次跑 `info --json` / `compositions --json`。
 */
export type ProjectMetadataProvider = (input: {
  projectPath: string
  composition?: string | null
}) => Promise<{ metadata: ProjectMetadata; fromCache: boolean } | null>

export class ProjectManager {
  private cliCommand: () => Promise<string>
  private cache = new Map<string, { info: ProjectInfo; at: number }>()
  private metadataProvider: ProjectMetadataProvider | null | undefined

  constructor(cliCommand: () => Promise<string>, metadataProvider?: ProjectMetadataProvider) {
    this.cliCommand = cliCommand
    this.metadataProvider = metadataProvider
  }

  /** index.ts 里服务构造顺序导致只能后置注入 */
  setMetadataProvider(provider: ProjectMetadataProvider): void {
    this.metadataProvider = provider
  }

  private normalizePath(input: string): string {
    const path = input.trim()
    return isAbsolute(path) ? resolve(path) : resolve(path)
  }

  /**
   * 扫描并校验项目目录。
   * `deep: false` 时只做目录结构校验（不读元数据），用于切换项目时的快速预览。
   */
  async scan(
    inputPath: string,
    options: { deep?: boolean; composition?: string | null } = {}
  ): Promise<ProjectScanResult> {
    const path = this.normalizePath(inputPath)
    if (!path) return { info: null, error: '未提供项目路径' }

    let stat
    try {
      stat = await fs.stat(path)
    } catch {
      return { info: null, error: `目录不存在：${path}` }
    }
    if (!stat.isDirectory()) {
      return { info: null, error: '选择的路径不是文件夹' }
    }

    const issues: ProjectIssue[] = []
    const indexHtml = join(path, 'index.html')
    const packageJsonPath = join(path, 'package.json')
    const configPath = join(path, 'hyperframes.json')

    const hasIndexHtml = existsSync(indexHtml)
    const hasPackageJson = existsSync(packageJsonPath)
    const hasHyperframesConfig = existsSync(configPath)

    let packageName: string | undefined
    if (hasPackageJson) {
      try {
        const raw = await fs.readFile(packageJsonPath, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> }
        packageName = pkg.name
        if (!pkg.scripts?.render && !pkg.scripts?.dev) {
          issues.push({
            level: 'info',
            message: 'package.json 里没有 render / dev 脚本',
            hint: '本工具直接调用 hyperframes CLI，不依赖 npm 脚本，可以正常预览和渲染；这条只是说明它不是 `hyperframes init` 生成的标准项目。'
          })
        }
      } catch {
        issues.push({
          level: 'warning',
          message: 'package.json 存在但无法解析',
          hint: '请检查该文件是否为合法 JSON。'
        })
      }
    } else {
      issues.push({
        level: 'info',
        message: '未找到 package.json',
        hint: '不是必需文件：本工具直接调用 hyperframes CLI，只要目录里有 index.html（或手动指定 composition）就能预览和渲染。'
      })
    }

    if (!hasHyperframesConfig) {
      issues.push({
        level: 'info',
        message: '未找到 hyperframes.json',
        hint: '该文件由 `hyperframes init` 生成，只影响部分项目级配置；本工具只要求 index.html，缺少它同样可以预览和渲染。'
      })
    }

    if (!hasIndexHtml) {
      issues.push({
        level: 'error',
        message: '缺少 index.html',
        hint: 'HyperFrames 默认渲染项目根目录的 index.html；也可以在最下方手动指定一个独立的 composition 文件。'
      })
    }

    const isHyperframesProject = hasIndexHtml || hasHyperframesConfig

    let width: number | undefined
    let height: number | undefined
    let duration: number | undefined
    let fps: number | undefined
    let name = packageName ?? basename(path)
    let compositions: CompositionInfo[] = []
    let metadata: ProjectMetadata | undefined
    let fromCache: boolean | undefined

    if (options.deep !== false && isHyperframesProject) {
      if (this.metadataProvider) {
        // 缓存优先：命中时只做一次文件指纹校验，不再执行 info / compositions
        const result = await this.metadataProvider({
          projectPath: path,
          composition: options.composition ?? null
        })
        if (result) {
          metadata = result.metadata
          fromCache = result.fromCache
          width = metadata.width ?? undefined
          height = metadata.height ?? undefined
          duration = metadata.durationSec ?? undefined
          fps = metadata.projectFps ?? undefined
          compositions = metadata.compositions
          if (metadata.name) name = metadata.name
        }
      } else {
        const enriched = await this.readCliInfo(path)
        width = enriched.width
        height = enriched.height
        duration = enriched.duration
        compositions = enriched.compositions
        if (enriched.name) name = enriched.name
      }
    }

    const valid = hasIndexHtml
    const info: ProjectInfo = {
      path,
      name,
      valid,
      isHyperframesProject,
      hasIndexHtml,
      hasPackageJson,
      hasHyperframesConfig,
      packageName,
      width,
      height,
      duration,
      fps,
      compositions,
      metadata,
      issues,
      checkedAt: new Date().toISOString(),
      fromCache
    }

    this.cache.set(path.toLowerCase(), { info, at: Date.now() })
    return { info }
  }

  /** 仅在没有元数据服务时使用的兜底实现（正常路径不会走到） */
  private async readCliInfo(
    path: string
  ): Promise<{ name?: string; width?: number; height?: number; duration?: number; compositions: CompositionInfo[] }> {
    const cliCommand = await this.cliCommand()
    const [infoRes, compRes] = await Promise.all([
      runCliCapture(['info', path, '--json'], cliCommand, { cwd: path, timeoutMs: 90_000 }),
      runCliCapture(['compositions', path, '--json'], cliCommand, { cwd: path, timeoutMs: 90_000 })
    ])

    const info = infoRes.code === 0 ? extractJsonObject<InfoJson>(infoRes.stdout) : null
    const comps = compRes.code === 0 ? extractJsonObject<CompositionsJson>(compRes.stdout) : null

    return {
      name: info?.name,
      width: info?.width,
      height: info?.height,
      duration: info?.duration,
      compositions: comps?.compositions ?? []
    }
  }

  /** 递归列出项目内的 html 文件（相对路径），供选择 composition 使用 */
  async htmlFiles(path: string, maxDepth = 3): Promise<string[]> {
    return listHtmlFiles(this.normalizePath(path), maxDepth)
  }

  async compositions(path: string): Promise<CompositionInfo[]> {
    const normalized = this.normalizePath(path)
    const cached = this.cache.get(normalized.toLowerCase())
    if (cached && Date.now() - cached.at < 30_000 && cached.info.compositions.length > 0) {
      return cached.info.compositions
    }
    // 有元数据服务时优先走缓存（避免为一个下拉框再跑一次 CLI）
    if (this.metadataProvider) {
      const result = await this.metadataProvider({ projectPath: normalized })
      if (result && result.metadata.compositions.length > 0) return result.metadata.compositions
    }
    const cliCommand = await this.cliCommand()
    const res = await runCliCapture(['compositions', normalized, '--json'], cliCommand, {
      cwd: normalized,
      timeoutMs: 90_000
    })
    if (res.code !== 0) return []
    const data = extractJsonObject<CompositionsJson>(res.stdout)
    return data?.compositions ?? []
  }

  /** 运行 `hyperframes lint`（预留能力，UI 以结构化方式展示） */
  async lint(
    path: string
  ): Promise<{ ok: boolean; findings: { level: 'error' | 'warning' | 'info'; message: string }[]; error?: string; raw?: string }> {
    const cliCommand = await this.cliCommand()
    const res = await runCliCapture(['lint', '--json', '--verbose'], cliCommand, {
      cwd: this.normalizePath(path),
      timeoutMs: 120_000
    })
    const raw = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
    if (res.error) return { ok: false, findings: [], error: res.error, raw }

    interface LintJson {
      findings?: { level?: string; severity?: string; message?: string; title?: string; file?: string }[]
      errors?: number
      warnings?: number
    }
    const data = extractJsonObject<LintJson>(res.stdout)
    if (!data) {
      return {
        ok: res.code === 0,
        findings: [],
        error: res.code === 0 ? undefined : stripAnsi(res.stderr).trim() || 'lint 执行失败',
        raw
      }
    }
    const findings = (data.findings ?? []).map((f) => {
      const level = (f.level ?? f.severity ?? 'info').toLowerCase()
      return {
        level: (level === 'error' ? 'error' : level === 'warning' || level === 'warn' ? 'warning' : 'info') as
          | 'error'
          | 'warning'
          | 'info',
        message: f.message ?? f.title ?? '未知问题'
      }
    })
    return { ok: res.code === 0, findings, raw }
  }
}
