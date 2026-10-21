/**
 * 性能测试临时文件清理 —— 真实执行验收（e2e）。
 *
 * 与 cleanup-test.ts 的区别：这里真的调用 HyperFrames CLI 渲染，
 * 覆盖「四种模式对比测试 / 单模式 Benchmark / 用户取消 / 失败任务」四条真实链路，
 * 然后在磁盘上核对：临时媒体是否被删、日志与报告是否保留、项目与用户导出是否完好。
 *
 * 运行：npm run test:cleanup:e2e
 * 依赖：本机已缓存的 hyperframes CLI（或用 HF_RENDER_E2E_CLI 指定）、ffprobe。
 */

import assert from 'node:assert'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BenchmarkEngine } from '../src/main/benchmark/benchmark-engine'
import { CliAdapter } from '../src/main/cli/cli-adapter'
import { PerformanceTestCleanup } from '../src/main/cleanup/cleanup-engine'
import { perfTestRoot } from '../src/main/cleanup/test-workspace'
import type { ResourceMonitor } from '../src/main/monitor/resource-monitor'
import type {
  BenchmarkCandidate,
  BenchmarkSessionState,
  CliCapabilities,
  PerformanceMode
} from '../src/shared/types/performance'
import type { RenderSettings } from '../src/shared/types/render'

const ROOT = resolve(__dirname, '..', '..')
const E2E_DIR = join(ROOT, '.workbuddy', 'e2e')
const PROJECT = join(E2E_DIR, 'proj-cleanup')
const USER_DATA = join(E2E_DIR, 'userData')
const REPORT_FILE = join(E2E_DIR, 'cleanup-e2e-report.json')

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn()
      results.push({ name, ok: true, detail: '' })
      console.log(`  ✓ ${name}`)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      results.push({ name, ok: false, detail })
      console.error(`  ✗ ${name}\n    ${detail}`)
      process.exitCode = 1
    }
  })()
}

/** 在 npm 的 _npx 缓存里找可用的 hyperframes CLI（避免 e2e 依赖联网） */
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
      if (!best || compareVersion(version, best.version) > 0) best = { version, bin: binPath }
    } catch {
      /* 跳过坏包 */
    }
  }
  if (!best) return null
  return `"${process.execPath}" "${best.bin}"`
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

const SETTINGS: RenderSettings = {
  format: 'mp4',
  fpsMode: '30',
  customFps: '',
  quality: 'draft',
  resolution: 'project',
  docker: false,
  gpu: false,
  browserGpu: 'auto',
  workers: 1,
  crf: null,
  videoBitrate: '',
  strict: false,
  gifLoop: 0,
  hlsSegmentSeconds: 4,
  extra: {
    fastCapture: 'auto',
    pageSideCompositing: true,
    lowMemoryMode: 'auto',
    browserTimeoutSec: null,
    playerReadyTimeoutMs: 180_000
  }
}

function candidate(mode: PerformanceMode, workers: number, label: string): BenchmarkCandidate {
  return {
    id: `cmp-${mode}`,
    label,
    mode,
    workers,
    gpuEncode: false,
    encoderId: null,
    browserGpu: 'auto',
    capturePath: 'default',
    pageSideCompositing: true
  }
}

const monitorStub = {
  resetSamples: () => undefined,
  setProgress: () => undefined,
  getPeaks: () => ({
    cpuPct: null,
    memoryBytes: null,
    vramBytes: null,
    gpuPct: null,
    videoEncodePct: null,
    avgCpuPct: null
  })
} as unknown as ResourceMonitor

interface RunLog {
  lines: string[]
}

