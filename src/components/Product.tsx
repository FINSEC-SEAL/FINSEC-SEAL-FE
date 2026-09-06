import { useEffect, useId, useRef, type ReactNode } from 'react'

export type Tone = 'purple' | 'blue' | 'green' | 'amber' | 'red' | 'muted'
export function Badge({ children, tone = 'purple' }: { children: ReactNode; tone?: Tone }) { return <span className={`badge badge--${tone}`}>{children}</span> }
export function Panel({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{description && <p className="panel-description">{description}</p>}</div>{action}</div>{children}</section>
}
export function Notice({ title, children, tone = 'blue' }: { title: string; children: ReactNode; tone?: Tone }) { return <div className={`notice notice--${tone}`}><strong>{title}</strong><div>{children}</div></div> }
export function Stat({ label, value, detail, tone = 'purple' }: { label: string; value: ReactNode; detail: string; tone?: Tone }) { return <article className={`metric-card tone-${tone}`}><p>{label}</p><strong>{value}</strong><span>{detail}</span></article> }
export function Progress({ label, value, total, tone = 'purple' }: { label: string; value: number; total: number; tone?: Tone }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0
  return <div className={`progress tone-${tone}`}><div><span>{label}</span><strong>{total > 0 ? `${value} / ${total}` : 'N/A'}</strong></div><div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={value} aria-valuetext={total > 0 ? `${total}개 중 ${value}개` : '미측정'}><i style={{ width: `${percent}%` }} /></div></div>
}
export function DataTable({ caption, headings, rows }: { caption: string; headings: string[]; rows: ReactNode[][] }) { return <div className="table-wrap"><table><caption className="sr-only">{caption}</caption><thead><tr>{headings.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div> }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const label = useId()
  useEffect(() => {
    const node = dialog.current
    const previous = document.activeElement as HTMLElement | null
    // Native dialog supplies focus containment and Escape semantics in browsers.
    node?.showModal?.()
    return () => { node?.close?.(); previous?.focus() }
  }, [])
  return <dialog ref={dialog} className="modal" aria-labelledby={label} aria-modal="true" open={typeof HTMLDialogElement.prototype.showModal !== 'function'} onCancel={e => { e.preventDefault(); closeRef.current() }}><div className="panel-heading"><h2 id={label}>{title}</h2><button className="icon-button" aria-label="확인창 닫기" onClick={onClose}>×</button></div>{children}</dialog>
}

export function Brand() { return <div className="brand-lockup" aria-label="FINAgent SEAL"><img src="/assets/brand-reference.png" alt="FINAgent SEAL" width="1103" height="478" /></div> }
