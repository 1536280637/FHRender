import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  extractJsonObject,
  findExecutable,
  findNodeExecutable,
  resolveNpmCliJs,
  runCliCapture,
  runNpmCapture,
  runProcess,
  stripAnsi
} from './hyperframes'
import type { EnvironmentCheckItem, EnvironmentReport } from '@shared/types/settings'
import { EnvironmentProfileCache } from '../cache/environment-profile-cache'

interface DoctorCheck {
  name: string
  ok: boolean
  detail?: string
  hint?: string
}

interface DoctorJson {
  ok: boolean
  platform?: string
  arch?: string
  checks: DoctorCheck[]
}

const MIN_NODE_MAJOR = 18
const RECOMMENDED_NODE_MAJOR = 20

function majorOf(version: string): number {
  const m = version.match(/(\d+)\./)
  return m ? Number(m[1]) : 0
}

export type ProjectProbe = (projectPath: string) => Promise<EnvironmentCheckItem>

/**
 * 轻量的 Node / npm / npx 探测（几十毫秒，不跑 doctor）。
 * 启动预热时调用一次，结果写入 EnvironmentProfileCache，之后直接复用。
 */
export async function probeNodeEnvironment(): Promise<{
  nodeVersion: string | null
  nodePath: string | null
  npmPath: string | null
  npxPath: string | null
  npmVersion: string | null
  npxCliJs: string | null
}> {
  const nodePath = findNodeExecutable()
  const npmPath = findExecutable('npm')
  const npxPath = findExecutable('npx')
  let nodeVersion: string | null = null
  if (nodePath) {
    const res = await runProcess(nodePath, ['-v'], { timeoutMs: 15_000 })
    const text = stripAnsi(res.stdout || res.stderr).trim()
    nodeVersion = res.code === 0 && text ? text : null
  }
  let npmVersion: string | null = null
  if (npmPath) {
    const res = await runNpmCapture('npm', ['-v'], 20_000)
    const text = stripAnsi(res.stdout).trim().split(/\r?\n/).pop() ?? ''
    npmVersion = res.code === 0 && text ? text : null
  }
  const npxCliJs = npxPath ? await resolveNpmCliJs(npxPath) : null
  return { nodeVersion, nodePath, npmPath, npxPath, npmVersion, npxCliJs }
}

export class EnvironmentService {
  private cliCommand: () => Promise<string>
  private projectProbe: ProjectProbe | null = null
  private envCache: EnvironmentProfileCache

  constructor(cliCommand: () => Promise<string>, envCache = new EnvironmentProfileCache()) {
    this.cliCommand = cliCommand
    this.envCache = envCache
  }

  setProjectProbe(probe: ProjectProbe): void {
    this.projectProbe = probe
  }

  /**
   * 环境检查。
   *
   * `doctor --json` 在本机要跑十几秒，因此机器级结果按「CLI 命令 + Node 路径 +
   * CLI 版本」缓存 12 小时；当前项目那一项始终实时判断（它便宜且会变）。
   * 只有手动「重新检查」或缓存过期/版本变化才会真的再跑一次 doctor。
   */
  async check(projectPath?: string, options: { force?: boolean } = {}): Promise<EnvironmentReport> {
    const cliCommand = await this.cliCommand()
    const nodeExe = findNodeExecutable()
    const cliVersion = await this.envCache.getCliVersion(cliCommand)
    const key = `${cliCommand}|${nodeExe ?? 'none'}|${cliVersion ?? 'unknown'}`

    let base: EnvironmentReport | null = options.force ? null : await this.envCache.getDoctor(key)
    let fromCache = true
    if (!base) {
      fromCache = false
      base = await this.checkMachine(cliCommand)
      await this.envCache.saveDoctor(key, base)
    }

    const items: EnvironmentCheckItem[] = [...base.items]
    if (projectPath && this.projectProbe) {
      items.push(await this.projectProbe(projectPath))
    } else {
      items.push({
        id: 'project',
        label: '当前项目',
        status: 'warning',
        detail: '尚未选择项目',
        hint: '选择包含 index.html 的 HyperFrames 项目目录。'
      })
    }

    const hasError = items.some((i) => i.status === 'error')
    const hasWarning = items.some((i) => i.status === 'warning')
    return {
      ...base,
      items,
      status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
      fromCache
    }
  }

