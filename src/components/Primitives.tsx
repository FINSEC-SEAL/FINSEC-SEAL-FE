import type { ReactNode } from 'react'
import type { ReleaseLifecycle } from '../api/contracts'

export function StatusBadge({ status }: { status: ReleaseLifecycle | 'ACTIVE' | 'ARCHIVED' | 'STALE' | 'INVALID' }) {
  const tone = ['PASS', 'ACTIVE'].includes(status)
    ? 'positive'
    : ['BLOCKED', 'ARCHIVED', 'STALE', 'INVALID'].includes(status)
      ? 'critical'
      : ['REVIEW', 'NEEDS_REVALIDATION'].includes(status)
        ? 'warning'
        : 'neutral'
  return <span className={`status status--${tone}`}>{status.replaceAll('_', ' ')}</span>
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state__mark" aria-hidden="true">◇</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}

export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'
  return (
    <div className="error-banner" role="alert">
      <span aria-hidden="true">!</span>
      <div><strong>요청을 완료하지 못했습니다</strong><p>{message}</p></div>
      {onDismiss ? <button className="icon-button" onClick={onDismiss} aria-label="오류 닫기">×</button> : null}
    </div>
  )
}

export function LoadingBlock({ label = '데이터를 불러오는 중' }: { label?: string }) {
  return <div className="loading-block" role="status"><span className="spinner" />{label}</div>
}

export function ShortHash({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">N/A</span>
  return <code title={value}>{value.length > 24 ? `${value.slice(0, 17)}…${value.slice(-6)}` : value}</code>
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
