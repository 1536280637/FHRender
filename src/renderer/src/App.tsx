import { useCallback, useEffect, useState } from 'react'
import { Home } from './pages/Home'
import { Performance } from './pages/Performance'
import { ErrorBoundary } from './components/ErrorBoundary'
import type { PageId, ResolvedTheme } from './pages/types'
import { api } from './services/api'

export default function App(): JSX.Element {
  const [page, setPage] = useState<PageId>('render')
  const [theme, setTheme] = useState<ResolvedTheme>('light')

  useEffect(() => {
    let cancelled = false
    void api()
      .settings.get()
      .then((settings) => {
        if (cancelled) return
        const resolved =
          settings.theme === 'system'
            ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
            : settings.theme
        setTheme(resolved)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    // 同步原生窗口按钮（titleBarOverlay）的配色，避免深色栏配浅色图标
    void api().window.setTheme(theme)
  }, [theme])

  useEffect(() => {
    let cancelled = false
    void api()
      .window.getState()
      .then((state) => {
        if (cancelled) return
        document.documentElement.dataset.platform = state.platform
        document.documentElement.dataset.maximized = String(state.maximized)
      })
      .catch(() => undefined)
    const off = api().window.onState((state) => {
      document.documentElement.dataset.maximized = String(state.maximized)
      document.documentElement.dataset.fullscreen = String(state.fullscreen)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const toggleTheme = useCallback((): void => {
    setTheme((prev) => {
      const next: ResolvedTheme = prev === 'dark' ? 'light' : 'dark'
      void api().settings.update({ theme: next })
      return next
    })
  }, [])

  return (
    <div className="app">
      <ErrorBoundary resetKey={page}>
        {page === 'render' ? (
          <Home theme={theme} onToggleTheme={toggleTheme} page={page} onNavigate={setPage} />
        ) : (
          <Performance theme={theme} onToggleTheme={toggleTheme} page={page} onNavigate={setPage} />
        )}
      </ErrorBoundary>
    </div>
  )
}
