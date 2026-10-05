import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const warning = kind === 'outcome' || (kind === 'status' && value === 'ACCEPTED_RISK')
  return <span className={`status status--${critical ? 'critical' : positive ? 'positive' : warning ? 'warning' : 'neutral'}`}>{value.replaceAll('_', ' ')}</span>
}

export function FindingsPage({ releases, actorId, preferredReleaseId, onReleaseChange }: { releases: Release[]; actorId: string; preferredReleaseId?: string; onReleaseChange?: (releaseId: string) => void }) {
  const [releaseId, setReleaseId] = useState(preferredReleaseId && releases.some((release) => release.id === preferredReleaseId) ? preferredReleaseId : releases[0]?.id ?? '')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const selectedReleaseId = preferredReleaseId && releases.some((release) => release.id === preferredReleaseId)
    ? preferredReleaseId
    : releases.some((release) => release.id === releaseId) ? releaseId : releases[0]?.id ?? ''

  useEffect(() => {
    if (releaseId !== selectedReleaseId) setReleaseId(selectedReleaseId)
  }, [releaseId, selectedReleaseId])

  function chooseRelease(nextReleaseId: string) {
    setReleaseId(nextReleaseId)
    onReleaseChange?.(nextReleaseId)
  }

  return <FindingReview key={JSON.stringify([actorId, selectedReleaseId])} releases={releases} actorId={actorId} releaseId={selectedReleaseId} category={category} status={status} setCategory={setCategory} setStatus={setStatus} chooseRelease={chooseRelease} />
}

