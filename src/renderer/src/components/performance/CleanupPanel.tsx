import { Badge, Button, Panel, Spinner, Toggle } from '../ui'
import { formatBytes } from '../../services/perf-format'
import type {
  TestCleanupSummary,
  TestStorageUsage,
  TestTaskStatus,
  TestTaskUsage
} from '@shared/types/cleanup'

const STATUS_LABEL: Record<TestTaskStatus | 'unknown', string> = {
  running: '测试中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  unknown: '未知'
}

function statusTone(status: TestTaskStatus | 'unknown'): 'ok' | 'warn' | 'error' | 'neutral' | 'info' {
  if (status === 'done') return 'ok'
  if (status === 'failed') return 'error'
  if (status === 'canceled') return 'warn'
  if (status === 'running') return 'info'
  return 'neutral'
}

function timeText(iso: string | null): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  return new Date(time).toLocaleString('zh-CN', { hour12: false })
}

function taskLabel(task: TestTaskUsage): string {
  if (!task.owned) return '未登记目录，不会被自动删除'
  if (task.status === 'running') return '正在运行，不会被清理'
  if (task.mediaBytes === 0) return '临时媒体已清理，仅保留日志与报告'
  return '存在临时媒体，可在下次清理时删除'
}

/**
 * 性能测试临时文件面板。
 *
 * 把「占用了多少空间 / 上次清掉了什么 / 三个清理开关」摆在一起，
 * 让用户能确认：只有测试任务自己的目录会被清理，日志与报告始终保留。
 */
