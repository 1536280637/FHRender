import type { RenderExtraOptions, RenderSettings } from '@shared/types/render'
import { DEFAULT_EXTRA_OPTIONS } from '@shared/types/render'
import type { CapturePath, FallbackEvent } from '@shared/types/performance'
import type { BrowserGpuMode } from '@shared/types/render'
import type { ProfileStore } from '../profiles/profile-store'

export interface FallbackContext {
  workers: number | 'auto'
  gpuEncode: boolean
  capturePath: CapturePath
  browserGpu: BrowserGpuMode
  encoderId?: string | null
  /** 当前生效的性能高级选项，用于判断某个超时是否还有放宽空间 */
  extra?: RenderExtraOptions
}

export interface FallbackAction {
  key: string
  label: string
  reason: string
  patch: Partial<RenderSettings>
  env?: Record<string, string>
  /** 需要人工处理（例如磁盘空间不足）时不再自动重试 */
  blocking?: boolean
}

interface Rule {
  key: string
  pattern: RegExp
  label: string
  build: (ctx: FallbackContext) => FallbackAction | null
}

function reduceWorkers(current: number | 'auto', floor = 1): number | 'auto' | null {
  if (current === 'auto') return 1
  if (current <= floor) return null
  return Math.max(floor, Math.floor(current / 2))
}

/**
 * 页面就绪等待的放宽阶梯。
 * CLI 默认 45s；每一个 worker 都会独立启动一个 Chrome 并初始化页面，
 * 并发越多、分辨率越高，单个 worker 的初始化就越慢。
 */
const READY_TIMEOUT_DEFAULT_MS = 45_000
const READY_TIMEOUT_STEPS_MS = [45_000, 90_000, 150_000, 240_000]

function nextReadyTimeout(current: number): number | null {
  return READY_TIMEOUT_STEPS_MS.find((v) => v > current) ?? null
}

