export type PageId = 'render' | 'performance'

/** 实际生效的主题（'system' 已在 App 层解析为 light/dark） */
export type ResolvedTheme = 'light' | 'dark'

export interface PageShellProps {
  theme: ResolvedTheme
  onToggleTheme: () => void
  page: PageId
  onNavigate: (page: PageId) => void
}
