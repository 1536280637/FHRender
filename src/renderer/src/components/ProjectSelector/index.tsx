import { Badge, Button, Icon, Panel, Spinner } from '../ui'
import type { ProjectInfo, RecentProject } from '@shared/types/project'

interface Props {
  project: ProjectInfo | null
  loading: boolean
  error?: string
  recent: RecentProject[]
  composition?: string
  onSelect: () => void
  onRescan: () => void
  onOpenRecent: (path: string) => void
  onRemoveRecent: (path: string) => void
  onReveal: () => void
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function ProjectSelector(props: Props): JSX.Element {
  const { project } = props

  return (
    <Panel
      title="项目"
      subtitle="选择包含 index.html 的 HyperFrames 项目目录"
      actions={
        <>
          {project && (
            <Button size="sm" onClick={props.onReveal} title="在资源管理器中显示项目目录">
              <span className="btn-icon">
                <Icon.Folder />
              </span>
              定位
            </Button>
          )}
          {project && (
            <Button size="sm" onClick={props.onRescan} disabled={props.loading}>
              <span className="btn-icon">
                <Icon.Refresh />
              </span>
              重新检测
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={props.onSelect} disabled={props.loading}>
            {props.loading ? <Spinner /> : <Icon.Folder />}
            {project ? '更换项目' : '选择项目'}
          </Button>
        </>
      }
    >
      {!project && (
        <div className="project-empty">
          <div className="project-empty-mark">
            <Icon.Folder />
          </div>
          <div>
            <strong>尚未选择项目</strong>
            <p>选择一个本地 HyperFrames 项目文件夹，扩展名不需要填写。本工具不会修改项目内的任何文件。</p>
          </div>
        </div>
      )}

      {props.error && <div className="alert alert-error">{props.error}</div>}

      {project && (
        <>
          <div className="project-path" title={project.path}>
            <span className="project-path-text">{project.path}</span>
            <span
              className={`project-valid ${project.valid ? 'ok' : props.composition ? 'info' : 'error'}`}
            >
              {project.valid ? '可渲染' : props.composition ? '已指定 composition' : '不可渲染'}
            </span>
          </div>

          <div className="badge-row">
            <Badge tone={project.hasIndexHtml ? 'ok' : 'error'} title="默认入口文件">
              index.html {project.hasIndexHtml ? '✓' : '✗'}
            </Badge>
            <Badge tone={project.hasPackageJson ? 'ok' : 'warn'}>
              package.json {project.hasPackageJson ? '✓' : '✗'}
            </Badge>
            <Badge tone={project.hasHyperframesConfig ? 'ok' : 'warn'}>
              hyperframes.json {project.hasHyperframesConfig ? '✓' : '✗'}
            </Badge>
            {project.width && project.height && (
              <Badge tone="info">
                {project.width}×{project.height}
              </Badge>
            )}
            {typeof project.duration === 'number' ? (
              <Badge tone="info">{project.duration}s</Badge>
            ) : project.valid ? (
              <Badge tone="neutral" >
                时长待检测
              </Badge>
            ) : null}
            {typeof project.fps === 'number' && <Badge tone="info">项目 {project.fps}fps</Badge>}
          </div>

          {project.issues.length > 0 && (
            <ul className="issue-list">
              {project.issues.map((issue, index) => (
                <li key={`${issue.message}-${index}`} className={`issue issue-${issue.level}`}>
                  <span className="issue-mark">
                    {issue.level === 'error' ? '✗' : issue.level === 'warning' ? '!' : 'i'}
                  </span>
                  <div>
                    <p>{issue.message}</p>
                    {issue.hint && <span>{issue.hint}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {props.recent.filter((r) => !project || normalize(r.path) !== normalize(project.path)).length > 0 && (
        <div className="recent">
          <div className="recent-head">最近项目</div>
          <ul className="recent-list">
            {props.recent
              .filter((r) => !project || normalize(r.path) !== normalize(project.path))
              .slice(0, 5)
              .map((item) => (
              <li key={item.path}>
                <button type="button" className="recent-item" title={item.path} onClick={() => props.onOpenRecent(item.path)}>
                  <span className="recent-name">{item.name}</span>
                  <span className="recent-path">{item.path}</span>
                </button>
                <button
                  type="button"
                  className="recent-remove"
                  title="从列表移除"
                  onClick={() => props.onRemoveRecent(item.path)}
                >
                  <Icon.Close />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}
