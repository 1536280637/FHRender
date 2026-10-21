import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Panel } from '../ui'
import type { RenderPreset } from '@shared/types/settings'

interface Props {
  presets: RenderPreset[]
  activeId: string | null
  dirty: boolean
  disabled?: boolean
  onApply: (preset: RenderPreset) => void
  onSave: (name: string) => void
  onUpdate: (preset: RenderPreset, name: string) => void
  onDelete: (preset: RenderPreset) => void
}

export function PresetSelector(props: Props): JSX.Element {
  const [mode, setMode] = useState<'idle' | 'save' | 'update'>('idle')
  const [name, setName] = useState('')
  const [target, setTarget] = useState<RenderPreset | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const active = props.presets.find((p) => p.id === props.activeId) ?? null

  useEffect(() => {
    if (mode !== 'idle') inputRef.current?.focus()
  }, [mode])

  const startSave = (): void => {
    setName(active && !active.builtin ? `${active.name} 副本` : '我的预设')
    setMode('save')
  }

  const startUpdate = (preset: RenderPreset): void => {
    if (preset.builtin) return
    setTarget(preset)
    setName(preset.name)
    setMode('update')
  }

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (mode === 'save') props.onSave(trimmed)
    if (mode === 'update' && target) props.onUpdate(target, trimmed)
    setMode('idle')
    setTarget(null)
  }

  return (
    <Panel
      title="参数预设"
      subtitle="预设只保存在应用数据目录，不会写入项目"
      actions={
        <Button size="sm" onClick={startSave} disabled={props.disabled}>
          + 保存当前参数
        </Button>
      }
    >
      <div className="preset-list">
        {props.presets.map((preset) => {
          const isActive = preset.id === props.activeId
          return (
            <div key={preset.id} className={`preset ${isActive ? 'active' : ''}`}>
              <button
                type="button"
                className="preset-main"
                onClick={() => props.onApply(preset)}
                disabled={props.disabled}
                title={describe(preset)}
              >
                <span className="preset-name">
                  {preset.name}
                  {preset.builtin && <em className="preset-tag">内置</em>}
                </span>
                <span className="preset-meta">{describe(preset)}</span>
              </button>
              {!preset.builtin && (
                <span className="preset-actions">
                  <button
                    type="button"
                    className="mini-btn"
                    title={props.dirty && isActive ? '用当前参数更新该预设' : '用当前参数覆盖该预设'}
                    onClick={() => startUpdate(preset)}
                    disabled={props.disabled}
                  >
                    更新
                  </button>
                  <button
                    type="button"
                    className="mini-btn danger"
                    title="删除预设"
                    onClick={() => {
                      if (window.confirm(`确定删除预设「${preset.name}」吗？`)) props.onDelete(preset)
                    }}
                    disabled={props.disabled}
                  >
                    <Icon.Trash />
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </div>

      {props.dirty && active && (
        <p className="preset-dirty">
          当前参数已偏离「{active.name}」
          {!active.builtin && (
            <button type="button" className="link-btn" onClick={() => startUpdate(active)}>
              更新预设
            </button>
          )}
        </p>
      )}

      {mode !== 'idle' && (
        <div className="preset-editor">
          <input
            ref={inputRef}
            className="input"
            value={name}
            placeholder="预设名称"
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setMode('idle')
            }}
          />
          <Button size="sm" variant="primary" onClick={submit} disabled={!name.trim()}>
            {mode === 'save' ? '保存' : '覆盖'}
          </Button>
          <Button size="sm" onClick={() => setMode('idle')}>
            取消
          </Button>
        </div>
      )}
    </Panel>
  )
}

const QUALITY_LABEL: Record<string, string> = {
  draft: 'Draft',
  looks: 'Looks',
  standard: 'Standard',
  high: 'High',
  delivery: 'Delivery'
}

function describe(preset: RenderPreset): string {
  const s = preset.settings
  const fps = s.fpsMode === 'project' ? '项目帧率' : s.fpsMode === 'custom' ? `${s.customFps || '?'}fps` : `${s.fpsMode}fps`
  const res = s.resolution === 'project' ? '原始尺寸' : s.resolution
  return `${s.format} · ${QUALITY_LABEL[s.quality] ?? s.quality} · ${fps} · ${res}`
}
