/**
 * 项目元数据 / 负载 / 缓存的逻辑回归测试（不需要启动 Electron、不需要渲染）。
 *
 * 运行：npm run test:metadata
 *
 * 覆盖：
 * 1. 根元素属性解析（data-duration / data-fps / data-composition-id）
 * 2. CLI 默认帧率解析（render --help 的 "else 30"）
 * 3. 导出 FPS 与项目 FPS 的区分（--fps 覆盖不改项目原始帧率）
 * 4. 总帧数只在时长与帧率都真实可用时计算
 * 5. 负载等级与时长解耦（4 秒的重项目 > 300 秒的轻项目）
 * 6. 完全读不到项目内容时标记 unknown，不编造复杂度
 * 7. 项目文件指纹（修改 / 删除能被发现）
 * 8. 缓存文件名按项目路径隔离、损坏缓存自动重建
 */
import assert from 'node:assert'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseDefaultFps, parseRootFacts } from '../src/main/analyzer/project-metadata'
import { buildWorkloadProfile, resolveExportFps } from '../src/main/analyzer/workload'
import {
  collectProjectFingerprint,
  verifyProjectFingerprint
} from '../src/main/analyzer/project-fingerprint'
import type { ProjectMetadata } from '../src/shared/types/project'
import type { WorkloadInput } from '../src/main/analyzer/workload'
import { projectCacheFileName, readJsonFile, writeJsonFile, normalizeProjectPath } from '../src/main/cache/cache-io'

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

const TOON_MV = 'D:/视频项目/claude/pro/toon-mv'
const FIXTURE = join(process.cwd(), '.workbuddy/diag/fixture')

function meta(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    path: 'D:/demo/project',
    name: 'project',
    compositionId: 'main',
    width: 1920,
    height: 1080,
    durationSec: 30,
    durationSource: 'composition',
    projectFps: 30,
    projectFpsSource: 'entry-html',
    cliDefaultFps: 30,
    elements: 20,
    tracks: 2,
    types: {},
    projectBytes: 1024,
    compositions: [],
    capability: {
      info: true,
      compositions: true,
      json: true,
      error: null,
      defaultFps: 30,
      cliVersion: '0.8.176',
      probedAt: new Date().toISOString()
    },
    cliVersion: '0.8.176',
    detectedAt: new Date().toISOString(),
    warnings: [],
    ...overrides
  }
}

const emptyAssets = {
  imageCount: 0,
  videoCount: 0,
  assetBytes: 0,
  largestAssetBytes: 0,
  largestAssetPath: null,
  videoFiles: [],
  truncated: false
}

const emptyEntry = {
  webgl: false,
  canvasCount: 0,
  domElements: null,
  animationHints: [],
  entryBytes: 0,
  htmlFiles: ['index.html'],
  found: true
}

function workloadInput(overrides: Partial<WorkloadInput> = {}): WorkloadInput {
  return {
    projectPath: 'D:/demo/project',
    metadata: meta(),
    exportFps: 30,
    assets: emptyAssets,
    entry: emptyEntry,
    videoProbe: null,
    ...overrides
  }
}

