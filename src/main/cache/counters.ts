import type { CacheCounters } from '@shared/types/cache'

/**
 * 进程内计数器：只用于验收与「缓存管理」界面，证明重复进入页面不会重复执行检测。
 * 不持久化，应用重启后归零（缓存命中次数属于本次会话的行为）。
 */
export const cacheCounters: CacheCounters = {
  hardwareScans: 0,
  hardwareCacheHits: 0,
  envProbes: 0,
  encoderProbes: 0,
  envCacheHits: 0,
  cliInfoCalls: 0,
  cliCompositionCalls: 0,
  projectScans: 0,
  projectCacheHits: 0,
  assetFileStats: 0,
  dirListings: 0
}

export function resetCacheCounters(): void {
  for (const key of Object.keys(cacheCounters) as (keyof CacheCounters)[]) cacheCounters[key] = 0
}

export function snapshotCounters(): CacheCounters {
  return { ...cacheCounters }
}
