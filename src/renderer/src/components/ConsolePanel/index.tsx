import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, Segmented } from '../ui'
import { copyText, formatClock } from '../../services/api'
import type { RenderLogLine } from '@shared/types/render'

type Filter = 'all' | 'info' | 'warn' | 'error'

interface Props {
  logs: RenderLogLine[]
  outputDir: string
  onClear: () => void
  onOpenOutputDir: () => void
  onToast: (message: string, tone?: 'ok' | 'error') => void
}

export function ConsolePanel(props: Props): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const [showDebug, setShowDebug] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const base = props.logs.filter((line) => showDebug || line.level !== 'debug')
    if (filter === 'all') return base.slice(-2500)
    if (filter === 'error') return base.filter((l) => l.level === 'error').slice(-2500)
    if (filter === 'warn') return base.filter((l) => l.level === 'warn' || l.level === 'error').slice(-2500)
    return base.filter((l) => l.level === 'info' || l.level === 'success').slice(-2500)
  }, [props.logs, filter, showDebug])

  useEffect(() => {
    if (!autoScroll || !bodyRef.current) return
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [visible, autoScroll])

  const handleScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    // 回到底部时自动恢复跟随
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom && !autoScroll) setAutoScroll(true)
  }

  const copyAll = async (): Promise<void> => {
    const text = props.logs
      .map((line) => `[${formatClock(line.ts)}] ${line.stream.toUpperCase()} ${line.text}`)
      .join('\n')
    const ok = await copyText(text || '（暂无日志）')
    props.onToast(ok ? '日志已复制到剪贴板' : '复制失败，请检查剪贴板权限', ok ? 'ok' : 'error')
  }

  return (
    <section className="panel console">
      <header className="console-head">
        <div className="console-title">
          <Icon.Terminal />
          <span>渲染日志</span>
          <span className="console-count mono">{props.logs.length}</span>
        </div>
        <div className="console-tools">
          <Segmented
            size="sm"
            value={filter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'info', label: '信息' },
              { value: 'warn', label: '警告' },
              { value: 'error', label: '错误' }
            ]}
            onChange={(value) => setFilter(value as Filter)}
          />
          <label className="mini-check" title="显示 CLI 的调试与追踪输出">
            <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
            调试
          </label>
          <Button size="sm" variant="subtle" onClick={() => void copyAll()} title="复制全部日志">
            <span className="btn-icon">
              <Icon.Copy />
            </span>
          </Button>
          <Button size="sm" variant="subtle" onClick={props.onClear} title="清空日志">
            <span className="btn-icon">
              <Icon.Trash />
            </span>
          </Button>
          <Button size="sm" variant="subtle" onClick={props.onOpenOutputDir} title="打开输出目录">
            输出目录
          </Button>
        </div>
      </header>

      <div
        className="console-body"
        ref={bodyRef}
        onScroll={handleScroll}
        onWheel={() => {
          if (autoScroll) setAutoScroll(false)
        }}
      >
        {visible.length === 0 ? (
          <div className="console-empty">暂无日志。开始渲染后，命令行输出会实时显示在这里。</div>
        ) : (
          visible.map((line) => (
            <div key={line.id} className={`log-line log-${line.level} log-${line.stream}`}>
              <span className="log-time">{formatClock(line.ts)}</span>
              <span className="log-stream">{line.stream === 'system' ? '›' : line.stream === 'stderr' ? '!' : ' '}</span>
              <span className="log-text">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <footer className="console-foot">
        <span className="muted-note">
          {autoScroll ? '自动滚动已开启' : '已暂停自动滚动（滚动到底部恢复）'}
        </span>
        <span className="muted-note mono">{props.outputDir || '未设置输出目录'}</span>
      </footer>
    </section>
  )
}
