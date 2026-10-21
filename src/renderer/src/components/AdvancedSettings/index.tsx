import { useEffect, useState } from 'react'
import { Badge, Button, Field, Icon, Segmented, Toggle } from '../ui'
import { isDirectoryFormat } from '../../services/api'
import { DEFAULT_EXTRA_OPTIONS, type RenderSettings } from '@shared/types/render'
import { checkBrowserTimeout, MAX_BROWSER_TIMEOUT_SEC, MIN_BROWSER_TIMEOUT_SEC } from '@shared/render-limits'
import type { ProjectInfo } from '@shared/types/project'

interface Props {
  settings: RenderSettings
  project: ProjectInfo | null
  composition: string
  htmlFiles: string[]
  disabled?: boolean
  onChange: (patch: Partial<RenderSettings>) => void
  onCompositionChange: (value: string) => void
  onRefreshFiles: () => void
  onBrowseComposition: () => void
  /** 临时帧存储目录（空 = 系统临时目录） */
  scratchDir: string
  /** 系统盘空间不足时是否自动切换暂存盘 */
  autoScratch: boolean
  onPickScratchDir: () => void
  onResetScratchDir: () => void
  onAutoScratchChange: (checked: boolean) => void
}

const CRF_FORMATS = ['mp4', 'webm']
/** mp4 / mov 在 workers = 1 时走流式编码，不会把每一帧写盘 */
const STREAMING_FORMATS = ['mp4', 'mov']

function supportsStreaming(format: string): boolean {
  return STREAMING_FORMATS.includes(format)
}

function workersHint(workers: number | 'auto', streaming: boolean): string {
  const base = '每个 worker 会启动一个独立 Chrome 进程（约 256MB 内存）'
  if (!streaming) return base
  if (workers === 1) return `${base}；workers = 1 时走流式编码，不占用临时帧空间`
  return `${base}；workers ≠ 1 时每一帧会先写到临时目录，需要较大的剩余磁盘空间`
}

