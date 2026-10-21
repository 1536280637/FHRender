/**
 * 渲染任务配置快照的单元回归测试（不需要真实渲染）。
 *
 * 运行：npm run test:render-config
 *
 * 覆盖：
 * 1. 编码器命令行解析（真实渲染命令 / 能力探测命令 / copy / 默认编码器）
 * 2. 编码器名称映射（硬件 / 软件 / 未知）
 * 3. 快照与真实 CLI 参数一致（分辨率 / FPS / 格式 / 质量 / worker / GPU / 捕获模式）
 * 4. 「请求了 GPU 但实际没下发」时不能显示成 GPU 编码
 * 5. 运行时证据更新（编码器 / 浏览器 GPU / 产出文件校正）
 * 6. 回退记录与重试后的配置重置
 * 7. 历史记录去重、排序与上限
 */

import assert from 'node:assert'
import { buildRenderArgs } from '../src/main/process/hyperframes'
import {
  describeEncoder,
  encoderFromTag,
  pickEncoderFromCommandLine
} from '../src/main/process/encoder-probe'
import {
  applyBrowserGpuEvidence,
  applyEncoderEvidence,
  applyFallback,
  applyOutputProbe,
  argValue,
  buildTaskConfigSnapshot,
  captureModeOf,
  exportFormatLine,
  exportSpecLine,
  performanceDetailLine,
  performanceSourceLabel,
  refreshEffectiveFromArgs,
  resolutionLabel
} from '../src/main/process/task-config'
import { RenderHistoryManager } from '../src/main/services/render-history'
import { checkBrowserTimeout, MIN_BROWSER_TIMEOUT_SEC, sanitizeBrowserTimeout } from '../src/shared/render-limits'
import { SettingsManager } from '../src/main/services/settings-manager'
import type { RenderRequest, RenderSettings } from '../src/shared/types/render'
import type { RenderHistoryEntry } from '../src/shared/types/render'

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

