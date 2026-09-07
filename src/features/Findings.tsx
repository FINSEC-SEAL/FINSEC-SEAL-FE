import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Finding, FindingDetail, Release } from '../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, ShortHash, formatDate } from '../components/Primitives'

const categories = [
  { value: '', label: '전체 공격 유형' },
  { value: 'FA-01', label: 'FA-01 · 악성 문서 지시' },
  { value: 'FA-02', label: 'FA-02 · 타 고객 데이터 조회' },
  { value: 'FA-03', label: 'FA-03 · 민감정보 과다 조회' },
  { value: 'FA-04', label: 'FA-04 · 외부 정보 유출' },
  { value: 'FA-05', label: 'FA-05 · 고위험 상태 변경' },
]

const categoryLabels = Object.fromEntries(categories.filter((item) => item.value).map((item) => [item.value, item.label]))

function FindingBadge({ value, kind }: { value: string; kind: 'severity' | 'status' | 'outcome' }) {
  const critical = ['CRITICAL', 'HIGH', 'ATTACK_SUCCESS', 'OPEN'].includes(value)
  const positive = ['ATTACK_BLOCKED', 'NORMAL_SUCCESS', 'TRIAGED', 'RESOLVED', 'CLOSED'].includes(value)
  return <span className={`status status--${critical ? 'critical' : positive ? 'positive' : kind === 'outcome' ? 'warning' : 'neutral'}`}>{value.replaceAll('_', ' ')}</span>
}

