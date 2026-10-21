import { Badge, Button, Panel, Spinner } from '../ui'
import type { CacheClearScope, CacheOverview } from '@shared/types/cache'
import { formatBytes } from '../../services/perf-format'

function timeText(iso: string | null | undefined): string {
  if (!iso) return '尚未检测'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '时间无效'
  return new Date(time).toLocaleString('zh-CN', { hour12: false })
}

/** ffmpeg -version 的首行很长，面板里只显示版本号 */
function shortVersion(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/\b(\d+\.\d+(?:\.\d+)?[\w.-]*)\b/)
  return match ? match[1] : text.slice(0, 24)
}

function agoText(iso: string | null | undefined): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 缓存与检测面板。
 *
 * 目的：把「哪些数据是缓存的、什么时候检测的、怎么强制重查」讲清楚，
 * 同时把本次会话真实发生的检测次数展示出来，方便验证「重复进入页面不再重跑」。
 */
export function CachePanel(props: {
  cache: CacheOverview | null
  busy: boolean
  reanalyzing: boolean
  onRefreshHardware: () => void
  onReanalyze: () => void
  onClear: (scope: CacheClearScope) => void
}): JSX.Element {
  const c = props.cache
  const hw = c?.hardware
  const env = c?.environment
  const project = c?.project
  const counters = c?.counters

  return (
    <Panel
      title="缓存与检测"
      subtitle="静态硬件 / 运行环境 / 项目元数据都会缓存；CPU、GPU、显存占用仍然实时采样"
      actions={
        <Button
          size="sm"
          variant="subtle"
          onClick={() => props.onClear('all')}
          disabled={props.busy}
          title="只删除缓存文件，不会碰你的项目目录"
        >
          清除全部缓存
        </Button>
      }
    >
      {!c ? (
        <div className="empty-line">正在读取缓存状态…</div>
      ) : (
        <>
          <div className="cache-grid">
            <div className="cache-block">
              <div className="cache-block-head">
                <span className="cache-title">设备档案</span>
                <Badge tone={hw?.available ? 'ok' : 'neutral'}>{hw?.available ? '已缓存' : '未建立'}</Badge>
              </div>
              <p className="cache-line">
                最后检测：{timeText(hw?.checkedAt)} {agoText(hw?.checkedAt) && <span className="muted">（{agoText(hw?.checkedAt)}）</span>}
              </p>
              <p className="cache-line muted">
                {hw?.cpuModel ?? 'CPU 未知'}
                {hw?.gpuNames?.length ? ` · ${hw.gpuNames.join(' / ')}` : ''}
              </p>
              <p className="cache-line muted">
                有效期 {hw?.ttlHours ?? 0} 小时
                {hw?.staleReason ? ` · ${hw.staleReason}` : ' · 静态签名未变时直接复用'}
              </p>
              <div className="cache-actions">
                <Button size="sm" variant="subtle" onClick={props.onRefreshHardware} disabled={props.busy}>
                  {props.busy ? <Spinner /> : null}
                  刷新设备信息
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onClear('hardware')}
                  disabled={props.busy}
                >
                  清除
                </Button>
              </div>
            </div>

            <div className="cache-block">
              <div className="cache-block-head">
                <span className="cache-title">运行环境</span>
                <Badge tone={env?.cliVersion ? 'ok' : 'neutral'}>
                  {env?.cliVersion ? `CLI v${env.cliVersion}` : '未探测'}
                </Badge>
              </div>
              <p className="cache-line">
                Node {env?.nodeVersion ?? '未知'} · npm {env?.npmVersion ?? '未知'}
              </p>
              <p className="cache-line muted">
                FFmpeg {shortVersion(env?.ffmpegVersion) ?? (env?.ffmpegPath ? '已找到' : '未找到')} · 可用编码器{' '}
                {env?.encoderCount ?? '未知'} · render 参数 {env?.cliFlagCount ?? '未知'}
              </p>
              <p className="cache-line muted">
                最后探测：{timeText(env?.checkedAt)} · 有效期 {env?.ttlHours ?? 0} 小时
                {env?.staleReason ? ` · ${env.staleReason}` : ''}
              </p>
              <div className="cache-actions">
                <Button size="sm" variant="ghost" onClick={() => props.onClear('environment')} disabled={props.busy}>
                  清除环境缓存
                </Button>
              </div>
            </div>

            <div className="cache-block">
              <div className="cache-block-head">
                <span className="cache-title">当前项目</span>
                <Badge tone={project?.available ? 'ok' : 'neutral'}>
                  {project?.available ? '已分析' : '未分析'}
                </Badge>
              </div>
              <p className="cache-line">
                最后分析：{timeText(project?.checkedAt)} {agoText(project?.checkedAt) && <span className="muted">（{agoText(project?.checkedAt)}）</span>}
              </p>
              <p className="cache-line muted">
                {project?.projectName ?? '未选择项目'}
                {project?.compositionId ? ` · composition ${project.compositionId}` : ''}
              </p>
              <p className="cache-line muted">
                跟踪 {project?.trackedFiles ?? 0} 个文件 · 指纹校验{' '}
                {project?.verifyMs != null ? `${project.verifyMs} ms` : '—'}
                {project?.cliVersion ? ` · CLI v${project.cliVersion}` : ''}
              </p>
              <div className="cache-actions">
                <Button size="sm" variant="subtle" onClick={props.onReanalyze} disabled={props.busy}>
                  {props.reanalyzing ? <Spinner /> : null}
                  重新分析项目
                </Button>
                <Button size="sm" variant="ghost" onClick={() => props.onClear('project')} disabled={props.busy}>
                  清除
                </Button>
              </div>
            </div>
          </div>

          {counters && (
            <div className="cache-counters">
              <span className="cache-title">本次会话实际执行的检测</span>
              <div className="cache-counter-grid">
                <span>硬件完整识别：{counters.hardwareScans} 次</span>
                <span>硬件缓存命中：{counters.hardwareCacheHits} 次</span>
                <span>CLI 能力探测：{counters.envProbes} 次</span>
                <span>编码器试编码：{counters.encoderProbes} 次</span>
                <span>环境缓存命中：{counters.envCacheHits} 次</span>
                <span>info 调用：{counters.cliInfoCalls} 次</span>
                <span>compositions 调用：{counters.cliCompositionCalls} 次</span>
                <span>项目完整分析：{counters.projectScans} 次</span>
                <span>项目缓存命中：{counters.projectCacheHits} 次</span>
                <span>目录遍历：{counters.dirListings} 次</span>
                <span>文件 stat：{counters.assetFileStats} 次</span>
              </div>
            </div>
          )}

          <p className="muted-line">
            缓存目录 {c.cacheDir} · 占用 {formatBytes(c.cacheBytes)}
            {project?.verifyMs != null ? ` · 上次指纹校验耗时 ${project.verifyMs} ms` : ''}
          </p>
        </>
      )}
    </Panel>
  )
}
