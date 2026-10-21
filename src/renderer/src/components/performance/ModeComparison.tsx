import { Badge, Button, Dot, Spinner, Toggle } from '../ui'
import type {
  BenchmarkSessionState,
  ComparisonFailure,
  ModeComparisonPlan,
  PerformanceReport,
  ResolvedModePreset
} from '@shared/types/performance'
import { MODE_LABEL, PHASE_LABELS } from '../../services/perf-format'
import { errorTypeText, formatBytes, formatPct, formatSeconds, stageText } from '../../services/perf-format'
import { api, copyText } from '../../services/api'
import type { PerformanceMode } from '@shared/types/performance'

const MODE_ORDER: PerformanceMode[] = ['balanced', 'performance', 'extreme', 'smart']

/* ------------------------------------------------------------------ */
/* 四种性能模式选择（唯一的模式选择入口）                                   */
/* ------------------------------------------------------------------ */

/**
 * 渲染 / 性能页面上「四种性能模式」的唯一渲染点。
 *
 * 历史问题：页面里同时存在 mode-row（四个 mode-card）和 ModePresetCards
 * （四个 mp-card），导致同一组四种模式出现两次。现在合并为一个组件：
 * 上方四张卡片负责选择，下方只展示「当前所选模式」的参数详情，
 * 不再出现第二组模式卡片。
 */

const MODES: { value: PerformanceMode; label: string; desc: string }[] = [
  { value: 'smart', label: '智能模式', desc: '复用历史最优档案，只有档案失效或你主动优化时才重新测试' },
  { value: 'balanced', label: '平衡模式', desc: '速度与占用平衡，给其他程序留出余量' },
  { value: 'performance', label: '性能模式', desc: '优先有效 GPU 加速与更快的捕获路径' },
  { value: 'extreme', label: '极限模式', desc: '实测对比，选最快且稳定的配置' }
]

/** 固定模式的档位文案；智能模式不适用 */
const TIER_LABEL: Record<string, string> = {
  entry: '入门设备',
  mainstream: '主流设备',
  'high-end': '高性能设备',
  workstation: '专业工作站'
}

function presetOf(
  presets: ResolvedModePreset[],
  mode: PerformanceMode
): ResolvedModePreset | undefined {
  return presets.find((p) => p.mode === mode)
}

function capturePathText(path: ResolvedModePreset['capturePath'] | undefined): string {
  if (path === 'fast-capture') return '快速捕获'
  if (path === 'parallel-stream') return '并行流（实验）'
  return '默认截图'
}

