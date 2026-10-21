/**
 * ETA 估算器与性能报告生成的功能测试（不需要真实渲染）。
 * 运行：先用 esbuild 打包成本文件，再由 node 执行（见 npm run test:logic）。
 */
import assert from 'node:assert'
import { RenderEtaEstimator } from '../src/main/process/eta-estimator'
import { buildPerformanceReport } from '../src/main/services/performance-report-manager'
import { resolveModePreset, detectHardwareTier, MODE_PRESET_TABLE } from '../src/main/optimizer/mode-presets'
import type { BenchmarkSessionState } from '../src/shared/types/performance'
import type { HardwareReport } from '../src/shared/types/hardware'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

const tick = (n: number): number => 1_700_000_000_000 + n * 1000

console.log('\n[1] RenderEtaEstimator')

test('样本不足时处于 estimating，不输出虚构 ETA', () => {
  const eta = new RenderEtaEstimator()
  const s1 = eta.update({ pct: 2, label: '捕获帧', done: 6, total: 300 }, tick(0))
  assert.equal(s1.reliability, 'estimating')
  assert.equal(s1.etaMs, null)
  assert.ok(s1.note?.includes('正在计算'))
})

test('全局百分比路径：ETA 是「秒」换算出的毫秒，不再固定 ~1s', () => {
  const eta = new RenderEtaEstimator()
  // 真实 CLI 语义：捕获阶段 pct 从 25 走到 80，120 秒内完成 300 帧
  let out
  for (let done = 1; done <= 300; done += 1) {
    const pct = Math.round(25 + (done / 300) * 55)
    out = eta.update(
      { pct, code: 'capture', label: `Streaming frame ${done}/300`, done, total: 300 },
      tick((120 * done) / 300)
    )
  }
  const visible = out!
  // 最后一个样本 pct=80 → 剩余 20% ≈ 30s 左右，绝不可能是 0~2s
  assert.ok(visible.etaMs != null, '应有 ETA')
  assert.ok(visible.etaMs! > 20_000, `ETA 必须按秒正确换算，实际 ${visible.etaMs}ms`)
  assert.ok(visible.etaMs! < 60_000, `ETA 不该离谱，实际 ${visible.etaMs}ms`)
  assert.notEqual(Math.floor(visible.etaMs! / 1000), 1, '不允许出现恒定的 1s')
})

test('全局百分比路径：ETA 随进度单调下降，不做单点瞬时跳变', () => {
  const eta = new RenderEtaEstimator()
  const seen: number[] = []
  for (let done = 1; done <= 300; done += 1) {
    const pct = Math.round(25 + (done / 300) * 55)
    const s = eta.update(
      { pct, code: 'capture', label: `Streaming frame ${done}/300`, done, total: 300 },
      tick((120 * done) / 300)
    )
    if (done % 50 === 0 && s.etaMs != null) seen.push(s.etaMs)
  }
  assert.ok(seen.length >= 4, `至少要有 4 个有效值，实际 ${seen.length}`)
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] <= seen[i - 1] * 1.15, `ETA 不应逆势暴涨：${seen.join(',')}`)
  }
  assert.ok(seen[seen.length - 1] < seen[0] / 2, `ETA 必须随进度下降：${seen.join(',')}`)
})