  /** 机器级检查（Node / npm / CLI / Chrome / FFmpeg / doctor），结果可缓存 */
  private async checkMachine(cliCommand: string): Promise<EnvironmentReport> {
    const items: EnvironmentCheckItem[] = []

    /* ---------- Node.js ---------- */
    const nodeExe = findNodeExecutable()
    let nodeVersion = ''
    if (!nodeExe) {
      items.push({
        id: 'node',
        label: 'Node.js',
        status: 'error',
        detail: '未在 PATH 中找到 node',
        hint: '请安装 Node.js 18 及以上版本（建议 20/22 LTS），安装后重启本应用。'
      })
    } else {
      const versionRes = await this.runNodeVersion(nodeExe)
      nodeVersion = versionRes.version
      if (versionRes.error) {
        items.push({
          id: 'node',
          label: 'Node.js',
          status: 'error',
          detail: versionRes.error,
          hint: '无法执行 node -v，请检查 Node.js 安装是否完整。'
        })
      } else {
        const major = majorOf(nodeVersion)
        if (major < MIN_NODE_MAJOR) {
          items.push({
            id: 'node',
            label: 'Node.js',
            status: 'error',
            detail: `${nodeVersion}（低于 ${MIN_NODE_MAJOR}）`,
            hint: `HyperFrames 需要 Node.js ${MIN_NODE_MAJOR}+，建议升级到 20/22 LTS。`
          })
        } else {
          items.push({
            id: 'node',
            label: 'Node.js',
            status: major < RECOMMENDED_NODE_MAJOR ? 'warning' : 'ok',
            detail: `${nodeVersion} · ${nodeExe}`,
            hint: major < RECOMMENDED_NODE_MAJOR ? '版本可用，但建议升级到 20/22 LTS。' : undefined
          })
        }
      }
    }

    /* ---------- npm / npx ---------- */
    const npmPath = findExecutable('npm')
    const npxPath = findExecutable('npx')
    if (!npmPath || !npxPath) {
      items.push({
        id: 'npm',
        label: 'npm / npx',
        status: 'error',
        detail: !npmPath && !npxPath ? '未找到 npm 与 npx' : !npmPath ? '未找到 npm' : '未找到 npx',
        hint: 'npm 通常随 Node.js 一起安装，请重新安装官方 Node.js 发行版。'
      })
    } else {
      const npmRes = await runNpmCapture('npm', ['-v'], 20_000)
      const version = stripAnsi(npmRes.stdout).trim().split(/\r?\n/).pop() ?? ''
      const npxCli = await resolveNpmCliJs(npxPath)
      const ok = npmRes.code === 0 && !!version
      items.push({
        id: 'npm',
        label: 'npm / npx',
        status: ok ? 'ok' : 'error',
        detail: ok
          ? `npm ${version}${npxCli ? ' · npx 可解析' : ''}`
          : (npmRes.error ?? stripAnsi(npmRes.stderr).trim() ?? 'npm 无法执行'),
        hint: ok ? undefined : 'npm 无法执行，请重新安装 Node.js。'
      })
    }

    /* ---------- HyperFrames CLI + 系统依赖（doctor） ---------- */
    const doctor = await this.runDoctor(cliCommand)
    let cliVersion: string | undefined

    if (doctor.error) {
      items.push({
        id: 'hyperframes',
        label: 'HyperFrames CLI',
        status: 'error',
        detail: doctor.error,
        hint: '确认网络可用、npm 可访问 registry，或先在终端执行 `npx hyperframes --help` 完成首次下载。'
      })
    } else {
      const checks = doctor.data?.checks ?? []
      const versionCheck = checks.find((c) => /^version$/i.test(c.name))
      cliVersion = versionCheck?.detail?.split(/\s+/)[0]
      items.push({
        id: 'hyperframes',
        label: 'HyperFrames CLI',
        status: cliVersion ? 'ok' : 'warning',
        detail: cliVersion ? `v${cliVersion} · ${cliCommand}` : `已可以调用 · ${cliCommand}`,
        hint: cliVersion ? undefined : '未能从 doctor 输出中读取版本号。'
      })

      const pick = (name: RegExp) => checks.find((c) => name.test(c.name))

      const chrome = pick(/^chrome$/i)
      items.push({
        id: 'chrome',
        label: 'Chrome / 渲染浏览器',
        status: !chrome ? 'warning' : chrome.ok ? 'ok' : 'error',
        detail: chrome?.detail ?? 'doctor 未返回 Chrome 检查项',
        hint: chrome && !chrome.ok ? '首次渲染时 CLI 会自动下载 chrome-headless-shell，请保持网络畅通。' : undefined
      })

      const ffmpeg = pick(/^ffmpeg$/i)
      items.push({
        id: 'ffmpeg',
        label: 'FFmpeg',
        status: !ffmpeg ? 'warning' : ffmpeg.ok ? 'ok' : 'error',
        detail: ffmpeg?.detail ?? 'doctor 未返回 FFmpeg 检查项',
        hint: ffmpeg && !ffmpeg.ok ? '请安装 FFmpeg 并加入 PATH。' : undefined
      })

      const ffprobe = pick(/^ffprobe$/i)
      if (ffprobe) {
        items.push({
          id: 'ffprobe',
          label: 'FFprobe',
          status: ffprobe.ok ? 'ok' : 'warning',
          detail: ffprobe.detail ?? '未找到',
          hint: ffprobe.ok ? undefined : '缺少 ffprobe 时部分素材探测能力会受限，建议与 FFmpeg 一同安装。'
        })
      }

      const docker = pick(/^docker$/i)
      if (docker) {
        items.push({
          id: 'docker',
          label: 'Docker（可选）',
          status: 'unknown',
          detail: docker.ok ? (docker.detail ?? '可用') : '未安装（仅 Docker 渲染模式需要）',
          hint: docker.ok ? undefined : undefined
        })
      }

      const memory = pick(/^memory$/i)
      const disk = pick(/^disk$/i)
      if (memory || disk) {
        items.push({
          id: 'resources',
          label: '内存 / 磁盘',
          status: 'ok',
          detail: [memory?.detail, disk?.detail].filter(Boolean).join(' · ') || '未知'
        })
      }

    }

    /* ---------- 当前项目 ---------- */
    // 项目状态由 check() 实时追加，这里只返回机器级结论

    const hasError = items.some((i) => i.status === 'error')
    const hasWarning = items.some((i) => i.status === 'warning')

    return {
      checkedAt: new Date().toISOString(),
      status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
      items,
      raw: doctor.raw,
      cliVersion,
      nodeVersion: nodeVersion || undefined
    }
  }