export function CleanupPanel(props: {
  usage: TestStorageUsage | null
  lastCleanup: TestCleanupSummary | null
  busy: boolean
  cleaning: boolean
  settings: { autoClean: boolean; keepFailed: boolean; keepReports: boolean }
  onToggle: (patch: { autoClean?: boolean; keepFailed?: boolean; keepReports?: boolean }) => void
  onRefresh: () => void
  onCleanup: () => void
}): JSX.Element {
  const usage = props.usage
  const tasks = (usage?.tasks ?? []).slice(0, 8)
  const cleanup = props.lastCleanup

  return (
    <Panel
      title="性能测试临时文件"
      subtitle="每次测试使用 performance-tests/<测试ID>/ 独立目录；结束后自动删除临时视频、PNG 序列、原始帧与专用 Chrome 配置，只保留日志与性能报告"
      actions={
        <>
          <Button size="sm" variant="subtle" onClick={props.onRefresh} disabled={props.busy || props.cleaning}>
            {props.busy ? <Spinner /> : null}
            刷新占用
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onCleanup} disabled={props.busy || props.cleaning}>
            {props.cleaning ? <Spinner /> : null}
            立即清理历史临时文件
          </Button>
        </>
      }
    >
      <div className="toggle-grid">
        <Toggle
          label="自动清理性能测试文件"
          description="测试结束后（成功 / 失败 / 取消）自动删除本次产生的临时媒体与中间文件"
          checked={props.settings.autoClean}
          onChange={(checked) => props.onToggle({ autoClean: checked })}
        />
        <Toggle
          label="保留失败测试文件"
          description="测试失败时保留临时视频与中间文件，便于排查；关闭后失败任务同样只保留日志"
          checked={props.settings.keepFailed}
          onChange={(checked) => props.onToggle({ keepFailed: checked })}
        />
        <Toggle
          label="保留性能测试报告"
          description="保留任务目录中的 report.json、cleanup.json 与 logs/；性能报告列表本身始终保留"
          checked={props.settings.keepReports}
          onChange={(checked) => props.onToggle({ keepReports: checked })}
        />
      </div>

      <div className="cleanup-stats">
        <div className="cleanup-stat">
          <span className="metric-label">本地测试文件占用</span>
          <strong>{usage ? formatBytes(usage.totalBytes) : '—'}</strong>
          <span className="muted-line">
            {usage ? `${usage.taskCount} 个任务目录 · ${usage.ownedTaskCount} 个由 HF Render 登记` : '正在统计…'}
          </span>
        </div>
        <div className="cleanup-stat">
          <span className="metric-label">可清理的临时媒体</span>
          <strong>{usage ? formatBytes(usage.mediaBytes) : '—'}</strong>
          <span className="muted-line">视频 / PNG 序列 / 原始帧 / 中间编码文件</span>
        </div>
        <div className="cleanup-stat">
          <span className="metric-label">长期保留</span>
          <strong>{usage ? formatBytes(usage.logBytes + usage.reportBytes) : '—'}</strong>
          <span className="muted-line">
            日志 {usage ? formatBytes(usage.logBytes) : '—'} · 报告 {usage ? formatBytes(usage.reportBytes) : '—'}
          </span>
        </div>
      </div>

      {cleanup && (
        <div className={`cleanup-summary ${cleanup.skipped ? 'skipped' : cleanup.failedFiles > 0 ? 'warn' : 'ok'}`}>
          <div className="cleanup-summary-head">
            <span className="cache-title">本次测试（{cleanup.taskId}）的清理结果</span>
            <Badge tone={cleanup.skipped ? 'warn' : cleanup.failedFiles > 0 ? 'warn' : 'ok'}>
              {cleanup.skipped ? '按策略保留' : `释放 ${formatBytes(cleanup.freedBytes)}`}
            </Badge>
          </div>
          {cleanup.skipped ? (
            <p className="cache-line muted">{cleanup.skipReason ?? '本次没有清理任何文件'}</p>
          ) : (
            <>
              <p className="cache-line">
                删除 {cleanup.deletedFiles} 个文件 · 释放 {formatBytes(cleanup.freedBytes)} · 清理前{' '}
                {formatBytes(cleanup.totalBytesBefore)} → 清理后 {formatBytes(cleanup.remainingBytes)}
              </p>
              <p className="cache-line muted">
                保留 {cleanup.keptFiles} 个文件（{formatBytes(cleanup.keptBytes)}）：日志
                {cleanup.keptLogDir ? ` ${cleanup.keptLogDir}` : '（已随设置删除）'} · 报告
                {cleanup.keptReportFile ? ' 已保留' : ' 未保留'}
                {cleanup.waitExitMs > 0 ? ` · 等待子进程退出 ${cleanup.waitExitMs} ms` : ''}
                {cleanup.retries > 0 ? ` · 重试 ${cleanup.retries} 次` : ''}
              </p>
              {cleanup.failedFiles > 0 && (
                <p className="cache-line warn-line">
                  {cleanup.failedFiles} 个文件因被占用 / 权限不足未能删除，已记录到 cleanup.json，下次启动或点「立即清理」会重试。
                </p>
              )}
              {cleanup.missingFiles > 0 && (
                <p className="cache-line muted">
                  另有 {cleanup.missingFiles} 个条目在删除时已不存在（已被子进程或上次清理删除），已如实记录。
                </p>
              )}
              {cleanup.errors
                .filter((e) => e.refused)
                .slice(0, 3)
                .map((e, index) => (
                  <p className="cache-line muted" key={`${e.path ?? 'err'}-${index}`}>
                    安全守卫拒绝：{e.message}
                  </p>
                ))}
            </>
          )}
        </div>
      )}

      {tasks.length > 0 ? (
        <div className="bench-table-wrap">
          <table className="bench-table">
            <thead>
              <tr>
                <th>测试任务</th>
                <th>状态</th>
                <th>占用</th>
                <th>临时媒体</th>
                <th>创建时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.taskId}>
                  <td className="mono">{task.taskId}</td>
                  <td>
                    <Badge tone={statusTone(task.status)}>{STATUS_LABEL[task.status]}</Badge>
                  </td>
                  <td className="mono">{formatBytes(task.bytes)}</td>
                  <td className="mono">{formatBytes(task.mediaBytes)}</td>
                  <td className="mono">{timeText(task.createdAt)}</td>
                  <td className="muted-line">{taskLabel(task)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-line">
          {usage?.exists ? '当前没有性能测试任务目录' : '还没有执行过性能测试，暂时没有临时文件'}
        </div>
      )}

      <p className="muted-line">
        目录 {usage?.root || '—'}
        {usage?.scannedAt ? ` · 统计于 ${new Date(usage.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
      </p>
      <p className="muted-line">
        清理只作用于本应用登记过的任务目录与文件：不会删除 HyperFrames 项目、项目素材、你正式导出的视频，也不会碰其他软件或公共
        Chrome 用户数据。
      </p>
    </Panel>
  )
}