async function main(): Promise<void> {
  console.log('\n[1] 根元素属性解析')

  await test('真实项目 index.html：取到 main / 56s / 60fps / 1920x1080', async () => {
    const html = await fs.readFile(join(TOON_MV, 'index.html'), 'utf-8')
    const facts = parseRootFacts(html)
    assert.equal(facts.compositionId, 'main')
    assert.equal(facts.durationSec, 56)
    assert.equal(facts.fps, 60)
    assert.equal(facts.width, 1920)
    assert.equal(facts.height, 1080)
  })

  await test('fixture 项目：4s / 24fps（属性跨多行也能读到）', async () => {
    const html = await fs.readFile(join(FIXTURE, 'index.html'), 'utf-8')
    const facts = parseRootFacts(html)
    assert.equal(facts.compositionId, 'main')
    assert.equal(facts.durationSec, 4)
    assert.equal(facts.fps, 24)
  })

  await test('没有 data-fps 时不虚构帧率', () => {
    const facts = parseRootFacts(
      '<div data-composition-id="main" data-duration="12" data-width="1280" data-height="720"></div>'
    )
    assert.equal(facts.durationSec, 12)
    assert.equal(facts.fps, null)
  })

  await test('没有 data-composition-id 时退到 <html> 上的属性', () => {
    const facts = parseRootFacts('<html data-duration="7.5" data-fps="30"><body></body></html>')
    assert.equal(facts.durationSec, 7.5)
    assert.equal(facts.fps, 30)
  })

  console.log('\n[2] CLI 默认帧率 / 导出 FPS')

  await test('从 render --help 读出「默认 data-fps，否则 30」', () => {
    const help = `-f, --fps=<fps>  Frame rate. Range 1-240. Defaults to the composition's root data-fps, else 30.`
    assert.equal(parseDefaultFps(help), 30)
  })

  await test('项目 FPS 与导出 FPS 分开：--fps 60 不改变项目原始 30', () => {
    const resolution = resolveExportFps({ projectFps: 30, cliDefaultFps: 30 }, {
      fpsMode: '60',
      customFps: ''
    })
    assert.equal(resolution.fps, 60)
    assert.match(resolution.note, /不改变项目原始帧率/)
    const project = resolveExportFps({ projectFps: 30, cliDefaultFps: 30 }, {
      fpsMode: 'project',
      customFps: ''
    })
    assert.equal(project.fps, 30)
    assert.match(project.note, /data-fps/)
  })

  await test('未声明 data-fps 时按 CLI 默认值，且来源标记为 cli-default', () => {
    const resolution = resolveExportFps({ projectFps: null, cliDefaultFps: 30 }, {
      fpsMode: 'project',
      customFps: ''
    })
    assert.equal(resolution.fps, 30)
    assert.equal(resolution.source, 'cli-default')
  })

  await test('有理数帧率 30000/1001 解析为 29.97', () => {
    const resolution = resolveExportFps({ projectFps: null, cliDefaultFps: 30 }, {
      fpsMode: 'custom',
      customFps: '30000/1001'
    })
    assert.equal(resolution.fps, 29.97)
  })

  await test('既无项目 FPS 也无 CLI 默认值时返回 null', () => {
    const resolution = resolveExportFps({ projectFps: null, cliDefaultFps: null }, {
      fpsMode: 'project',
      customFps: ''
    })
    assert.equal(resolution.fps, null)
    assert.equal(resolution.source, 'unknown')
  })

  console.log('\n[3] 总帧数计算')

  await test('56s × 60fps = 3360 帧', () => {
    const profile = buildWorkloadProfile(
      workloadInput({
        metadata: meta({ durationSec: 56, projectFps: 60 }),
        exportFps: 60
      })
    )
    assert.equal(profile.durationSec, 56)
    assert.equal(profile.fps, 60)
    assert.equal(profile.exportFps, 60)
    assert.equal(profile.frameCount, 3360)
  })

  await test('时长或帧率缺失时不计算总帧数（不给假数字）', () => {
    const noFps = buildWorkloadProfile(
      workloadInput({ metadata: meta({ durationSec: 56, projectFps: null }), exportFps: null })
    )
    assert.equal(noFps.frameCount, null)
    assert.equal(noFps.frameCountSource, 'unknown')

    const noDuration = buildWorkloadProfile(
      workloadInput({ metadata: meta({ durationSec: null }), exportFps: 30 })
    )
    assert.equal(noDuration.frameCount, null)
    assert.ok(noDuration.unknownFields.includes('时长'))
  })

  console.log('\n[4] 负载等级与时长解耦')

  const heavy4s = buildWorkloadProfile(
    workloadInput({
      metadata: meta({
        width: 3840,
        height: 2160,
        durationSec: 4,
        projectFps: 60,
        elements: 420,
        tracks: 6,
        projectBytes: 900 * 1024 ** 2
      }),
      exportFps: 60,
      assets: {
        imageCount: 12,
        videoCount: 3,
        assetBytes: 800 * 1024 ** 2,
        largestAssetBytes: 400 * 1024 ** 2,
        largestAssetPath: 'assets/big.mp4',
        videoFiles: ['assets/big.mp4'],
        truncated: false
      },
      entry: {
        webgl: true,
        canvasCount: 2,
        domElements: 520,
        animationHints: ['GSAP', 'Three.js', 'WebGL 上下文', 'Shader', 'Canvas 元素'],
        entryBytes: 200_000,
        htmlFiles: ['index.html'],
        found: true
      },
      videoProbe: { width: 3840, height: 2160, durationSec: 30 }
    })
  )

  const light300s = buildWorkloadProfile(
    workloadInput({
      metadata: meta({ width: 1920, height: 1080, durationSec: 300, projectFps: 30, elements: 4, tracks: 1 }),
      exportFps: 30,
      entry: {
        webgl: false,
        canvasCount: 0,
        domElements: 12,
        animationHints: ['CSS 关键帧'],
        entryBytes: 8_000,
        htmlFiles: ['index.html'],
        found: true
      }
    })
  )

  await test('4 秒的 WebGL 4K 项目负载高于 300 秒的文字动画', () => {
    assert.ok(
      heavy4s.score > light300s.score,
      `heavy=${heavy4s.score} light=${light300s.score}`
    )
    assert.ok(heavy4s.complexity === '4k-heavy' || heavy4s.complexity === 'high')
    assert.ok(light300s.complexity !== 'high' && light300s.complexity !== '4k-heavy')
  })

  await test('时长对分数的贡献被限制在 8 分以内', () => {
    const durationPart = light300s.scoreBreakdown.find((p) => p.key === 'duration')
    assert.ok(durationPart, '应有 duration 得分项')
    assert.ok((durationPart?.points ?? 0) <= 8, `duration=${durationPart?.points}`)
    assert.ok((durationPart?.points ?? 0) > 0)
  })

  await test('得分构成可解释：每项都有标签与说明', () => {
    for (const part of heavy4s.scoreBreakdown) {
      assert.ok(part.label.length > 0)
      assert.ok(part.detail.length > 0)
      assert.ok(part.points >= 0)
    }
  })

  console.log('\n[5] 未知项目不编造复杂度')

  await test('连入口文件都读不到 → 负载未知 / 时长 null / FPS null', () => {
    const profile = buildWorkloadProfile(
      workloadInput({
        metadata: meta({
          width: null,
          height: null,
          durationSec: null,
          durationSource: 'unknown',
          projectFps: null,
          projectFpsSource: 'unknown',
          cliDefaultFps: null,
          elements: null,
          tracks: null,
          projectBytes: null,
          capability: {
            info: false,
            compositions: false,
            json: false,
            error: '当前 CLI 未提供 info / compositions 命令',
            defaultFps: null,
            cliVersion: null,
            probedAt: null
          }
        }),
        exportFps: null,
        entry: { ...emptyEntry, found: false, htmlFiles: [] }
      })
    )
    assert.equal(profile.complexity, 'unknown')
    assert.equal(profile.durationSec, null)
    assert.equal(profile.fps, null)
    assert.equal(profile.frameCount, null)
    assert.ok(profile.unknownFields.length >= 5)
    assert.ok(profile.notes.some((n) => n.includes('时长无法可靠确定')))
  })

  console.log('\n[6] 项目文件指纹')

  const tmpProject = join(tmpdir(), `hf-meta-test-${Date.now()}`)
  await fs.mkdir(join(tmpProject, 'assets'), { recursive: true })
  await fs.writeFile(join(tmpProject, 'index.html'), '<div data-composition-id="main"></div>', 'utf-8')
  await fs.writeFile(join(tmpProject, 'assets', 'a.txt'), 'a', 'utf-8')

  await test('首次采集包含 index.html 与素材文件', async () => {
    const fingerprint = await collectProjectFingerprint(tmpProject)
    assert.ok(fingerprint.files.some((f) => f.path === 'index.html'))
    assert.ok(fingerprint.files.some((f) => f.path === 'assets/a.txt'))
    assert.ok(fingerprint.dirListings > 0)
  })

  await test('文件未变化时校验通过，且不遍历目录', async () => {
    const fingerprint = await collectProjectFingerprint(tmpProject)
    const diff = await verifyProjectFingerprint(tmpProject, fingerprint)
    assert.equal(diff.ok, true)
    assert.equal(diff.stats, fingerprint.files.length)
    assert.ok(diff.verifyMs >= 0)
  })

  await test('修改 index.html 后校验失败并指出文件', async () => {
    const fingerprint = await collectProjectFingerprint(tmpProject)
    await new Promise((resolve) => setTimeout(resolve, 12))
    await fs.writeFile(
      join(tmpProject, 'index.html'),
      '<div data-composition-id="main" data-duration="8"></div>',
      'utf-8'
    )
    const diff = await verifyProjectFingerprint(tmpProject, fingerprint)
    assert.equal(diff.ok, false)
    assert.ok(diff.changed.includes('index.html'))
    assert.match(diff.reason ?? '', /index\.html/)
  })

  await test('删除素材后校验失败并指出缺失', async () => {
    const fingerprint = await collectProjectFingerprint(tmpProject)
    await fs.rm(join(tmpProject, 'assets', 'a.txt'))
    const diff = await verifyProjectFingerprint(tmpProject, fingerprint)
    assert.equal(diff.ok, false)
    assert.ok(diff.missing.includes('assets/a.txt'))
  })

  console.log('\n[7] 缓存文件命名与损坏恢复')

  await test('同一项目的不同写法映射到同一个缓存文件', () => {
    const a = projectCacheFileName('D:/Demo/Project')
    const b = projectCacheFileName('D:\\Demo\\Project\\')
    assert.equal(a, b)
    assert.equal(normalizeProjectPath('D:\\Demo\\Project\\'), 'd:/demo/project')
  })

  await test('不同项目映射到不同缓存文件', () => {
    const a = projectCacheFileName('D:/project-a')
    const b = projectCacheFileName('D:/project-b')
    assert.notEqual(a, b)
  })

  await test('缓存 JSON 损坏时返回 null 并留档，不抛异常', async () => {
    const file = join(tmpdir(), `hf-cache-corrupt-${Date.now()}.json`)
    await fs.writeFile(file, '{ this is not json', 'utf-8')
    const value = await readJsonFile<{ a: number }>(file)
    assert.equal(value, null)
    const dir = join(file, '..')
    const entries = await fs.readdir(dir)
    assert.ok(entries.some((name) => name.includes('hf-cache-corrupt-') && name.includes('.corrupt-')))
  })

  await test('写入后可以读回（原子写）', async () => {
    const file = join(tmpdir(), `hf-cache-ok-${Date.now()}.json`)
    const ok = await writeJsonFile(file, { hello: 'world' })
    assert.equal(ok, true)
    const value = await readJsonFile<{ hello: string }>(file)
    assert.equal(value?.hello, 'world')
  })

  await fs.rm(tmpProject, { recursive: true, force: true })

  console.log(`\n通过 ${passed} 组断言`)
  if (existsSync(join(tmpdir(), 'hf-render-logic-test'))) {
    // 逻辑测试会在临时目录留下缓存目录，清理掉避免影响下一次断言
  }
}

void main()
