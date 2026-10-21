/**
 * 性能对比测试的公共链路回归测试（不需要启动 Electron，也不需要长渲染）。
 *
 * 运行：npm run test:comparison
 *   → esbuild 打包 scripts/comparison-test.ts（electron 用 scripts/electron-stub.cjs 替代）后执行
 *
 * 覆盖：
 * 1. CLI 参数兼容性校验（unknown option 必须在启动前被拦住）
 * 2. 失败分类（阶段 + 错误类型 + 原始错误保留）
 * 3. 期望产出规格推导（帧率 / 分辨率 / 时长）
 * 4. 产出文件验证（不存在的文件 / 真实 mp4 的 ffprobe 校验）
 */
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { validateRenderArgs, describeArgFailure } from '../src/main/benchmark/arg-check'
import { classifyFailure } from '../src/main/benchmark/failure'
import { expectedVideoSpec } from '../src/main/benchmark/benchmark-engine'
import { verifyOutputFile, findFfprobe } from '../src/main/benchmark/output-verify'
import { findExecutable, resolveNpmCliJs } from '../src/main/process/hyperframes'
import type { CliCapabilities } from '../src/shared/types/performance'
import type { RenderSettings } from '../src/shared/types/render'

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

const cliWith = (flags: string[]): CliCapabilities => ({
  probedAt: new Date().toISOString(),
  command: 'npx hyperframes@0.8.176',
  version: '0.8.176',
  render: { ok: true, options: [], flags, probedMs: 1 },
  benchmark: { available: true, options: [], flags: [] },
  worker: { supportsAuto: true, min: 1, max: null, source: 'derived' },
  features: {
    gpuEncode: flags.includes('--gpu'),
    browserGpu: flags.includes('--browser-gpu'),
    fastCapture: flags.includes('--experimental-fast-capture'),
    pageSideCompositing: flags.includes('--page-side-compositing'),
    lowMemoryMode: flags.includes('--low-memory-mode'),
    strictAll: false,
    hdr: false,
    segmented: false,
    maxConcurrentRenders: false,
    browserTimeout: flags.includes('--browser-timeout'),
    framesCacheDir: false
  }
})

