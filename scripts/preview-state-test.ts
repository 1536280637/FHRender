/**
 * 预览状态同步回归测试。
 *
 * 运行：npm run test:preview-state
 *
 * 第一部分（不需要 Electron / CLI）：用假 transport 驱动 PreviewStore，
 * 覆盖 idle → starting → running → stopping → idle、启动失败 → error、外部启动、
 * 浏览器关闭但服务仍在、服务异常退出、切换项目、页面重新挂载。
 *
 * 第二部分（可选，需要本机缓存的 hyperframes CLI）：真实启动 / 停止一次预览服务，
 * 验证 PreviewManager 通过 onState 推送的状态序列（starting → running → idle）。
 */

import assert from 'node:assert'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PreviewStore, derivePreviewPhase, matchSession } from '../src/renderer/src/services/preview-store'
import type { PreviewStoreSnapshot } from '../src/renderer/src/services/preview-store'
import type { PreviewActionResult, PreviewRuntimeState, PreviewSession } from '../src/shared/types/preview'
import { PreviewManager } from '../src/main/preview/preview-manager'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

const PROJ_A = 'D:/tmp/proj-a'
const PROJ_B = 'D:/tmp/proj-b'

function makeSession(projectPath: string, status: PreviewSession['status'] = 'running'): PreviewSession {
  return {
    projectPath,
    projectName: projectPath.split('/').pop() ?? 'proj',
    status,
    port: 4321,
    studioUrl: 'http://127.0.0.1:4321/studio',
    serverUrl: 'http://127.0.0.1:4321',
    startedAt: new Date().toISOString(),
    cliVersion: '0.8.181',
    source: 'app',
    owned: true,
    healthy: status === 'running',
    mode: 'background',
    pid: 1234,
    logPath: null,
    error: status === 'error' ? '预览服务已退出' : null,
    checkedAt: new Date().toISOString()
  }
}

function stateWith(session: PreviewSession | null): PreviewRuntimeState {
  return {
    current: session,
    sessions: session ? [session] : [],
    capabilities: {
      helpAvailable: true,
      background: true,
      noOpen: true,
      json: true,
      status: true,
      stop: true,
      list: true
    },
    cliVersion: '0.8.181',
    helpError: null
  }
}

interface FakeTransportOptions {
  session?: PreviewSession | null
  startResult?: PreviewActionResult
  stopResult?: PreviewActionResult
  delayMs?: number
}

