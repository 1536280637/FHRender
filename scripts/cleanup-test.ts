/**
 * 性能测试临时文件清理的回归测试（不需要 Electron，也不需要真实渲染）。
 *
 * 运行：npm run test:cleanup
 *
 * 覆盖：
 * 1. 安全守卫：越界 / 路径穿越 / 任务根本身 / 项目目录 / node_modules 一律拒绝
 * 2. 任务工作区与 manifest 登记（绝对路径 / 类型 / 来源 / 任务 / 是否可清理）
 * 3. 成功清理：删临时媒体、保留日志与报告、空目录被清掉、重复清理不再产生垃圾
 * 4. 失败清理：默认删媒体；开启「保留失败现场」时不删
 * 5. 取消清理：同样删除媒体并保留日志
 * 6. 文件被占用：记录错误并有限重试，不抛异常；释放后可清理
 * 7. 清单被篡改（指向项目文件）：安全守卫拒绝，项目文件完好
 * 8. 历史批量清理：未登记目录绝不触碰
 * 9. 启动扫描：只清理过期的 running 任务
 * 10. 占用统计：媒体 / 日志 / 报告分类正确
 */

import assert from 'node:assert'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { guardDeletablePath, isStrictlyInside, normalizeForCompare } from '../src/main/cleanup/path-guard'
import { TestWorkspace, perfTestRoot } from '../src/main/cleanup/test-workspace'
import { PerformanceTestCleanup, measurePath } from '../src/main/cleanup/cleanup-engine'
import type { TestCleanupPolicy } from '../src/shared/types/cleanup'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 1
  }
}

const POLICY: TestCleanupPolicy = { autoClean: true, keepFailed: false, keepReports: true }

