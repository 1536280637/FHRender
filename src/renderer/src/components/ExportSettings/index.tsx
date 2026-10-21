import { Badge, Button, Field, Icon, Panel, Segmented } from '../ui'
import {
  EXTENSION_MAP,
  QUALITY_OPTIONS,
  RESOLUTION_OPTIONS,
  FORMAT_OPTIONS,
  isDirectoryFormat
} from '../../services/api'
import type { ProjectInfo } from '@shared/types/project'
import type { RenderSettings, FpsMode, VideoFormat } from '@shared/types/render'

interface Props {
  settings: RenderSettings
  project: ProjectInfo | null
  outputDir: string
  outputName: string
  recentOutputDirs: string[]
  disabled?: boolean
  onChange: (patch: Partial<RenderSettings>) => void
  onOutputDirChange: (value: string) => void
  onOutputNameChange: (value: string) => void
  onBrowseOutput: () => void
}

const FPS_OPTIONS: { value: FpsMode; label: string }[] = [
  { value: 'project', label: '跟随项目' },
  { value: '24', label: '24' },
  { value: '25', label: '25' },
  { value: '30', label: '30' },
  { value: '60', label: '60' },
  { value: 'custom', label: '自定义' }
]

const FORMAT_NOTES: Record<VideoFormat, string> = {
  mp4: 'H.264 视频，最通用的交付格式',
  webm: 'VP9 视频，支持透明通道',
  mov: 'ProRes 4444，固定保留透明通道',
  gif: '适合文档 / PR 演示，建议 15fps',
  'png-sequence': '输出 PNG 帧序列目录，供 AE / Nuke / Fusion 使用',
  hls: '输出 HLS VOD 播放列表目录（H.264/AAC，仅 SDR）'
}

export function ExportSettings(props: Props): JSX.Element {
  const { settings, project } = props
  const isDir = isDirectoryFormat(settings.format)
  const ext = EXTENSION_MAP[settings.format]
  const quality = QUALITY_OPTIONS.find((q) => q.value === settings.quality)

  return (
    <Panel title="导出参数" subtitle="参数直接对应 hyperframes render 的真实选项">
      <Field
        label="视频格式"
        hint={FORMAT_NOTES[settings.format]}
      >
        <div className="wrap-row">
          <Segmented
            value={settings.format}
            options={FORMAT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
            onChange={(value) => props.onChange({ format: value })}
          />
          {isDir && <Badge tone="warn">目录输出</Badge>}
        </div>
      </Field>

      <Field
        label="视频帧率"
        hint={
          settings.fpsMode === 'project'
            ? project?.fps
              ? `使用项目内置帧率 ${project.fps}fps`
              : '使用 composition 根元素的 data-fps，未声明时 CLI 默认 30'
            : 'CLI 支持 1–240 整数，或 ffmpeg 风格有理数（如 30000/1001）'
        }
      >
        <div className="wrap-row">
          <Segmented
            size="sm"
            value={settings.fpsMode}
            options={FPS_OPTIONS}
            onChange={(value) => props.onChange({ fpsMode: value })}
          />
          {settings.fpsMode === 'custom' && (
            <input
              className="input input-fps"
              value={settings.customFps}
              placeholder="30 或 30000/1001"
              onChange={(e) => props.onChange({ customFps: e.target.value })}
            />
          )}
        </div>
      </Field>

      <div className="field-grid">
        <Field label="视频质量" hint={quality?.hint}>
          <select
            className="input"
            value={settings.quality}
            onChange={(e) => props.onChange({ quality: e.target.value as RenderSettings['quality'] })}
          >
            {QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.value === 'looks' ? '（CLI 默认）' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="输出分辨率"
          hint={
            settings.resolution === 'project'
              ? project?.width
                ? `项目原始尺寸 ${project.width}×${project.height}`
                : '保持 composition 自身尺寸'
              : '通过提高 deviceScaleFactor 放大采样，宽高比必须与项目一致且为整数倍'
          }
        >
          <select
            className="input"
            value={settings.resolution}
            onChange={(e) =>
              props.onChange({ resolution: e.target.value as RenderSettings['resolution'] })
            }
          >
            {RESOLUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="divider" />

      <Field
        label={isDir ? '输出目录名' : '文件名称'}
        hint={
          isDir
            ? '目录型输出会在所选位置下创建同名文件夹'
            : `扩展名由格式自动决定${ext ? `：${ext}` : ''}`
        }
      >
        <div className="input-affix">
          <input
            className="input"
            value={props.outputName}
            placeholder="例如 my-video"
            onChange={(e) => props.onOutputNameChange(e.target.value)}
          />
          {ext && <span className="affix">{ext}</span>}
        </div>
      </Field>

      <Field label={isDir ? '输出位置' : '输出文件夹'} hint="会记住上次使用的导出位置">
        <div className="path-input">
          <input
            className="input mono"
            value={props.outputDir}
            placeholder={project ? `${project.path}\\renders` : '选择输出文件夹'}
            onChange={(e) => props.onOutputDirChange(e.target.value)}
          />
          <Button onClick={props.onBrowseOutput} disabled={props.disabled}>
            <span className="btn-icon">
              <Icon.Folder />
            </span>
            浏览
          </Button>
        </div>
        {props.recentOutputDirs.length > 0 && (
          <div className="recent-chips">
            {props.recentOutputDirs.slice(0, 3).map((dir) => (
              <button
                type="button"
                key={dir}
                className="chip chip-quiet"
                title={dir}
                onClick={() => props.onOutputDirChange(dir)}
              >
                {dir}
              </button>
            ))}
          </div>
        )}
      </Field>

      {settings.format === 'mov' && (
        <div className="alert alert-info">
          MOV 由 CLI 固定使用 ProRes 4444 以保留透明通道，因此 CRF 与视频码率参数不可用。
        </div>
      )}
    </Panel>
  )
}