const SETTINGS: RenderSettings = {
  format: 'mp4',
  fpsMode: '30',
  customFps: '',
  quality: 'high',
  resolution: 'landscape-4k',
  docker: false,
  gpu: true,
  browserGpu: 'auto',
  workers: 3,
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

function makeRequest(patch: Partial<RenderRequest> = {}): RenderRequest {
  return {
    ...SETTINGS,
    projectPath: 'D:/tmp/project',
    composition: '',
    outputDir: 'D:/tmp/out',
    outputName: 'demo',
    projectMeta: { width: 1920, height: 1080, durationSec: 2, fps: 30 },
    ...patch
  }
}

/** 声明支持导航超时等选项的 CLI 能力（用于验证参数是否真的下发） */
function cliStub(): Parameters<typeof buildRenderArgs>[1] {
  return {
    render: {
      ok: true,
      options: [],
      flags: [
        '--experimental-fast-capture',
        '--page-side-compositing',
        '--browser-timeout',
        '--player-ready-timeout',
        '--low-memory-mode'
      ]
    },
    features: {
      fastCapture: true,
      pageSideCompositing: true,
      lowMemoryMode: true,
      browserTimeout: true
    }
  } as unknown as Parameters<typeof buildRenderArgs>[1]
}

async function main(): Promise<void> {
  console.log('\n[1] ffmpeg 命令行 → 真实编码器')

  await test('真实渲染命令取到 h264_nvenc', () => {
    const cmd =
      'ffmpeg.exe -framerate 30 -i C:\\tmp\\frames\\frame_%06d.jpg -r 30 -c:v h264_nvenc -preset p1 -o out.mp4'
    assert.equal(pickEncoderFromCommandLine(cmd), 'h264_nvenc')
  })

  await test('软件编码命令取到 libx264', () => {
    const cmd = 'ffmpeg -y -i frames/frame_%06d.png -c:v libx264 -crf 18 out.mp4'
    assert.equal(pickEncoderFromCommandLine(cmd), 'libx264')
  })

  await test('-vcodec 写法同样识别', () => {
    assert.equal(pickEncoderFromCommandLine('ffmpeg -i in.png -vcodec libx265 out.mp4'), 'libx265')
  })

  await test('能力探测（lavfi / null 输出）不会被当成渲染编码器', () => {
    const probe =
      'ffmpeg.exe -hide_banner -loglevel error -f lavfi -i color=size=320x240:rate=1:duration=1 -frames:v 1 -an -c:v h264_nvenc -f null -'
    assert.equal(pickEncoderFromCommandLine(probe), null)
    assert.equal(pickEncoderFromCommandLine('ffmpeg.exe -version'), null)
  })

  await test('-c:v copy 与没有 -c:v 的命令返回 null（无法判断，就不猜）', () => {
    assert.equal(pickEncoderFromCommandLine('ffmpeg -i in.mp4 -c:v copy out.mp4'), null)
    assert.equal(pickEncoderFromCommandLine('ffmpeg -i in.mp4 out.mp4'), null)
    assert.equal(pickEncoderFromCommandLine(''), null)
  })

  console.log('\n[2] 编码器名称映射')

  await test('NVENC / AMF / QSV / VideoToolbox 标为硬件', () => {
    for (const id of ['h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_qsv', 'h264_videotoolbox']) {
      const d = describeEncoder(id)
      assert.equal(d.hardware, true, `${id} 应为硬件编码`)
      assert.ok(d.label.length > 0)
    }
  })

  await test('x264 / x265 / gif 标为软件', () => {
    for (const id of ['libx264', 'libx265', 'gif', 'prores_ks']) {
      assert.equal(describeEncoder(id).hardware, false, `${id} 应为软件编码`)
    }
  })

  await test('未知编码器不硬猜硬件/软件', () => {
    const d = describeEncoder('some_future_encoder')
    assert.equal(d.hardware, null)
    assert.equal(d.id, 'some_future_encoder')
  })

  await test('从 ffprobe 的 encoder tag 里识别编码器', () => {
    assert.equal(encoderFromTag('Lavc60.31.102 h264_nvenc'), 'h264_nvenc')
    assert.equal(encoderFromTag('libx264 core 164'), 'libx264')
    assert.equal(encoderFromTag('Lavf62.12.100'), null)
    assert.equal(encoderFromTag(null), null)
  })

  console.log('\n[3] 快照与真实 CLI 参数一致')

  const request = makeRequest()
  const built = buildRenderArgs(request)
  const snapshot = buildTaskConfigSnapshot({
    taskId: 'task-1',
    request,
    args: built.args,
    performanceMode: 'performance'
  })

  await test('分辨率 / FPS / 格式 / 质量 / worker 与命令行一致', () => {
    assert.equal(snapshot.format, 'mp4')
    assert.equal(snapshot.quality, 'high')
    assert.equal(snapshot.resolution.preset, 'landscape-4k')
    assert.equal(snapshot.resolution.width, 3840)
    assert.equal(snapshot.resolution.height, 2160)
    assert.equal(snapshot.resolution.label, '4K')
    assert.equal(snapshot.fps.value, 30)
    assert.equal(argValue(built.args, '-f'), '30')
    assert.equal(snapshot.workers, 3)
    assert.equal(argValue(built.args, '-w'), '3')
    assert.equal(argValue(built.args, '--format'), snapshot.format)
    assert.equal(argValue(built.args, '-q'), snapshot.quality)
  })

  await test('GPU 编码开关取自 args（真正下发），不是 request.gpu', () => {
    assert.equal(built.args.includes('--gpu'), true)
    assert.equal(snapshot.gpuEncodingEnabled, true)
    assert.equal(snapshot.effectivePerformanceConfig.gpuEncodingEnabled, true)
  })

  await test('性能模式来源：智能 = 自动优化配置，固定模式 = 固定预设', () => {
    assert.equal(snapshot.effectivePerformanceConfig.source, 'fixed-preset')
    assert.equal(performanceSourceLabel(snapshot), '固定预设')
    const smart = buildTaskConfigSnapshot({
      taskId: 'task-1b',
      request,
      args: built.args,
      performanceMode: 'smart'
    })
    assert.equal(smart.effectivePerformanceConfig.source, 'smart-auto')
    assert.equal(performanceSourceLabel(smart), '自动优化配置')
  })

  await test('浏览器 GPU：显式开关才写 true/false，auto 保持 null（等运行时证据）', () => {
    assert.equal(snapshot.browserGpuEnabled, null)
    const bgBuilt = buildRenderArgs(makeRequest({ browserGpu: 'off' }))
    const bg = buildTaskConfigSnapshot({ taskId: 't', request: makeRequest({ browserGpu: 'off' }), args: bgBuilt.args, performanceMode: 'balanced' })
    assert.equal(bg.browserGpuEnabled, false)
  })

  await test('捕获模式由 args/env 决定', () => {
    assert.equal(captureModeOf(built.args), 'default')
    // fast capture 只有在 CLI 声明支持时才会真正下发（这里给一个支持该开关的能力集合）
    const cli = {
      render: {
        ok: true,
        options: [],
        flags: [
          '--experimental-fast-capture',
          '--page-side-compositing',
          '--browser-timeout',
          '--player-ready-timeout',
          '--low-memory-mode'
        ]
      },
      features: { fastCapture: true, pageSideCompositing: true, lowMemoryMode: true, browserTimeout: true }
    } as unknown as Parameters<typeof buildRenderArgs>[1]
    const fast = buildRenderArgs(makeRequest({ extra: { ...SETTINGS.extra!, fastCapture: 'on' } }), cli)
    assert.equal(fast.args.includes('--experimental-fast-capture'), true)
    assert.equal(captureModeOf(fast.args), 'fast-capture')
    assert.equal(captureModeOf(built.args, { HF_CAPTURE_PARALLEL_STREAM: 'true' }), 'parallel-stream')
  })

  await test('PNG 序列：请求了 GPU 也不会下发 --gpu，快照如实显示 CPU / 不编码', () => {
    const pngRequest = makeRequest({ format: 'png-sequence', gpu: true })
    const pngBuilt = buildRenderArgs(pngRequest)
    const png = buildTaskConfigSnapshot({
      taskId: 't-png',
      request: pngRequest,
      args: pngBuilt.args,
      performanceMode: 'extreme'
    })
    assert.equal(pngBuilt.args.includes('--gpu'), false)
    assert.equal(png.gpuEncodingEnabled, false)
    assert.match(png.encoder.label, /PNG 序列不编码/)
  })

  await test('resolution=project 用项目元信息推断尺寸，不自造 4K', () => {
    const projRequest = makeRequest({ resolution: 'project' })
    const projBuilt = buildRenderArgs(projRequest)
    const proj = buildTaskConfigSnapshot({
      taskId: 't-proj',
      request: projRequest,
      args: projBuilt.args,
      performanceMode: 'balanced'
    })
    assert.equal(proj.resolution.width, 1920)
    assert.equal(proj.resolution.height, 1080)
    assert.equal(proj.resolution.label, '项目尺寸（高清）')
    assert.equal(projBuilt.args.includes('--resolution'), false)
  })

  await test('fpsMode=project 时跟随项目帧率', () => {
    const projRequest = makeRequest({ fpsMode: 'project' })
    const proj = buildTaskConfigSnapshot({
      taskId: 't-fps',
      request: projRequest,
      args: buildRenderArgs(projRequest).args,
      performanceMode: 'balanced'
    })
    assert.equal(proj.fps.value, 30)
    assert.match(proj.fps.label, /跟随项目 30 FPS/)
  })

  await test('右栏两行文案符合约定格式', () => {
    assert.equal(exportSpecLine(snapshot), '4K · 30 FPS')
    assert.match(exportFormatLine(snapshot), /^MP4 · 确认中… · 3 Workers$/)
    assert.match(performanceDetailLine(snapshot), /3 Workers · GPU 编码请求已下发/)
  })

  console.log('\n[4] 运行时证据')

  await test('进程证据写入真实编码器', () => {
    const next = applyEncoderEvidence(snapshot, 'h264_nvenc', 'process')
    assert.equal(next.encoder.id, 'h264_nvenc')
    assert.equal(next.encoder.hardware, true)
    assert.equal(next.encoder.source, 'process')
    assert.ok(next.encoder.label.includes('NVENC'))
    assert.ok(next.encoder.confirmedAt)
  })

  await test('回退到 CPU 后编码器证据变成 libx264（不保留旧的 NVENC）', () => {
    const nvenc = applyEncoderEvidence(snapshot, 'h264_nvenc', 'process')
    const cpu = applyEncoderEvidence(nvenc, 'libx264', 'process')
    assert.equal(cpu.encoder.id, 'libx264')
    assert.equal(cpu.encoder.hardware, false)
  })

  await test('浏览器 GPU 证据可更新', () => {
    const on = applyBrowserGpuEvidence(snapshot, true)
    assert.equal(on.browserGpuEnabled, true)
    assert.equal(on.effectivePerformanceConfig.browserGpuEnabled, true)
  })

  await test('产出文件校正分辨率 / 帧率；只有编码格式时如实说明"未暴露"', () => {
    const corrected = applyOutputProbe(snapshot, {
      available: true,
      ok: true,
      codec: 'h264',
      width: 3840,
      height: 2160,
      fps: 30,
      encoderTag: null,
      error: null
    })
    assert.equal(corrected.resolution.confirmed, true)
    assert.equal(corrected.fps.confirmed, true)
    assert.equal(corrected.encoder.hardware, null)
    assert.match(corrected.encoder.label, /编码器未暴露/)

    const withTag = applyOutputProbe(snapshot, {
      available: true,
      ok: true,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      encoderTag: 'Lavc62 h264_nvenc',
      error: null
    })
    assert.equal(withTag.encoder.id, 'h264_nvenc')
    assert.equal(withTag.encoder.source, 'ffprobe')
  })

  await test('ffprobe 不可用时不改动任何字段', () => {
    const same = applyOutputProbe(snapshot, {
      available: false,
      ok: false,
      codec: null,
      width: null,
      height: null,
      fps: null,
      encoderTag: null,
      error: '未找到 ffprobe'
    })
    assert.deepEqual(same, snapshot)
  })

  console.log('\n[5] 回退与重试')

  await test('回退记录去重、递增 attempt', () => {
    const once = applyFallback(snapshot, ['GPU 编码不可用', 'worker 减半'], 1)
    assert.deepEqual(once.effectivePerformanceConfig.fallbacks, ['GPU 编码不可用', 'worker 减半'])
    assert.equal(once.attempt, 1)
    const twice = applyFallback(once, ['GPU 编码不可用'], 2)
    assert.deepEqual(twice.effectivePerformanceConfig.fallbacks, ['GPU 编码不可用', 'worker 减半'])
    assert.equal(twice.attempt, 2)
  })

  await test('重试后 args 变化会同步到快照；GPU 变化时编码器重新回到"确认中"', () => {
    const gpuSnapshot = applyEncoderEvidence(snapshot, 'h264_nvenc', 'process')
    const cpuRequest = makeRequest({ gpu: false, workers: 1 })
    const cpuArgs = buildRenderArgs(cpuRequest).args
    const refreshed = refreshEffectiveFromArgs(gpuSnapshot, cpuRequest, cpuArgs)
    assert.equal(refreshed.gpuEncodingEnabled, false)
    assert.equal(refreshed.workers, 1)
    assert.equal(refreshed.encoder.id, null)
    assert.match(refreshed.encoder.label, /确认中/)
    // 回退记录保留
    const withFallback = applyFallback(gpuSnapshot, ['GPU 编码不可用'], 1)
    const kept = refreshEffectiveFromArgs(withFallback, cpuRequest, cpuArgs)
    assert.deepEqual(kept.effectivePerformanceConfig.fallbacks, ['GPU 编码不可用'])
    // 模式仍然是任务启动时冻结的那个
    assert.equal(kept.selectedPerformanceMode, 'performance')
  })

  await test('GPU 开关没变时保留已确认的编码器', () => {
    const confirmed = applyEncoderEvidence(snapshot, 'h264_nvenc', 'process')
    const refreshed = refreshEffectiveFromArgs(confirmed, makeRequest({ workers: 2 }), buildRenderArgs(makeRequest({ workers: 2 })).args)
    assert.equal(refreshed.encoder.id, 'h264_nvenc')
  })

  console.log('\n[6] 历史渲染记录')

  const history = new RenderHistoryManager()

  await test('保存 / 读取 / 同任务去重 / 最新在前', async () => {
    const base = applyEncoderEvidence(snapshot, 'h264_nvenc', 'process')
    const entry = (taskId: string, status: RenderHistoryEntry['status'], at: string): RenderHistoryEntry => ({
      taskId,
      status,
      startedAt: at,
      finishedAt: at,
      elapsedMs: 1000,
      config: { ...base, taskId },
      outputPath: 'D:/tmp/out.mp4',
      sizeText: '1.2 MB',
      error: null
    })
    await history.clear()
    await history.save(entry('t1', 'succeeded', '2026-10-21T00:00:01Z'))
    await history.save(entry('t2', 'failed', '2026-10-21T00:00:02Z'))
    await history.save(entry('t1', 'canceled', '2026-10-21T00:00:03Z'))
    const list = await history.list()
    assert.equal(list.length, 2)
    assert.equal(list[0].taskId, 't1')
    assert.equal(list[0].status, 'canceled')
    assert.equal(list[0].config.encoder.id, 'h264_nvenc')
    assert.equal(list[1].taskId, 't2')
  })

  await test('最多保留 20 条', async () => {
    await history.clear()
    const base = applyEncoderEvidence(snapshot, 'libx264', 'process')
    for (let i = 0; i < 25; i += 1) {
      await history.save({
        taskId: `t${i}`,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 1,
        config: { ...base, taskId: `t${i}` },
        outputPath: null,
        sizeText: null,
        error: null
      })
    }
    assert.equal((await history.list()).length, 20)
  })

  console.log('\n[7] 文案边界')

  await test('分辨率标签不臆造', () => {
    assert.equal(resolutionLabel('project', null, null), '项目尺寸')
    assert.equal(resolutionLabel('landscape', 1920, 1080), '1080p')
    assert.equal(resolutionLabel('portrait-4k', 2160, 3840), '竖屏 4K')
  })

  console.log('\n[8] 浏览器导航超时：必失败值拦截（--browser-timeout 实为 page.goto 超时）')

  await test('1–9 秒被判定为危险值，留空 / 非法同样视为未设置', () => {
    for (const bad of [1, 2, 5, 9]) {
      const result = checkBrowserTimeout(bad)
      assert.equal(result.value, null, `${bad}s 不应下发`)
      assert.equal(result.ignored, true)
      assert.match(result.reason ?? '', /导航超时/)
    }
    assert.equal(checkBrowserTimeout(null).value, null)
    assert.equal(checkBrowserTimeout('').value, null)
    assert.equal(checkBrowserTimeout(0).value, null)
    assert.equal(checkBrowserTimeout(-3).value, null)
    assert.equal(checkBrowserTimeout('abc').value, null)
    assert.equal(sanitizeBrowserTimeout(1), null)
  })

  await test('10 秒是允许的最小值，10–600 正常下发', () => {
    assert.equal(checkBrowserTimeout(MIN_BROWSER_TIMEOUT_SEC).value, 10)
    assert.equal(checkBrowserTimeout(10.4).value, 10)
    assert.equal(checkBrowserTimeout(120).value, 120)
    assert.equal(checkBrowserTimeout(600).value, 600)
    assert.equal(checkBrowserTimeout(601).value, null, '超过上限应丢弃')
    assert.equal(checkBrowserTimeout(601).ignored, true)
  })

  await test('buildRenderArgs 不会把 1 秒写进命令行，并给出警告', () => {
    const risky = makeRequest({ extra: { ...SETTINGS.extra!, browserTimeoutSec: 1 } })
    const built = buildRenderArgs(risky, cliStub())
    assert.equal(built.args.includes('--browser-timeout'), false)
    assert.ok(
      built.warnings.some((w) => w.includes('浏览器导航超时 1s')),
      `应给出危险值警告，实际：${built.warnings.join(' | ')}`
    )
  })

  await test('合法的导航超时正常下发', () => {
    const safe = makeRequest({ extra: { ...SETTINGS.extra!, browserTimeoutSec: 120 } })
    const built = buildRenderArgs(safe, cliStub())
    const idx = built.args.indexOf('--browser-timeout')
    assert.ok(idx >= 0)
    assert.equal(built.args[idx + 1], '120')
  })

  await test('读取设置时会清掉历史存档里的 1 秒脏值', async () => {
    const manager = new SettingsManager()
    await manager.update({
      lastSettings: {
        ...SETTINGS,
        extra: { ...SETTINGS.extra!, browserTimeoutSec: 1 }
      }
    })
    const settings = await manager.get()
    assert.equal(settings.lastSettings?.extra?.browserTimeoutSec, null)
    // 合法值不会被清掉
    await manager.update({ lastSettings: { ...SETTINGS, extra: { ...SETTINGS.extra!, browserTimeoutSec: 120 } } })
    assert.equal((await manager.get()).lastSettings?.extra?.browserTimeoutSec, 120)
  })

  console.log(`\n共 ${passed} 组断言通过${process.exitCode ? '（存在失败项）' : ''}`)
}

void main()
