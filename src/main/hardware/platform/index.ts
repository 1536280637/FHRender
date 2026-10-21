import type { PlatformAdapter } from './types'
import { WindowsAdapter } from './windows'
import { DarwinAdapter } from './darwin'
import { LinuxAdapter } from './linux'

export * from './types'
export { WindowsAdapter, DarwinAdapter, LinuxAdapter }

/** 按运行平台选择适配器；业务层只依赖 PlatformAdapter 接口 */
export function createPlatformAdapter(platform: string = process.platform): PlatformAdapter {
  switch (platform) {
    case 'win32':
      return new WindowsAdapter()
    case 'darwin':
      return new DarwinAdapter()
    default:
      return new LinuxAdapter()
  }
}
