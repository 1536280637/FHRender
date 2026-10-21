import type { ReactNode, JSX } from 'react'

/* ------------------------------- 基础块 ------------------------------- */

export function Panel(props: {
  title?: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  flush?: boolean
}): JSX.Element {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <header className="panel-head">
          <div className="panel-head-text">
            <h2>{props.title}</h2>
            {props.subtitle && <p>{props.subtitle}</p>}
          </div>
          {props.actions && <div className="panel-head-actions">{props.actions}</div>}
        </header>
      )}
      <div className={props.flush ? 'panel-body flush' : 'panel-body'}>{props.children}</div>
    </section>
  )
}

export function Field(props: {
  label: string
  hint?: ReactNode
  children: ReactNode
  inline?: boolean
  error?: string
}): JSX.Element {
  return (
    <div className={`field ${props.inline ? 'field-inline' : ''} ${props.error ? 'has-error' : ''}`}>
      <div className="field-label">
        <span>{props.label}</span>
      </div>
      <div className="field-control">
        {props.children}
        {props.error ? <p className="field-hint error">{props.error}</p> : props.hint ? (
          <p className="field-hint">{props.hint}</p>
        ) : null}
      </div>
    </div>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
}): JSX.Element {
  return (
    <div className={`segmented ${props.size === 'sm' ? 'segmented-sm' : ''}`} role="group">
      {props.options.map((opt) => (
        <button
          type="button"
          key={opt.value}
          title={opt.title}
          disabled={opt.disabled}
          className={opt.value === props.value ? 'active' : ''}
          onClick={() => props.onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <label className={`toggle-row ${props.disabled ? 'disabled' : ''}`}>
      <span className="toggle-text">
        <span className="toggle-label">{props.label}</span>
        {props.description && <span className="toggle-desc">{props.description}</span>}
      </span>
      <input
        type="checkbox"
        className="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  )
}

export function Badge(props: {
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'info'
  children: ReactNode
  title?: string
}): JSX.Element {
  return (
    <span className={`badge badge-${props.tone ?? 'neutral'}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Dot(props: { tone: 'ok' | 'warn' | 'error' | 'unknown' }): JSX.Element {
  return <span className={`dot dot-${props.tone}`} />
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}): JSX.Element {
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${props.variant ?? 'ghost'} ${props.size === 'sm' ? 'btn-sm' : ''}`}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function IconButton(props: {
  children: ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn ${props.className ?? ''}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function Empty(props: { text: string; hint?: string }): JSX.Element {
  return (
    <div className="empty">
      <p>{props.text}</p>
      {props.hint && <span>{props.hint}</span>}
    </div>
  )
}

export function Spinner(): JSX.Element {
  return <span className="spinner" aria-hidden />
}

/* -------------------------------- 图标 -------------------------------- */

export const Icon = {
  Folder: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M1.8 3.6h4l1.4 1.6h7v7.2H1.8z" strokeLinejoin="round" />
    </svg>
  ),
  Play: () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <path d="M4.4 2.8l8 5.2-8 5.2z" />
    </svg>
  ),
  Stop: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
      <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1" />
    </svg>
  ),
  Copy: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="5.6" y="5.6" width="8" height="8" rx="1.4" />
      <path d="M10.4 3.2H3.4a1 1 0 00-1 1v7" />
    </svg>
  ),
  Trash: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2.8 4.4h10.4M6.4 2.6h3.2M4.2 4.4l.6 9h6.4l.6-9" strokeLinecap="round" />
    </svg>
  ),
  Refresh: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M13 8a5 5 0 11-1.6-3.7M13 2.4V5h-2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Sun: () => (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" strokeLinecap="round" />
    </svg>
  ),
  Moon: () => (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M13.4 9.6A5.6 5.6 0 016.4 2.6a5.8 5.8 0 107 7z" strokeLinejoin="round" />
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3.2 8.4l3.2 3.2 6.4-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  ),
  Chevron: () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3.6L10.4 8 6 12.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  File: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M3.4 1.8h6l3.2 3.2v9.2h-9.2z" strokeLinejoin="round" />
      <path d="M9.2 1.8V5h3.2" />
    </svg>
  ),
  Terminal: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" />
      <path d="M4.2 6l2 2-2 2M8.4 10.4h3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Eye: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.6 8S3.9 3.9 8 3.9 14.4 8 14.4 8 12.1 12.1 8 12.1 1.6 8 1.6 8z" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  ),
  External: () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M9 2.6h4.4V7M13.4 2.6L7.6 8.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9.6v3.2a.6.6 0 01-.6.6H3.2a.6.6 0 01-.6-.6V4.6a.6.6 0 01.6-.6h3.2" strokeLinecap="round" />
    </svg>
  ),
  Server: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2.6" width="12" height="4.4" rx="1.1" />
      <rect x="2" y="9" width="12" height="4.4" rx="1.1" />
      <path d="M4.6 4.8h.01M4.6 11.2h.01" strokeLinecap="round" />
    </svg>
  )
}
