import { useEffect, useRef, useState } from 'react'
import type { Release } from '../../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader } from '../../components/Primitives'
import { Badge, Notice, Panel } from '../../components/Product'
import type { GatewayRunOption } from './gatewayEvidence'
import { ReplayComparisonClient, type ReplayComparisonApi, type ReplayPolicyEvent, type ReplayPolicySide, type StoredReplayPolicyComparison } from './replayComparison'

const defaultClient = new ReplayComparisonClient()
const perPage = 50
const wrap = { minWidth: 0, overflowWrap: 'anywhere' as const }
const label = (value: string | null) => value === '' ? '빈 문자열' : value ?? '기록 없음 또는 판독 불가'
type LoadState<T> = { client: ReplayComparisonApi; revision: number; value: T | null; failed: boolean }

export function StoredReplayPolicyPage({ releases, actorId, preferredReleaseId, onReleaseChange, client = defaultClient }: {
  releases: Release[]; actorId: string; preferredReleaseId?: string; onReleaseChange?: (id: string) => void; client?: ReplayComparisonApi
}) {
  const [selection, setSelection] = useState({ preferred: preferredReleaseId, id: preferredReleaseId ?? '' })
  const requested = selection.preferred === preferredReleaseId ? selection.id : preferredReleaseId ?? ''
  const releaseId = releases.some(release => release.id === requested) ? requested : ''
  useEffect(() => {
    setSelection(current => current.preferred === preferredReleaseId && current.id === releaseId
      ? current : { preferred: preferredReleaseId, id: releaseId })
  }, [preferredReleaseId, releaseId])

  return <div className="stack" style={wrap}>
    <PageHeader eyebrow="STORED REPLAY POLICY" title="저장된 Replay 정책 비교" description="저장된 비교 쌍의 정책 판단과 사유를 확인합니다." />
    <Notice title="저장 기록의 관찰 범위">
      비교 가능 여부는 서버에 저장된 비교 판정입니다. 이 화면에서 통제 조건을 다시 평가하지 않습니다.
      ALLOW·DENY·ERROR 기록만으로 실제 호출·전달·상태 변화나 공격 차단 여부를 확정할 수 없습니다.
    </Notice>
    <section className="panel"><label>Replay Release<select aria-label="Replay Release" value={releaseId} style={{ maxWidth: '100%' }} onChange={event => {
      const id = event.target.value
      setSelection({ preferred: preferredReleaseId, id }); onReleaseChange?.(id)
    }}><option value="">Release 선택</option>{releases.map(release => <option key={release.id} value={release.id}>Release v{release.version} · {release.id}</option>)}</select></label></section>
    {!releaseId ? <EmptyState title="Release를 선택하세요">저장된 비교를 조회할 실제 릴리스를 선택하세요.</EmptyState>
      : <ReleaseSession key={JSON.stringify([releaseId, actorId])} releaseId={releaseId} actorId={actorId} client={client} />}
  </div>
}

