import { useEffect, useState } from 'react'
import { Badge, Button, Dot, Icon, Spinner } from '../ui'
import type { EnvironmentReport } from '@shared/types/settings'
import type { LintResult } from '@shared/ipc'

interface Props {
  open: boolean
  report: EnvironmentReport | null
  loading: boolean
  projectPath?: string
  cliCommand: string
  autoEnvCheck: boolean
  onClose: () => void
  onRecheck: () => void
  onLint: () => Promise<LintResult>
  onSaveSettings: (patch: { cliCommand?: string; autoEnvCheck?: boolean }) => Promise<void>
}

const STATUS_LABEL: Record<string, string> = {
  ok: '正常',
  warning: '可用（有提示）',
  error: '存在问题'
}

const TONE: Record<string, 'ok' | 'warn' | 'error' | 'unknown'> = {
  ok: 'ok',
  warning: 'warn',
  error: 'error',
  unknown: 'unknown'
}

export function EnvDialog(props: Props): JSX.Element | null {
  const [showRaw, setShowRaw] = useState(false)
  const [lint, setLint] = useState<LintResult | null>(null)
  const [linting, setLinting] = useState(false)
  const [cliDraft, setCliDraft] = useState(props.cliCommand)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setCliDraft(props.cliCommand)
  }, [props.cliCommand, props.open])

  if (!props.open) return null

  const report = props.report
  const errors = report?.items.filter((i) => i.status === 'error') ?? []
  const warnings = report?.items.filter((i) => i.status === 'warning') ?? []

  const runLint = async (): Promise<void> => {
    setLinting(true)
    try {
      setLint(await props.onLint())
    } finally {
      setLinting(false)
    }
  }

  return (
    <div className="modal-layer" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <h2>环境检测</h2>
            <p>
              {report
                ? `检测于 ${new Date(report.checkedAt).toLocaleString('zh-CN', { hour12: false })}${
                    report.cliVersion ? ` · CLI v${report.cliVersion}` : ''
                  }`
                : '尚未检测'}
            </p>
          </div>
          <div className="modal-head-actions">
            <Button size="sm" onClick={props.onRecheck} disabled={props.loading}>
              {props.loading ? <Spinner /> : <Icon.Refresh />}
              重新检测
            </Button>
            <Button size="sm" variant="subtle" onClick={props.onClose} title="关闭">
              <Icon.Close />
            </Button>
          </div>
        </header>

        <div className="modal-body">
          {props.loading && !report && (
            <div className="env-loading">
              <Spinner />
              <span>正在检测 Node.js / npm / HyperFrames CLI / FFmpeg / 项目状态…</span>
            </div>
          )}

          {report && (
            <>
              <div className={`env-summary env-summary-${report.status}`}>
                <strong>{STATUS_LABEL[report.status]}</strong>
                <span>
                  {report.items.length} 项检查
                  {errors.length > 0 && ` · ${errors.length} 项错误`}
                  {warnings.length > 0 && ` · ${warnings.length} 项提示`}
                </span>
              </div>

              <ul className="env-list">
                {report.items.map((item) => (
                  <li key={item.id} className={`env-item env-${item.status}`}>
                    <Dot tone={TONE[item.status] ?? 'unknown'} />
                    <div className="env-item-main">
                      <div className="env-item-head">
                        <span className="env-label">{item.label}</span>
                        <span className={`env-status env-status-${item.status}`}>
                          {item.status === 'ok'
                            ? '正常'
                            : item.status === 'warning'
                              ? '提示'
                              : item.status === 'error'
                                ? '异常'
                                : '信息'}
                        </span>
                      </div>
                      <p className="env-detail mono">{item.detail}</p>
                      {item.hint && <p className="env-hint">{item.hint}</p>}
                    </div>
                  </li>
                ))}
              </ul>

              {report.raw && (
                <div className="env-raw">
                  <button type="button" className="link-btn" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? '收起 doctor 原始输出' : '查看 doctor 原始输出'}
                  </button>
                  {showRaw && <pre className="raw-block">{report.raw}</pre>}
                </div>
              )}

              <div className="lint-section">
                <div className="lint-head">
                  <div>
                    <strong>项目 lint 检查</strong>
                    <p>调用 hyperframes lint --json，验证 composition 的常见问题（可选）</p>
                  </div>
                  <Button size="sm" onClick={() => void runLint()} disabled={!props.projectPath || linting}>
                    {linting ? <Spinner /> : null}
                    运行 lint
                  </Button>
                </div>
                {lint && (
                  <div className="lint-result">
                    {lint.error && <div className="alert alert-error">{lint.error}</div>}
                    {!lint.error && lint.findings.length === 0 && (
                      <div className="alert alert-ok">未发现问题</div>
                    )}
                    {lint.findings.map((finding, index) => (
                      <div key={index} className={`lint-finding lint-${finding.level}`}>
                        <Badge tone={finding.level === 'error' ? 'error' : finding.level === 'warning' ? 'warn' : 'neutral'}>
                          {finding.level}
                        </Badge>
                        <span>{finding.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="lint-section">
                <div className="lint-head">
                  <div>
                    <strong>CLI 调用命令</strong>
                    <p>默认使用 npx --yes hyperframes@latest，可改为固定版本或已安装的 CLI</p>
                  </div>
                </div>
                <div className="path-input">
                  <input
                    className="input mono"
                    value={cliDraft}
                    placeholder="npx --yes hyperframes@latest"
                    onChange={(e) => setCliDraft(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving || !cliDraft.trim() || cliDraft.trim() === props.cliCommand}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await props.onSaveSettings({ cliCommand: cliDraft.trim() })
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    保存
                  </Button>
                </div>
                <p className="field-hint">
                  命令会被拆成参数数组后直接执行，项目路径等参数不经过 shell，因此不存在命令注入。
                </p>
                <label className="mini-check">
                  <input
                    type="checkbox"
                    checked={props.autoEnvCheck}
                    onChange={(e) => void props.onSaveSettings({ autoEnvCheck: e.target.checked })}
                  />
                  启动时自动检测环境
                </label>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