function FindingReview({ releases, actorId, releaseId, category, status, setCategory, setStatus, chooseRelease }: {
  releases: Release[]; actorId: string; releaseId: string; category: string; status: string
  setCategory: (value: string) => void; setStatus: (value: string) => void; chooseRelease: (value: string) => void
}) {
  const [items, setItems] = useState<Finding[] | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<{ value: FindingDetail; generation: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const [comment, setComment] = useState('')
  const mounted = useRef(false)
  const requestGeneration = useRef(0)
  const busy = useRef(false)
  const currentItems = useRef<Finding[] | null>(null)
  const selectedFinding = useRef<{ id: string; generation: number } | null>(null)
  const currentComment = useRef('')
  const detail = selectedDetail?.value ?? null

  function beginRequest() {
    const generation = ++requestGeneration.current
    busy.current = true
    setLoading(true)
    setError(undefined)
    return { generation, isCurrent: () => mounted.current && requestGeneration.current === generation }
  }

  function finishRequest(request: { isCurrent: () => boolean }) {
    if (request.isCurrent()) {
      busy.current = false
      setLoading(false)
    }
  }

  function clearSelection() {
    selectedFinding.current = null
    currentComment.current = ''
    setSelectedDetail(null)
    setComment('')
  }

  async function loadFindings() {
    if (!mounted.current || !releaseId || busy.current) return
    const request = beginRequest()
    currentItems.current = null
    setItems(null)
    clearSelection()
    try {
      const next = await api.findings(releaseId, actorId, { category: category || undefined, status: status || undefined })
      if (!request.isCurrent()) return
      if (next.some((item) => item.releaseId !== releaseId)) throw new Error('선택한 Release와 Finding 목록이 일치하지 않습니다.')
      currentItems.current = next
      setItems(next)
    } catch (cause) {
      if (request.isCurrent()) setError(cause)
    } finally { finishRequest(request) }
  }

  useLayoutEffect(() => {
    mounted.current = true
    void loadFindings()
    return () => {
      mounted.current = false
      ++requestGeneration.current
      busy.current = false
      currentItems.current = null
      selectedFinding.current = null
      currentComment.current = ''
    }
  }, [actorId, releaseId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function inspect(item: Finding) {
    if (!mounted.current || item.releaseId !== releaseId || !currentItems.current?.some((current) => current.id === item.id)) return
    const request = beginRequest()
    clearSelection()
    selectedFinding.current = { id: item.id, generation: request.generation }
    try {
      const next = await api.finding(item.id, actorId)
      if (!request.isCurrent()) return
      if (next.finding.id !== item.id || next.finding.releaseId !== releaseId
        || next.oracleResult.id !== next.finding.sourceOracleResultId
        || next.relatedFindings.some((related) => related.releaseId !== releaseId)) {
        throw new Error('선택한 Finding과 판정 근거가 일치하지 않습니다.')
      }
      setSelectedDetail({ value: next, generation: request.generation })
    } catch (cause) {
      if (request.isCurrent()) setError(cause)
    } finally { finishRequest(request) }
  }

  function changeComment(value: string) {
    if (!mounted.current || busy.current || !selectedDetail || selectedDetail.generation !== selectedFinding.current?.generation) return
    currentComment.current = value
    setComment(value)
  }

  async function triage() {
    const selection = selectedFinding.current
    const submittedComment = currentComment.current.trim()
    if (!mounted.current || busy.current || !selectedDetail || !detail || detail.finding.status !== 'OPEN'
      || !selection || selection.id !== detail.finding.id || selection.generation !== selectedDetail.generation
      || detail.finding.releaseId !== releaseId || !submittedComment) return
    const request = beginRequest()
    try {
      const updated = await api.triageFinding(detail.finding.id, submittedComment, actorId)
      if (!request.isCurrent()) return
      if (updated.id !== detail.finding.id || updated.releaseId !== releaseId || updated.sourceOracleResultId !== detail.oracleResult.id) {
        throw new Error('검토 결과가 선택한 Finding과 일치하지 않습니다.')
      }
      const nextItems = currentItems.current?.map((item) => item.id === updated.id ? updated : item) ?? null
      currentItems.current = nextItems
      setItems(nextItems)
      setSelectedDetail({ value: { ...detail, finding: updated }, generation: selectedDetail.generation })
      currentComment.current = ''
      setComment('')
    } catch (cause) {
      if (request.isCurrent()) setError(cause)
    } finally { finishRequest(request) }
  }

  return <>
    <PageHeader eyebrow="DETERMINISTIC EVIDENCE" title="Findings" description="실제 API 응답과 Sandbox side effect로 입증된 보안 위반을 Oracle 증거와 함께 검토합니다." />
    {error ? <ErrorBanner error={error} onDismiss={() => setError(undefined)} /> : null}
    <section className="panel finding-filters">
      <label>검사할 Agent 버전<select aria-label="Finding Release" value={releaseId} onChange={(event) => chooseRelease(event.target.value)}><option value="">Release 선택</option>{releases.map((release) => <option key={release.id} value={release.id}>Release v{release.version} · {release.effectiveStatus}</option>)}</select></label>
      <label>공격 유형<select aria-label="Finding category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}</select></label>
      <label>Status<select aria-label="Finding status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">전체 status</option><option>OPEN</option><option>TRIAGED</option><option>ACCEPTED_RISK</option><option>RESOLVED</option><option>CLOSED</option></select></label>
      <button className="primary-button" disabled={!releaseId || loading} onClick={() => void loadFindings()}>조회</button>
    </section>
    {releaseId && items !== null ? <section className="finding-summary" aria-label="Finding summary">
      <div><span>전체</span><strong>{items.length}</strong></div>
      <div><span>Open</span><strong>{items.filter((item) => item.status === 'OPEN').length}</strong></div>
      <div><span>High / Critical</span><strong>{items.filter((item) => ['HIGH', 'CRITICAL'].includes(item.severity)).length}</strong></div>
      <div><span>처리됨</span><strong>{items.filter((item) => ['TRIAGED', 'RESOLVED', 'CLOSED'].includes(item.status)).length}</strong></div>
    </section> : null}
    {!releaseId ? <EmptyState title="Release를 선택하세요">평가할 Release가 먼저 필요합니다.</EmptyState> : items === null ? loading ? <LoadingBlock label="Finding을 불러오는 중" /> : <EmptyState title="Finding 조회 대기">조회를 눌러 현재 Release의 Finding을 확인하세요.</EmptyState> : items.length === 0 ? <EmptyState title="Finding이 없습니다">이 Release에서 입증된 공격 성공이 없거나 아직 Baseline 실행 전입니다.</EmptyState> :
      <div className="finding-layout">
        <section className="panel table-wrap"><div className="panel-heading"><div><p className="eyebrow">VIOLATIONS</p><h2>{items.length} findings</h2></div></div><table><thead><tr><th>Finding</th><th>Severity</th><th>Status</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={detail?.finding.id === item.id ? 'selected-row' : undefined} onClick={() => void inspect(item)}><td><strong>{categoryLabels[item.category] ?? item.category} · {item.title}</strong><small>{item.violatedInvariant} · {item.findingGroupKey ? 'grouped finding' : 'single finding'}</small></td><td><FindingBadge value={item.severity} kind="severity" /></td><td><FindingBadge value={item.status} kind="status" /></td><td>{formatDate(item.updatedAt)}</td></tr>)}</tbody></table></section>
        <section className="panel finding-detail">{detail ? <>
          <div className="panel-heading"><div><p className="eyebrow">ORACLE EVIDENCE</p><h2>{detail.finding.title}</h2></div><FindingBadge value={detail.oracleResult.outcome} kind="outcome" /></div>
          {detail.finding.status === 'ACCEPTED_RISK' ? <p role="note"><FindingBadge value={detail.finding.status} kind="status" /> · 위험 수용은 Finding 해결이나 Release PASS를 뜻하지 않습니다. BLOCKED 조건이 우선하며, 그 외에는 REVIEW 대상입니다.</p> : null}
          <dl className="detail-grid"><div><dt>Oracle</dt><dd>{detail.oracleResult.oracleType} v{detail.oracleResult.oracleVersion}</dd></div><div><dt>Reason</dt><dd>{detail.oracleResult.reasonCode}</dd></div><div><dt>Invariant</dt><dd>{detail.oracleResult.invariantId}</dd></div><div><dt>Source event</dt><dd><ShortHash value={detail.oracleResult.sourceEventId} /></dd></div><div><dt>Evidence digest</dt><dd><ShortHash value={detail.oracleResult.evidenceDigest} /></dd></div><div><dt>Evaluated</dt><dd>{formatDate(detail.oracleResult.evaluatedAt)}</dd></div></dl>
          <details open><summary>검증된 Evidence JSON</summary><pre>{JSON.stringify(detail.oracleResult.evidence, null, 2)}</pre></details>
          <details><summary>Root cause</summary><pre>{JSON.stringify(detail.finding.rootCause, null, 2)}</pre></details>
          {detail.relatedFindings.length ? <details><summary>연관 Finding {detail.relatedFindings.length}건</summary><ul className="related-findings">{detail.relatedFindings.map((item) => <li key={item.id}><span>{categoryLabels[item.category] ?? item.category} · {item.title}</span><FindingBadge value={item.status} kind="status" /></li>)}</ul></details> : null}
          {detail.finding.status === 'OPEN' ? <div className="triage-box"><label>Triage comment<textarea aria-label="Triage comment" rows={3} value={comment} disabled={loading} onChange={(event) => changeComment(event.target.value)} placeholder="검토 결과와 후속 조치를 기록하세요." /></label><button className="secondary-button" disabled={loading || !comment.trim()} onClick={() => void triage()}>TRIAGED로 전환</button></div> : null}
        </> : loading ? <LoadingBlock label="Finding 근거를 불러오는 중" /> : <EmptyState title="Finding을 선택하세요">목록을 선택하면 판정 근거와 redacted Evidence를 확인할 수 있습니다.</EmptyState>}</section>
      </div>}
  </>
}
