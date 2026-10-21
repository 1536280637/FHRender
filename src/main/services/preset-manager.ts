import { randomUUID } from 'node:crypto'
import { JsonStore } from './store'
import { DEFAULT_RENDER_SETTINGS } from './settings-manager'
import type { RenderPreset, PresetSaveInput } from '@shared/types/settings'
import type { RenderSettings } from '@shared/types/render'

interface PresetFile {
  presets: RenderPreset[]
}

const now = () => new Date().toISOString()

function withDefaults(settings: Partial<RenderSettings>): RenderSettings {
  return { ...DEFAULT_RENDER_SETTINGS, ...settings }
}

/** 内置预设：参数均对应 CLI 真实支持的能力 */
function builtinPresets(): RenderPreset[] {
  const base = { builtin: true, createdAt: 'builtin', updatedAt: 'builtin' }
  return [
    {
      ...base,
      id: 'builtin-preview',
      name: '快速预览',
      settings: withDefaults({ quality: 'draft', format: 'mp4', workers: 'auto' })
    },
    {
      ...base,
      id: 'builtin-standard',
      name: '标准导出',
      settings: withDefaults({ quality: 'looks', format: 'mp4', fpsMode: '60', workers: 'auto' })
    },
    {
      ...base,
      id: 'builtin-high',
      name: '高质量导出',
      settings: withDefaults({ quality: 'delivery', format: 'mp4', fpsMode: '60', workers: 'auto' })
    },
    {
      ...base,
      id: 'builtin-transparent',
      name: '透明素材导出',
      settings: withDefaults({
        quality: 'looks',
        format: 'webm',
        workers: 'auto',
        browserGpu: 'auto',
        gpu: false
      })
    }
  ]
}

export class PresetManager {
  private store = new JsonStore<PresetFile>('presets.json', { presets: [] })

  async list(): Promise<RenderPreset[]> {
    const data = await this.store.read()
    const users = (data.presets ?? []).map((p) => ({
      ...p,
      builtin: false,
      settings: withDefaults(p.settings)
    }))
    return [...builtinPresets(), ...users]
  }

  async save(input: PresetSaveInput): Promise<RenderPreset[]> {
    const data = await this.store.read()
    const name = input.name.trim() || '未命名预设'
    const preset: RenderPreset = {
      id: randomUUID(),
      name,
      builtin: false,
      settings: withDefaults(input.settings),
      createdAt: now(),
      updatedAt: now()
    }
    await this.store.write({ presets: [...(data.presets ?? []), preset] })
    return this.list()
  }

  async update(id: string, input: PresetSaveInput): Promise<RenderPreset[]> {
    const data = await this.store.read()
    const presets = (data.presets ?? []).map((p) => {
      if (p.id !== id) return p
      return {
        ...p,
        name: input.name.trim() || p.name,
        settings: withDefaults(input.settings),
        updatedAt: now()
      }
    })
    // 内置预设不允许原地修改，改为另存为新的用户预设
    if (!presets.some((p) => p.id === id)) {
      const builtin = builtinPresets().find((p) => p.id === id)
      if (!builtin) throw new Error('预设不存在')
      return this.save({ name: input.name || `${builtin.name} 副本`, settings: input.settings })
    }
    await this.store.write({ presets })
    return this.list()
  }

  async remove(id: string): Promise<RenderPreset[]> {
    const data = await this.store.read()
    await this.store.write({ presets: (data.presets ?? []).filter((p) => p.id !== id) })
    return this.list()
  }

  async reset(): Promise<RenderPreset[]> {
    await this.store.write({ presets: [] })
    return this.list()
  }
}
