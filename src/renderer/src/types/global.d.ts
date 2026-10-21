import type { JSX as ReactJSX } from 'react'
import type { HfRenderApi } from '@shared/ipc'

declare global {
  interface Window {
    hf: HfRenderApi & {
      onMenuOpenProject(listener: () => void): () => void
    }
  }

  /** React 19 移除了全局 JSX 命名空间，这里补一个最小声明 */
  namespace JSX {
    type Element = ReactJSX.Element
  }
}

export {}
