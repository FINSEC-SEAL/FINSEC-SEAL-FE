import { useState } from 'react'
import type { Attestation, Release } from '../api/contracts'
import { api } from '../api/client'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, StatusBadge, formatDate } from '../components/Primitives'

export function EvidencePage({ releases, actorId }: { releases: Release[]; actorId: string }) {
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? '')
  const [attestation, setAttestation] = useState<Attestation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  async function inspect() {
    if (!releaseId) return
    setBusy(true); setError(undefined); setAttestation(null)
    try { setAttestation(await api.attestation(releaseId, actorId)) }
    catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  async function download(format: 'json' | 'html') {
    if (!releaseId) return
    setBusy(true); setError(undefined)
    try { await api.downloadAttestation(releaseId, format, actorId) }
    catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="EVIDENCE PROJECTION" title="Attestation" description="확정된 ReleaseDecision의 immutable input snapshot을 재계산 없이 JSON·HTML 증적으로 projection합니다." />
    <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
    <section className="panel attestation-picker"><label>Release<select value={releaseId} onChange={(event) => { setReleaseId(event.target.value); setAttestation(null) }}>
      <option value="">선택하세요</option>{releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.businessPurpose} · {release.effectiveStatus}</option>)}</select></label>
      <button className="primary-button" disabled={!releaseId || busy} onClick={() => void inspect()}>{busy ? '검증 중…' : 'Attestation 검증'}</button>
    </section>
    {!attestation ? <EmptyState title="Attestation을 선택하세요">확정 Decision이 있는 Release만 증적을 생성할 수 있습니다. A는 Decision을 계산하지 않습니다.</EmptyState> :
      <section className="content-grid attestation-grid">
        <article className="panel attestation-summary"><div className="panel-heading"><div><p className="eyebrow">VERIFIED PROJECTION</p><h2>{attestation.stale ? 'Historical attestation' : 'Current attestation'}</h2></div><StatusBadge status={attestation.stale ? 'STALE' : 'PASS'} /></div>
          {attestation.stale ? <div className="stale-notice"><strong>STALE / NEEDS REVALIDATION</strong><p>기존 증적은 보존되지만 현재 Release의 상태를 인증하지 않습니다.</p></div> : null}
          <dl className="detail-grid"><div><dt>Document hash</dt><dd><ShortHash value={attestation.documentHash} /></dd></div><div><dt>Generated</dt><dd>{formatDate(attestation.generatedAt)}</dd></div>
            <div><dt>Decision</dt><dd>{String(attestation.document.decision && typeof attestation.document.decision === 'object' && !Array.isArray(attestation.document.decision) ? attestation.document.decision.value : '—')}</dd></div><div><dt>Disclaimer</dt><dd>{attestation.disclaimerVersion}</dd></div></dl>
          <div className="button-row"><button className="secondary-button" onClick={() => void download('json')}>JSON 내려받기</button><button className="primary-button" onClick={() => void download('html')}>HTML 내려받기</button></div>
        </article>
        <article className="panel document-preview"><div className="panel-heading"><div><p className="eyebrow">CANONICAL DOCUMENT</p><h2>Evidence snapshot</h2></div></div><pre>{JSON.stringify(attestation.document, null, 2)}</pre></article>
      </section>}
  </>
}

