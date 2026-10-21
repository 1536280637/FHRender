import { JsonStore } from './store'
import type { AppSettings, ThemeMode } from '@shared/types/settings'
import { DEFAULT_EXTRA_OPTIONS, type RenderSettings } from '@shared/types/render'
import { sanitizeBrowserTimeout } from '@shared/render-limits'

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  format: 'mp4',
  fpsMode: 'project',
  customFps: '',
  quality: 'looks',
  resolution: 'project',
  docker: false,
  gpu: false,
  browserGpu: 'auto',
  workers: 'auto',
  crf: null,
  videoBitrate: '',
  strict: false,
  gifLoop: 0,
  hlsSegmentSeconds: 4
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  recentProjects: [],
  recentOutputDirs: [],
  lastOutputDir: '',
  lastSettings: DEFAULT_RENDER_SETTINGS,
  lastComposition: '',
  autoEnvCheck: true,
  cliCommand: 'npx --yes hyperframes@latest',
  performanceMode: 'smart',
  allowExperimental: false,
  scratchDir: '',
  autoScratch: true,
  autoCleanPerfTests: true,
  keepFailedPerfTests: false,
  keepPerfReports: true
}

const MAX_RECENT_PROJECTS = 8
const MAX_RECENT_OUTPUTS = 6

const THEMES: ThemeMode[] = ['light', 'dark', 'system']

/**
 * 归一化导出参数：
 * - extra 补全默认值（旧版本存档可能没有 extra 字段）；
 * - `browserTimeoutSec` 只保留安全区间（10–600s）内的值。
 *   历史存档 / 手改 JSON 里如果有 1s 这种必失败值，这里直接清掉——
 *   否则它会一直跟着 lastSettings 传给 CLI，让每次渲染都失败。
 */
function normalizeRenderSettings(input: RenderSettings | null | undefined): RenderSettings {
  const base: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, ...(input ?? {}) }
  return {
    ...base,
    extra: {
      ...DEFAULT_EXTRA_OPTIONS,
      ...(base.extra ?? {}),
      browserTimeoutSec: sanitizeBrowserTimeout(base.extra?.browserTimeoutSec)
    }
  }
}

/** Windows 下正反斜杠混用会导致重复记录，统一比较 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function dedupeByPath<T extends { path: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of list) {
    const key = item.path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export class SettingsManager {
  private store = new JsonStore<AppSettings>('settings.json', DEFAULT_SETTINGS)

  async get(): Promise<AppSettings> {
    const data = await this.store.read()
    return {
      ...DEFAULT_SETTINGS,
      ...data,
      theme: THEMES.includes(data.theme) ? data.theme : 'light',
      lastSettings: data.lastSettings ? normalizeRenderSettings(data.lastSettings) : DEFAULT_RENDER_SETTINGS,
      recentProjects: Array.isArray(data.recentProjects) ? dedupeByPath(data.recentProjects) : [],
      recentOutputDirs: Array.isArray(data.recentOutputDirs) ? data.recentOutputDirs : [],
      /*
       * 清理开关必须是严格布尔值：
       * 配置文件被手工改坏（null / "false" 字符串）时按默认值处理，
       * 避免「看起来关了其实没关」或者反过来把用户的临时文件删掉。
       */
      autoScratch: data.autoScratch !== false,
      autoCleanPerfTests: data.autoCleanPerfTests !== false,
      keepFailedPerfTests: data.keepFailedPerfTests === true,
      keepPerfReports: data.keepPerfReports !== false
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get()
    const next: AppSettings = {
      ...current,
      ...patch,
      lastSettings:
        patch.lastSettings !== undefined ? normalizeRenderSettings(patch.lastSettings) : current.lastSettings,
      recentProjects: (patch.recentProjects ?? current.recentProjects).slice(0, MAX_RECENT_PROJECTS),
      recentOutputDirs: (patch.recentOutputDirs ?? current.recentOutputDirs).slice(0, MAX_RECENT_OUTPUTS)
    }
    return this.store.write(next)
  }

  async rememberProject(path: string, name: string): Promise<AppSettings> {
    const current = await this.get()
    const others = current.recentProjects.filter((p) => !samePath(p.path, path))
    const recentProjects = [{ path, name, openedAt: new Date().toISOString() }, ...others].slice(
      0,
      MAX_RECENT_PROJECTS
    )
    return this.update({ recentProjects })
  }

  async forgetProject(path: string): Promise<AppSettings> {
    const current = await this.get()
    return this.update({
      recentProjects: current.recentProjects.filter((p) => !samePath(p.path, path))
    })
  }

  async rememberOutputDir(dir: string): Promise<AppSettings> {
    const current = await this.get()
    const others = current.recentOutputDirs.filter((d) => !samePath(d, dir))
    return this.update({
      lastOutputDir: dir,
      recentOutputDirs: [dir, ...others].slice(0, MAX_RECENT_OUTPUTS)
    })
  }
}