export function PerformanceModeSelector(props: {
  presets: ResolvedModePreset[]
  active: PerformanceMode
  busy: boolean
  optimizing: boolean
  allowExperimental?: boolean
  onAllowExperimentalChange?: (value: boolean) => void
  onSelect: (mode: PerformanceMode) => void
  onOptimize: () => void
}): JSX.Element {
  const current = presetOf(props.presets, props.active)
  const currentMeta = MODES.find((m) => m.value === props.active)
  // 智能模式是唯一的「自动优化」入口；固定模式只是重新生成该模式的推荐参数
  const actionLabel = props.active === 'smart' ? '开始自动优化' : '生成该模式推荐'

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>四种性能模式</h2>
          <p>固定模式使用开发者预定义的静态预设（按设备等级匹配）；智能模式使用自动优化结果</p>
        </div>
      </header>
      <div className="panel-body">
        {/* 唯一一组四种模式卡片 */}
        <div className="mp-grid">
          {MODES.map((item) => {
            const preset = presetOf(props.presets, item.value)
            const badge = item.value === 'smart' ? '自动优化' : preset ? TIER_LABEL[preset.tier] ?? preset.tier : '待识别'
            return (
              <button
                type="button"
                key={item.value}
                className={props.active === item.value ? 'mp-card active' : 'mp-card'}
                onClick={() => props.onSelect(item.value)}
                aria-pressed={props.active === item.value}
              >
                <div className="mp-card-head">
                  <strong>{item.label}</strong>
                  <Badge tone={item.value === 'smart' ? 'info' : 'neutral'}>{badge}</Badge>
                </div>
                <p className="mp-card-desc">{item.desc}</p>
              </button>
            )
          })}
        </div>

        {/* 当前所选模式的参数详情（不是第二组模式卡片） */}
        <div className="mode-detail">
          <div className="mode-detail-main">
            <div className="mode-detail-head">
              <span className="metric-label">当前模式</span>
              <strong>{currentMeta?.label ?? props.active}</strong>
              <span className="muted-line">
                {current
                  ? props.active === 'smart'
                    ? '预设：自动优化档案'
                    : `预设：${currentMeta?.label ?? props.active} · ${TIER_LABEL[current.tier] ?? current.tier}`
                  : '正在读取预设参数…'}
              </span>
            </div>
            <dl className="mode-detail-facts">
              <div>
                <dt>Worker 数量</dt>
                <dd className="mono">{current ? (current.workers === 'auto' ? 'auto' : current.workers) : '—'}</dd>
              </div>
              <div>
                <dt>GPU 编码</dt>
                <dd>
                  {current
                    ? current.gpuEncode
                      ? current.encoderLabel ?? '开启'
                      : '关闭（CPU 编码）'
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Browser GPU</dt>
                <dd>{current ? (current.browserGpu === 'on' ? '强制开启' : 'auto') : '—'}</dd>
              </div>
              <div>
                <dt>捕获方式</dt>
                <dd>{current ? capturePathText(current.capturePath) : '—'}</dd>
              </div>
              <div>
                <dt>低内存保护</dt>
                <dd>{current ? (current.lowMemoryMode === 'on' ? '已启用' : '按需') : '—'}</dd>
              </div>
            </dl>
            {current && current.fallbacks.length > 0 && (
              <ul className="mp-fallbacks">
                {current.fallbacks.map((fb, i) => (
                  <li key={i}>{fb}</li>
                ))}
              </ul>
            )}
            {current && current.notes.length > 0 && (
              <p className="muted-line">{current.notes[0]}</p>
            )}
          </div>
          <div className="mode-action">
            <Button variant="primary" onClick={props.onOptimize} disabled={props.optimizing || props.busy}>
              {props.optimizing ? <Spinner /> : null}
              {actionLabel}
            </Button>
            <span className="muted-line">
              {props.active === 'smart'
                ? '读取硬件与历史档案；只有档案失效或你主动重新优化时才会完整测试'
                : '固定模式使用开发者预定义的静态预设，不执行 Benchmark，也不动态修改参数'}
            </span>
            {props.active === 'extreme' && props.onAllowExperimentalChange && (
              <Toggle
                checked={props.allowExperimental ?? false}
                onChange={props.onAllowExperimentalChange}
                disabled={props.busy || props.optimizing}
                label="允许实验性并行流捕获"
                description="仅 Windows、多 worker 时尝试 HF_CAPTURE_PARALLEL_STREAM，稳定性由实测判定"
              />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 渲染速度对比（横向柱状图） + 性能提升比例                                */
/* ------------------------------------------------------------------ */

interface ChartDatum {
  mode: PerformanceMode
  label: string
  medianMs: number | null
  runs: number
  workers: number | 'auto'
  timeSavedPct: number | null
  throughputGainPct: number | null
  status: 'ok' | 'failed' | 'untested'
}

function chartDataFromReport(report: PerformanceReport): ChartDatum[] {
  return MODE_ORDER.map((mode) => {
    const entry = report.entries.find((e) => e.mode === mode)
    return {
      mode,
      label: MODE_LABEL[mode],
      medianMs: entry?.medianMs ?? null,
      runs: entry?.runs.length ?? 0,
      workers: entry?.workers ?? 'auto',
      timeSavedPct: report.timeSavedPct[mode] ?? null,
      throughputGainPct: report.throughputGainPct[mode] ?? null,
      status: entry ? entry.status : 'untested'
    }
  })
}

function chartDataFromLive(state: BenchmarkSessionState): ChartDatum[] {
  const medianOf = (mode: PerformanceMode): number | null => {
    const candidate = state.candidates.find((c) => c.mode === mode)
    const result = candidate ? state.results.find((r) => r.candidateId === candidate.id) : undefined
    return result?.status === 'ok' ? result.durationMs : null
  }
  const baseline = medianOf('balanced')
  return MODE_ORDER.map((mode) => {
    const candidate = state.candidates.find((c) => c.mode === mode)
    const result = candidate ? state.results.find((r) => r.candidateId === candidate.id) : undefined
    const medianMs = result?.status === 'ok' ? result.durationMs : null
    // 与报告里的算法保持一致：缩短率以平衡模式为基准，吞吐提升率单独计算
    const timeSavedPct =
      baseline && medianMs && medianMs > 0 && mode !== 'balanced'
        ? Math.round(((baseline - medianMs) / baseline) * 1000) / 10
        : null
    const throughputGainPct =
      baseline && medianMs && medianMs > 0 && mode !== 'balanced'
        ? Math.round(((baseline / medianMs) * 100 - 100) * 10) / 10
        : null
    return {
      mode,
      label: MODE_LABEL[mode],
      medianMs,
      runs: result?.status === 'ok' ? 1 : 0,
      workers: candidate?.workers ?? 'auto',
      timeSavedPct,
      throughputGainPct,
      status: result ? (result.status === 'ok' ? 'ok' : 'failed') : 'untested'
    }
  })
}

export function SpeedComparison(props: {
  report: PerformanceReport | null
  live: BenchmarkSessionState | null
}): JSX.Element {
  const lived = props.live?.kind === 'comparison' ? props.live : null
  const liveComparison = !!lived && lived.status === 'running'
  /**
   * 刚跑完的对比测试也必须立刻反映在图表上：
   * 报告落库后如果因为导出参数（fps / 质量）与当前选择不同而匹配不到，
   * 不能显示「尚未测试」——那会让用户以为测试白跑了。
   */
  const liveFinished = !!lived && lived.status !== 'running' && lived.results.length > 0
  const useLive = liveComparison || (liveFinished && !props.report)
  const data = useLive
    ? chartDataFromLive(lived!)
    : props.report
      ? chartDataFromReport(props.report)
      : null

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>渲染速度对比</h2>
          <p>
            {liveComparison
              ? '四模式对比测试进行中，以下为已完成的实时成绩'
              : useLive
                ? '本次对比测试刚结束，以下为实测成绩（与当前导出参数不完全一致时会单独标注）'
                : '同一项目、相同导出参数下的实测耗时（中位数）；以平衡模式为基准'}
          </p>
        </div>
        {props.report ? (
          <Badge tone={props.report.kind === 'precise' ? 'ok' : 'neutral'}>
            {props.report.kind === 'precise' ? '精确对比（多次取中位）' : '快速对比（单次）'}
          </Badge>
        ) : useLive ? (
          <Badge tone="info">本次测试</Badge>
        ) : null}
      </header>
      <div className="panel-body">
        {!data ? (
          <div className="empty-state">
            <strong>尚未测试性能</strong>
            <p>选择项目并点击「开始模式对比」后，这里会展示四种模式的真实渲染耗时对比。</p>
          </div>
        ) : (
          <>
            <div className="bar-chart">
              {data.map((d) => {
                const values = data.map((x) => x.medianMs ?? 0).filter((v) => v > 0)
                const max = Math.max(...values, 1)
                const width = d.medianMs ? Math.max(6, (d.medianMs / max) * 100) : 0
                const fastest = useLive
                  ? d.status === 'ok' &&
                    d.medianMs ===
                      Math.min(...data.filter((x) => x.status === 'ok' && x.medianMs).map((x) => x.medianMs as number))
                  : props.report?.fastestMode === d.mode && d.status === 'ok'
                return (
                  <div key={d.mode} className="bar-row">
                    <div className="bar-head">
                      <span className="bar-name">
                        {d.label}
                        {fastest && <Badge tone="ok">最快</Badge>}
                      </span>
                      <span className="bar-value mono">
                        {d.status === 'ok' && d.medianMs
                          ? formatSeconds(d.medianMs)
                          : d.status === 'failed'
                            ? '测试失败'
                            : '尚未测试'}
                      </span>
                    </div>
                    <div className="bar-track">
                      {d.status === 'ok' && d.medianMs ? (
                        <div
                          className={`bar-fill ${fastest ? 'best' : ''}`}
                          style={{ width: `${width}%` }}
                        />
                      ) : (
                        <div className="bar-fill empty" style={{ width: '0%' }} />
                      )}
                    </div>
                    <div className="bar-sub mono">
                      {d.workers !== 'auto' ? `${d.workers} worker` : 'auto worker'}
                      {d.runs > 1 ? ` · ${d.runs} 次取中位` : ''}
                      {d.status === 'ok' && d.medianMs && d.timeSavedPct != null && (
                        <span className="bar-pct">
                          {' '}· 耗时{d.timeSavedPct >= 0 ? '缩短' : '增加'}{' '}
                          {Math.abs(d.timeSavedPct)}%
                        </span>
                      )}
                      {d.status === 'ok' && d.medianMs && d.throughputGainPct != null && (
                        <span className="bar-pct gain">
                          {' '}· 吞吐提升 {d.throughputGainPct}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="muted-line">
              耗时缩短率 =（平衡耗时 − 当前耗时）÷ 平衡耗时 × 100%；渲染吞吐提升率 =
              平衡耗时 ÷ 当前耗时 × 100% − 100%。两者含义不同，不能混用；比平衡慢时会如实显示负值。
            </p>
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 最快渲染时间                                                         */
/* ------------------------------------------------------------------ */

export function FastestRenderTime(props: { report: PerformanceReport | null }): JSX.Element {
  const report = props.report
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>当前项目最快渲染时间</h2>
          <p>相同项目、相同导出参数下所有有效性能配置中实测最快的一次</p>
        </div>
      </header>
      <div className="panel-body">
        {!report ? (
          <div className="empty-state">
            <strong>暂无完整对比结果</strong>
            <p>
              最快时间只能来自当前设备 + 当前项目 + 当前导出参数的真实测试，
              不会用显卡型号推算，也不会把其他项目的成绩直接搬过来。
            </p>
          </div>
        ) : (
          <div className="fastest-grid">
            <div className="fastest-main">
              <span className="metric-label">最快单次耗时</span>
              <span className="fastest-time mono">
                {report.entries
                  .flatMap((e) => e.runs)
                  .reduce((min, v) => (min == null || v < min ? v : min), null as number | null) ===
                null
                  ? 'N/A'
                  : formatSeconds(
                      Math.min(...report.entries.flatMap((e) => e.runs))
                    )}
              </span>
              <span className="metric-label">稳定参考耗时（中位数）</span>
              <span className="mono">
                {report.fastestStableMs ? formatSeconds(report.fastestStableMs) : 'N/A'}
              </span>
            </div>
            <dl className="fastest-facts">
              <div>
                <dt>最快模式</dt>
                <dd>{report.fastestMode ? MODE_LABEL[report.fastestMode] : '数据不足'}</dd>
              </div>
              <div>
                <dt>测试日期</dt>
                <dd className="mono">{new Date(report.createdAt).toLocaleString('zh-CN')}</dd>
              </div>
              <div>
                <dt>输出参数</dt>
                <dd>
                  {report.project.format} · {report.project.resolution} ·{' '}
                  {report.project.fpsLabel} · {report.project.quality}
                </dd>
              </div>
              <div>
                <dt>对应配置</dt>
                <dd>
                  {(() => {
                    const e = report.entries.find((x) => x.mode === report.fastestMode)
                    if (!e) return 'N/A'
                    return `${e.workers === 'auto' ? 'auto' : `${e.workers} worker`} · ${e.gpuEncode ? 'GPU 编码' : 'CPU 编码'} · ${e.capturePath === 'fast-capture' ? '快速捕获' : '默认捕获'}`
                  })()}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* CPU / GPU / RAM 资源对比                                              */
/* ------------------------------------------------------------------ */

export function ResourceComparison(props: { report: PerformanceReport | null }): JSX.Element {
  const report = props.report
  const entries = report?.entries ?? []
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>资源使用对比</h2>
          <p>帮助理解某种模式为什么更快或更慢（例如 worker 多但内存吃满反而变慢）</p>
        </div>
      </header>
      <div className="panel-body">
        {entries.length === 0 ? (
          <div className="empty-state">
            <strong>尚未测试性能</strong>
            <p>资源数据来自对比测试期间的真实采样，测试后自动生成。</p>
          </div>
        ) : (
          <div className="bench-table-wrap">
            <table className="bench-table">
              <thead>
                <tr>
                  <th>模式</th>
                  <th>Workers</th>
                  <th>CPU 均值</th>
                  <th>CPU 峰值</th>
                  <th>GPU 3D 峰值</th>
                  <th>Video Encode 峰值</th>
                  <th>显存峰值</th>
                  <th>内存峰值</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.mode} className={e.status === 'ok' ? '' : 'row-failed'}>
                    <td>{MODE_LABEL[e.mode]}</td>
                    <td className="mono">{e.workers === 'auto' ? 'auto' : e.workers}</td>
                    <td>{formatPct(e.avgCpuPct)}</td>
                    <td>{formatPct(e.peak.cpuPct)}</td>
                    <td>{formatPct(e.peak.gpuPct)}</td>
                    <td>{formatPct(e.peak.videoEncodePct)}</td>
                    <td>{formatBytes(e.peak.vramBytes)}</td>
                    <td>{formatBytes(e.peak.memoryBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted-line">
          GPU 3D 与 Video Encode 是两个不同指标，分别表示渲染合成与视频编码负载；拿不到的指标显示 N/A，
          不会用总利用率冒充。
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 对比测试入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 对比测试进行中的状态条。
 *
 * 设计要点（对应需求二）：
 * - 顶部直接显示「正在测试 · 性能模式」+「第 2 / 4 项」；
 * - 四项测试本身的推进用不定进度动画表示，不伪装成视频渲染百分比；
 * - 只有当前子任务真的能从 CLI 输出解析到百分比时，才显示具体数字；
 * - 结束（done/failed/canceled）后不再显示动画，改由结果区展示各模式成绩。
 */
export function ComparisonProgressBar(props: { state: BenchmarkSessionState | null }): JSX.Element | null {
  const state = props.state
  const p = state?.progress
  if (!state || state.status !== 'running' || !p) return null

  const modeLabel = p.mode ? MODE_LABEL[p.mode] : null
  const headline =
    p.phase === 'environment'
      ? '正在检查环境'
      : p.phase === 'smoke'
        ? '正在预检 · 基础渲染'
        : p.phase === 'warmup'
          ? '正在预热（不计成绩）'
          : p.phase === 'verify'
            ? `正在验证产出${modeLabel ? ` · ${modeLabel}` : ''}`
            : modeLabel
              ? `正在测试 · ${modeLabel}`
              : '正在测试'

  const itemText =
    p.itemTotal > 0 && p.itemIndex > 0 ? `第 ${p.itemIndex} / ${p.itemTotal} 项测试` : ''
  const hasPct = typeof p.pct === 'number'
  const runText =
    p.runTotal > 1 ? `第 ${Math.min(p.runIndex, p.runTotal)} / ${p.runTotal} 次` : ''

  return (
    <div className="cmp-progress" aria-live="polite">
      <div className="cmp-progress-head">
        <div className="cmp-progress-title">
          <Spinner />
          <strong>{headline}</strong>
          {p.phase === 'smoke' && <Badge tone="info">预检</Badge>}
        </div>
        {itemText && <span className="cmp-progress-count mono">{itemText}</span>}
      </div>

      <div className={hasPct ? 'cmp-bar' : 'cmp-bar indeterminate'} role="progressbar"
        aria-valuenow={hasPct ? p.pct ?? undefined : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={headline}
      >
        <span style={hasPct ? { width: `${Math.max(2, Math.min(100, p.pct ?? 0))}%` } : undefined} />
      </div>

      <div className="cmp-progress-meta">
        <span>阶段：{PHASE_LABELS[p.phase]}</span>
        {runText && <span>{runText}</span>}
        {hasPct ? (
          <span className="mono">
            当前子任务 {p.pct}%{p.pctLabel ? ` · ${p.pctLabel}` : ''}
          </span>
        ) : (
          <span className="muted-line">当前子任务进度未知（CLI 未输出百分比）</span>
        )}
      </div>

      <div className="cmp-mode-row">
        {MODE_ORDER.map((mode) => {
          const status = p.modeStatus[mode]
          const label = MODE_LABEL[mode]
          return (
            <span
              key={mode}
              className={`cmp-mode-chip status-${status}`}
              title={`${label}模式：${MODE_STATUS_LABEL[status]}`}
            >
              <Dot
                tone={
                  status === 'ok'
                    ? 'ok'
                    : status === 'failed'
                      ? 'error'
                      : status === 'running'
                        ? 'warn'
                        : 'unknown'
                }
              />
              {label}
              <span className="cmp-mode-state">{MODE_STATUS_LABEL[status]}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

const MODE_STATUS_LABEL: Record<string, string> = {
  pending: '待测试',
  running: '测试中',
  ok: '完成',
  failed: '失败',
  skipped: '跳过'
}

export function ComparisonRunner(props: {
  plan: ModeComparisonPlan | null
  state: BenchmarkSessionState | null
  running: boolean
  busy: boolean
  kind: 'quick' | 'precise'
  archiveReason: string
  archiveValid: boolean
  onKindChange: (kind: 'quick' | 'precise') => void
  onPlan: () => void
  onStart: () => void
  onStop: () => void
}): JSX.Element {
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>性能对比测试</h2>
          <p>用四种模式各自的配置渲染同一个项目并记录真实耗时；不会修改固定预设本身</p>
        </div>
        <div className="panel-head-actions">
          {props.running ? (
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
        <ComparisonProgressBar state={props.state} />

        <div className="bench-options">
          <label className="select-row">
            <span>测试方式</span>
            <select
              value={props.kind}
              onChange={(e) => props.onKindChange(e.target.value as 'quick' | 'precise')}
              disabled={props.running}
            >
              <option value="quick">快速对比（每种模式 1 次）</option>
              <option value="precise">精确对比（预热 + 3 次取中位）</option>
            </select>
          </label>
        </div>

        {props.plan && (
          <div className="plan-box">
            <div className="plan-head">
              <strong>测试计划</strong>
              <span>
                {props.plan.modes.length} 种模式 · {props.plan.totalRuns} 次渲染 · 预计{' '}
                {props.plan.estimatedMinutes} 分钟
              </span>
            </div>
            <ul className="plan-list">
              {props.plan.modes.map((m, i) => (
                <li key={m}>
                  {i + 1}. {MODE_LABEL[m]}模式
                </li>
              ))}
            </ul>
            {props.plan.notes.map((note, i) => (
              <p className="muted-line" key={i}>
                {note}
              </p>
            ))}
          </div>
        )}

        <div className="bench-actions">
          <Button variant="primary" onClick={props.onStart} disabled={props.busy || props.running}>
            {props.running ? <Spinner /> : null}
            {props.running ? '测试进行中…' : '开始模式对比'}
          </Button>
          {props.running && (
            <span className="muted-line">测试期间请保持应用在前台；四种模式依次执行，互不覆盖产物</span>
          )}
        </div>
        <p className="muted-line">
          智能模式使用已保存的最优配置：{props.archiveReason}
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 对比测试诊断（失败阶段 / 错误类型 / 原始错误 / 日志位置）                  */
/* ------------------------------------------------------------------ */

function buildDiagnosticText(state: BenchmarkSessionState): string {
  const lines: string[] = []
  const ctx = state.comparison
  lines.push('HF Render · 性能对比测试诊断')
  lines.push(`测试 ID：${ctx?.testId || state.id}`)
  lines.push(`状态：${state.status}${state.error ? ` · ${state.error}` : ''}`)
  lines.push(`项目：${state.projectPath}`)
  lines.push(`参数：${state.format} · ${state.fpsLabel} · ${state.quality} · ${state.resolution}`)
  if (ctx?.logDir) lines.push(`日志目录：${ctx.logDir}`)
  if (ctx?.smoke) {
    lines.push(
      `冒烟预检：${ctx.smoke.status}${ctx.smoke.durationMs ? ` · ${(ctx.smoke.durationMs / 1000).toFixed(1)}s` : ''}${
        ctx.smoke.failure
          ? ` · ${stageText(ctx.smoke.failure.stage)} / ${errorTypeText(ctx.smoke.failure.errorType)}`
          : ''
      }`
    )
    if (ctx.smoke.failure) {
      lines.push('—— 冒烟预检关键错误行 ——')
      lines.push(ctx.smoke.failure.highlight ?? ctx.smoke.failure.detail)
    }
  }
  if (ctx?.lastFailure) {
    lines.push(
      `会话失败：阶段=${stageText(ctx.lastFailure.stage)} 类型=${errorTypeText(ctx.lastFailure.errorType)}`
    )
    lines.push('—— 关键错误行 ——')
    lines.push(ctx.lastFailure.highlight ?? ctx.lastFailure.detail)
    lines.push('—— 完整原始输出 ——')
    lines.push(ctx.lastFailure.detail)
  }
  for (const result of state.results) {
    const d = result.diagnostics
    lines.push('')
    lines.push(`── ${result.label} ──`)
    lines.push(`状态：${result.status} · 耗时 ${(result.durationMs / 1000).toFixed(1)}s`)
    if (!d) {
      lines.push(`错误：${result.error ?? '无'}`)
      continue
    }
    lines.push(`阶段：${stageText(d.stage)} · 类型：${errorTypeText(d.errorType)}`)
    lines.push(`命令：${d.command}`)
    lines.push(`执行：${d.execFile} ${d.execArgs.join(' ')}`)
    lines.push(`cwd：${d.cwd} · pid：${d.pid ?? 'N/A'}`)
    lines.push(`退出码：${d.exitCode ?? 'N/A'} · 信号：${d.signal ?? 'N/A'}`)
    lines.push(`输出：${d.outputPath} · ${d.outputBytes ?? 'N/A'} 字节`)
    if (d.fileCheck) {
      const probe = d.fileCheck.probe
      lines.push(
        `文件验证：存在=${d.fileCheck.exists} 停止写入=${d.fileCheck.writeSettled} ffprobe=${
          probe ? (probe.available ? (probe.ok ? 'ok' : 'failed') : 'unavailable') : 'n/a'
        }${probe?.durationSec ? ` 时长=${probe.durationSec}s` : ''}${
          probe?.width ? ` 分辨率=${probe.width}x${probe.height}` : ''
        }${probe?.fps ? ` 帧率=${probe.fps}` : ''}`
      )
      if (d.fileCheck.problems.length > 0) lines.push(`未通过：${d.fileCheck.problems.join('；')}`)
    }
    if (d.failure) {
      lines.push(`错误类型：${errorTypeText(d.failure.errorType)}`)
      lines.push(d.failure.hint)
      if (d.failure.highlight) {
        lines.push('—— 关键错误行 ——')
        lines.push(d.failure.highlight)
      }
      lines.push('—— 完整原始输出 ——')
      lines.push(d.failure.detail)
    }
    lines.push('—— stderr 尾部 ——')
    lines.push(d.stderrTail || '(空)')
    lines.push('—— stdout 尾部 ——')
    lines.push(d.stdoutTail || '(空)')
  }
  return lines.join('\n')
}

/**
 * 错误文本：先给「关键错误行」（从原始输出里定位到的那几行），
 * 再把完整原始输出折叠起来——几千行进度日志不会淹没真正的错误。
 * 两者都来自 CLI 的真实输出，没有经过改写。
 */
function FailureText(props: { failure: ComparisonFailure }): JSX.Element {
  const { failure } = props
  const full = failure.detail ?? ''
  const lines = full ? full.split(/\r?\n/).length : 0
  return (
    <>
      {failure.highlight ? (
        <>
          <div className="diag-key-label">关键错误行</div>
          <pre className="diag-key">{failure.highlight}</pre>
        </>
      ) : null}
      <details open={!failure.highlight}>
        <summary className="muted-line">
          完整原始输出{lines > 0 ? `（${lines} 行）` : ''}
        </summary>
        <pre className="diag-pre">{full || '无错误信息'}</pre>
      </details>
    </>
  )
}

/**
 * 对比测试的诊断面板。
 * 只在「本次会话是对比测试」时出现；成功时也保留日志入口，失败时给出
 * 失败阶段 / 错误类型 / 真实错误文本 / 复制日志 / 打开日志目录。
 */
export function ComparisonDiagnostics(props: {
  state: BenchmarkSessionState | null
}): JSX.Element | null {
  const state = props.state
  if (!state || state.kind !== 'comparison' || !state.comparison) return null

  const ctx = state.comparison
  const failedRuns = state.results.filter((r) => r.status !== 'ok')
  const okRuns = state.results.filter((r) => r.status === 'ok')
  const smoke = ctx.smoke
  const sessionFailure = ctx.lastFailure ?? null
  const hasFailure = failedRuns.length > 0 || smoke?.status === 'failed' || sessionFailure !== null

  const copyAll = async (): Promise<void> => {
    await copyText(buildDiagnosticText(state))
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>对比测试诊断</h2>
          <p>
            每次对比测试都会写入独立日志：<span className="mono">{ctx.testId}</span>
          </p>
        </div>
        <div className="panel-head-actions">
          <Button size="sm" variant="subtle" onClick={() => void copyAll()}>
            复制错误日志
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => void api().shell.openPath(ctx.logDir)}
            disabled={!ctx.logDir}
          >
            打开日志目录
          </Button>
        </div>
      </header>
      <div className="panel-body">
        {/* 冒烟预检 */}
        <div className="diag-row">
          <span className="metric-label">基础渲染预检</span>
          {smoke ? (
            <span>
              <Badge
                tone={
                  smoke.status === 'ok' ? 'ok' : smoke.status === 'failed' ? 'error' : 'neutral'
                }
              >
                {smoke.status === 'ok'
                  ? '通过'
                  : smoke.status === 'failed'
                    ? '失败'
                    : smoke.status === 'running'
                      ? '进行中'
                      : '待执行'}
              </Badge>
              {smoke.durationMs ? (
                <span className="muted-line"> {formatSeconds(smoke.durationMs)}</span>
              ) : null}
              {smoke.outputBytes ? (
                <span className="muted-line"> · {formatBytes(smoke.outputBytes)}</span>
              ) : null}
            </span>
          ) : (
            <span className="muted-line">未执行</span>
          )}
        </div>

        {sessionFailure && (
          <div className="diag-failure">
            <div className="diag-failure-head">
              <Badge tone="error">会话级失败</Badge>
              <span className="mono">
                {stageText(sessionFailure.stage)} / {errorTypeText(sessionFailure.errorType)}
              </span>
            </div>
            <p className="diag-hint">{sessionFailure.hint}</p>
            <FailureText failure={sessionFailure} />
          </div>
        )}

        {/* 逐模式结果 */}
        {state.results.length > 0 && (
          <div className="bench-table-wrap">
            <table className="bench-table">
              <thead>
                <tr>
                  <th>模式</th>
                  <th>耗时</th>
                  <th>产出</th>
                  <th>ffprobe</th>
                  <th>阶段 / 类型</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {state.results.map((r) => {
                  const d = r.diagnostics
                  const probe = d?.fileCheck?.probe
                  return (
                    <tr key={r.candidateId} className={r.status === 'ok' ? '' : 'row-failed'}>
                      <td>{r.label}</td>
                      <td>{formatSeconds(r.durationMs)}</td>
                      <td>{formatBytes(r.sizeBytes)}</td>
                      <td className="mono">
                        {!probe
                          ? '—'
                          : !probe.available
                            ? '不可用'
                            : probe.ok
                              ? `${probe.durationSec ?? '?'}s · ${probe.width ?? '?'}×${probe.height ?? '?'} · ${
                                  probe.fps ?? '?'
                                }fps`
                              : '读取失败'}
                      </td>
                      <td className="mono">
                        {d && d.stage !== 'none'
                          ? `${stageText(d.stage)} / ${errorTypeText(d.errorType)}`
                          : '—'}
                      </td>
                      <td>
                        <Badge tone={r.status === 'ok' ? 'ok' : 'error'}>
                          {r.status === 'ok' ? '完成' : '失败'}
                        </Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 失败明细：原始错误文本 */}
        {failedRuns.map((r) => {
          const d = r.diagnostics
          return (
            <div className="diag-failure" key={`fail-${r.candidateId}`}>
              <div className="diag-failure-head">
                <Badge tone="error">{r.label}</Badge>
                <span className="mono">
                  {stageText(d?.stage ?? 'render')} / {errorTypeText(d?.errorType ?? 'unknown')}
                </span>
                {d ? <span className="muted-line">pid {d.pid ?? 'N/A'} · exit {d.exitCode ?? 'N/A'}</span> : null}
              </div>
              {d?.failure?.hint ? <p className="diag-hint">{d.failure.hint}</p> : null}
              {d?.fileCheck && d.fileCheck.problems.length > 0 && (
                <p className="error-line">文件验证未通过：{d.fileCheck.problems.join('；')}</p>
              )}
              {d?.failure ? <FailureText failure={d.failure} /> : <pre className="diag-pre">{r.error ?? '无错误信息'}</pre>}
              {d?.stderrTail ? (
                <details>
                  <summary className="muted-line">原始 stderr（尾部）</summary>
                  <pre className="diag-pre">{d.stderrTail}</pre>
                </details>
              ) : null}
            </div>
          )
        })}

        {!hasFailure && state.status === 'done' && (
          <p className="muted-line">
            {okRuns.length} 种模式全部通过验证（文件存在、体积合理、ffprobe 可读、时长 / 分辨率 / 帧率符合本次参数）。
          </p>
        )}

        <p className="muted-line mono">
          日志：{ctx.logFile || '—'}
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 报告历史                                                             */
/* ------------------------------------------------------------------ */

export function ReportHistory(props: {
  reports: PerformanceReport[]
  onClear?: () => void
}): JSX.Element {
  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-head-text">
          <h2>历史性能报告</h2>
          <p>每次对比测试完成后自动保存；不同项目 / 参数的报告分开记录，不会混淆</p>
        </div>
      </header>
      <div className="panel-body">
        {props.reports.length === 0 ? (
          <div className="empty-state">
            <strong>暂无报告</strong>
            <p>完成一次性能对比测试后，报告会保存在这里。</p>
          </div>
        ) : (
          <div className="report-list">
            {props.reports.map((report) => {
              const fastest = report.entries.find((e) => e.mode === report.fastestMode)
              return (
                <details key={report.id} className="report-item">
                  <summary>
                    <span className="report-title">
                      {report.project.name} · {report.project.format} ·{' '}
                      {report.project.resolution}
                    </span>
                    <span className="report-meta mono">
                      {new Date(report.createdAt).toLocaleString('zh-CN')}
                      {report.fastestMode
                        ? ` · 最快：${MODE_LABEL[report.fastestMode]} ${formatSeconds(report.fastestMedianMs ?? 0)}`
                        : ' · 无有效对比'}
                    </span>
                  </summary>
                  <div className="report-detail">
                    <p className="muted-line">
                      {report.device.cpuModel} · {report.device.memoryGb}GB · {report.device.os} ·
                      CLI {report.cliVersion ?? '未知'} ·{' '}
                      {report.kind === 'precise' ? '精确对比' : '快速对比'}
                    </p>
                    <div className="bench-table-wrap">
                      <table className="bench-table">
                        <thead>
                          <tr>
                            <th>模式</th>
                            <th>耗时（中位）</th>
                            <th>单次成绩</th>
                            <th>配置</th>
                            <th>状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.entries.map((e) => (
                            <tr key={e.mode} className={e.status === 'ok' ? '' : 'row-failed'}>
                              <td>{MODE_LABEL[e.mode]}</td>
                              <td>{formatSeconds(e.medianMs)}</td>
                              <td className="mono">
                                {e.runs.map((ms) => formatSeconds(ms)).join(' / ') || '—'}
                              </td>
                              <td>
                                {e.workers === 'auto' ? 'auto' : `${e.workers} worker`} ·{' '}
                                {e.gpuEncode ? 'GPU 编码' : 'CPU 编码'}
                              </td>
                              <td>
                                <Badge tone={e.status === 'ok' ? 'ok' : 'error'}>
                                  {e.status === 'ok' ? '完成' : '失败'}
                                </Badge>
                                {e.status === 'failed' && (
                                  <span className="report-error"> {e.error}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {fastest && report.timeSavedPct[fastest.mode] != null && (
                      <p className="muted-line">
                        相对平衡模式：耗时缩短 {report.timeSavedPct[fastest.mode]}%，吞吐提升{' '}
                        {report.throughputGainPct[fastest.mode]}%
                      </p>
                    )}
                    {report.failures.length > 0 && (
                      <p className="error-line">
                        失败记录：{report.failures.map((f) => `${MODE_LABEL[f.mode]}（${f.error}）`).join('；')}
                      </p>
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
