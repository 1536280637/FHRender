import { existsSync, promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ChildProcess } from 'node:child_process'
import { PreviewCliAdapter } from './cli-adapter'
import type {
  PreviewActionResult,
  PreviewCapabilities,
  PreviewRuntimeState,
  PreviewSession
} from '@shared/types/preview'

const NO_CAPABILITIES: PreviewCapabilities = {
  helpAvailable: false,
  background: false,
  noOpen: false,
  json: false,
  status: false,
  stop: false,
  list: false
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** 项目路径归一化（Windows 大小写与斜杠差异会导致同一个项目被当成两个） */
export function previewKey(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 只允许回环地址的 HTTP(S) URL —— 预览服务永远在本机 */
export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** HTTP 探活（不走系统代理，避免 Clash 等代理返回 502 造成误判） */
export function pingUrl(raw: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((done) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      done(value)
    }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      finish(false)
      return
    }
    const isHttps = url.protocol === 'https:'
    if (!isHttps && url.protocol !== 'http:') {
      finish(false)
      return
    }
    try {
      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname || '/'}${url.search}`,
          method: 'GET',
          timeout: timeoutMs,
          headers: { 'User-Agent': 'HF-Render-Preview-Probe', Accept: '*/*' }
        },
        (res) => {
          res.resume()
          const code = res.statusCode ?? 0
          finish(code >= 200 && code < 500)
        }
      )
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.on('error', () => finish(false))
      req.end()
    } catch {
      finish(false)
    }
  })
}

async function waitForHealth(url: string | null, timeoutMs: number): Promise<boolean> {
  if (!url) return false
  const deadline = Date.now() + timeoutMs
  do {
    if (await pingUrl(url)) return true
    await delay(300)
  } while (Date.now() < deadline)
  return false
}

interface ProjectCheck {
  ok: boolean
  path: string
  name: string
  error?: string
}

export interface PreviewManagerDeps {
  getCliCommand: () => Promise<string>
  /** 用系统默认浏览器打开（shell.openExternal） */
  openExternal: (url: string) => Promise<void>
  onState?: (state: PreviewRuntimeState) => void
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void
}

/**
 * 预览服务管理器。
 *
 * 职责：
 * - 通过 HyperFrames CLI 启动 / 查询 / 停止预览服务（绝不自建 Studio）。
 * - 记录每个项目的服务信息与归属（本应用启动 or 外部启动）。
 * - 应用退出时只停止「本应用启动」的服务，不误杀用户自己的服务。
 * - 打开浏览器前校验 URL 协议与主机，且只使用 CLI 返回的真实 Studio 地址。
 */
export class PreviewManager {
  private adapter: PreviewCliAdapter
  private deps: PreviewManagerDeps
  private sessions = new Map<string, PreviewSession>()
  private foreground = new Map<string, ChildProcess>()
  private pending = new Map<string, Promise<PreviewActionResult>>()
  private capabilities: PreviewCapabilities = { ...NO_CAPABILITIES }
  private cliVersion: string | null = null
  private helpError: string | null = null
  private probePromise: Promise<PreviewCapabilities> | null = null
  private currentKey: string | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private polling = false
  /** 连续探活失败次数（用于判断服务是否真的挂了） */
  private failStreak = new Map<string, number>()
  private disposed = false

  constructor(deps: PreviewManagerDeps) {
    this.deps = deps
    this.adapter = new PreviewCliAdapter(deps.getCliCommand)
    this.healthTimer = setInterval(() => void this.pollHealth(), 7000)
    this.healthTimer.unref?.()
  }

  /* ------------------------------ 查询 ------------------------------ */

  async getState(projectPath?: string | null): Promise<PreviewRuntimeState> {
    if (projectPath) this.currentKey = previewKey(projectPath)
    await this.ensureCapabilities()
    return this.snapshot()
  }

  /** 主动与 CLI 对账（页面打开、项目切换、操作后调用） */
  async refresh(projectPath?: string | null): Promise<PreviewRuntimeState> {
    if (projectPath) this.currentKey = previewKey(projectPath)
    await this.ensureCapabilities()
    const key = this.currentKey
    if (!key) return this.snapshot()
    const session = this.sessions.get(key)
    if (!session || session.status !== 'running') return this.snapshot()

    if (this.cliVersion) session.cliVersion = this.cliVersion
    if (this.capabilities.status) {
      const run = await this.adapter.status(session.projectPath)
      const state = run.ok ? String(run.result?.state ?? '') : ''
      if (state === 'not-running') {
        // CLI 认为没在跑：再确认一次 HTTP，避免 CLI 状态文件滞后
        const alive = await pingUrl(session.serverUrl ?? '')
        if (!alive) {
          this.sessions.delete(key)
          this.emit()
          return this.snapshot()
        }
      }
      if (state === 'running') {
        const port = Number(run.result?.port)
        if (Number.isFinite(port) && port > 0 && port !== session.port) {
          session.port = port
          session.serverUrl = `http://127.0.0.1:${port}`
          session.studioUrl = await this.lookupStudioUrl(session.projectPath, port)
        }
      }
    }
    session.healthy = await pingUrl(session.serverUrl ?? '')
    session.checkedAt = new Date().toISOString()
    this.emit()
    return this.snapshot()
  }

  async list(): Promise<PreviewSession[]> {
    await this.ensureCapabilities()
    if (this.capabilities.list) {
      const run = await this.adapter.list()
      const sessions = run.ok ? run.result?.sessions ?? [] : []
      const seen = new Set<string>()
      for (const item of sessions) {
        const dir = typeof item.projectDir === 'string' ? item.projectDir : ''
        const port = Number(item.port)
        if (!dir || !Number.isFinite(port) || port <= 0) continue
        const key = previewKey(dir)
        seen.add(key)
        const known = this.sessions.get(key)
        const studioUrl =
          typeof item.studioUrl === 'string' && isLoopbackHttpUrl(item.studioUrl)
            ? item.studioUrl
            : await this.lookupStudioUrl(dir, port)
        const session: PreviewSession = {
          projectPath: resolve(dir),
          projectName: String(item.projectName ?? basename(dir)),
          status: 'running',
          port,
          studioUrl,
          serverUrl:
            typeof item.serverUrl === 'string' && isLoopbackHttpUrl(item.serverUrl)
              ? item.serverUrl
              : `http://127.0.0.1:${port}`,
          startedAt: known?.startedAt ?? null,
          cliVersion: known?.cliVersion ?? this.cliVersion,
          source: known?.owned ? 'app' : 'external',
          owned: known?.owned ?? false,
          healthy: true,
          mode: known?.mode ?? 'background',
          pid: Number.isFinite(Number(item.pid)) ? Number(item.pid) : null,
          logPath: typeof item.logPath === 'string' ? item.logPath : null,
          error: null,
          checkedAt: new Date().toISOString()
        }
        this.sessions.set(key, session)
      }
      /*
       * CLI 的列表通常可以当权威，但 hyperframes 0.8.175 的 `preview --list` 在服务
       * 确实在跑时也会返回空数组（已实测）。所以不能凭"不在列表里"就删会话，
       * 也不能凭一次端口探活失败就删——这里只标记不健康，是否判定为 error
       * 交给 pollHealth（连续 2 次失败）决定，避免一次抖动把会话从界面上抹掉。
       */
      if (run.ok) {
        for (const [key, session] of [...this.sessions]) {
          if (seen.has(key)) continue
          if (this.pending.has(key)) continue
          if (session.status !== 'running') continue
          const port = session.port
          const probe =
            session.serverUrl || (typeof port === 'number' && port > 0 ? `http://127.0.0.1:${port}` : '')
          const alive = probe ? await pingUrl(probe, 1500) : false
          session.checkedAt = new Date().toISOString()
          if (alive) {
            session.healthy = true
            continue
          }
          session.healthy = false
          session.error = session.error ?? '预览服务暂时无响应（健康检查会继续重试）'
        }
      }
    }
    return [...this.sessions.values()].filter((s) => s.status === 'running')
  }

  /* ------------------------------ 启动 ------------------------------ */

  async start(projectPath: string): Promise<PreviewActionResult> {
    const key = previewKey(projectPath)
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.doStart(projectPath).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  private async doStart(projectPath: string): Promise<PreviewActionResult> {
    this.currentKey = previewKey(projectPath)
    try {
      return await this.startInternal(projectPath)
    } catch (err) {
      // 兜底：任何未预期异常都要落到错误态，不能把会话卡在“启动中”
      const key = previewKey(projectPath)
      return this.fail(key, err instanceof Error ? err.message : String(err))
    }
  }

  private async startInternal(projectPath: string): Promise<PreviewActionResult> {
    this.currentKey = previewKey(projectPath)
    const check = await this.validateProject(projectPath)
    if (!check.ok) return { ok: false, error: check.error ?? '项目无效' }

    await this.ensureCapabilities()
    if (!this.capabilities.helpAvailable) {
      return {
        ok: false,
        error:
          this.helpError ??
          '无法使用 HyperFrames preview：请确认已安装 Node.js 18+ 与 HyperFrames CLI（npm i -g hyperframes）'
      }
    }

    const key = previewKey(check.path)
    const known = this.sessions.get(key)

    // 1) 本进程已记录的健康服务：直接复用并打开，不重复启动
    if (known && known.status === 'running' && known.studioUrl) {
      const alive = await pingUrl(known.serverUrl ?? '')
      if (alive) {
        known.healthy = true
        known.checkedAt = new Date().toISOString()
        this.emit()
        const opened = await this.openStudio(known)
        return { ok: true, session: known, opened, reused: true }
      }
    }

    // 2) 让 CLI 自己判断：已有同项目服务时会返回 reused，不会重复启动
    const starting = this.createSession(check)
    starting.status = 'starting'
    starting.source = 'app'
    starting.owned = true
    this.sessions.set(key, starting)
    this.emit()

    // 只保留一个由本应用持有的预览服务，避免留下无主后台进程
    await this.stopOtherOwned(key)

    if (this.capabilities.background) {
      const run = await this.adapter.startBackground(check.path)
      if (!run.ok || !run.result) {
        return this.fail(key, run.error ?? '启动 HyperFrames Preview 失败')
      }
      const result = run.result
      const port = Number(result.port)
      const serverUrl =
        typeof result.serverUrl === 'string' && isLoopbackHttpUrl(result.serverUrl)
          ? result.serverUrl
          : Number.isFinite(port) && port > 0
            ? `http://127.0.0.1:${port}`
            : null
      const studioUrl =
        typeof result.studioUrl === 'string' && isLoopbackHttpUrl(result.studioUrl)
          ? result.studioUrl
          : null
      if (!serverUrl || !studioUrl) {
        return this.fail(key, 'HyperFrames CLI 未返回可用的预览地址，已取消打开浏览器')
      }

      const reusedByCli = result.state === 'reused'
      const healthy = await waitForHealth(serverUrl, 8000)
      const session: PreviewSession = {
        ...starting,
        status: healthy ? 'running' : 'error',
        port: Number.isFinite(port) && port > 0 ? port : null,
        serverUrl,
        studioUrl,
        pid: Number.isFinite(Number(result.pid)) ? Number(result.pid) : null,
        logPath: typeof result.logPath === 'string' ? result.logPath : null,
        mode: 'background',
        // CLI 复用的服务不是本应用启动的：标记为 external，退出时不擅自停止
        source: reusedByCli && !known?.owned ? 'external' : 'app',
        owned: reusedByCli ? Boolean(known?.owned) : true,
        healthy,
        startedAt: new Date().toISOString(),
        error: healthy ? null : '预览服务已启动但没有响应 HTTP 探活，请稍后重试'
      }
      this.sessions.set(key, session)

      if (!healthy) {
        this.emit()
        return { ok: false, session, error: session.error ?? '预览服务未就绪' }
      }

      this.emit()
      const opened = await this.openStudio(session)
      return { ok: true, session, opened, reused: reusedByCli }
    }

    // 3) 旧版 CLI 没有 --background：由本应用持有前台子进程
    return this.startForeground(check, starting)
  }

  /** 旧版 CLI 兜底：前台子进程 + 从输出里解析 Studio 地址 */
  private async startForeground(check: ProjectCheck, starting: PreviewSession): Promise<PreviewActionResult> {
    const key = previewKey(check.path)
    // 用对象持有解析结果，避免闭包赋值被 TS 的窄化分析误判
    const found: { studioUrl: string | null; serverUrl: string | null } = {
      studioUrl: null,
      serverUrl: null
    }

    const spawned = await this.adapter.spawnForeground(check.path, (line) => {
      const studio = line.match(/Studio\s+(https?:\/\/\S+)/i)
      if (studio && !found.studioUrl) found.studioUrl = studio[1].trim()
      const server = line.match(/Server\s+(https?:\/\/\S+)/i)
      if (server && !found.serverUrl) found.serverUrl = server[1].trim()
    })
    if (!spawned.child) {
      return this.fail(key, spawned.error ?? '无法启动预览进程')
    }
    this.foreground.set(key, spawned.child)

    spawned.child.once('exit', (code) => {
      const session = this.sessions.get(key)
      this.foreground.delete(key)
      if (!session || session.mode !== 'foreground' || session.status !== 'running') return
      session.status = 'error'
      session.healthy = false
      session.error = `预览进程已退出（code ${code ?? 'null'}）`
      this.emit()
    })

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && !found.studioUrl) {
      await delay(300)
      if (!this.foreground.has(key)) break
    }
    const studioUrl = found.studioUrl
    if (!studioUrl) {
      this.adapter.killForeground(spawned.child)
      this.foreground.delete(key)
      return this.fail(key, '预览进程启动超时，未获取到 Studio 地址')
    }
    if (!isLoopbackHttpUrl(studioUrl)) {
      this.adapter.killForeground(spawned.child)
      this.foreground.delete(key)
      return this.fail(key, 'CLI 返回的 Studio 地址不是本机地址，已拒绝打开')
    }

    let port: number | null = null
    try {
      const parsedPort = Number(new URL(studioUrl).port)
      port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null
    } catch {
      port = null
    }

    const healthy = await waitForHealth(found.serverUrl ?? studioUrl, 10_000)
    const session: PreviewSession = {
      ...starting,
      status: healthy ? 'running' : 'error',
      port,
      serverUrl: found.serverUrl,
      studioUrl,
      mode: 'foreground',
      pid: spawned.child.pid ?? null,
      healthy,
      startedAt: new Date().toISOString(),
      error: healthy ? null : '预览进程已启动但没有响应'
    }
    this.sessions.set(key, session)
    this.emit()
    if (!healthy) return { ok: false, session, error: session.error ?? '预览服务未就绪' }
    const opened = await this.openStudio(session)
    return { ok: true, session, opened }
  }

  /* ------------------------------ 打开 ------------------------------ */

  async open(projectPath: string): Promise<PreviewActionResult> {
    const key = previewKey(projectPath)
    this.currentKey = key
    const session = this.sessions.get(key)
    if (!session || session.status !== 'running' || !session.studioUrl) {
      return this.start(projectPath)
    }
    session.healthy = await pingUrl(session.serverUrl ?? '')
    session.checkedAt = new Date().toISOString()
    if (!session.healthy) {
      this.emit()
      return {
        ok: false,
        session,
        error: '预览服务当前无响应，请停止后重新开启预览'
      }
    }
    this.emit()
    const opened = await this.openStudio(session)
    return { ok: true, session, opened }
  }

  private async openStudio(session: PreviewSession): Promise<boolean> {
    const url = session.studioUrl
    if (!url || !isLoopbackHttpUrl(url)) {
      session.error = 'Studio 地址无效或不是本机地址，已拒绝打开'
      return false
    }
    try {
      await this.deps.openExternal(url)
      return true
    } catch (err) {
      session.error = `打开浏览器失败：${err instanceof Error ? err.message : String(err)}`
      return false
    }
  }

  /* ------------------------------ 停止 ------------------------------ */

  async stop(projectPath: string): Promise<PreviewActionResult> {
    const key = previewKey(projectPath)
    await this.ensureCapabilities()
    const session = this.sessions.get(key)
    if (!session) {
      const check = await this.validateProject(projectPath)
      if (!check.ok) return { ok: false, error: check.error }
      await this.ensureCapabilities()
      const run = this.capabilities.stop ? await this.adapter.stop(check.path) : null
      if (run && !run.ok) return { ok: false, error: run.error ?? '停止预览服务失败' }
      return { ok: true, session: null }
    }
    session.status = 'stopping'
    this.emit()
    const error = await this.stopInternal(session)
    return error ? { ok: false, error, session } : { ok: true, session: null }
  }

  /** 真正执行停止：本应用持有的前台子进程直接结束；后台服务交给 CLI --stop */
  private async stopInternal(session: PreviewSession): Promise<string | null> {
    const key = previewKey(session.projectPath)
    const child = this.foreground.get(key)
    if (child) {
      this.adapter.killForeground(child)
      this.foreground.delete(key)
    }
    let error: string | null = null
    if (this.capabilities.stop) {
      const run = await this.adapter.stop(session.projectPath)
      if (!run.ok) error = run.error ?? '停止预览服务失败'
    } else if (!child) {
      error = '当前 CLI 不支持 --stop，无法安全停止该预览服务'
    }
    // 确认端口已经关闭，避免 UI 显示“已停止”但服务仍在
    if (!error) {
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        if (!(await pingUrl(session.serverUrl ?? '', 1200))) break
        await delay(250)
      }
      if (await pingUrl(session.serverUrl ?? '', 1200)) {
        error = '预览服务仍在响应，停止未生效'
      }
    }
    this.sessions.delete(key)
    if (this.currentKey === key) this.currentKey = null
    this.emit()
    return error
  }

  /** 启动新项目前，停掉本应用启动的其它项目服务 */
  private async stopOtherOwned(keepKey: string): Promise<void> {
    for (const [key, session] of [...this.sessions]) {
      if (key === keepKey) continue
      if (!session.owned) continue
      if (session.status !== 'running' && session.status !== 'error') {
        this.sessions.delete(key)
        continue
      }
      this.deps.log?.(`切换预览项目：停止 ${session.projectName} 的预览服务`, 'info')
      session.status = 'stopping'
      await this.stopInternal(session)
    }
  }

  /** 应用退出：只停止由本实例启动的服务 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    const owned = [...this.sessions.values()].filter((s) => s.owned)
    await Promise.all(
      owned.map(async (session) => {
        const child = this.foreground.get(previewKey(session.projectPath))
        if (child) {
          this.adapter.killForeground(child)
          this.foreground.delete(previewKey(session.projectPath))
        }
        if (this.capabilities.stop) {
          await this.adapter.stop(session.projectPath).catch(() => undefined)
        }
        this.sessions.delete(previewKey(session.projectPath))
      })
    )
  }

  /* ------------------------------ 内部 ------------------------------ */

  private createSession(check: ProjectCheck): PreviewSession {
    return {
      projectPath: check.path,
      projectName: check.name,
      status: 'idle',
      port: null,
      studioUrl: null,
      serverUrl: null,
      startedAt: null,
      cliVersion: this.cliVersion,
      source: 'app',
      owned: false,
      healthy: false,
      mode: null,
      pid: null,
      logPath: null,
      error: null,
      checkedAt: null
    }
  }

  private fail(key: string, error: string): PreviewActionResult {
    const session = this.sessions.get(key)
    if (session) {
      session.status = 'error'
      session.healthy = false
      session.error = error
    }
    this.emit()
    return { ok: false, error, session: session ?? null }
  }

  private async validateProject(input: string): Promise<ProjectCheck> {
    const path = resolve(input)
    if (!path) return { ok: false, path, name: '', error: '未提供项目路径' }
    if (!existsSync(path)) return { ok: false, path, name: basename(path), error: `项目目录不存在：${path}` }
    try {
      const stat = await fs.stat(path)
      if (!stat.isDirectory()) {
        return { ok: false, path, name: basename(path), error: '选择的路径不是文件夹' }
      }
    } catch (err) {
      return {
        ok: false,
        path,
        name: basename(path),
        error: `无法读取项目目录：${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (!existsSync(join(path, 'index.html'))) {
      return {
        ok: false,
        path,
        name: basename(path),
        error: '项目缺少 index.html，无法启动预览（Preview 只支持标准 HyperFrames 项目）'
      }
    }
    return { ok: true, path, name: basename(path) }
  }

  private async ensureCapabilities(force = false): Promise<PreviewCapabilities> {
    if (this.probePromise && !force) return this.probePromise
    this.probePromise = (async () => {
      const probe = await this.adapter.probe()
      this.capabilities = probe.capabilities
      this.cliVersion = probe.version
      this.helpError = probe.error ?? null
      for (const session of this.sessions.values()) {
        if (this.cliVersion) session.cliVersion = this.cliVersion
      }
      return probe.capabilities
    })()
    return this.probePromise
  }

  /** `--status` 不带 studioUrl，用 `--list` 找到真实 Studio 深链 */
  private async lookupStudioUrl(projectPath: string, port: number): Promise<string> {
    if (this.capabilities.list) {
      const run = await this.adapter.list()
      const found = (run.ok ? run.result?.sessions ?? [] : []).find(
        (s) => typeof s.projectDir === 'string' && previewKey(s.projectDir) === previewKey(projectPath)
      )
      if (found && typeof found.studioUrl === 'string' && isLoopbackHttpUrl(found.studioUrl)) {
        return found.studioUrl
      }
    }
    return `http://127.0.0.1:${port}/`
  }

  private snapshot(): PreviewRuntimeState {
    const current = this.currentKey ? this.sessions.get(this.currentKey) ?? null : null
    return {
      current,
      sessions: [...this.sessions.values()],
      capabilities: { ...this.capabilities },
      cliVersion: this.cliVersion,
      helpError: this.helpError
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.deps.onState?.(this.snapshot())
  }

  /**
   * 周期性健康检查：只做 HTTP 探活，不调用 CLI，避免拖慢渲染。
   *
   * 连续 2 次探活失败才把会话判为 error（单次失败可能只是服务在忙），
   * 这样服务被外部杀掉时界面能及时从「打开预览」变成「重新开启预览」，
   * 而用户只是关掉浏览器（服务仍在跑）时状态不会被打回 idle。
   */
  private async pollHealth(): Promise<void> {
    if (this.polling || this.disposed) return
    const running = [...this.sessions.values()].filter((s) => s.status === 'running' || s.status === 'error')
    if (running.length === 0) return
    this.polling = true
    try {
      let changed = false
      for (const session of running) {
        const alive = await pingUrl(session.serverUrl ?? '')
        const key = previewKey(session.projectPath)
        if (alive) {
          this.failStreak.delete(key)
          if (!session.healthy || session.status === 'error') {
            session.healthy = true
            session.status = 'running'
            session.error = null
            changed = true
          }
        } else {
          const streak = (this.failStreak.get(key) ?? 0) + 1
          this.failStreak.set(key, streak)
          if (session.healthy) {
            session.healthy = false
            changed = true
          }
          if (streak >= 2 && session.status !== 'error') {
            session.status = 'error'
            session.error = '预览服务已停止响应（可能被外部关闭或异常退出），请重新开启预览'
            changed = true
          }
        }
        session.checkedAt = new Date().toISOString()
      }
      if (changed) this.emit()
    } finally {
      this.polling = false
    }
  }
}