async function main(): Promise<void> {
  const sandbox = join(tmpdir(), `hf-render-cleanup-test-${randomUUID().slice(0, 8)}`)
  const userData = join(sandbox, 'userData')
  const projectDir = join(sandbox, 'MyProject')
  const outputDir = join(sandbox, 'UserExports')
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(outputDir, { recursive: true })
  const projectFile = join(projectDir, 'index.html')
  const userVideo = join(outputDir, 'final-cut.mp4')
  await fs.writeFile(projectFile, '<html>project</html>', 'utf-8')
  await fs.writeFile(userVideo, Buffer.alloc(1024 * 64))

  const cleanup = new PerformanceTestCleanup({ userDataDir: userData })
  const forbidden = [projectDir, outputDir]

  /** 造一个任务：媒体文件 + PNG 序列 + 原始帧 + Chrome 配置 + 日志 + 报告 */
  async function buildTask(
    taskId: string,
    status: 'running' | 'done' | 'failed' | 'canceled' = 'done'
  ): Promise<{ workspace: TestWorkspace; mediaBytes: number; modeDir: string }> {
    const workspace = await TestWorkspace.create({
      userDataDir: userData,
      taskId,
      taskKind: 'comparison',
      projectPath: projectDir
    })
    const modeDir = await workspace.ensureModeDir('balanced')
    const video = join(modeDir, 'balanced-run-1.mp4')
    await fs.writeFile(video, Buffer.alloc(220 * 1024))
    await workspace.registerPath(video, { source: 'balanced' })

    const pngDir = await workspace.ensureModeDir('performance')
    const pngRun = join(pngDir, 'performance-run-1')
    await fs.mkdir(pngRun, { recursive: true })
    for (let i = 0; i < 6; i += 1) {
      await fs.writeFile(join(pngRun, `frame-${String(i).padStart(4, '0')}.png`), Buffer.alloc(20 * 1024))
    }
    await workspace.registerPath(pngRun, { source: 'performance', entry: 'dir', kind: 'png-sequence' })

    // 原始 RGBA 帧 + 临时截图 + Chrome 配置：全部在任务 tmp/ 内（子进程 TEMP 指向这里）
    await fs.writeFile(join(workspace.screenshotsDir, 'shot-1.png'), Buffer.alloc(30 * 1024))
    await fs.writeFile(join(workspace.tmpDir, 'frames-raw.rgba'), Buffer.alloc(90 * 1024))
    await fs.mkdir(join(workspace.chromeProfileDir, 'Default'), { recursive: true })
    await fs.writeFile(join(workspace.chromeProfileDir, 'Default', 'Cookies'), Buffer.alloc(40 * 1024))

    // 日志与报告（长期保留）
    await fs.writeFile(join(workspace.logDir, 'session.log'), '[info] test session\n', 'utf-8')
    await workspace.writeReport({ testId: taskId, status, runs: [{ mode: 'balanced', durationMs: 1234 }] })

    await workspace.setStatus(status)
    const mediaBytes =
      220 * 1024 + 6 * 20 * 1024 + 30 * 1024 + 90 * 1024 + 40 * 1024
    return { workspace, mediaBytes, modeDir }
  }

  console.log('\n[1] 安全守卫')

  await test('任务目录内的普通文件放行', () => {
    const root = join(userData, 'performance-tests', 't1')
    const verdict = guardDeletablePath(join(root, 'balanced', 'a.mp4'), { taskRoot: root })
    assert.equal(verdict.ok, true)
  })

  await test('包含 .. 的路径被判定为路径穿越', () => {
    const root = join(userData, 'performance-tests', 't1')
    // 用字符串拼接保留 ".."（path.join 会提前把它规范化掉，测不出守卫）
    const verdict = guardDeletablePath(`${root}\\..\\..\\evil.mp4`, { taskRoot: root })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'traversal')
  })

  await test('任务目录外的路径被拒绝', () => {
    const root = join(userData, 'performance-tests', 't1')
    const verdict = guardDeletablePath(join(userData, 'profiles', 'hardware.json'), { taskRoot: root })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'outside-task')
  })

  await test('任务根目录本身不允许被当作临时文件删除', () => {
    const root = join(userData, 'performance-tests', 't1')
    const verdict = guardDeletablePath(root, { taskRoot: root })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'task-root')
  })

  await test('任务根的上级目录被拒绝', () => {
    const root = join(userData, 'performance-tests', 't1')
    const verdict = guardDeletablePath(perfTestRoot(userData), { taskRoot: root })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.code === 'task-root' || verdict.code === 'outside-task')
  })

  await test('用户输出目录 / 项目目录被拒绝', () => {
    const root = join(userData, 'performance-tests', 't1')
    assert.equal(guardDeletablePath(join(outputDir, 'x.mp4'), { taskRoot: root, forbiddenRoots: forbidden }).ok, false)
    assert.equal(guardDeletablePath(join(projectDir, 'index.html'), { taskRoot: root, forbiddenRoots: forbidden }).ok, false)
  })

  await test('依赖目录（node_modules / .git）被拒绝', () => {
    const root = join(userData, 'performance-tests', 't1')
    const verdict = guardDeletablePath(join(root, 'node_modules', 'x.js'), { taskRoot: root })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'protected-segment')
  })

  await test('相对路径与文件系统根被拒绝', () => {
    const root = join(userData, 'performance-tests', 't1')
    assert.equal(guardDeletablePath('balanced/a.mp4', { taskRoot: root }).ok, false)
    const fsRoot = process.platform === 'win32' ? 'C:\\' : '/'
    assert.equal(guardDeletablePath(fsRoot, { taskRoot: root }).ok, false)
  })

  await test('边界判断不会把同前缀目录误判为内部', () => {
    assert.equal(isStrictlyInside('C:/a/task', 'C:/a/task2/file.mp4'), false)
    assert.equal(isStrictlyInside('C:/a/task', 'C:/a/task/file.mp4'), true)
  })

  console.log('\n[2] 任务工作区与清单登记')

  const taskA = await buildTask('cmp_20261021_000001')
  const workspaceA = taskA.workspace

  await test('任务目录结构符合约定（各模式独立目录 / logs / tmp / chrome-profile）', async () => {
    assert.equal(normalizeForCompare(workspaceA.root), normalizeForCompare(join(perfTestRoot(userData), 'cmp_20261021_000001')))
    for (const dir of ['logs', 'tmp', 'tmp/chrome-profile', 'tmp/screenshots', 'balanced', 'performance']) {
      const stat = await fs.stat(join(workspaceA.root, dir))
      assert.ok(stat.isDirectory(), `${dir} 应存在`)
    }
  })

  await test('manifest 带应用标记、任务 ID、输出根与独占目录', async () => {
    const raw = await fs.readFile(workspaceA.manifestPath, 'utf-8')
    const manifest = JSON.parse(raw)
    assert.equal(manifest.app, 'hf-render')
    assert.equal(manifest.taskId, 'cmp_20261021_000001')
    assert.equal(manifest.taskKind, 'comparison')
    assert.ok(manifest.roots.some((r: { path: string }) => r.path.endsWith('logs')))
    assert.ok(manifest.roots.some((r: { path: string }) => r.path.endsWith('tmp')))
  })

  await test('产物登记包含绝对路径 / 类型 / 来源 / 创建时间 / 是否可清理', async () => {
    const entries = workspaceA.manifest.entries
    const video = entries.find((e) => e.path.endsWith('balanced-run-1.mp4'))
    assert.ok(video, '应登记 mp4')
    assert.equal(video!.kind, 'video-mp4')
    assert.equal(video!.source, 'balanced')
    assert.equal(video!.cleanable, true)
    assert.equal(video!.owner, 'hf-render-child')
    assert.ok(Date.parse(video!.createdAt) > 0)
    const png = entries.find((e) => e.path.endsWith('performance-run-1'))
    assert.equal(png!.kind, 'png-sequence')
    const report = entries.find((e) => e.path.endsWith('report.json'))
    assert.equal(report!.cleanable, false)
  })

  console.log('\n[3] 成功清理')

  let summaryA = await cleanup.cleanupTask({
    workspace: workspaceA,
    taskStatus: 'done',
    policy: POLICY,
    forbiddenRoots: forbidden
  })

  await test('临时视频 / PNG 序列 / 原始帧 / 截图 / Chrome 配置全部删除', async () => {
    assert.equal(await exists(join(taskA.modeDir, 'balanced-run-1.mp4')), false)
    assert.equal(await exists(join(workspaceA.root, 'performance', 'performance-run-1')), false)
    assert.equal(await exists(join(workspaceA.tmpDir, 'frames-raw.rgba')), false)
    assert.equal(await exists(join(workspaceA.chromeProfileDir, 'Default', 'Cookies')), false)
    assert.equal(await exists(join(workspaceA.screenshotsDir, 'shot-1.png')), false)
    assert.ok(summaryA.deletedFiles >= 5, `删除文件数应 >= 5，实际 ${summaryA.deletedFiles}`)
    assert.ok(summaryA.freedBytes >= taskA.mediaBytes, `释放空间应覆盖媒体体积，实际 ${summaryA.freedBytes}`)
  })

  await test('日志与性能报告保留', async () => {
    assert.equal(await exists(join(workspaceA.logDir, 'session.log')), true)
    assert.equal(await exists(workspaceA.reportPath), true)
    const report = JSON.parse(await fs.readFile(workspaceA.reportPath, 'utf-8'))
    assert.equal(report.testId, 'cmp_20261021_000001')
    assert.equal(summaryA.keptReportFile, workspaceA.reportPath)
  })

  await test('清理记录 cleanup.json 落盘且包含释放空间与错误列表', async () => {
    const record = JSON.parse(await fs.readFile(workspaceA.cleanupPath, 'utf-8'))
    assert.equal(record.taskId, 'cmp_20261021_000001')
    assert.equal(record.skipped, false)
    assert.ok(Array.isArray(record.errors))
    assert.ok(record.remainingBytes >= 0)
  })

  await test('空的临时子目录被清掉', async () => {
    assert.equal(await exists(join(workspaceA.root, 'performance')), false)
  })

  await test('重复清理不产生新垃圾（第二次释放为 0）', async () => {
    const again = await cleanup.cleanupTask({
      workspace: workspaceA,
      taskStatus: 'done',
      policy: POLICY,
      forbiddenRoots: forbidden
    })
    assert.equal(again.freedBytes, 0)
    assert.equal(again.deletedFiles, 0)
  })

  console.log('\n[4] 失败清理')

  const taskFail = await buildTask('cmp_20261021_000002', 'failed')
  const failSummary = await cleanup.cleanupTask({
    workspace: taskFail.workspace,
    taskStatus: 'failed',
    policy: { ...POLICY, keepFailed: false },
    forbiddenRoots: forbidden
  })

  await test('失败任务默认删除大型临时文件，保留日志与报告', async () => {
    assert.equal(await exists(join(taskFail.modeDir, 'balanced-run-1.mp4')), false)
    assert.equal(await exists(join(taskFail.workspace.logDir, 'session.log')), true)
    assert.equal(await exists(taskFail.workspace.reportPath), true)
    assert.ok(failSummary.freedBytes > 0)
  })

  const taskKeep = await buildTask('cmp_20261021_000003', 'failed')
  const keepSummary = await cleanup.cleanupTask({
    workspace: taskKeep.workspace,
    taskStatus: 'failed',
    policy: { ...POLICY, keepFailed: true },
    forbiddenRoots: forbidden
  })

  await test('开启「保留失败测试文件」时一个文件都不删，并说明原因', async () => {
    assert.equal(keepSummary.skipped, true)
    assert.match(keepSummary.skipReason ?? '', /保留失败测试现场/)
    assert.equal(await exists(join(taskKeep.modeDir, 'balanced-run-1.mp4')), true)
    assert.equal(keepSummary.deletedFiles, 0)
  })

  console.log('\n[5] 用户取消')

  const taskCancel = await buildTask('cmp_20261021_000004', 'canceled')
  const cancelSummary = await cleanup.cleanupTask({
    workspace: taskCancel.workspace,
    taskStatus: 'canceled',
    policy: POLICY,
    forbiddenRoots: forbidden
  })

  await test('取消任务：删除临时媒体、保留已获得的报告与取消日志', async () => {
    assert.equal(await exists(join(taskCancel.modeDir, 'balanced-run-1.mp4')), false)
    assert.equal(await exists(join(taskCancel.workspace.logDir, 'session.log')), true)
    assert.equal(await exists(taskCancel.workspace.reportPath), true)
    assert.equal(cancelSummary.taskStatus, 'canceled')
    assert.ok(cancelSummary.deletedFiles > 0)
  })

  console.log('\n[6] 删除失败时的异常保护')

  const taskLocked = await buildTask('cmp_20261021_000005', 'done')
  const lockedFile = join(taskLocked.modeDir, 'balanced-run-1.mp4')
  // 把一个目录登记成「文件」：unlink 必然失败（Windows 上是 EPERM，Unix 上是 EISDIR），
  // 用来验证「有限重试 → 记录错误 → 不抛异常 → 其他产物与报告照常」
  const blockedDir = join(taskLocked.workspace.tmpDir, 'blocked-dir')
  await fs.mkdir(blockedDir, { recursive: true })
  await fs.writeFile(join(blockedDir, 'inside.bin'), Buffer.alloc(2048))
  await taskLocked.workspace.registerPath(blockedDir, { source: 'test-failure', entry: 'file' })
  await taskLocked.workspace.flush()

  const lockedSummary = await cleanup.cleanupTask({
    workspace: taskLocked.workspace,
    taskStatus: 'done',
    policy: POLICY,
    forbiddenRoots: forbidden
  })

  await test('删除失败只记录错误，不抛异常，日志 / 报告 / 其他产物照常处理', async () => {
    assert.ok(lockedSummary.failedFiles >= 1, '应记录未能删除的条目')
    assert.ok(lockedSummary.errors.length >= 1)
    assert.ok(
      lockedSummary.errors.some((e) => !e.refused && (e.code === 'io' || e.code === 'locked' || e.code === 'permission')),
      `应记录真实 IO 失败，实际 ${JSON.stringify(lockedSummary.errors)}`
    )
    assert.equal(await exists(lockedFile), false, '其他临时媒体应已正常删除')
    assert.equal(await exists(taskLocked.workspace.reportPath), true, '报告必须保留')
    assert.equal(await exists(join(taskLocked.workspace.logDir, 'session.log')), true, '日志必须保留')
  })

  console.log('\n[7] 清单被篡改 / 未登记文件')

  const taskTampered = await buildTask('cmp_20261021_000006', 'done')
  // 手工往清单里塞一条指向「项目文件」的条目：模拟清单被改坏 / 被伪造
  taskTampered.workspace.manifest.entries.push({
    path: projectFile,
    entry: 'file',
    kind: 'video-mp4',
    cleanable: true,
    source: 'tampered',
    owner: 'hf-render-child',
    createdAt: new Date().toISOString(),
    bytes: null
  })
  await taskTampered.workspace.flush()
  const tamperedSummary = await cleanup.cleanupTask({
    workspace: taskTampered.workspace,
    taskStatus: 'done',
    policy: POLICY,
    forbiddenRoots: forbidden
  })

  await test('清单里指向项目文件的条目被安全守卫拒绝，项目文件完好', async () => {
    assert.equal(await exists(projectFile), true)
    assert.ok(tamperedSummary.refusedFiles >= 1, '应记录被拒绝的条目')
    assert.ok(tamperedSummary.errors.some((e) => e.refused))
    const content = await fs.readFile(projectFile, 'utf-8')
    assert.match(content, /project/)
  })

  await test('用户正式导出的视频同样不受影响', async () => {
    assert.equal(await exists(userVideo), true)
  })

  console.log('\n[8] 历史批量清理')

  const strayDir = join(perfTestRoot(userData), 'someone-else-dir')
  await fs.mkdir(strayDir, { recursive: true })
  await fs.writeFile(join(strayDir, 'keep-me.bin'), Buffer.alloc(4096))
  const taskHistory = await buildTask('cmp_20261021_000007', 'done')

  const batch = await cleanup.cleanupHistory({ policy: POLICY, forbiddenRoots: forbidden })

  await test('批量清理删掉本应用任务的临时媒体', async () => {
    assert.equal(await exists(join(taskHistory.modeDir, 'balanced-run-1.mp4')), false)
    assert.ok(batch.deletedFiles > 0)
    assert.ok(batch.cleanedTasks.length > 0 || batch.freedBytes > 0)
  })

  await test('未登记目录（没有 manifest）完全不碰', async () => {
    assert.equal(await exists(join(strayDir, 'keep-me.bin')), true)
    assert.ok(batch.skippedTasks.includes('someone-else-dir'))
  })

  await test('自动清理关闭时不删除任何文件', async () => {
    const taskOff = await buildTask('cmp_20261021_000008', 'done')
    const off = await cleanup.cleanupTask({
      workspace: taskOff.workspace,
      taskStatus: 'done',
      policy: { ...POLICY, autoClean: false },
      forbiddenRoots: forbidden
    })
    assert.equal(off.skipped, true)
    assert.equal(await exists(join(taskOff.modeDir, 'balanced-run-1.mp4')), true)
  })

  console.log('\n[9] 启动扫描')

  const staleTask = await buildTask('cmp_20261021_000009', 'running')
  const freshTask = await buildTask('cmp_20261021_00000a', 'running')
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(staleTask.workspace.root, oneHourAgo, oneHourAgo)

  const scan = await cleanup.startupScan({ policy: POLICY, forbiddenRoots: forbidden })

  await test('过期 running 任务按取消处理并清理临时媒体', async () => {
    assert.equal(await exists(join(staleTask.modeDir, 'balanced-run-1.mp4')), false)
    assert.ok(scan.deletedFiles > 0)
    const manifest = JSON.parse(await fs.readFile(staleTask.workspace.manifestPath, 'utf-8'))
    assert.equal(manifest.status, 'canceled', '清单状态应被纠正为 canceled')
    assert.equal(await exists(staleTask.workspace.cleanupPath), true, '应留下清理记录')
  })

  await test('刚启动的 running 任务不会被误清理', async () => {
    assert.equal(await exists(join(freshTask.modeDir, 'balanced-run-1.mp4')), true)
  })

  console.log('\n[10] 占用统计')

  const usage = await cleanup.usage(null)

  await test('占用统计区分媒体 / 日志 / 报告，且总量等于各文件之和', async () => {
    assert.equal(usage.exists, true)
    assert.ok(usage.taskCount >= 5)
    assert.ok(usage.ownedTaskCount >= 5)
    assert.ok(usage.logBytes > 0, '应统计到日志')
    assert.ok(usage.reportBytes > 0, '应统计到报告')
    const sum = usage.tasks.reduce((acc, t) => acc + t.bytes, 0)
    assert.equal(usage.totalBytes, sum)
    const stray = usage.tasks.find((t) => t.taskId === 'someone-else-dir')
    assert.ok(stray && stray.owned === false, '未登记目录应标记为不受管')
  })

  await test('measurePath 对不存在的路径返回 0 而不是抛错', async () => {
    const measured = await measurePath(join(sandbox, 'nope', 'nothing.mp4'))
    assert.equal(measured.bytes, 0)
    assert.equal(measured.files, 0)
  })

  /* ---- 收尾：模拟用户项目与导出目录仍然完整 ---- */
  await test('全部清理结束后：项目文件、用户导出视频仍在', async () => {
    assert.equal(await exists(projectFile), true)
    assert.equal(await exists(userVideo), true)
    assert.equal(await exists(join(projectDir, 'index.html')), true)
  })

  // 清理测试沙箱
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined)

  console.log(`\n共 ${passed} 组断言通过${process.exitCode ? '（存在失败项）' : ''}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

void main()