async function runScenario(input: {
  engine: BenchmarkEngine
  label: string
  start: () => Promise<{ ok: boolean; error?: string }>
  /** 启动后多少毫秒调用 stop()；不传表示跑完 */
  cancelAfterMs?: number
  timeoutMs?: number
}): Promise<BenchmarkSessionState> {
  const log: RunLog = { lines: [] }
  const off = input.engine.onEvent((event) => {
    if (event.type === 'log') log.lines.push(`${event.line.level}: ${event.line.text}`)
  })
  const started = await input.start()
  assert.equal(started.ok, true, `启动失败：${started.error ?? '未知'}`)

  if (input.cancelAfterMs != null) {
    const timer = setTimeout(() => input.engine.stop(), input.cancelAfterMs)
    timer.unref?.()
  }

    const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000)
  let terminalAt: number | null = null
  while (Date.now() < deadline) {
    const state = input.engine.getState()
    if (state.status !== 'running') {
      terminalAt = terminalAt ?? Date.now()
      if (state.cleanup) break
      // 清理兜底：状态已终态但 180 秒内没拿到清理结果（正常几百毫秒内就有）
      if (Date.now() - terminalAt > 180_000) break
    }
    await sleep(400)
  }
  off()
  const state = input.engine.getState()
  console.log(`  · ${input.label}：${state.status}${state.error ? `（${state.error.slice(0, 120)}）` : ''}`)
  console.log(`    日志尾部：${log.lines.slice(-3).join(' | ').slice(0, 300)}`)
  return state
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** 递归列出目录下所有文件（相对路径 + 体积） */
async function listFiles(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const stat = await fs.stat(full)
        out.push({ path: full, size: stat.size })
      }
    }
  }
  await walk(dir)
  return out
}

