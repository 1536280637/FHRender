/**
 * 渲染任务配置快照 —— 真实渲染验收（e2e）。
 *
 * 运行：npm run test:render-config:e2e
 * 依赖：本机缓存的 hyperframes CLI（或 HF_RENDER_E2E_CLI）、ffprobe。
 *
 * 真实验证：
 * 1. 四种性能模式各自启动一次真实渲染，快照里的模式 / 分辨率 / FPS / 格式 /
 *    worker / GPU 开关与真实 CLI 参数一致；
 * 2. 编码器显示的是运行中 ffmpeg 的真实 `-c:v`（GPU 模式必须是 NVENC，CPU 模式必须是 x264），
 *    结束后由 ffprobe 校正分辨率 / 帧率；
 * 3. 渲染期间再次以另一个模式启动会被拒绝，且当前任务显示的模式不变；
 * 4. PNG 序列（不支持 GPU 编码）不会显示成 GPU 编码；
 * 5. 历史记录持久化：重新打开一个 manager 仍能读到每个任务的配置与真实编码器。
 */

import assert from 'node:assert'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RenderManager } from '../src/main/process/render-manager'
import { CliAdapter } from '../src/main/cli/cli-adapter'
import { RenderHistoryManager } from '../src/main/services/render-history'
import type { RenderHistoryEntry, RenderRequest, RenderSettings, RenderTaskState } from '../src/shared/types/render'
import type { PerformanceMode } from '../src/shared/types/performance'

const ROOT = resolve(__dirname, '..', '..')
const E2E_DIR = join(ROOT, '.workbuddy', 'e2e')
const PROJECT = join(E2E_DIR, 'proj-cleanup')
const OUTPUT_ROOT = join(E2E_DIR, 'render-out')
const USER_DATA = join(E2E_DIR, 'userData-render')
const REPORT_FILE = join(E2E_DIR, 'render-config-e2e-report.json')

const results: { name: string; ok: boolean; detail: string }[] = []
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
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
      if (!best || compareVersion(version, best.version) > 0) best = { version, bin: binPath }
    } catch {
      /* ignore */
    }
  }
  return best ? `"${process.execPath}" "${best.bin}"` : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

const BASE_SETTINGS: RenderSettings = {
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
    playerReadyTimeoutMs: null
  }
}

interface ModeCase {
  mode: PerformanceMode
  settings: Partial<RenderSettings>
  expectGpu: boolean
  expectHardwareEncoder: boolean
}

const CASES: ModeCase[] = [
  { mode: 'smart', settings: { workers: 1, gpu: false, browserGpu: 'auto' }, expectGpu: false, expectHardwareEncoder: false },
  { mode: 'balanced', settings: { workers: 1, gpu: false, browserGpu: 'auto' }, expectGpu: false, expectHardwareEncoder: false },
  { mode: 'performance', settings: { workers: 2, gpu: true, browserGpu: 'auto' }, expectGpu: true, expectHardwareEncoder: true },
  { mode: 'extreme', settings: { workers: 3, gpu: true, browserGpu: 'on' }, expectGpu: true, expectHardwareEncoder: true }
]

async function waitTerminal(manager: RenderManager, timeoutMs: number): Promise<RenderTaskState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = manager.getState()
    if (state.status !== 'running' && state.status !== 'preparing') return state
    await sleep(400)
  }
  return manager.getState()
}

function requestFor(mode: PerformanceMode, settings: Partial<RenderSettings>, name: string): RenderRequest {
  return {
    ...BASE_SETTINGS,
    ...settings,
    projectPath: PROJECT,
    composition: '',
    outputDir: join(OUTPUT_ROOT, mode),
    outputName: name,
    projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
  }
}

