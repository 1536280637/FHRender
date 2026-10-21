/**
 * 候选参数矩阵测试面板（当前**未挂载**到任何页面）。
 *
 * 为什么保留文件但不在页面上使用：
 * - 它与「性能对比测试」在用户视角是同一个动作（都是长时间真实渲染），
 *   两个入口会互相抢资源、也会让成绩混在一起；本次更新把 UI 入口收敛为
 *   「智能模式 → 开始自动优化」与「性能中心 → 开始模式对比」两个。
 * - 但矩阵测试的业务逻辑（BenchmarkEngine 的 matrix 模式 + IPC）仍然保留，
 *   供智能优化在有需要时驱动，不属于可以随手删除的死代码。
 *
 * 如果将来要重新开放矩阵测试，请放在「高级」折叠区，并复用同一个任务管理器，
 * 确保同一时刻只有一个渲染/测试任务。
 */
import { Badge, Button, Spinner, Toggle } from '../ui'
import type {
  BenchmarkLogLine,
  BenchmarkPlan,
  BenchmarkSessionState,
  PerformanceMode
} from '@shared/types/performance'
import { formatBytes, formatPct, formatSeconds } from '../../services/perf-format'

export function BenchmarkPanel(props: {
  mode: PerformanceMode
  state: BenchmarkSessionState | null
  plan: BenchmarkPlan | null
  logs: BenchmarkLogLine[]
  running: boolean
  busy: boolean
  runs: number
  includeOfficial: boolean
  allowExperimental: boolean
  officialAvailable: boolean
  onRunsChange: (runs: number) => void
  onIncludeOfficialChange: (value: boolean) => void
  onAllowExperimentalChange: (value: boolean) => void
  onPlan: () => void
  onStart: () => void
  onStop: () => void
}): JSX.Element {
  const state = props.state
  const progressText =
    state && state.status === 'running'
      ? `正在测试 ${Math.min(state.results.length + 1, state.candidates.length)}/${state.candidates.length}`
      : ''

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>性能测试</h2>
          <p>同一项目、同一格式与质量，只比较 worker / 编码 / 捕获路径</p>
        </div>
        <div className="panel-head-actions">
          {state?.status === 'running' ? (
            <Button size="sm" variant="danger" onClick={props.onStop}>
              停止测试
            </Button>
          ) : (
            <Button size="sm" variant="subtle" onClick={props.onPlan} disabled={props.busy}>
              预估任务
            </Button>
          )}
        </div>
      </header>

      <div className="panel-body">
        <div className="bench-options">
          <label className="select-row">
            <span>每配置次数</span>
            <select value={props.runs} onChange={(e) => props.onRunsChange(Number(e.target.value))} disabled={props.running}>
              <option value={1}>1 次（最快）</option>
              <option value={2}>2 次</option>
              <option value={3}>3 次（最稳）</option>
            </select>
          </label>

          <Toggle
            checked={props.includeOfficial}
            onChange={props.onIncludeOfficialChange}
            disabled={props.running || !props.officialAvailable}
            label="同时运行官方 benchmark"
            description={
              props.officialAvailable
                ? '官方基准覆盖 fps / quality / worker 预设，耗时较长'
                : '当前 CLI 未提供 benchmark 命令'
            }
          />

          {props.mode === 'extreme' && (
            <Toggle
              checked={props.allowExperimental}
              onChange={props.onAllowExperimentalChange}
              disabled={props.running}
              label="允许实验性并行流捕获"
              description="仅 Windows、多 worker 时尝试 HF_CAPTURE_PARALLEL_STREAM，稳定性由实测判定"
            />
          )}
        </div>

        {props.plan && (
          <div className="plan-box">
            <div className="plan-head">
              <strong>测试计划</strong>
              <span>
                {props.plan.candidates.length} 组配置 · {props.plan.totalRuns} 次渲染 · 预计{' '}
                {props.plan.estimatedMinutes} 分钟
              </span>
            </div>
            <ul className="plan-list">
              {props.plan.candidates.map((c) => (
                <li key={c.id}>{c.label}</li>
              ))}
            </ul>
            {props.plan.notes.map((note, i) => (
              <p className="muted-line" key={i}>
                {note}
              </p>
            ))}
            <p className="muted-line">
              测试会写入应用数据目录下的独立临时目录，渲染完成后即删除，不会动项目里的视频。
            </p>
          </div>
        )}

        <div className="bench-actions">
          <Button
            variant="primary"
            onClick={props.onStart}
            disabled={props.busy || props.running}
          >
            {props.running ? <Spinner /> : null}
            {props.running ? '测试中…' : '开始性能测试'}
          </Button>
          {progressText && <span className="muted-line">{progressText}</span>}
        </div>

        {state && state.results.length > 0 && (
          <div className="bench-table-wrap">
            <table className="bench-table">
              <thead>
                <tr>
                  <th>配置</th>
                  <th>耗时</th>
                  <th>体积</th>
                  <th>峰值 CPU</th>
                  <th>峰值显存</th>
                  <th>GPU</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {[...state.results]
                  .sort((a, b) => a.durationMs - b.durationMs)
                  .map((r) => (
                    <tr key={r.candidateId} className={r.status === 'ok' ? '' : 'row-failed'}>
                      <td title={r.label}>{r.label}</td>
                      <td>{formatSeconds(r.durationMs)}</td>
                      <td>{formatBytes(r.sizeBytes)}</td>
                      <td>{formatPct(r.peak.cpuPct)}</td>
                      <td>{formatBytes(r.peak.vramBytes)}</td>
                      <td>{formatPct(r.peak.gpuPct)}</td>
                      <td>
                        <Badge tone={r.status === 'ok' ? 'ok' : 'error'}>
                          {r.status === 'ok' ? '完成' : '失败'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {state?.official.ran && (
          <div className="official-box">
            <div className="official-head">
              <strong>官方 benchmark</strong>
              <Badge tone={state.official.ok ? 'ok' : 'warn'}>
                {state.official.ok ? `${state.official.results.length} 组` : '未取得结果'}
              </Badge>
            </div>
            {state.official.ok ? (
              <ul className="official-list">
                {state.official.results.map((r, i) => (
                  <li key={i}>
                    <span>{r.name}</span>
                    <span>{r.seconds}s</span>
                    <span>{formatBytes(r.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-line">{state.official.error ?? '官方基准未返回可用结果'}</p>
            )}
          </div>
        )}

        {props.logs.length > 0 && (
          <div className="bench-log">
            {props.logs.slice(-12).map((line, i) => (
              <div className={`bench-log-line level-${line.level}`} key={`${line.ts}-${i}`}>
                <span className="bench-log-time">{line.ts.slice(11, 19)}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        )}

        {state?.status === 'canceled' && <p className="muted-line">测试已停止，已完成的组仍保留在表格中。</p>}
        {state?.error && <p className="error-line">{state.error}</p>}
      </div>
    </section>
  )
}
