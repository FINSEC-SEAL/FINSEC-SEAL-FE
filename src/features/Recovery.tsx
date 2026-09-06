import { useState, type FormEvent } from 'react'
import type { PendingRecovery, RecoveryRequest } from '../api/contracts'
import { api, type PlatformClient } from '../api/client'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, formatDate } from '../components/Primitives'

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

export function RecoveryPage({ actorId, onActorChange, client = api, simulated = false }: { actorId: string; onActorChange: (actor: string) => void; client?: PlatformClient; simulated?: boolean }) {
  const [operatorKey, setOperatorKey] = useState('')
  const [pending, setPending] = useState<PendingRecovery[]>([])
  const [selected, setSelected] = useState<PendingRecovery | null>(null)
  const [resolution, setResolution] = useState<'RELEASE' | 'COMPLETE'>('RELEASE')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<unknown>()

  async function load(preserveMessage = false) {
    setBusy(true); setError(undefined)
    if (!preserveMessage) setMessage('')
    try { setPending(await client.pendingRecoveries(operatorKey, actorId)); setLoaded(true) }
    catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const data = new FormData(event.currentTarget)
    if (data.get('confirmation') !== resolution) {
      setError(new Error(`확인란에 ${resolution}를 정확히 입력하세요.`)); return
    }
    const request: RecoveryRequest = {
      actorId: selected.actorId,
      httpMethod: selected.httpMethod,
      requestPath: selected.requestPath,
      idempotencyKey: selected.idempotencyKey,
      requestDigest: selected.requestDigest,
      resolution,
      verificationReference: String(data.get('verificationReference') ?? ''),
    }
    if (resolution === 'COMPLETE') {
      request.completedResponse = {
        status: Number(data.get('status')),
        contentType: String(data.get('contentType') ?? ''),
        location: String(data.get('location') ?? ''),
        traceId: String(data.get('traceId') ?? ''),
        bodyBase64: utf8Base64(String(data.get('responseBody') ?? '')),
      }
    }
    setBusy(true); setError(undefined); setMessage('')
    try {
      const result = await client.recover(request, operatorKey, actorId)
      setMessage(`${result.stateAfterRecovery}: recovery ${result.id.slice(0, 8)}가 audit에 기록됐습니다.`)
      setSelected(null); await load(true)
    } catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="FAIL-CLOSED OPERATIONS" title="운영 복구 대기열" description="실행 여부가 불명확한 요청은 증거 확인 전까지 재실행하지 않습니다. 운영자만 복구 결과를 기록할 수 있습니다." />
    <section className="recovery-notices" aria-label="운영 복구 안내">
      {simulated ? <div className="notice notice--blue"><strong>복구 폼 체험 · 서버로 전송하지 않습니다.</strong><p>실제 운영 키를 입력하지 마세요. 아래 버튼은 이 브라우저의 합성 대기열만 변경합니다.</p><button className="secondary-button" onClick={() => { setOperatorKey('demo-only-not-a-real-recovery-key'); onActorChange('operator:demo') }}>샘플 운영자 설정</button></div> : null}
      <div className="critical-notice"><strong>자동 복구 금지</strong><p>TTL이 지났다는 이유만으로 재실행하지 마세요. DB·업무 결과·사고 티켓을 교차 확인해야 합니다.</p></div>
    </section>
    <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
    {message ? <div className="success-banner" role="status">{message}</div> : null}
    <section className="panel credential-panel"><label>Operator actor<input value={actorId} onChange={(event) => onActorChange(event.target.value)} placeholder="operator:platform" /></label>
      <label>Recovery key<input type="password" autoComplete="off" value={operatorKey} onChange={(event) => setOperatorKey(event.target.value)} placeholder="저장되지 않습니다" /></label>
      <button className="primary-button" disabled={busy || operatorKey.length < 32 || !actorId.startsWith('operator:')} onClick={() => void load()}>{busy ? '조회 중…' : 'Recovery queue 조회'}</button></section>
    {loaded && pending.length === 0 ? <EmptyState title="대기 중인 recovery가 없습니다">RECOVERY_REQUIRED 상태만 이 목록에 표시됩니다.</EmptyState> : null}
    <div className="recovery-list">{pending.map((item) => <article className="panel recovery-item" key={item.idempotencyRecordId}>
      <div><p className="eyebrow">{item.recoveryReason}</p><h2>{item.httpMethod} {item.requestPath}</h2><p><code>{item.idempotencyKey}</code></p></div>
      <dl><div><dt>Original actor</dt><dd>{item.actorId}</dd></div><div><dt>Finished</dt><dd>{formatDate(item.executionFinishedAt)}</dd></div><div><dt>Request digest</dt><dd><ShortHash value={item.requestDigest} /></dd></div></dl>
      <button className="secondary-button" onClick={() => setSelected(item)}>검증 결과 등록</button></article>)}</div>
    {selected ? <form className="panel recovery-form" onSubmit={recover}><div className="panel-heading"><div><p className="eyebrow">AUDITED OPERATOR ACTION</p><h2>{selected.httpMethod} {selected.requestPath}</h2></div><button type="button" className="icon-button" aria-label="복구 폼 닫기" onClick={() => setSelected(null)}>×</button></div>
      <div className="segmented"><button type="button" className={resolution === 'RELEASE' ? 'active' : ''} onClick={() => setResolution('RELEASE')}>RELEASE · 미실행 확인</button><button type="button" className={resolution === 'COMPLETE' ? 'active' : ''} onClick={() => setResolution('COMPLETE')}>COMPLETE · 실행 확인</button></div>
      <label>검증 참조<input name="verificationReference" required pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{7,299}" placeholder="ops:incident/FINSEC-2026-0001" /></label>
      {resolution === 'COMPLETE' ? <div className="form-grid"><label>HTTP status<input name="status" type="number" min="200" max="499" required defaultValue="200" /></label><label>Content type<input name="contentType" placeholder="application/json" /></label><label>Location<input name="location" placeholder="/api/v1/resources/id" /></label><label>Original trace ID<input name="traceId" required placeholder="UUID" /></label><label className="span-2">Original response body<textarea name="responseBody" rows={5} required /></label></div> : null}
      <label className="confirmation-label">확인을 위해 <strong>{resolution}</strong> 입력<input name="confirmation" required autoComplete="off" /></label>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setSelected(null)}>취소</button><button className="danger-button" disabled={busy}>{busy ? '처리 중…' : `${resolution} 기록`}</button></div>
    </form> : null}
  </>
}
