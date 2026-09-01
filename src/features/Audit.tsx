import { useState, type FormEvent } from 'react'
import type { AuditRecord } from '../api/contracts'
import { api } from '../api/client'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, formatDate } from '../components/Primitives'

export function AuditPage({ actorId }: { actorId: string }) {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(undefined)
    const data = new FormData(event.currentTarget)
    try {
      setRecords(await api.audit(String(data.get('resourceType')), String(data.get('resourceId')), actorId))
      setSearched(true)
    } catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="PROVENANCE" title="Audit records" description="Resource scope가 DB에서 검증된 append-only audit를 조회합니다." />
    <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
    <form className="panel audit-search" onSubmit={search}><label>Resource type<select name="resourceType" defaultValue="AGENT_RELEASE"><option>AGENT</option><option>AGENT_RELEASE</option><option>TEST_RUN</option><option>RELEASE_ATTESTATION</option><option>IDEMPOTENCY_RECOVERY</option></select></label>
      <label>Resource UUID<input name="resourceId" required placeholder="00000000-0000-0000-0000-000000000000" /></label><button className="primary-button" disabled={busy}>{busy ? '조회 중…' : 'Audit 조회'}</button></form>
    {searched && records.length === 0 ? <EmptyState title="Audit record가 없습니다">Resource type과 UUID를 다시 확인하세요.</EmptyState> : null}
    <div className="timeline">{records.map((record) => <article className="timeline-item" key={record.id}><div className="timeline-dot" /><div className="panel"><div className="panel-heading"><div><p className="eyebrow">{record.resourceType}</p><h2>{record.action}</h2></div><time>{formatDate(record.occurredAt)}</time></div>
      <dl className="detail-grid"><div><dt>Actor</dt><dd>{record.actorId}</dd></div><div><dt>Record</dt><dd><ShortHash value={record.id} /></dd></div><div><dt>Before</dt><dd><ShortHash value={record.beforeDigest} /></dd></div><div><dt>After</dt><dd><ShortHash value={record.afterDigest} /></dd></div></dl>
      <details><summary>Metadata</summary><pre>{JSON.stringify(record.metadata, null, 2)}</pre></details></div></article>)}</div>
  </>
}