test('帧数路径：没有全局 pct 时按剩余帧折算（毫秒单位）', () => {
  const eta = new RenderEtaEstimator()
  let out
  for (let i = 0; i < 8; i += 1) {
    out = eta.update({ pct: null, label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  // 稳定速度 5 帧/秒，已完成 70/100，剩余 30 帧 → 约 6 秒 = 6000ms
  assert.ok(out!.etaMs != null && Math.abs(out!.etaMs - 6000) < 1500, `ETA≈6s，实际 ${out!.etaMs}`)
  assert.equal(out!.speedFps != null && Math.abs(out!.speedFps - 5) < 0.5, true)
})

test('阶段切换重置估算，不把捕获速度当编码速度', () => {
  const eta = new RenderEtaEstimator()
  for (let i = 0; i < 8; i += 1) {
    eta.update({ pct: i * 8, code: 'capture', label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  const after = eta.update({ pct: 80, code: 'encode', label: '编码视频' }, tick(20))
  assert.ok(after.note?.includes('新阶段'))
  // 捕获阶段的帧速度必须作废，不能当成编码速度
  assert.equal(after.speedFps, null)
  assert.equal(after.reliability, 'medium')
})

test('进度条文本行可推断阶段（不带 code 的场景）', () => {
  const eta = new RenderEtaEstimator()
  for (let i = 0; i < 8; i += 1) {
    eta.update({ pct: i * 8, code: 'capture', label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  // 切到编码阶段，但这条进度条没有 code 字段
  const after = eta.update({ pct: 82, label: 'Encoding frame 20/60', done: 20, total: 60 }, tick(30))
  assert.ok(after.note?.includes('新阶段'), `应识别为阶段切换，实际 ${after.note}`)
})

test('进度停滞进入 stalled，不虚构剩余时间', () => {
  const eta = new RenderEtaEstimator()
  for (let i = 0; i < 8; i += 1) {
    eta.update({ pct: i * 8, code: 'capture', label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  const stalled = eta.update({ pct: 56, code: 'capture', label: '捕获帧', done: 70, total: 100 }, tick(100))
  assert.equal(stalled.reliability, 'stalled')
  assert.equal(stalled.etaMs, null)
  assert.equal(stalled.stalled, true)
  assert.ok(stalled.note?.includes('等待渲染进度'), `停滞文案应说明在等待进度，实际 ${stalled.note}`)
})

test('停滞恢复后重新给出 ETA', () => {
  const eta = new RenderEtaEstimator()
  for (let i = 0; i <= 10; i += 1) {
    eta.update({ pct: 20 + i * 3, code: 'capture', label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  const stalled = eta.update({ pct: 50, code: 'capture', label: '冻结', done: 100, total: 100 }, tick(60))
  assert.equal(stalled.stalled, true)
  let resumed
  for (let i = 1; i <= 10; i += 1) {
    resumed = eta.update(
      { pct: 50 + i * 3, code: 'capture', label: '恢复', done: 100 + i * 5, total: 200 },
      tick(60 + i * 2)
    )
  }
  assert.equal(resumed!.stalled, false)
  assert.ok(resumed!.etaMs != null && resumed!.etaMs > 0, '恢复后应重新给出 ETA')
})

test('完成后记录最初预计 vs 实际误差', () => {
  const eta = new RenderEtaEstimator()
  for (let i = 0; i < 8; i += 1) {
    eta.update({ pct: i * 8, code: 'capture', label: '捕获帧', done: i * 10, total: 100 }, tick(i * 2))
  }
  const finalState = eta.finishState(14_000)
  assert.ok(finalState?.note?.includes('预估误差'))
  assert.ok(finalState?.initialTotalMs != null)
  assert.equal(finalState?.etaMs, null)
})

console.log('\n[2] 硬件等级与固定模式预设')

function makeHardware(cores: number, ramGb: number, vramGb: number): HardwareReport {
  return {
    scannedAt: new Date().toISOString(),
    platform: 'win32',
    os: { platform: 'win32', name: 'Windows 11', release: '11', version: '11', arch: 'x64', isElevated: false, locale: 'zh-CN' },
    cpu: { brand: 'test', model: 'Test CPU', physicalCores: Math.ceil(cores / 2), logicalCores: cores, baseClockMhz: null, currentClockMhz: null, usagePct: null, temperatureC: null, features: [], loadAvg: null },
    memory: { totalBytes: ramGb * 1024 ** 3, usedBytes: ramGb * 1024 ** 3 * 0.5, freeBytes: ramGb * 1024 ** 3 * 0.5, usagePct: 50, renderProcessBytes: null },
    gpus: [{ id: 'g1', name: 'Test GPU', vendor: 'nvidia', kind: 'discrete', vramBytes: vramGb * 1024 ** 3, driverVersion: '566.03', activeForBrowser: true, metrics: { usage3dPct: null, videoEncodePct: null, videoDecodePct: null, copyPct: null, vramUsedBytes: null, temperatureC: null, powerW: null, powerLimitW: null }, encoderHints: [] }],
    disk: { tempDir: 'C:\\Temp', tempFreeBytes: 50 * 1024 ** 3, tempTotalBytes: 100 * 1024 ** 3 },
    fingerprint: 'hw_test',
    warnings: []
  }
}

const cliStub = {
  probedAt: new Date().toISOString(),
  command: 'npx',
  version: '0.8.176',
  render: { ok: true, options: [], flags: [] },
  benchmark: { available: false, options: [], flags: [] },
  worker: { supportsAuto: true, min: 1, max: 8, source: 'help' as const },
  features: {
    gpuEncode: true, browserGpu: true, fastCapture: true, pageSideCompositing: true,
    lowMemoryMode: true, strictAll: true, hdr: false, segmented: false,
    maxConcurrentRenders: false, browserTimeout: true, framesCacheDir: false
  }
}

const capStub = (encodersWorking: boolean) => ({
  scannedAt: new Date().toISOString(),
  cpu: { physicalCores: 8, logicalCores: 16, safeWorkerCeiling: 6, features: [], throttled: null, note: '' },
  encoders: encodersWorking
    ? [{ id: 'h264_nvenc', label: 'NVENC H.264', family: 'nvidia' as const, codec: 'h264' as const, compiled: true, tested: true, working: true, formats: ['mp4' as const, 'webm' as const] }]
    : [],
  browserGpu: { probed: true, hardwareCompositing: true, webgl: true, webgl2: true, softwareOnly: false, activeGpuName: 'Test GPU', activeVendorId: 1, activeDeviceId: 1, driverVersion: '566.03', hardwareVideoDecode: true },
  ffmpeg: { found: true, path: 'ffmpeg', version: '7' },
  warnings: []
})

test('等级划分：4 核 8GB = 入门，32 核 64GB = 工作站', () => {
  assert.equal(detectHardwareTier(makeHardware(4, 8, 2)), 'entry')
  assert.equal(detectHardwareTier(makeHardware(32, 64, 12)), 'workstation')
})

test('固定模式从静态表取 worker，不读 Benchmark', () => {
  const hw = makeHardware(16, 16, 6)
  for (const mode of ['balanced', 'performance', 'extreme'] as const) {
    const spec = MODE_PRESET_TABLE[mode].find((p) => p.tier === 'high-end')!
    const resolved = resolveModePreset({
      mode,
      hardware: hw,
      capability: capStub(true),
      cli: cliStub,
      format: 'mp4',
      settings: { format: 'mp4', fpsMode: 'project', customFps: '', quality: 'looks', resolution: 'project', docker: false, gpu: false, browserGpu: 'auto', workers: 'auto', crf: null, videoBitrate: '', strict: false, gifLoop: 0, hlsSegmentSeconds: 0 },
      allowExperimental: true,
      platformSupport: { parallelStream: true, fastCapture: true, note: '' }
    })
    assert.equal(resolved.workers, spec.workers, `${mode} worker 应等于静态预设`)
  }
})

test('无硬件编码器时 GPU 编码回退并记录原因', () => {
  const resolved = resolveModePreset({
    mode: 'performance',
    hardware: makeHardware(16, 16, 0),
    capability: capStub(false),
    cli: cliStub,
    format: 'mp4',
    settings: { format: 'mp4', fpsMode: 'project', customFps: '', quality: 'looks', resolution: 'project', docker: false, gpu: false, browserGpu: 'auto', workers: 'auto', crf: null, videoBitrate: '', strict: false, gifLoop: 0, hlsSegmentSeconds: 0 },
    allowExperimental: false,
    platformSupport: { parallelStream: true, fastCapture: true, note: '' }
  })
  assert.equal(resolved.gpuEncode, false)
  assert.ok(resolved.fallbacks.some((f) => f.includes('硬件编码器')))
})

console.log('\n[3] 性能报告：基准比例与最快模式')

function fakeReportState(): BenchmarkSessionState {
  const mk = (id: string, mode: 'balanced' | 'performance' | 'extreme' | 'smart', ms: number, ok = true) => ({
    candidateId: id,
    label: id,
    status: ok ? ('ok' as const) : ('failed' as const),
    durationMs: ms,
    sizeBytes: 24_000_000,
    peak: { cpuPct: 60, memoryBytes: 6 * 1024 ** 3, vramBytes: 2 * 1024 ** 3, gpuPct: 40, videoEncodePct: 55 },
    avgCpuPct: 45
  })
  return {
    id: 'bench_x',
    status: 'done',
    kind: 'comparison',
    comparisonKind: 'precise',
    projectPath: 'D:\\Proj\\demo',
    format: 'mp4',
    quality: 'looks',
    resolution: 'project',
    fpsLabel: '跟随项目',
    candidates: [
      { id: 'cmp-balanced', label: '平衡', mode: 'balanced', workers: 2, gpuEncode: true, encoderId: 'h264_nvenc', browserGpu: 'auto', capturePath: 'default', pageSideCompositing: true },
      { id: 'cmp-performance', label: '性能', mode: 'performance', workers: 3, gpuEncode: true, encoderId: 'h264_nvenc', browserGpu: 'on', capturePath: 'fast-capture', pageSideCompositing: true },
      { id: 'cmp-extreme', label: '极限', mode: 'extreme', workers: 4, gpuEncode: true, encoderId: 'h264_nvenc', browserGpu: 'on', capturePath: 'fast-capture', pageSideCompositing: true },
      { id: 'cmp-smart', label: '智能', mode: 'smart', workers: 1, gpuEncode: true, encoderId: 'h264_nvenc', browserGpu: 'auto', capturePath: 'default', pageSideCompositing: true }
    ],
    results: [
      // 平衡：3 次（中位 100s）
      mk('cmp-balanced', 'balanced', 98_000), mk('cmp-balanced', 'balanced', 100_000), mk('cmp-balanced', 'balanced', 110_000),
      // 性能：3 次（中位 80s）
      mk('cmp-performance', 'performance', 80_000), mk('cmp-performance', 'performance', 82_000), mk('cmp-performance', 'performance', 90_000),
      // 极限：失败
      mk('cmp-extreme', 'extreme', 0, false),
      // 智能：中位 75s → 最快
      mk('cmp-smart', 'smart', 75_000), mk('cmp-smart', 'smart', 76_000), mk('cmp-smart', 'smart', 78_000)
    ],
    currentIndex: 4,
    estimatedMinutes: 10,
    official: { ran: false, ok: false, results: [] }
  }
}

test('中位数、耗时缩短率与吞吐提升率计算正确且分开标注', () => {
  const report = buildPerformanceReport({
    state: fakeReportState(),
    candidates: fakeReportState().candidates,
    hardware: makeHardware(16, 16, 6),
    cliVersion: '0.8.176',
    kind: 'precise'
  })
  const perf = report.entries.find((e) => e.mode === 'performance')!
  assert.equal(perf.medianMs, 82_000, '性能模式中位 82s（3 次排序取中）')
  assert.equal(perf.runs.length, 3)
  // 耗时缩短率 = (100000-82000)/100000 = 18%
  assert.equal(report.timeSavedPct.performance, 18)
  // 吞吐提升率 = 100000/82000-1 ≈ 21.95% → 22%
  assert.equal(report.throughputGainPct.performance, 22)
  assert.equal(report.fastestMode, 'smart')
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].mode, 'extreme')
})

test('失败模式不参与最快判定，未测试模式不显示百分比', () => {
  const state = fakeReportState()
  const report = buildPerformanceReport({
    state,
    candidates: state.candidates,
    hardware: makeHardware(16, 16, 6),
    cliVersion: '0.8.176',
    kind: 'precise'
  })
  assert.equal(report.timeSavedPct.extreme, undefined, '失败模式没有比例数据')
})

console.log(`\n通过 ${passed} 组断言`)