  private runNodeVersion(nodeExe: string): Promise<{ version: string; error?: string }> {
    return runProcess(nodeExe, ['-v'], { timeoutMs: 15_000 }).then((res) => {
      const version = stripAnsi(res.stdout || res.stderr).trim()
      if (res.error) return { version: '', error: res.error }
      if (res.code !== 0 || !version) {
        return { version: '', error: stripAnsi(res.stderr).trim() || 'node -v 执行失败' }
      }
      return { version }
    })
  }

  private async runDoctor(
    cliCommand: string,
    projectPath?: string
  ): Promise<{ data?: DoctorJson; raw?: string; error?: string }> {
    const cwd = projectPath && existsSync(projectPath) ? projectPath : homedir()
    const res = await runCliCapture(['doctor', '--json'], cliCommand, {
      cwd,
      timeoutMs: 240_000
    })
    const raw = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
    if (res.error) return { error: res.error, raw }
    const data = extractJsonObject<DoctorJson>(res.stdout)
    if (!data) {
      if (res.timedOut) return { error: 'doctor 执行超时（4 分钟）', raw }
      const message = stripAnsi(res.stderr).trim().split(/\r?\n/).slice(-4).join(' ').trim()
      return {
        error: message || `doctor 未返回可解析的 JSON（退出码 ${res.code ?? 'unknown'}）`,
        raw
      }
    }
    return { data, raw }
  }
}

/** 项目状态 -> 环境检查项 */
export function buildProjectCheckItem(input: {
  path: string
  valid: boolean
  hasIndexHtml: boolean
  width?: number
  height?: number
  issues: { level: 'error' | 'warning' | 'info'; message: string; hint?: string }[]
}): EnvironmentCheckItem {
  if (input.valid) {
    return {
      id: 'project',
      label: '当前项目',
      status: 'ok',
      detail: `${input.path}${input.width ? ` · ${input.width}×${input.height}` : ''}`
    }
  }
  const first = input.issues.find((i) => i.level === 'error') ?? input.issues[0]
  return {
    id: 'project',
    label: '当前项目',
    status: input.issues.some((i) => i.level === 'error') ? 'error' : 'warning',
    detail: first?.message ?? '项目无效',
    hint: first?.hint
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