export function AdvancedSettings(props: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const { settings } = props
  const supportsCrf = CRF_FORMATS.includes(settings.format)
  const supportsGpu = ['mp4', 'webm', 'mov', 'gif'].includes(settings.format)
  const usesCrf = settings.crf !== null && settings.crf !== undefined
  const usesBitrate = settings.videoBitrate.trim().length > 0
  const isDir = isDirectoryFormat(settings.format)

  /* ---------------- 浏览器导航超时：只允许留空或 10–600 秒 ---------------- */
  const navTimeout = settings.extra?.browserTimeoutSec ?? null
  const [navDraft, setNavDraft] = useState(navTimeout != null ? String(navTimeout) : '')
  useEffect(() => {
    setNavDraft(navTimeout != null ? String(navTimeout) : '')
  }, [navTimeout])
  const navCheck = checkBrowserTimeout(navDraft.trim() === '' ? null : Number(navDraft))
  const navError =
    navDraft.trim() !== '' && navCheck.value === null
      ? navCheck.reason ?? `请输入 ${MIN_BROWSER_TIMEOUT_SEC}–${MAX_BROWSER_TIMEOUT_SEC} 之间的秒数，或留空`
      : undefined

  const commitNavTimeout = (raw: string): void => {
    setNavDraft(raw)
    const check = checkBrowserTimeout(raw.trim() === '' ? null : Number(raw))
    // 非法值不落盘：输入框显示原始内容，旁边给出错误提示
    if (raw.trim() !== '' && check.value === null) return
    props.onChange({
      extra: { ...(settings.extra ?? DEFAULT_EXTRA_OPTIONS), browserTimeoutSec: check.value }
    })
  }

  const activeCount = [
    settings.docker,
    settings.gpu,
    settings.browserGpu !== 'auto',
    settings.workers !== 'auto',
    usesCrf,
    usesBitrate,
    settings.strict,
    props.composition.length > 0,
    navTimeout != null
  ].filter(Boolean).length

  return (
    <section className={`panel advanced ${open ? 'open' : ''}`}>
      <button type="button" className="advanced-head" onClick={() => setOpen((v) => !v)}>
        <span className="advanced-title">
          <span className={`caret ${open ? 'rotated' : ''}`}>
            <Icon.Chevron />
          </span>
          高级参数
          {activeCount > 0 && <Badge tone="info">{activeCount} 项已修改</Badge>}
        </span>
        <span className="advanced-sub">
          Docker / GPU / Workers / Composition / 编码参数
        </span>
      </button>

      {open && (
        <div className="advanced-body">
          <Field
            label="Composition"
            hint={
              props.project?.hasIndexHtml
                ? '默认渲染项目根目录的 index.html；留空即使用默认入口'
                : '该项目缺少 index.html，必须在此指定一个 composition 文件才能渲染'
            }
          >
            <div className="path-input">
              <select
                className="input mono"
                value={props.composition}
                onChange={(e) => props.onCompositionChange(e.target.value)}
              >
                <option value="">index.html（默认入口）</option>
                {props.htmlFiles
                  .filter((file) => file !== 'index.html')
                  .map((file) => (
                    <option key={file} value={file}>
                      {file}
                    </option>
                  ))}
                {props.composition &&
                  props.composition !== 'index.html' &&
                  !props.htmlFiles.includes(props.composition) && (
                    <option value={props.composition}>{props.composition}</option>
                  )}
              </select>
              <Button size="sm" onClick={props.onRefreshFiles} disabled={!props.project} title="重新扫描项目内的 html 文件">
                <Icon.Refresh />
              </Button>
              <Button size="sm" onClick={props.onBrowseComposition} disabled={!props.project}>
                选择文件
              </Button>
            </div>
          </Field>

          <div className="divider" />

          <div className="toggle-grid">
            <Toggle
              label="Docker 渲染模式"
              description="对应 --docker，使用容器渲染以获得确定性环境（需本地 Docker）"
              checked={settings.docker}
              onChange={(checked) => props.onChange({ docker: checked })}
            />
            <Toggle
              label="GPU 编码"
              description={
                supportsGpu
                  ? '对应 --gpu，使用 NVENC / VideoToolbox 等硬件编码器'
                  : `${settings.format.toUpperCase()} 输出不支持 GPU 编码`
              }
              checked={settings.gpu}
              disabled={!supportsGpu || settings.docker}
              onChange={(checked) => props.onChange({ gpu: checked })}
            />
          </div>

          <Field label="Browser GPU" hint="控制 Chrome / WebGL 捕获时的 GPU 加速，自动模式会先探测再回退软件渲染">
            <Segmented
              size="sm"
              value={settings.browserGpu}
              options={[
                { value: 'auto', label: '自动', title: '--browser-gpu 默认（探测后回退）' },
                { value: 'on', label: '强制开启', title: '--browser-gpu' },
                { value: 'off', label: '强制关闭', title: '--no-browser-gpu（SwiftShader）' }
              ]}
              onChange={(value) => props.onChange({ browserGpu: value })}
            />
          </Field>

          <div className="field-grid">
            <Field label="Workers 数量" hint={workersHint(settings.workers, supportsStreaming(settings.format))}>
              <div className="inline-control">
                <label className="mini-check">
                  <input
                    type="checkbox"
                    checked={settings.workers === 'auto'}
                    onChange={(e) =>
                      props.onChange({ workers: e.target.checked ? 'auto' : 2 })
                    }
                  />
                  自动
                </label>
                <input
                  className="input input-num"
                  type="number"
                  min={1}
                  max={64}
                  disabled={settings.workers === 'auto'}
                  value={settings.workers === 'auto' ? '' : settings.workers}
                  placeholder="2"
                  onChange={(e) => {
                    const num = Number(e.target.value)
                    props.onChange({
                      workers: Number.isFinite(num) && num >= 1 ? Math.min(64, Math.round(num)) : 1
                    })
                  }}
                />
              </div>
            </Field>

            <Field
              label="输出类型"
              hint="目录型输出会自动按目录处理，不会拼成文件路径"
            >
              <div className="inline-note">
                {isDir ? '目录输出（png-sequence / hls）' : '单文件输出'}
              </div>
            </Field>
          </div>

          <Field
            label="浏览器导航超时（秒）"
            error={navError}
            hint={
              navError
                ? undefined
                : `对应 --browser-timeout，实际作用于页面导航（page.goto）。小于 ${MIN_BROWSER_TIMEOUT_SEC} 秒会让每次渲染必然失败；留空使用 CLI 默认 60s。`
            }
          >
            <div className="path-input">
              <input
                className="input input-num"
                type="number"
                min={MIN_BROWSER_TIMEOUT_SEC}
                max={MAX_BROWSER_TIMEOUT_SEC}
                placeholder="CLI 默认（60s）"
                value={navDraft}
                onChange={(e) => commitNavTimeout(e.target.value)}
                onBlur={() => {
                  // 失焦时把非法输入还原成已保存的值，避免显示与配置不一致
                  if (navError) setNavDraft(navTimeout != null ? String(navTimeout) : '')
                }}
              />
              <Button
                size="sm"
                variant="subtle"
                onClick={() => commitNavTimeout('')}
                disabled={navTimeout == null && navDraft === ''}
                title="清空，使用 CLI 默认 60s"
              >
                清空
              </Button>
            </div>
          </Field>

          <div className="field-grid">
            <Field
              label="视频 CRF"
              hint={
                supportsCrf
                  ? '0–63，数值越小画质越高；与视频码率互斥'
                  : `${settings.format.toUpperCase()} 不支持 CRF`
              }
            >
              <input
                className="input input-num"
                type="number"
                min={0}
                max={63}
                disabled={!supportsCrf || usesBitrate}
                value={requiresValue(settings.crf)}
                placeholder="默认"
                onChange={(e) => {
                  const raw = e.target.value
                  props.onChange({ crf: raw === '' ? null : Math.min(63, Math.max(0, Number(raw))) })
                }}
              />
            </Field>

            <Field
              label="Video Bitrate"
              hint={
                supportsCrf
                  ? '例如 10M / 8000k；设置后 CRF 失效'
                  : `${settings.format.toUpperCase()} 不支持自定义码率`
              }
            >
              <input
                className="input"
                disabled={!supportsCrf || usesCrf}
                value={settings.videoBitrate}
                placeholder="10M"
                onChange={(e) => props.onChange({ videoBitrate: e.target.value })}
              />
            </Field>
          </div>

          {settings.format === 'gif' && (
            <Field label="GIF 循环次数" hint="0 表示无限循环（对应 --gif-loop）">
              <input
                className="input input-num"
                type="number"
                min={0}
                max={65535}
                value={settings.gifLoop}
                onChange={(e) =>
                  props.onChange({ gifLoop: Math.min(65535, Math.max(0, Number(e.target.value) || 0)) })
                }
              />
            </Field>
          )}

          {settings.format === 'hls' && (
            <Field label="HLS 分片长度（秒）" hint="1–60 秒，对应 --hls-segment-seconds">
              <input
                className="input input-num"
                type="number"
                min={1}
                max={60}
                value={settings.hlsSegmentSeconds}
                onChange={(e) =>
                  props.onChange({
                    hlsSegmentSeconds: Math.min(60, Math.max(1, Number(e.target.value) || 4))
                  })
                }
              />
            </Field>
          )}

          <div className="divider" />

          <Field
            label="临时帧存储目录"
            hint="磁盘捕获会把每一帧先写到临时目录（Windows 固定为系统盘的 os.tmpdir）。空间不足时改到剩余更多的分区，可避免 “Disk capture may need …” 失败。"
          >
            <div className="path-input">
              <input
                className="input mono"
                value={props.scratchDir}
                placeholder="系统临时目录（默认）"
                readOnly
                title={props.scratchDir || '系统临时目录'}
                onChange={() => undefined}
              />
              <Button size="sm" onClick={props.onPickScratchDir} title="选择临时帧存放目录">
                选择目录
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={props.onResetScratchDir}
                disabled={!props.scratchDir}
                title="恢复为系统临时目录"
              >
                清空
              </Button>
            </div>
          </Field>

          <Toggle
            label="临时空间不足时自动换盘"
            description="系统临时目录放不下本次帧数时，自动把本次渲染的暂存位置切到剩余空间更充裕的分区（仅作用于本次渲染的子进程）"
            checked={props.autoScratch}
            onChange={props.onAutoScratchChange}
          />

          <Toggle
            label="严格模式"
            description="对应 --strict，lint 出现错误时直接失败而不是继续渲染"
            checked={settings.strict}
            onChange={(checked) => props.onChange({ strict: checked })}
          />

          <div className="advanced-actions">
            <Button
              size="sm"
              variant="subtle"
              onClick={() =>
                props.onChange({
                  docker: false,
                  gpu: false,
                  browserGpu: 'auto',
                  workers: 'auto',
                  crf: null,
                  videoBitrate: '',
                  strict: false
                })
              }
            >
              重置高级参数
            </Button>
            <span className="muted-note">参数清空后将回落到 CLI 自身默认值</span>
          </div>
        </div>
      )}
    </section>
  )
}

function requiresValue(crf: number | null): string | number {
  return crf === null || crf === undefined ? '' : crf
}