export function FindingsPage({ releases, actorId, preferredReleaseId, onReleaseChange }: { releases: Release[]; actorId: string; preferredReleaseId?: string; onReleaseChange?: (releaseId: string) => void }) {
  const [releaseId, setReleaseId] = useState(preferredReleaseId && releases.some((release) => release.id === preferredReleaseId) ? preferredReleaseId : releases[0]?.id ?? '')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [items, setItems] = useState<Finding[]>([])
  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const [comment, setComment] = useState('')

  useEffect(() => {
    if (preferredReleaseId && releases.some((release) => release.id === preferredReleaseId) && preferredReleaseId !== releaseId) setReleaseId(preferredReleaseId)
    else if (!releaseId && releases[0]) setReleaseId(releases[0].id)
  }, [preferredReleaseId, releaseId, releases])

  function chooseRelease(nextReleaseId: string) {
    setReleaseId(nextReleaseId); onReleaseChange?.(nextReleaseId)
  }

  async function loadFindings() {
    if (!releaseId) return
    setLoading(true); setError(undefined); setDetail(null)
    try { setItems(await api.findings(releaseId, actorId, { category: category || undefined, status: status || undefined })) }
    catch (cause) { setError(cause) }
    finally { setLoading(false) }
  }

  useEffect(() => { void loadFindings() }, [releaseId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function inspect(item: Finding) {
    setLoading(true); setError(undefined)
    try { setDetail(await api.finding(item.id, actorId)) }
    catch (cause) { setError(cause) }
    finally { setLoading(false) }
  }

  async function triage() {
    if (!detail || !comment.trim()) return
    setLoading(true); setError(undefined)
    try {
      const updated = await api.triageFinding(detail.finding.id, comment.trim(), actorId)
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item))
      setDetail((current) => current ? { ...current, finding: updated } : current)
      setComment('')
    } catch (cause) { setError(cause) }
    finally { setLoading(false) }
  }

  return <>
    <PageHeader eyebrow="DETERMINISTIC EVIDENCE" title="Findings" description="실제 API 응답과 Sandbox side effect로 입증된 보안 위반을 Oracle 증거와 함께 검토합니다." />
    {error ? <ErrorBanner error={error} onDismiss={() => setError(undefined)} /> : null}
    <section className="panel finding-filters">
      <label>검사할 Agent 버전<select aria-label="Finding Release" value={releaseId} onChange={(event) => chooseRelease(event.target.value)}><option value="">Release 선택</option>{releases.map((release) => <option key={release.id} value={release.id}>Release v{release.version} · {release.effectiveStatus}</option>)}</select></label>
      <label>공격 유형<select aria-label="Finding category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}</select></label>
      <label>Status<select aria-label="Finding status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">전체 status</option><option>OPEN</option><option>TRIAGED</option><option>RESOLVED</option><option>CLOSED</option></select></label>
      <button className="primary-button" disabled={!releaseId || loading} onClick={() => void loadFindings()}>조회</button>
    </section>
    {releaseId ? <section className="finding-summary" aria-label="Finding summary">
      <div><span>전체</span><strong>{items.length}</strong></div>
      <div><span>Open</span><strong>{items.filter((item) => item.status === 'OPEN').length}</strong></div>
      <div><span>High / Critical</span><strong>{items.filter((item) => ['HIGH', 'CRITICAL'].includes(item.severity)).length}</strong></div>
      <div><span>처리됨</span><strong>{items.filter((item) => ['TRIAGED', 'RESOLVED', 'CLOSED'].includes(item.status)).length}</strong></div>
    </section> : null}
    {loading && items.length === 0 ? <LoadingBlock label="Finding을 불러오는 중" /> : !releaseId ? <EmptyState title="Release를 선택하세요">평가할 Release가 먼저 필요합니다.</EmptyState> : items.length === 0 ? <EmptyState title="Finding이 없습니다">이 Release에서 입증된 공격 성공이 없거나 아직 Baseline 실행 전입니다.</EmptyState> :
      <div className="finding-layout">
        <section className="panel table-wrap"><div className="panel-heading"><div><p className="eyebrow">VIOLATIONS</p><h2>{items.length} findings</h2></div></div><table><thead><tr><th>Finding</th><th>Severity</th><th>Status</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={detail?.finding.id === item.id ? 'selected-row' : undefined} onClick={() => void inspect(item)}><td><strong>{categoryLabels[item.category] ?? item.category} · {item.title}</strong><small>{item.violatedInvariant} · {item.findingGroupKey ? 'grouped finding' : 'single finding'}</small></td><td><FindingBadge value={item.severity} kind="severity" /></td><td><FindingBadge value={item.status} kind="status" /></td><td>{formatDate(item.updatedAt)}</td></tr>)}</tbody></table></section>
        <section className="panel finding-detail">{detail ? <>
          <div className="panel-heading"><div><p className="eyebrow">ORACLE EVIDENCE</p><h2>{detail.finding.title}</h2></div><FindingBadge value={detail.oracleResult.outcome} kind="outcome" /></div>
          <dl className="detail-grid"><div><dt>Oracle</dt><dd>{detail.oracleResult.oracleType} v{detail.oracleResult.oracleVersion}</dd></div><div><dt>Reason</dt><dd>{detail.oracleResult.reasonCode}</dd></div><div><dt>Invariant</dt><dd>{detail.oracleResult.invariantId}</dd></div><div><dt>Source event</dt><dd><ShortHash value={detail.oracleResult.sourceEventId} /></dd></div><div><dt>Evidence digest</dt><dd><ShortHash value={detail.oracleResult.evidenceDigest} /></dd></div><div><dt>Evaluated</dt><dd>{formatDate(detail.oracleResult.evaluatedAt)}</dd></div></dl>
          <details open><summary>검증된 Evidence JSON</summary><pre>{JSON.stringify(detail.oracleResult.evidence, null, 2)}</pre></details>
          <details><summary>Root cause</summary><pre>{JSON.stringify(detail.finding.rootCause, null, 2)}</pre></details>
          {detail.relatedFindings.length ? <details><summary>연관 Finding {detail.relatedFindings.length}건</summary><ul className="related-findings">{detail.relatedFindings.map((item) => <li key={item.id}><span>{categoryLabels[item.category] ?? item.category} · {item.title}</span><FindingBadge value={item.status} kind="status" /></li>)}</ul></details> : null}
          {detail.finding.status === 'OPEN' ? <div className="triage-box"><label>Triage comment<textarea aria-label="Triage comment" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="검토 결과와 후속 조치를 기록하세요." /></label><button className="secondary-button" disabled={loading || !comment.trim()} onClick={() => void triage()}>TRIAGED로 전환</button></div> : null}
        </> : <EmptyState title="Finding을 선택하세요">목록을 선택하면 판정 근거와 redacted Evidence를 확인할 수 있습니다.</EmptyState>}</section>
      </div>}
  </>
}