function ReleaseSession({ releaseId, actorId, client }: { releaseId: string; actorId: string; client: ReplayComparisonApi }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<LoadState<readonly GatewayRunOption[]> | null>(null)
  const [selection, setSelection] = useState<{ id: string; client: ReplayComparisonApi } | null>(null)
  const generation = useRef(0)
  // Scope checks hide stale data during render, before effect cleanup starts a new request.
  const current = state?.client === client && state.revision === revision ? state : null
  const runs = current?.value ?? null
  const runId = selection?.client === client && runs?.some(run => run.id === selection.id) ? selection.id : ''
  useEffect(() => {
    const request = ++generation.current, controller = new AbortController()
    setState(null); setSelection(null)
    void (async () => {
      try {
        const value = await client.listRuns(releaseId, actorId, controller.signal)
        if (generation.current === request) setState({ client, revision, value, failed: false })
      } catch {
        if (generation.current === request) setState({ client, revision, value: null, failed: true })
      }
    })()
    return () => { ++generation.current; controller.abort() }
  }, [releaseId, actorId, client, revision])
  return <>
    <Panel title="저장된 Replay Run 선택" action={<button className="secondary-button" onClick={() => setRevision(value => value + 1)}>Replay Run 목록 새로고침</button>}>
      {!current ? <LoadingBlock label="Replay Run 목록을 불러오는 중" />
        : current.failed ? <ErrorBanner error={new Error('Replay Run 목록을 조회하지 못했습니다. 새로고침해 주세요.')} />
          : !runs?.length ? <EmptyState title="저장된 Replay Run이 없습니다">이 릴리스에서 조회할 SEAL_REPLAY 기록이 없습니다.</EmptyState>
            : <label>Replay Run<select aria-label="Replay Run" value={runId} style={{ maxWidth: '100%' }} onChange={event => setSelection({ id: event.target.value, client })}>
              <option value="">Replay Run 선택</option>{runs.map(run => <option key={run.id} value={run.id}>{run.mode} · {run.status} · {run.id}</option>)}
            </select></label>}
    </Panel>
    {runId ? <ComparisonPanel key={runId} releaseId={releaseId} runId={runId} client={client} />
      : runs?.length ? <EmptyState title="Replay Run을 선택하세요">비교 기록이 준비된 실행을 선택하세요. 선택 전에는 비교를 조회하지 않습니다.</EmptyState> : null}
  </>
}

function ComparisonPanel({ releaseId, runId, client }: { releaseId: string; runId: string; client: ReplayComparisonApi }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<LoadState<StoredReplayPolicyComparison> | null>(null)
  const generation = useRef(0)
  const current = state?.client === client && state.revision === revision ? state : null
  useEffect(() => {
    const request = ++generation.current, controller = new AbortController()
    setState(null)
    void (async () => {
      try {
        const value = await client.comparison(releaseId, runId, controller.signal)
        if (generation.current === request) setState({ client, revision, value, failed: false })
      } catch {
        if (generation.current === request) setState({ client, revision, value: null, failed: true })
      }
    })()
    return () => { ++generation.current; controller.abort() }
  }, [releaseId, runId, client, revision])
  return <Panel title="저장된 비교 판정" action={<button className="secondary-button" onClick={() => setRevision(value => value + 1)}>비교 기록 새로고침</button>}>
    {!current ? <LoadingBlock label="저장된 비교 기록을 불러오는 중" />
      : current.failed ? <ErrorBanner error={new Error('저장된 비교를 조회하지 못했습니다. 비교 기록의 준비 여부와 연결 상태를 확인한 뒤 다시 조회해 주세요.')} />
        : current.value ? <ComparisonRecords key={revision} record={current.value} /> : null}
  </Panel>
}

function ComparisonRecords({ record }: { record: StoredReplayPolicyComparison }) {
  return <div className="stack" style={wrap}>
    <div><Badge tone={record.comparable ? 'blue' : 'amber'}>{record.comparable ? '서버 기록: 비교 가능' : '서버 기록: 비교 불가'}</Badge></div>
    {!!record.mismatchReasons.length && <section aria-label="저장된 비교 불일치 사유"><h3>저장된 불일치 사유</h3><ul>{record.mismatchReasons.map((reason, index) => <li key={index}><code>{label(reason)}</code></li>)}</ul></section>}
    <details><summary>비교 쌍 출처</summary><dl>
      <dt>Release ID</dt><dd><code>{record.releaseId}</code></dd>
      <dt>Replay Run ID</dt><dd><code>{record.replayRunId}</code></dd>
      <dt>Replay Link ID</dt><dd><code>{record.replayLinkId}</code></dd>
      <dt>Finding ID</dt><dd><code>{record.findingId}</code></dd>
    </dl></details>
    <p className="muted">각 측의 정책 기록을 서버 응답 순서로 표시합니다. 표시 번호는 이벤트 순번이나 양측의 일대일 대응을 뜻하지 않습니다. digest는 저장된 출처 식별값입니다.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 20, minWidth: 0 }}>
      <PolicySide title="Baseline" side={record.baseline} />
      <PolicySide title="Replay" side={record.replay} />
    </div>
  </div>
}

