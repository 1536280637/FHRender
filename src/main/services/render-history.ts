/**
 * 历史渲染记录。
 *
 * 只保存"本次任务真正使用的配置"（RenderTaskConfigSnapshot）与结果摘要，
 * 供「渲染状态」面板里的历史列表查看；不保存帧、不保存日志文件本体。
 * 与 performance-reports.json 的区别：那是性能对比测试报告，这里是普通渲染任务。
 */

import type { RenderHistoryEntry } from '@shared/types/render'
import { JsonStore } from './store'

const MAX_ENTRIES = 20

interface RenderHistoryFile {
  entries: RenderHistoryEntry[]
}

export class RenderHistoryManager {
  private store = new JsonStore<RenderHistoryFile>('render-history.json', { entries: [] })

  async list(): Promise<RenderHistoryEntry[]> {
    const data = await this.store.read()
    return Array.isArray(data.entries) ? data.entries.slice(0, MAX_ENTRIES) : []
  }

  async save(entry: RenderHistoryEntry): Promise<void> {
    const data = await this.store.read()
    const others = (data.entries ?? []).filter((item) => item.taskId !== entry.taskId)
    await this.store.write({ entries: [entry, ...others].slice(0, MAX_ENTRIES) })
  }

  async clear(): Promise<void> {
    await this.store.write({ entries: [] })
  }
}