const RULES: Rule[] = [
  {
    key: 'ready-timeout',
    // "[Parallel] Capture failed: Worker 0: Parallel worker cancelled; ... Worker 3: [FrameCapture] window.__hf not ready after 45000ms"
    pattern: /window\.__hf not ready after|not ready after \d+ms|Parallel worker cancelled|\[Parallel\]\s*capture failed/i,
    label: '页面就绪超时',
    build: (ctx) => {
      const current = ctx.extra?.playerReadyTimeoutMs ?? READY_TIMEOUT_DEFAULT_MS
      const nextTimeout = nextReadyTimeout(current)
      const nextWorkers = reduceWorkers(ctx.workers)
      if (nextTimeout === null && nextWorkers === null) return null

      const parts: string[] = []
      if (nextWorkers !== null) {
        parts.push(`并行 worker 降到 ${nextWorkers}，减少多个 Chrome 争抢导致的页面初始化过慢`)
      }
      if (nextTimeout !== null) {
        parts.push(
          `页面就绪等待放宽到 ${Math.round(nextTimeout / 1000)}s（原先 ${Math.round(current / 1000)}s 内没完成初始化）`
        )
      }

      return {
        key: 'ready-timeout',
        label: '页面就绪超时',
        reason: parts.join('，'),
        patch: {
          ...(nextWorkers !== null ? { workers: nextWorkers } : {}),
          extra: {
            ...(ctx.extra ?? DEFAULT_EXTRA_OPTIONS),
            playerReadyTimeoutMs: nextTimeout ?? current
          }
        }
      }
    }
  },
  {
    key: 'browser-gpu',
    pattern: /failed to launch|browser.*not.*launch|target closed|gpu process|crash|swiftshader|webgl.*fail|screenshot.*timeout/i,
    label: '浏览器 GPU 异常',
    build: (ctx) =>
      ctx.browserGpu === 'off'
        ? null
        : {
            key: 'browser-gpu',
            label: '浏览器 GPU 异常',
            reason: '渲染浏览器启动 / 捕获失败，回退到软件渲染（--no-browser-gpu）',
            patch: { browserGpu: 'off' }
          }
  },
  {
    key: 'hardware-encoder',
    pattern: /nvenc|nvcuda|amfrt|qsv|mfx|vaapi|videotoolbox|hardware device context|no capable devices|cannot load/i,
    label: '硬件编码器不可用',
    build: (ctx) =>
      !ctx.gpuEncode
        ? null
        : {
            key: 'hardware-encoder',
            label: '硬件编码器不可用',
            reason: '硬件编码初始化失败，回退到 CPU 编码（保留原始格式与质量参数）',
            patch: { gpu: false }
          }
  },
  {
    key: 'memory',
    pattern: /out of memory|enomem|heap out of memory|low memory|allocation failed|memory limit/i,
    label: '内存压力',
    build: (ctx) => ({
      key: 'memory',
      label: '内存压力',
      reason: '渲染过程中出现内存不足，降低 worker 并行度并启用 CLI 低内存模式',
      patch: {
        workers: ctx.workers === 'auto' ? 1 : Math.max(1, Math.floor((ctx.workers as number) / 2)),
        extra: {
          fastCapture: 'auto',
          pageSideCompositing: true,
          lowMemoryMode: 'on',
          browserTimeoutSec: null,
          playerReadyTimeoutMs: null
        }
      }
    })
  },
  {
    key: 'worker-crash',
    pattern: /worker.*(crash|exit|terminated)|protocol error|target closed|navigation timeout|timed out waiting/i,
    label: 'Worker 不稳定',
    build: (ctx) => {
      const next = reduceWorkers(ctx.workers)
      if (!next) return null
      return {
        key: 'worker-crash',
        label: 'Worker 不稳定',
        reason: `并发捕获不稳定，worker 降到 ${next} 后重试`,
        patch: { workers: next }
      }
    }
  },
  {
    key: 'disk',
    pattern: /no space left|enospc|disk full|insufficient disk/i,
    label: '磁盘空间不足',
    build: () => ({
      key: 'disk',
      label: '磁盘空间不足',
      reason: '磁盘空间不足，请更换输出目录或清理临时空间后再试（不会自动降质重试）',
      patch: {},
      blocking: true
    })
  },
  {
    key: 'capture-path',
    pattern: /drawElementImage|fast capture|parallel stream|capture.*fallback/i,
    label: '捕获路径回退',
    build: (ctx) =>
      ctx.capturePath === 'default'
        ? null
        : {
            key: 'capture-path',
            label: '捕获路径回退',
            reason: '实验性 / 快速捕获路径失败，回退到默认截图捕获',
            patch: {
              extra: {
                fastCapture: 'auto',
                pageSideCompositing: true,
                lowMemoryMode: 'auto',
                browserTimeoutSec: null,
                playerReadyTimeoutMs: null
              }
            }
          }
  }
]

/**
 * 统一故障回退：把渲染失败信息映射为具体的降载动作。
 * 只降低负载 / 回退加速路径，绝不修改输出格式、分辨率、质量。
 */
export class FallbackManager {
  private store: ProfileStore

  constructor(store: ProfileStore) {
    this.store = store
  }

  analyze(errorText: string, ctx: FallbackContext): FallbackAction[] {
    if (!errorText) return []
    // lint 失败属于项目问题，不是性能问题，不做性能回退
    if (/lint/i.test(errorText) && /abort|fail/i.test(errorText)) return []

    const actions: FallbackAction[] = []
    for (const rule of RULES) {
      if (!rule.pattern.test(errorText)) continue
      const action = rule.build(ctx)
      if (action) actions.push(action)
    }
    return actions.slice(0, 2)
  }

  async record(actions: FallbackAction[], scope: string): Promise<FallbackEvent[]> {
    const events: FallbackEvent[] = actions.map((action) => ({
      ts: new Date().toISOString(),
      scope,
      from: action.key,
      to: JSON.stringify(action.patch),
      reason: action.reason
    }))
    for (const event of events) await this.store.recordFallback(event)
    return events
  }
}
