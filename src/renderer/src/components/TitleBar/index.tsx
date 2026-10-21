import { useEffect, useState } from 'react'
import { Button, Dot, Icon, Spinner } from '../ui'
import { api } from '../../services/api'
import type { ThemeMode } from '@shared/types/settings'
import type { PageId } from '../../pages/types'

interface Props {
  theme: ThemeMode
  onToggleTheme: () => void
  page: PageId
  onNavigate: (page: PageId) => void
  /** 当前项目（用于标题栏的项目状态） */
  projectName?: string | null
  projectPath?: string | null
  projectValid?: boolean
  envStatus?: 'ok' | 'warning' | 'error' | 'unknown'
  envLoading?: boolean
  onOpenEnv?: () => void
  /** 预览服务运行中的端口；用于标题栏的轻量状态指示 */
  previewPort?: number | null
  onOpenPreview?: () => void
}

const ENV_TEXT: Record<string, string> = {
  ok: '环境正常',
  warning: '环境有提示',
  error: '环境异常',
  unknown: '未检测环境'
}

let cachedVersion: string | null = null

/**
 * 自定义窗口标题栏。
 *
 * 窗口本身使用 `titleBarStyle: 'hidden'` + `titleBarOverlay`：
 * 右侧的最小化 / 最大化 / 关闭由 Windows 原生绘制并处理，
 * 这里只负责左侧品牌区、导航与右侧操作区，中间留出拖动区域。
 */
export function TitleBar(props: Props): JSX.Element {
  const [version, setVersion] = useState<string>(cachedVersion ?? '')

  useEffect(() => {
    if (cachedVersion) return
    let cancelled = false
    void api()
      .app.info()
      .then((info) => {
        cachedVersion = info.version
        if (!cancelled) setVersion(info.version)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <div className="brand-mark">HF</div>
        <div className="titlebar-name">
          <strong>HF Render</strong>
          {version && <span className="titlebar-version">v{version}</span>}
        </div>
        {props.projectName && (
          <div
            className="titlebar-project"
            title={props.projectPath ?? props.projectName}
          >
            <Dot
              tone={
                props.projectValid === false ? 'warn' : props.projectValid ? 'ok' : 'unknown'
              }
            />
            <span className="titlebar-project-name">{props.projectName}</span>
          </div>
        )}
        {typeof props.previewPort === 'number' && props.previewPort > 0 && (
          <button
            type="button"
            className="titlebar-preview"
            title="HyperFrames Studio 正在运行，点击打开预览"
            onClick={props.onOpenPreview}
          >
            <Dot tone="ok" />
            预览 :{props.previewPort}
          </button>
        )}
      </div>

      <nav className="titlebar-nav" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={props.page === 'render'}
          className={props.page === 'render' ? 'titlebar-tab active' : 'titlebar-tab'}
          onClick={() => props.onNavigate('render')}
        >
          渲染
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.page === 'performance'}
          className={props.page === 'performance' ? 'titlebar-tab active' : 'titlebar-tab'}
          onClick={() => props.onNavigate('performance')}
        >
          性能
        </button>
      </nav>

      {/* 拖动区域：不放置任何交互控件 */}
      <div className="titlebar-drag" aria-hidden />

      <div className="titlebar-actions">
        {props.envStatus && props.onOpenEnv && (
          <>
            <button
              type="button"
              className={`env-pill env-pill-${props.envStatus}`}
              onClick={props.onOpenEnv}
              title="查看环境检测结果"
            >
              {props.envLoading ? (
                <Spinner />
              ) : (
                <Dot tone={props.envStatus === 'warning' ? 'warn' : props.envStatus} />
              )}
              {ENV_TEXT[props.envStatus]}
            </button>

            <Button size="sm" variant="subtle" onClick={props.onOpenEnv} title="打开环境检测">
              <Icon.Refresh />
              环境检测
            </Button>
          </>
        )}

        <button
          type="button"
          className="theme-toggle"
          onClick={props.onToggleTheme}
          title={props.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        >
          {props.theme === 'dark' ? <Icon.Sun /> : <Icon.Moon />}
        </button>
      </div>

      {/*
        原生窗口按钮的占位区域。
        env(titlebar-area-width) 由 titleBarOverlay 提供，未提供时按 138px 兜底，
        避免自定义内容压在系统按钮下面。
      */}
      <div className="titlebar-reserve" aria-hidden />
    </header>
  )
}