function PolicySide({ title, side }: { title: string; side: ReplayPolicySide }) {
  const [page, setPage] = useState(0)
  const count = side.policyDecisions.length, pageCount = Math.max(1, Math.ceil(count / perPage))
  const currentPage = Math.min(page, pageCount - 1), first = currentPage * perPage
  const visible = side.policyDecisions.slice(first, first + perPage)
  return <section aria-label={`${title} 정책 기록`} style={wrap}>
    <h3>{title} 정책 기록</h3>
    <dl><dt>Run ID</dt><dd><code>{side.runId}</code></dd><dt>CaseRun ID</dt><dd><code>{side.caseRunId}</code></dd>
      <dt>저장 모드</dt><dd>{side.mode}</dd><dt>Run / Case 상태</dt><dd>{side.runStatus} / {side.caseStatus}</dd></dl>
    {!count ? <EmptyState title="정책 판단 기록이 없습니다">기록 부재만으로 정책 판단이나 실제 집행 결과를 추정할 수 없습니다.</EmptyState> : <>
      <p role="status">{title} 정책 판단 {count}건 · {first + 1}–{first + visible.length}건 표시</p>
      {pageCount > 1 && <nav aria-label={`${title} 정책 페이지`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="secondary-button" disabled={currentPage === 0} onClick={() => setPage(value => value - 1)}>이전 {title} 정책 페이지</button>
        <span>페이지 {currentPage + 1}/{pageCount}</span>
        <button className="secondary-button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(value => value + 1)}>다음 {title} 정책 페이지</button>
      </nav>}
      <div className="event-list" style={wrap}>{visible.map((event, index) => <PolicyEvent key={event.eventId} event={event} position={first + index + 1} />)}</div>
    </>}
  </section>
}

function PolicyEvent({ event, position }: { event: ReplayPolicyEvent; position: number }) {
  const decision = event.decision === 'UNKNOWN' ? 'UNKNOWN · 판독 불가' : event.decision === 'ERROR' ? 'ERROR · 운영 오류' : `기록된 ${event.decision}`
  return <details style={wrap}>
    <summary style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <strong>표시 {position} · {event.toolName === '' ? 'Tool 이름 빈 문자열' : event.toolName ?? 'Tool 기록 없음'}</strong>
      <Badge tone={event.decision === 'ERROR' || event.decision === 'UNKNOWN' ? 'amber' : 'muted'}>{decision}</Badge>
      <time dateTime={event.occurredAt}>{event.occurredAt}</time>
    </summary>
    <dl><dt>판단 기록 방식</dt><dd>{event.decisionEncoding === 'explicit' ? '명시적 decisionType + allowed' : event.decisionEncoding === 'legacy' ? '이전 형식: allowed 값' : '판단 형식 없음 또는 충돌'}</dd>
      <dt>저장된 평가 방식</dt><dd>{label(event.evaluationMode)}</dd>
      <dt>이벤트 reasonCode</dt><dd><code>{label(event.eventReasonCode)}</code></dd>
      <dt>policyDecision.reasonCode</dt><dd><code>{label(event.policyReasonCode)}</code></dd>
      <dt>Event ID</dt><dd><code>{event.eventId}</code></dd><dt>Payload digest</dt><dd><code>{event.payloadDigest}</code></dd>
    </dl>
    {event.eventReasonCode !== null && event.policyReasonCode !== null && event.eventReasonCode !== event.policyReasonCode
      && <p className="muted">사유가 서로 다르게 기록되어 있습니다. 각 위치의 값을 그대로 표시합니다.</p>}
  </details>
}