class FakeTransport {
  startCalls = 0
  openCalls = 0
  stopCalls = 0
  statusCalls = 0
  session: PreviewSession | null
  startResult?: PreviewActionResult
  stopResult?: PreviewActionResult
  delayMs: number
  private listeners = new Set<(state: PreviewRuntimeState) => void>()
  /** 测试里手动模拟主进程推送 */
  emit(session: PreviewSession | null): void {
    for (const listener of this.listeners) listener(stateWith(session))
  }
  constructor(options: FakeTransportOptions = {}) {
    this.session = options.session ?? null
    this.startResult = options.startResult
    this.stopResult = options.stopResult
    this.delayMs = options.delayMs ?? 0
  }
  async start(projectPath: string): Promise<PreviewActionResult> {
    this.startCalls += 1
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.startResult) {
      if (this.startResult.session) this.session = this.startResult.session
      return this.startResult
    }
    const session = makeSession(projectPath, 'running')
    this.session = session
    return { ok: true, session, opened: true }
  }
  async open(): Promise<PreviewActionResult> {
    this.openCalls += 1
    return { ok: true, session: this.session, opened: true }
  }
  async stop(): Promise<PreviewActionResult> {
    this.stopCalls += 1
    this.session = null
    return this.stopResult ?? { ok: true, session: null }
  }
  async status(projectPath: string | null): Promise<PreviewRuntimeState> {
    this.statusCalls += 1
    const session = this.session && projectPath && same(this.session.projectPath, projectPath) ? this.session : null
    return stateWith(session)
  }
  async list(): Promise<PreviewSession[]> {
    return this.session ? [this.session] : []
  }
  onEvent(listener: (state: PreviewRuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function same(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()
}

function track(store: PreviewStore): { phases: string[]; seen: PreviewStoreSnapshot } {
  const phases: string[] = []
  const box = { phases, seen: store.getSnapshot() }
  store.subscribe(() => {
    const snap = store.getSnapshot()
    box.seen = snap
    if (phases[phases.length - 1] !== snap.phase) phases.push(snap.phase)
  })
  return box
}

async function findCachedCli(): Promise<string | null> {
  if (process.env.HF_RENDER_E2E_CLI) return process.env.HF_RENDER_E2E_CLI
  const base = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  let dirs: string[] = []
  try {
    dirs = await fs.readdir(base)
  } catch {
    return null
  }
  let best: { version: string; bin: string } | null = null
  for (const dir of dirs) {
    const pkgPath = join(base, dir, 'node_modules', 'hyperframes', 'package.json')
    const binPath = join(base, dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
    if (!existsSync(pkgPath) || !existsSync(binPath)) continue
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { version?: string }
      const version = pkg.version ?? '0.0.0'
      if (!best || version.localeCompare(best.version, undefined, { numeric: true }) > 0) best = { version, bin: binPath }
    } catch {
      /* ignore */
    }
  }
  return best ? `"${process.execPath}" "${best.bin}"` : null
}

async function main(): Promise<void> {
  console.log('\n[1] 状态机（纯函数）')

  await test('会话状态 → 5 态映射覆盖全部情况', () => {
    assert.equal(derivePreviewPhase(null, null, null), 'idle')
    assert.equal(derivePreviewPhase(null, 'starting', null), 'starting')
    assert.equal(derivePreviewPhase(null, 'stopping', null), 'stopping')
    assert.equal(derivePreviewPhase(makeSession(PROJ_A, 'running'), null, null), 'running')
    assert.equal(derivePreviewPhase(makeSession(PROJ_A, 'starting'), null, null), 'starting')
    assert.equal(derivePreviewPhase(makeSession(PROJ_A, 'stopping'), null, null), 'stopping')
    assert.equal(derivePreviewPhase(makeSession(PROJ_A, 'error'), null, null), 'error')
    assert.equal(derivePreviewPhase(null, null, '启动失败'), 'error')
    // 服务在跑时，历史错误不能把按钮打回"重新开启"
    assert.equal(derivePreviewPhase(makeSession(PROJ_A, 'running'), null, '旧错误'), 'running')
  })

  await test('只认同当前项目的会话（不把别的项目服务当成本项目的）', () => {
    const state = stateWith(makeSession(PROJ_B, 'running'))
    assert.equal(matchSession(state, PROJ_A), null)
    assert.ok(matchSession(state, PROJ_B))
  })

  console.log('\n[2] Store：完整生命周期')

  await test('初次进入：idle', async () => {
    const transport = new FakeTransport()
    const store = new PreviewStore(transport)
    const box = track(store)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().phase, 'idle')
    assert.equal(store.getSnapshot().session, null)
    // 主动对账会产生一次 idle 通知（初始态），之后不应再有别的相位
    assert.deepEqual(box.phases, ['idle'])
  })

  await test('点击开启：starting → running（事件到达即时更新）', async () => {
    const transport = new FakeTransport({ delayMs: 30 })
    const store = new PreviewStore(transport)
    const box = track(store)
    await store.setProject(PROJ_A)
    const pending = store.start()
    // 点击瞬间就是 starting，不需要等主进程
    assert.equal(store.getSnapshot().phase, 'starting')
    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(store.getSnapshot().phase, 'running')
    assert.deepEqual(box.phases, ['idle', 'starting', 'running'])
    assert.ok(store.getSnapshot().session?.studioUrl)
  })

  await test('运行中不重复启动，再点只打开已有 Studio', async () => {
    const transport = new FakeTransport()
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    await store.start()
    assert.equal(transport.startCalls, 1)
    const before = transport.startCalls
    await store.open()
    assert.equal(transport.startCalls, before, 'open 不应再次启动服务')
    assert.equal(transport.openCalls, 1)
    assert.equal(store.getSnapshot().phase, 'running')
  })

  await test('主进程直接推送 running（例如服务在外部已启动）→ 按钮立刻变成打开预览', async () => {
    const transport = new FakeTransport()
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().phase, 'idle')
    transport.emit(makeSession(PROJ_A, 'running'))
    assert.equal(store.getSnapshot().phase, 'running')
  })

  await test('浏览器关掉但服务仍在：状态保持 running', async () => {
    const transport = new FakeTransport({ session: makeSession(PROJ_A, 'running') })
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().phase, 'running')
    // 主进程健康检查继续推送 running（浏览器关闭与本应用无关）
    transport.emit(makeSession(PROJ_A, 'running'))
    assert.equal(store.getSnapshot().phase, 'running')
  })

  await test('服务异常退出：事件推送 error → 重新开启预览', async () => {
    const transport = new FakeTransport({ session: makeSession(PROJ_A, 'running') })
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    transport.emit(makeSession(PROJ_A, 'error'))
    assert.equal(store.getSnapshot().phase, 'error')
  })

  await test('启动失败 → error；再次点击可重新启动', async () => {
    const transport = new FakeTransport({
      startResult: { ok: false, error: 'CLI 未返回可用地址', session: null }
    })
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    const failed = await store.start()
    assert.equal(failed.ok, false)
    assert.equal(store.getSnapshot().phase, 'error')
    assert.match(store.getSnapshot().error ?? '', /CLI 未返回可用地址/)

    // 主进程恢复：下一次 start 成功（模拟重新开启）
    transport.startResult = undefined
    const retried = await store.start()
    assert.equal(retried.ok, true)
    assert.equal(store.getSnapshot().phase, 'running')
    assert.equal(store.getSnapshot().error, null)
  })

  await test('停止服务：stopping → idle', async () => {
    const transport = new FakeTransport({ session: makeSession(PROJ_A, 'running') })
    const store = new PreviewStore(transport)
    const box = track(store)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().phase, 'running')
    const result = await store.stop()
    assert.equal(result.ok, true)
    assert.equal(store.getSnapshot().phase, 'idle')
    assert.equal(store.getSnapshot().session, null)
    assert.ok(box.phases.includes('stopping'))
  })

  console.log('\n[3] Store：项目切换与页面重挂载')

  await test('切换项目：新项目未启动 → idle；旧项目服务不会被当成本项目', async () => {
    const transport = new FakeTransport({ session: makeSession(PROJ_A, 'running') })
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().phase, 'running')
    await store.setProject(PROJ_B)
    assert.equal(store.getSnapshot().phase, 'idle')
    assert.equal(store.getSnapshot().session, null)
  })

  await test('页面重新挂载：不默认回到 idle，主动查询主进程真实状态', async () => {
    const transport = new FakeTransport({ session: makeSession(PROJ_A, 'running') })
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    const before = transport.statusCalls
    // 模拟组件卸载再挂载：store 是应用级单例，重新 setProject 同一路径
    await store.setProject(PROJ_A)
    assert.ok(transport.statusCalls > before, '重新挂载必须主动查询一次')
    assert.equal(store.getSnapshot().phase, 'running')
  })

  await test('查询失败不会把界面卡在 starting', async () => {
    const transport = new FakeTransport()
    transport.status = async () => {
      throw new Error('IPC 超时')
    }
    const store = new PreviewStore(transport)
    await store.setProject(PROJ_A)
    assert.equal(store.getSnapshot().busy, null)
    assert.equal(store.getSnapshot().phase, 'idle')
  })

  console.log('\n[4] 真实 PreviewManager 的状态推送（可选）')

  const cli = await findCachedCli()
  const project = join(process.cwd(), '.workbuddy', 'e2e', 'proj-cleanup')
  if (!cli || !existsSync(join(project, 'index.html'))) {
    console.log('  · 跳过（缺少 hyperframes CLI 或样例项目）')
  } else {
    const phases: string[] = []
    const manager = new PreviewManager({
      getCliCommand: async () => cli,
      openExternal: async () => undefined,
      onState: (state) => {
        const status = state.current?.status ?? 'idle'
        if (phases[phases.length - 1] !== status) phases.push(status)
      },
      log: () => undefined
    })

    await test('真实启动：starting → running，且能拿到 Studio URL', async () => {
      const result = await manager.start(project)
      assert.equal(result.ok, true, result.error ?? '启动失败')
      assert.equal(result.session?.status, 'running')
      assert.ok(result.session?.studioUrl && result.session.studioUrl.startsWith('http://127.0.0.1'))
      assert.ok(phases.includes('starting'), `状态序列缺少 starting：${phases.join(',')}`)
      assert.equal(phases[phases.length - 1], 'running')
    })

    await test('真实停止：回到 idle，不再有会话', async () => {
      const stopped = await manager.stop(project)
      assert.equal(stopped.ok, true, stopped.error ?? '停止失败')
      const state = await manager.getState(project)
      assert.equal(state.current, null)
    })
  }

  console.log(`\n共 ${passed} 组断言通过${process.exitCode ? '（存在失败项）' : ''}`)
}

void main()