async function main(): Promise<void> {
  process.env.HF_RENDER_E2E_USERDATA = USER_DATA
  await fs.rm(USER_DATA, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(USER_DATA, { recursive: true })
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(OUTPUT_ROOT, { recursive: true })

  const cliCommand = await findCachedCli()
  if (!cliCommand) {
    console.error('未找到可用的 hyperframes CLI；请设置 HF_RENDER_E2E_CLI 后重试')
    process.exit(2)
  }
  console.log(`\n[e2e] CLI: ${cliCommand}`)
  console.log(`[e2e] 项目: ${PROJECT}`)
  console.log(`[e2e] 输出: ${OUTPUT_ROOT}`)
  console.log(`[e2e] userData: ${USER_DATA}`)

  const adapter = new CliAdapter(async () => cliCommand)
  const history = new RenderHistoryManager()
  const manager = new RenderManager()
  manager.setCliProvider(async () => adapter.probe())
  manager.setHistorySink((entry) => history.save(entry))
  let modeSwitchRejected: { ok: boolean; error?: string } | null = null
  let modeBeforeSwitch = ''

  const snapshots: Record<string, RenderTaskState> = {}
  const logsByTask: Record<string, string[]> = {}

  manager.onEvent((event) => {
    if (event.type !== 'logs') return
    const id = manager.getState().id
    const bucket = logsByTask[id] ?? (logsByTask[id] = [])
    for (const line of event.lines) bucket.push(line.text)
  })

  /* ---------------- 四种模式 ---------------- */
  for (const item of CASES) {
    console.log(`\n[${item.mode}] 真实渲染`)
    const request = requestFor(item.mode, item.settings, `mode-${item.mode}`)
    const started = await manager.start(request, cliCommand, {
      performanceMode: item.mode,
      scratchDir: null,
      autoScratch: false
    })
    assert.equal(started.ok, true, started.error ?? '启动失败')

    // 渲染期间尝试用另一个模式再启动：必须被拒绝，且当前任务的模式不能变
    if (item.mode === 'performance') {
      modeBeforeSwitch = manager.getState().config?.selectedPerformanceMode ?? ''
      modeSwitchRejected = await manager.start(requestFor('extreme', { workers: 3, gpu: true }, 'mode-should-not-start'), cliCommand, {
        performanceMode: 'extreme',
        scratchDir: null,
        autoScratch: false
      })
    }

    const state = await waitTerminal(manager, 12 * 60_000)
    snapshots[item.mode] = state
    const config = state.config
    console.log(
      `  · ${state.status} · ${config?.selectedPerformanceMode} · ${config?.resolution.label} · ${config?.fps.label} · ${
        config?.encoder.label ?? '无编码器'
      }`
    )
    console.log(`  · 日志尾部：${(logsByTask[state.id] ?? []).slice(-3).join(' | ').slice(0, 260)}`)

    await check(`${item.mode}：渲染成功且快照模式正确`, () => {
      assert.equal(state.status, 'succeeded', state.error ?? '')
      assert.ok(config, '缺少配置快照')
      assert.equal(config!.selectedPerformanceMode, item.mode)
      assert.equal(
        config!.effectivePerformanceConfig.source,
        item.mode === 'smart' ? 'smart-auto' : 'fixed-preset'
      )
    })

    await check(`${item.mode}：导出配置与真实 CLI 参数一致`, () => {
      const args = config!.cliArgs
      assert.equal(args[args.indexOf('--format') + 1], 'mp4')
      assert.equal(args[args.indexOf('-q') + 1], 'draft')
      assert.equal(args[args.indexOf('-f') + 1], '30')
      assert.equal(args[args.indexOf('-w') + 1], String(item.settings.workers))
      assert.equal(config!.workers, item.settings.workers)
      assert.equal(config!.format, 'mp4')
      assert.equal(config!.quality, 'draft')
      assert.equal(config!.fps.value, 30)
      // 真实命令行里确实带上了 -o <outputPath>
      const outArg = args[args.indexOf('-o') + 1]
      assert.ok(outArg && existsSync(outArg), `输出文件不存在：${outArg}`)
    })

    await check(`${item.mode}：编码器为真实运行结果（${item.expectHardwareEncoder ? '硬件' : 'CPU'}）`, () => {
      const encoder = config!.encoder
      // 证据必须来自运行中的 ffmpeg 进程或产出文件；绝不能是"请求值"
      assert.ok(encoder.source === 'process' || encoder.source === 'ffprobe', `证据来源不可信：${encoder.source}`)
      assert.ok(encoder.id, '未拿到编码器 id')
      assert.ok(encoder.confirmedAt, '缺少确认时间')
      if (item.expectHardwareEncoder) {
        assert.equal(encoder.hardware, true, `期望硬件编码，实际 ${encoder.id}`)
        assert.match(encoder.id!, /nvenc|amf|qsv|videotoolbox|vaapi/i)
      } else {
        assert.equal(encoder.hardware, false, `期望 CPU 编码，实际 ${encoder.id}`)
        assert.match(encoder.id!, /libx264|libx265|x264|x265/i)
      }
      assert.equal(config!.gpuEncodingEnabled, item.expectGpu)
    })

    await check(`${item.mode}：日志记录了真实编码器与模式`, () => {
      const text = (logsByTask[state.id] ?? []).join('\n')
      assert.match(text, /性能模式\s/)
      assert.match(text, /实际编码器\s/)
      if (item.expectHardwareEncoder) assert.match(text, /nvenc|NVENC/i)
      else assert.match(text, /x264|CPU/i)
    })

    await check(`${item.mode}：结束后用产出文件校正了分辨率 / 帧率`, () => {
      assert.equal(config!.resolution.confirmed, true)
      assert.equal(config!.resolution.width, 640)
      assert.equal(config!.resolution.height, 360)
      assert.equal(config!.fps.confirmed, true)
      assert.equal(config!.fps.value, 30)
    })
  }

  await check('渲染期间切换模式：启动被拒绝，当前任务仍显示原模式', () => {
    assert.ok(modeSwitchRejected, '未执行切换尝试')
    assert.equal(modeSwitchRejected!.ok, false)
    assert.match(modeSwitchRejected!.error ?? '', /已有渲染任务/)
    assert.equal(modeBeforeSwitch, 'performance')
    assert.equal(snapshots['performance'].config?.selectedPerformanceMode, 'performance')
  })

  await check('运行时 ffmpeg 进程证据确实生效（不是只靠产出文件反推）', () => {
    const fromProcess = Object.entries(snapshots)
      .filter(([key, state]) => key !== 'png' && state.config?.encoder.source === 'process')
      .map(([key]) => key)
    assert.ok(fromProcess.length >= 2, `应至少 2 个任务拿到进程级证据，实际：${fromProcess.join(',') || '无'}`)
  })

  /* ---------------- PNG 序列：不支持 GPU 编码 ---------------- */
  console.log('\n[png-sequence] 不支持 GPU 编码时的如实显示')
  const pngRequest: RenderRequest = {
    ...requestFor('performance', { gpu: true, workers: 2 }, 'mode-png'),
    format: 'png-sequence'
  }
  const pngStart = await manager.start(pngRequest, cliCommand, {
    performanceMode: 'performance',
    scratchDir: null,
    autoScratch: false
  })
  assert.equal(pngStart.ok, true, pngStart.error ?? 'PNG 序列启动失败')
  const pngState = await waitTerminal(manager, 10 * 60_000)
  snapshots['png'] = pngState

  await check('PNG 序列：请求 GPU 但快照如实显示未启用 GPU、无视频编码器', () => {
    assert.equal(pngState.status, 'succeeded', pngState.error ?? '')
    const config = pngState.config!
    assert.equal(config.format, 'png-sequence')
    assert.equal(config.gpuEncodingEnabled, false)
    assert.equal(config.cliArgs.includes('--gpu'), false)
    assert.match(config.encoder.label, /PNG 序列不编码/)
    assert.equal(config.encoder.id, null)
  })

  /* ---------------- 历史记录 ---------------- */
  console.log('\n[历史] 持久化与重开页面后的一致性')
  await sleep(500)
  const entries = await history.list()

  await check('历史记录保存了每个任务的真实配置（含编码器）', () => {
    assert.equal(entries.length, 5, `应有 5 条（4 模式 + png），实际 ${entries.length}`)
    const modes = entries.map((e) => e.config.selectedPerformanceMode)
    for (const mode of ['smart', 'balanced', 'performance', 'extreme']) {
      assert.ok(modes.includes(mode as PerformanceMode), `缺少 ${mode} 的历史`)
    }
    const perf = entries.find((e) => e.config.selectedPerformanceMode === 'performance' && e.config.format === 'mp4')
    assert.ok(perf, '缺少性能模式（mp4）历史')
    assert.equal(perf!.config.encoder.hardware, true)
    assert.equal(perf!.status, 'succeeded')
    const smart = entries.find((e) => e.config.selectedPerformanceMode === 'smart')
    assert.equal(smart!.config.encoder.hardware, false)
  })

  await check('历史条目与当前任务快照同源（同 taskId 的字段一致）', () => {
    for (const mode of ['smart', 'performance'] as PerformanceMode[]) {
      const state = snapshots[mode]
      const entry = entries.find((e: RenderHistoryEntry) => e.taskId === state.id)
      assert.ok(entry, `${mode} 的历史记录缺失`)
      assert.equal(entry!.config.selectedPerformanceMode, state.config!.selectedPerformanceMode)
      assert.equal(entry!.config.encoder.id, state.config!.encoder.id)
      assert.equal(entry!.config.resolution.label, state.config!.resolution.label)
    }
  })

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.ok)
  const report = {
    ranAt: new Date().toISOString(),
    cliCommand,
    project: PROJECT,
    userData: USER_DATA,
    runs: Object.entries(snapshots).map(([key, state]) => ({
      key,
      taskId: state.id,
      status: state.status,
      elapsedMs: state.elapsedMs,
      config: state.config
    })),
    history: entries.map((entry) => ({
      taskId: entry.taskId,
      status: entry.status,
      mode: entry.config.selectedPerformanceMode,
      encoder: entry.config.encoder,
      resolution: entry.config.resolution,
      fps: entry.config.fps,
      workers: entry.config.workers,
      gpu: entry.config.gpuEncodingEnabled
    })),
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