const SETTINGS: RenderSettings = {
  format: 'mp4',
  fpsMode: '24',
  customFps: '',
  quality: 'draft',
  resolution: 'project',
  docker: false,
  gpu: true,
  browserGpu: 'on',
  workers: 2,
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

async function main(): Promise<void> {
  console.log('\n[1] CLI 参数兼容性校验')

  await test('当前版本支持的参数全部通过', () => {
    const cli = cliWith([
      'render',
      '-o',
      '--output',
      '-f',
      '--fps',
      '-q',
      '--quality',
      '-w',
      '--workers',
      '--format',
      '--gpu',
      '--browser-gpu',
      '--page-side-compositing',
      '--browser-timeout'
    ])
    const result = validateRenderArgs(
      ['render', '--format', 'mp4', '-q', 'draft', '-f', '24', '-w', '2', '--gpu', '--browser-gpu', '-o', 'x.mp4'],
      cli
    )
    assert.equal(result.ok, true)
    assert.equal(result.unsupported.length, 0)
  })

  await test('不支持的参数在启动前被拦住，并列出具体选项', () => {
    const cli = cliWith(['render', '-o', '--output', '-f', '--fps', '-w', '--workers'])
    const result = validateRenderArgs(
      ['render', '--gpu', '--browser-gpu', '--page-side-compositing', '--experimental-fast-capture', '-w', '2'],
      cli
    )
    assert.equal(result.ok, false)
    const flags = result.unsupported.map((u) => u.flag).sort()
    assert.deepEqual(flags, ['--browser-gpu', '--experimental-fast-capture', '--gpu', '--page-side-compositing'])
    assert.match(describeArgFailure(result), /--gpu/)
  })

  await test('--no-xxx 形式在声明了 --xxx 时被视为支持', () => {
    const cli = cliWith(['render', '--page-side-compositing', '--browser-gpu'])
    const result = validateRenderArgs(
      ['render', '--no-page-side-compositing', '--no-browser-gpu'],
      cli
    )
    assert.equal(result.ok, true)
  })

  await test('--flag=value 归一化后参与校验', () => {
    const cli = cliWith(['render', '--experimental-fast-capture'])
    const result = validateRenderArgs(['render', '--experimental-fast-capture=false'], cli)
    assert.equal(result.ok, true)
  })

  await test('CLI 能力探测失败时不谎称通过（给出明确提示）', () => {
    const cli: CliCapabilities = {
      ...cliWith([]),
      render: { ok: false, options: [], flags: [], error: 'probe failed' }
    }
    const result = validateRenderArgs(['render', '--gpu'], cli)
    assert.equal(result.ok, true)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /跳过参数兼容性校验/)
  })

  console.log('\n[2] 失败分类（阶段 + 类型 + 原始错误）')

  await test('导航超时 → Chrome 异常，且保留原始错误文本', () => {
    const raw =
      '[Parallel] Capture failed: Worker 0: Navigation timeout of 1000 ms exceeded; ' +
      'diagnostics: [FrameCapture:ERROR] page.goto failed mode=screenshot timeoutMs=1000'
    const failure = classifyFailure('render', raw)
    assert.equal(failure.stage, 'render')
    assert.equal(failure.errorType, 'chrome')
    assert.ok(failure.detail.includes('Navigation timeout of 1000 ms exceeded'))
    assert.ok(failure.hint.length > 0)
  })

  await test('unknown option → 参数不支持', () => {
    const failure = classifyFailure('render', 'error: unknown option \'--gpu\'')
    assert.equal(failure.errorType, 'unsupported-arg')
  })

  await test('磁盘空间不足 → 文件写入失败', () => {
    const failure = classifyFailure('render', 'ENOSPC: no space left on device')
    assert.equal(failure.errorType, 'file-write')
  })

  await test('合成时长为零 → 项目无效（而不是笼统的未知错误）', () => {
    const raw =
      '[WARN] Browser probe attempt failed {"error":"[FrameCapture] Composition has zero duration.\\n  Runtime ready: true, __player: true, __hf.seek: true"}'
    const failure = classifyFailure('render', raw)
    assert.equal(failure.errorType, 'invalid-project')
    assert.ok(failure.highlight!.includes('Composition has zero duration'))
  })

  await test('无法识别的输出也会保留原文而不是编造原因', () => {
    const failure = classifyFailure('render', 'something totally unexpected happened')
    assert.equal(failure.errorType, 'unknown')
    assert.equal(failure.detail, 'something totally unexpected happened')
  })

  await test('完全没有输出时给出明确说明', () => {
    const failure = classifyFailure('spawn', '')
    assert.equal(failure.errorType, 'unknown')
    assert.match(failure.detail, /未获得任何可用的错误输出/)
  })

  await test('关键错误行定位到真正的失败行，而不是日志首行的 INFO', () => {
    // 真实场景：stderr 开头是 Pipeline started 的 info，失败原因在 30 秒后的末尾
    const raw = [
      '[INFO] [Render] Pipeline started {"fps":{"num":24,"den":1},"quality":"draft"}',
      '[INFO] [Render] Compiling composition',
      '███░░░░░░░ 12% Capturing frame 4/112',
      '███░░░░░░░ 53% Capturing frame 76/112',
      '[Parallel] Capture failed: Worker 0: Navigation timeout of 1000 ms exceeded;',
      'diagnostics: [FrameCapture:ERROR] page.goto failed mode=screenshot timeoutMs=1000'
    ].join('\n')
    const failure = classifyFailure('render', raw)
    assert.equal(failure.errorType, 'chrome')
    assert.ok(failure.highlight, '必须给出关键错误行')
    assert.ok(failure.highlight!.includes('Navigation timeout of 1000 ms exceeded'))
    assert.ok(!failure.highlight!.includes('Pipeline started'), '关键行不应是日志首部的 INFO')
    assert.ok(!failure.highlight!.includes('Capturing frame'), '关键行应跳过进度条刷屏')
    // detail 仍然保留完整原文
    assert.ok(failure.detail.includes('Pipeline started'))
  })

  await test('去掉 ANSI 颜色码但不丢失错误文本', () => {
    const failure = classifyFailure('render', '\u001b[31m[ERROR]\u001b[0m Target closed')
    assert.equal(failure.errorType, 'chrome')
    assert.ok(!failure.detail.includes('\u001b'))
    assert.ok(failure.detail.includes('Target closed'))
  })

  console.log('\n[3] 期望产出规格')

  await test('fpsMode=24 → 期望 24fps', () => {
    const spec = expectedVideoSpec(SETTINGS, { durationSec: 10, fps: 60 })
    assert.equal(spec.fps, 24)
    assert.equal(spec.durationSec, 10)
    assert.equal(spec.width, null)
  })

  await test('fpsMode=project → 跟随项目帧率', () => {
    const spec = expectedVideoSpec({ ...SETTINGS, fpsMode: 'project' }, { durationSec: 6, fps: 30 })
    assert.equal(spec.fps, 30)
  })

  await test('resolution=portrait → 期望 1080×1920', () => {
    const spec = expectedVideoSpec({ ...SETTINGS, resolution: 'portrait' }, null)
    assert.equal(spec.width, 1080)
    assert.equal(spec.height, 1920)
  })

  await test('无法推导时返回 null（不编造期望值）', () => {
    const spec = expectedVideoSpec({ ...SETTINGS, fpsMode: 'project' }, null)
    assert.equal(spec.fps, null)
    assert.equal(spec.durationSec, null)
  })

  console.log('\n[4] 产出文件验证')

  await test('文件不存在 → exists=false 并给出问题说明', async () => {
    const check = await verifyOutputFile(join(process.cwd(), '.workbuddy', 'diag', 'not-exist.mp4'))
    assert.equal(check.exists, false)
    assert.ok(check.problems[0].includes('不存在'))
  })

  const sample = join(process.cwd(), '.workbuddy', 'diag', 'fixture-out', 'test2.mp4')
  if (existsSync(sample)) {
    await test('真实 mp4 → ffprobe 读到时长 / 分辨率 / 帧率且与期望一致', async () => {
      const check = await verifyOutputFile(sample, {
        expectedFps: 24,
        expectedDurationSec: 4
      })
      assert.equal(check.exists, true)
      assert.equal(check.writeSettled, true)
      assert.equal(check.problems.length, 0, check.problems.join('；'))
      assert.ok(check.probe?.ok)
      assert.equal(check.probe?.width, 1280)
      assert.equal(check.probe?.height, 720)
      assert.equal(check.probe?.fps, 24)
    })

    await test('期望时长不符时会被判定为问题（不放过脏数据）', async () => {
      const check = await verifyOutputFile(sample, { expectedDurationSec: 30 })
      assert.ok(check.problems.some((p) => p.includes('视频时长')))
    })
  } else {
    console.log('  · 跳过 ffprobe 用例（缺少 .workbuddy/diag/fixture-out/test2.mp4 样本）')
  }

  await test('ffprobe 可用性如实上报', () => {
    const probe = findFfprobe()
    console.log(`      ffprobe = ${probe ?? '未找到'}`)
    assert.ok(probe === null || existsSync(probe))
  })

  console.log('\n[5] CLI 命令解析（不要整块读二进制）')

  await test('把 node.exe 当 CLI 命令时不会去读二进制内容（快速返回 null）', async () => {
    const started = Date.now()
    const result = await resolveNpmCliJs(process.execPath)
    const cost = Date.now() - started
    assert.equal(result, null)
    assert.ok(cost < 1500, `解析耗时 ${cost}ms，说明又把可执行文件当文本读了`)
  })

  await test('真实 npx 包装脚本仍能解析出 npm-cli / npx-cli 入口', async () => {
    const npx = findExecutable('npx')
    if (!npx) {
      console.log('      （当前环境没有 npx，跳过）')
      return
    }
    const cliJs = await resolveNpmCliJs(npx)
    if (cliJs === null) {
      console.log(`      （${npx} 旁没有 npm 自带 cli js，跳过）`)
      return
    }
    assert.ok(existsSync(cliJs), `${cliJs} 应存在`)
    assert.match(cliJs, /(npm|npx)-cli\.js$/i)
  })

  console.log(`\n共 ${passed} 组断言通过${process.exitCode ? '（存在失败项）' : ''}`)
}

void main()