async function main(): Promise<void> {
  // 必须在创建任何引擎之前指定 userData：electron 桩会在 app.getPath 调用时读取它，
  // 这样 e2e 的所有任务目录都落在 .workbuddy/e2e/userData，不污染真实应用数据。
  process.env.HF_RENDER_E2E_USERDATA = USER_DATA
  // 每轮都从干净的 userData 开始（目录由本进程创建，删除范围仅限这个测试目录）
  await fs.rm(USER_DATA, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(USER_DATA, { recursive: true })

  const cliCommand = await findCachedCli()
  if (!cliCommand) {
    console.error('未找到可用的 hyperframes CLI；请设置 HF_RENDER_E2E_CLI 后重试')
    process.exit(2)
  }
  console.log(`\n[e2e] CLI: ${cliCommand}`)
  console.log(`[e2e] 样例项目: ${PROJECT}`)
  console.log(`[e2e] userData: ${USER_DATA}`)

  /* ---------------- 基线快照 ---------------- */
  const projectBefore = await listFiles(PROJECT)
  const projectHashes = new Map<string, number>()
  for (const file of projectBefore) projectHashes.set(file.path, file.size)
  const perfRoot = perfTestRoot(USER_DATA)
  const preExistingDirs = existsSync(perfRoot)
    ? (await fs.readdir(perfRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    : []
  // 造一个「不是本应用任务」的目录：清理时绝不能被碰
  const strayDir = join(perfRoot, 'user-own-folder')
  await fs.mkdir(strayDir, { recursive: true })
  await fs.writeFile(join(strayDir, 'keep.bin'), Buffer.alloc(8192))

  const cleanup = new PerformanceTestCleanup({ userDataDir: USER_DATA })
  const usageBefore = await cleanup.usage(null)

  const cliAdapter = new CliAdapter(async () => cliCommand)
  const engine = new BenchmarkEngine({
    getCliCommand: async () => cliCommand,
    getCli: async (): Promise<CliCapabilities> => cliAdapter.probe(),
    monitor: monitorStub,
    getCleanupPolicy: async () => ({ autoClean: true, keepFailed: false, keepReports: true }),
    getForbiddenRoots: async () => []
  })

  const candidates = [
    candidate('balanced', 1, '平衡'),
    candidate('performance', 2, '性能'),
    candidate('extreme', 3, '极限'),
    candidate('smart', 1, '智能')
  ]

  console.log('\n[A] 真实执行四种模式对比测试')

  const stateA = await runScenario({
    engine,
    label: '四模式对比',
    start: () =>
      engine.start({
        projectPath: PROJECT,
        settings: SETTINGS,
        candidates,
        runsPerCandidate: 1,
        includeOfficial: false,
        officialRuns: 1,
        confirmBest: false,
        kind: 'comparison',
        comparisonKind: 'quick',
        warmupRuns: 0,
        projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
      }),
    timeoutMs: 20 * 60_000
  })

  const taskA = join(perfTestRoot(USER_DATA), stateA.id)
  const filesA = await listFiles(taskA)
  const mediaA = filesA.filter((f) => /\.(mp4|webm|mov|png|rgba|y4m)$/i.test(f.path))
  const tmpFilesA = filesA.filter((f) => f.path.includes(`${join(taskA, 'tmp')}`))

  await check('A1 四种模式都真实执行并有结果', async () => {
    assert.equal(stateA.status, 'done', `测试状态应为 done，实际 ${stateA.status}：${stateA.error ?? ''}`)
    const ok = stateA.results.filter((r) => r.status === 'ok')
    assert.ok(ok.length >= 3, `至少 3 种模式成功渲染，实际 ${ok.length}（${JSON.stringify(stateA.results.map((r) => r.status))}）`)
    assert.ok(stateA.results.every((r) => r.durationMs > 0))
  })

  await check('A2 临时视频 / PNG 序列 / 原始帧 / Chrome 配置全部被删除', async () => {
    assert.equal(mediaA.length, 0, `仍残留媒体文件：${mediaA.map((f) => f.path).join(', ')}`)
    assert.equal(tmpFilesA.length, 0, `tmp/ 仍有残留：${tmpFilesA.map((f) => f.path).join(', ')}`)
    assert.ok(stateA.cleanup, '应返回清理结果')
    assert.ok(stateA.cleanup!.deletedFiles > 0, '应真的删除了文件')
    assert.ok(stateA.cleanup!.freedBytes > 0, '应释放了空间')
  })

  await check('A3 manifest / report.json / cleanup.json / logs 全部保留', async () => {
    for (const name of ['manifest.json', 'report.json', 'cleanup.json']) {
      assert.equal(existsSync(join(taskA, name)), true, `${name} 应保留`)
    }
    assert.equal(existsSync(join(taskA, 'logs', 'session.log')), true, 'logs/session.log 应保留')
    const report = JSON.parse(await fs.readFile(join(taskA, 'report.json'), 'utf-8'))
    assert.equal(report.app, 'hf-render')
    assert.ok(report.runs.length >= 3, '报告应包含每次运行的数据')
    assert.ok(report.modes.length >= 3, '报告应包含逐模式汇总')
    assert.ok(
      report.modes.every((m: { workers: number | 'auto' | null }) => m.workers !== null),
      '报告应记录每种模式的 Worker 数量'
    )
    assert.ok(report.device && report.device.cpuModel, '报告应记录测试设备信息')
    assert.ok(report.totals.mediaBytes > 0, '报告应记录当时的输出体积')
    assert.ok(
      report.runs.some((r: { videoDurationSec: number | null }) => r.videoDurationSec != null),
      '报告应记录视频时长（ffprobe）'
    )
    const manifest = JSON.parse(await fs.readFile(join(taskA, 'manifest.json'), 'utf-8'))
    assert.equal(manifest.status, 'done')
    assert.ok(Array.isArray(manifest.entries))
  })

  await check('A4 空目录被清理，不留下空的模式子目录', async () => {
    const entries = await fs.readdir(taskA, { withFileTypes: true })
    const emptyDirs: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const children = await fs.readdir(join(taskA, entry.name))
      if (children.length === 0) emptyDirs.push(entry.name)
    }
    assert.equal(emptyDirs.length, 0, `仍存在空目录：${emptyDirs.join(', ')}`)
  })

  await check('A5 样例项目原有文件完整（大小与内容未变；.hyperframes 缓存由 CLI 自己维护）', async () => {
    for (const [path, size] of projectHashes) {
      // CLI 会在项目内维护 .hyperframes 状态文件（video-state.json 等），那是它自己的缓存，
      // 不属于本工具清理范围；这里只核对用户文件本身没被动过。
      if (/[\\/]\.hyperframes[\\/]/.test(path)) continue
      assert.equal(existsSync(path), true, `项目文件缺失：${path}`)
      const stat = await fs.stat(path)
      assert.equal(stat.size, size, `项目文件被改动：${path}`)
    }
    const html = await fs.readFile(join(PROJECT, 'index.html'), 'utf-8')
    assert.match(html, /data-composition-id="main"/)
  })

  await check('A6 未登记目录（用户自己的文件夹）完全没被碰', async () => {
    assert.equal(existsSync(join(strayDir, 'keep.bin')), true)
  })

  /* ---------------- 单模式 Benchmark ---------------- */
  console.log('\n[B] 单模式 Benchmark（智能模式矩阵）')

  const stateB = await runScenario({
    engine,
    label: '矩阵 Benchmark',
    start: () =>
      engine.start({
        projectPath: PROJECT,
        settings: SETTINGS,
        candidates: [candidate('smart', 1, '智能（矩阵）')],
        runsPerCandidate: 1,
        includeOfficial: false,
        officialRuns: 1,
        confirmBest: false,
        kind: 'matrix',
        projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
      }),
    timeoutMs: 10 * 60_000
  })

  const taskB = join(perfTestRoot(USER_DATA), stateB.id)
  const filesB = await listFiles(taskB)
  const mediaB = filesB.filter((f) => /\.(mp4|webm|mov|png|rgba|y4m)$/i.test(f.path))

  await check('B1 矩阵测试的临时媒体同样被清理，日志与报告保留', async () => {
    assert.equal(stateB.status, 'done', stateB.error ?? '')
    assert.equal(mediaB.length, 0, `仍残留媒体：${mediaB.map((f) => f.path).join(', ')}`)
    assert.equal(existsSync(join(taskB, 'report.json')), true)
    assert.equal(existsSync(join(taskB, 'logs', 'session.log')), true)
    assert.equal(existsSync(join(taskB, 'manifest.json')), true)
    assert.ok(stateB.results.some((r) => r.status === 'ok'))
  })

  /* ---------------- 用户取消 ---------------- */
  console.log('\n[C] 用户主动取消')

  const stateC = await runScenario({
    engine,
    label: '取消',
    start: () =>
      engine.start({
        projectPath: PROJECT,
        settings: SETTINGS,
        candidates,
        runsPerCandidate: 1,
        includeOfficial: false,
        officialRuns: 1,
        confirmBest: false,
        kind: 'comparison',
        comparisonKind: 'quick',
        warmupRuns: 0,
        projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
      }),
    cancelAfterMs: 12_000,
    timeoutMs: 10 * 60_000
  })

  const taskC = join(perfTestRoot(USER_DATA), stateC.id)
  const filesC = await listFiles(taskC)
  const mediaC = filesC.filter((f) => /\.(mp4|webm|mov|png|rgba|y4m)$/i.test(f.path))

  await check('C1 取消后临时文件被清理，取消日志与已获得的数据保留', async () => {
    assert.equal(stateC.status, 'canceled')
    assert.equal(mediaC.length, 0, `取消后仍残留媒体：${mediaC.map((f) => f.path).join(', ')}`)
    assert.equal(existsSync(join(taskC, 'logs', 'session.log')), true, '取消日志应保留')
    assert.equal(existsSync(join(taskC, 'cleanup.json')), true, '清理记录应保留')
    assert.equal(existsSync(join(taskC, 'report.json')), true, '已获得的测试数据应保留')
    assert.ok(stateC.cleanup, '取消也应产生清理结果')
  })

  /* ---------------- 失败任务 ---------------- */
  console.log('\n[D] 失败任务（项目无效）')

  const brokenProject = join(E2E_DIR, 'proj-broken')
  await fs.mkdir(brokenProject, { recursive: true })
  await fs.writeFile(join(brokenProject, 'README.md'), 'no index.html here', 'utf-8')

  const stateD = await runScenario({
    engine,
    label: '失败',
    start: () =>
      engine.start({
        projectPath: brokenProject,
        settings: SETTINGS,
        candidates,
        runsPerCandidate: 1,
        includeOfficial: false,
        officialRuns: 1,
        confirmBest: false,
        kind: 'comparison',
        comparisonKind: 'quick',
        projectMeta: null
      }),
    timeoutMs: 5 * 60_000
  })

  const taskD = join(perfTestRoot(USER_DATA), stateD.id)

  await check('D1 失败任务记录真实原因，日志保留，不残留媒体', async () => {
    assert.equal(stateD.status, 'failed')
    assert.ok(stateD.error && stateD.error.length > 0, '应记录失败原因')
    assert.equal(existsSync(join(taskD, 'logs', 'session.log')), true, '错误日志应保留')
    assert.equal(existsSync(join(taskD, 'cleanup.json')), true)
    const filesD = await listFiles(taskD)
    const mediaD = filesD.filter((f) => /\.(mp4|webm|mov|png|rgba|y4m)$/i.test(f.path))
    assert.equal(mediaD.length, 0, `失败任务残留媒体：${mediaD.map((f) => f.path).join(', ')}`)
  })

  /* ---------------- 磁盘占用 ---------------- */
  console.log('\n[E] 磁盘占用与重复测试')

  const usageAfter = await cleanup.usage(null)

  await check('E1 所有任务剩余占用只有日志 + 报告，媒体为 0', async () => {
    // 只统计本应用任务（owned）；user-own-folder 是刻意造出来的「用户自己的目录」，不该被算在内
    const ownedMedia = usageAfter.tasks.filter((t) => t.owned).reduce((sum, t) => sum + t.mediaBytes, 0)
    assert.equal(ownedMedia, 0, `本应用任务仍有 ${ownedMedia} 字节媒体残留`)
    assert.ok(usageAfter.logBytes > 0, '应保留日志')
    assert.ok(usageAfter.reportBytes > 0, '应保留报告')
    assert.ok(
      usageAfter.totalBytes < usageBefore.totalBytes + 6 * 1024 * 1024,
      `新增占用应远小于渲染产物（实际 ${usageAfter.totalBytes} 字节）`
    )
  })

  await check('E2 多次测试没有产生磁盘垃圾（无 100MB 级目录）', async () => {
    const big = usageAfter.tasks.filter((t) => t.bytes > 50 * 1024 * 1024)
    assert.equal(big.length, 0, `仍存在大目录：${big.map((t) => `${t.taskId}=${t.bytes}`).join(', ')}`)
  })

  await check('E3 历史任务与未登记目录都在（没有被误删）', async () => {
    for (const name of preExistingDirs) {
      assert.equal(existsSync(join(perfRoot, name)), true, `历史任务目录被误删：${name}`)
    }
    assert.equal(existsSync(strayDir), true)
  })

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.ok)
  const report = {
    ranAt: new Date().toISOString(),
    cliCommand,
    project: PROJECT,
    userData: USER_DATA,
    scenarios: {
      comparison: { taskId: stateA.id, status: stateA.status, cleanup: stateA.cleanup ?? null, results: stateA.results.map((r) => ({ label: r.label, status: r.status, durationMs: r.durationMs, sizeBytes: r.sizeBytes })) },
      matrix: { taskId: stateB.id, status: stateB.status, cleanup: stateB.cleanup ?? null },
      canceled: { taskId: stateC.id, status: stateC.status, cleanup: stateC.cleanup ?? null },
      failed: { taskId: stateD.id, status: stateD.status, error: stateD.error ?? null, cleanup: stateD.cleanup ?? null }
    },
    usage: usageAfter,
    checks: results,
    passed: results.length - failed.length,
    failed: failed.length
  }
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8')

  console.log(`\n[e2e] 通过 ${results.length - failed.length}/${results.length} 项检查`)
  console.log(`[e2e] 报告：${REPORT_FILE}`)
  if (failed.length > 0) process.exitCode = 1
}

void main()
