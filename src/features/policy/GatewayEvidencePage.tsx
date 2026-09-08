import { useEffect, useRef, useState } from 'react'
import type { Release } from '../../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader } from '../../components/Primitives'
import { Badge, DataTable, Notice, Panel } from '../../components/Product'
import { GatewayEvidenceClient, gatewayStages, type CallEventRef, type GatewayCallDetails, type GatewayEvidenceApi, type GatewayPolicyEvent, type GatewayRunEvidence, type GatewayRunOption } from './gatewayEvidence'

const defaultClient = new GatewayEvidenceClient()
const missingReason = '없음 또는 문자열이 아님'
const recordsPerPage = 50
function toolLabel(value: string | null) { return value === '' ? 'Tool 이름 빈 문자열' : value ?? 'Tool 기록 없음' }
function reasonLabel(value: string | null) { return value === '' ? '빈 문자열' : value ?? missingReason }

type LoadState<T> = {
  client: GatewayEvidenceApi
  revision: number
  value: T | null
  failed: boolean
}

export function GatewayEvidencePage({ releases, actorId, preferredReleaseId, onReleaseChange, client = defaultClient }: {
  releases: Release[]
  actorId: string
  preferredReleaseId?: string
  onReleaseChange?: (id: string) => void
  client?: GatewayEvidenceApi
}) {
  const [selection, setSelection] = useState({ preferred: preferredReleaseId, id: preferredReleaseId ?? '' })
  const requestedId = selection.preferred === preferredReleaseId ? selection.id : preferredReleaseId ?? ''
  const releaseId = releases.some(release => release.id === requestedId) ? requestedId : ''

  // Derive the visible scope before effects run, so removed or externally changed selections hide old data.
  useEffect(() => {
    setSelection(current => current.preferred === preferredReleaseId && current.id === releaseId
      ? current : { preferred: preferredReleaseId, id: releaseId })
  }, [preferredReleaseId, releaseId])

  return <div className="stack" style={{ minWidth: 0 }}>
    <PageHeader eyebrow="GATEWAY EVIDENCE" title="Gateway 정책 판단 이력" description="저장된 정책 판단과 사유를 Run별로 조회합니다." />
    <Notice title="저장 기록의 관찰 범위">
      ALLOW·DENY·ERROR는 기록된 판단의 표시입니다. 실제 API 호출, 응답 전달, 공격 차단 여부는 이 화면에서 확정하지 않습니다.
      Run 모드는 저장값이며 정책 집행 방식이나 Replay 비교 성립을 뜻하지 않습니다.
    </Notice>
    <section className="panel">
      <label>Gateway Release<select aria-label="Gateway Release" value={releaseId} onChange={event => {
        const id = event.target.value
        setSelection({ preferred: preferredReleaseId, id })
        onReleaseChange?.(id)
      }}><option value="">Release 선택</option>{releases.map(release => <option key={release.id} value={release.id}>Release v{release.version} · {release.id}</option>)}</select></label>
    </section>
    {!releaseId ? <EmptyState title="Release를 선택하세요">조회할 실제 릴리스가 필요합니다.</EmptyState>
      : <GatewayReleaseSession key={JSON.stringify([releaseId, actorId])} releaseId={releaseId} actorId={actorId} client={client} />}
  </div>
}

function GatewayReleaseSession({ releaseId, actorId, client }: { releaseId: string; actorId: string; client: GatewayEvidenceApi }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<LoadState<readonly GatewayRunOption[]> | null>(null)
  const [selection, setSelection] = useState<{ id: string; client: GatewayEvidenceApi } | null>(null)
  const generation = useRef(0)
  const current = state?.client === client && state.revision === revision ? state : null
  const runs = current?.value ?? null
  const runId = selection?.client === client && runs?.some(run => run.id === selection.id) ? selection.id : ''

  useEffect(() => {
    const request = ++generation.current
    const controller = new AbortController()
    setState(null)
    setSelection(null)
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
    <Panel title="저장 Run 선택" action={<button className="secondary-button" onClick={() => setRevision(value => value + 1)}>Run 목록 새로고침</button>}>
      {!current ? <LoadingBlock label="Run 목록을 불러오는 중" />
        : current.failed ? <ErrorBanner error={new Error('Run 목록을 조회하지 못했습니다. 새로고침하여 다시 확인해 주세요.')} />
          : !runs?.length ? <EmptyState title="저장된 Run이 없습니다">이 릴리스의 실행 기록이 아직 없습니다.</EmptyState>
            : <label>Gateway Run<select aria-label="Gateway Run" value={runId} onChange={event => setSelection({ id: event.target.value, client })}>
              <option value="">Run 선택</option>{runs.map(run => <option key={run.id} value={run.id}>{run.mode} · {run.status} · {run.id}</option>)}
            </select></label>}
    </Panel>
    {runId ? <GatewayRunPanel key={runId} releaseId={releaseId} runId={runId} actorId={actorId} client={client} />
      : runs?.length ? <EmptyState title="Run을 선택하세요">저장된 정책 판단 이력을 조회할 실행을 선택하세요.</EmptyState> : null}
  </>
}

function GatewayRunPanel({ releaseId, runId, actorId, client }: { releaseId: string; runId: string; actorId: string; client: GatewayEvidenceApi }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<LoadState<GatewayRunEvidence> | null>(null)
  const generation = useRef(0)
  const current = state?.client === client && state.revision === revision ? state : null

  useEffect(() => {
    const request = ++generation.current
    const controller = new AbortController()
    setState(null)
    void (async () => {
      try {
        const value = await client.loadRun(releaseId, runId, actorId, controller.signal)
        if (generation.current === request) setState({ client, revision, value, failed: false })
      } catch {
        if (generation.current === request) setState({ client, revision, value: null, failed: true })
      }
    })()
    return () => { ++generation.current; controller.abort() }
  }, [releaseId, runId, actorId, client, revision])

  return <Panel title="정책 판단 기록" action={<button className="secondary-button" onClick={() => setRevision(value => value + 1)}>판단 이력 새로고침</button>}>
    {!current ? <LoadingBlock label="정책 판단 이력을 불러오는 중" />
      : current.failed ? <ErrorBanner error={new Error('정책 판단 이력을 조회하지 못했습니다. 기록의 완전성을 확인할 수 없습니다. 새로고침해 주세요.')} />
        : current.value ? <GatewayRecords key={revision} evidence={current.value} /> : null}
  </Panel>
}

function GatewayRecords({ evidence }: { evidence: GatewayRunEvidence }) {
  const [caseId, setCaseId] = useState('')
  const [toolName, setToolName] = useState('')
  const [decision, setDecision] = useState('')
  const [page, setPage] = useState(0)
  const cases = [...new Set(evidence.events.map(event => event.testCaseRunId))]
  const tools = [...new Set(evidence.events.map(event => event.toolName))]
  const events = evidence.events.filter(event => (!caseId || JSON.stringify(event.testCaseRunId) === caseId)
    && (!toolName || JSON.stringify(event.toolName) === toolName) && (!decision || event.decision === decision))
  const pageCount = Math.max(1, Math.ceil(events.length / recordsPerPage))
  const currentPage = Math.min(page, pageCount - 1)
  const firstIndex = currentPage * recordsPerPage
  const visibleEvents = events.slice(firstIndex, firstIndex + recordsPerPage)

  return <div className="stack" style={{ minWidth: 0 }}>
    <DataTable caption="조회한 Run 기록" headings={['항목', '저장값']} rows={[
      ['Run ID', <code>{evidence.run.id}</code>], ['Release ID', <code>{evidence.run.releaseId}</code>],
      ['Run 모드', evidence.run.mode], ['Run 상태', evidence.run.status],
      ['Contract Version ID', evidence.run.contractVersionId ? <code>{evidence.run.contractVersionId}</code> : '기록 없음'],
    ]} />
    <Notice title={`캡처한 이력 범위 · head ${evidence.headSequence}`} tone="muted">
      {evidence.headSequence === 0 ? '캡처 시점의 이벤트 기록이 없습니다.'
        : evidence.events.length <= recordsPerPage ? `이벤트 순서 1–${evidence.headSequence} 중 정책 판단 ${evidence.events.length}건을 표시합니다.`
          : `이벤트 순서 1–${evidence.headSequence} 중 정책 판단 ${evidence.events.length}건을 조회했습니다. 페이지당 최대 ${recordsPerPage}건을 표시합니다.`}
      {' '}이후 추가된 기록은 새로고침으로 조회합니다. Run 정보는 이력과 별도 시점에 조회한 저장값입니다. digest는 출처 식별용 표시입니다.
    </Notice>
    {!evidence.events.length ? <EmptyState title="캡처한 범위에 정책 판단 기록이 없습니다">정책 판단이나 실제 집행 결과를 확인할 근거가 없습니다.</EmptyState> : <>
      <div className="filters">
        <label>CaseRun 필터<select aria-label="CaseRun 필터" value={caseId} onChange={event => { setCaseId(event.target.value); setPage(0) }}><option value="">전체 CaseRun</option>{cases.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{value ?? 'CaseRun 기록 없음'}</option>)}</select></label>
        <label>Tool 필터<select aria-label="Tool 필터" value={toolName} onChange={event => { setToolName(event.target.value); setPage(0) }}><option value="">전체 Tool</option>{tools.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{toolLabel(value)}</option>)}</select></label>
        <label>판단 필터<select aria-label="판단 필터" value={decision} onChange={event => { setDecision(event.target.value); setPage(0) }}><option value="">전체 판단</option><option value="ALLOW">ALLOW</option><option value="DENY">DENY</option><option value="ERROR">ERROR · 운영 오류</option><option value="UNKNOWN">UNKNOWN · 판독 불가</option></select></label>
      </div>
      <p role="status">{events.length <= recordsPerPage
        ? `정책 판단 ${evidence.events.length}건 중 ${events.length}건 표시`
        : `정책 판단 ${evidence.events.length}건 중 ${events.length}건 일치 · ${firstIndex + 1}–${firstIndex + visibleEvents.length}건 표시`}</p>
      {pageCount > 1 && <nav aria-label="정책 판단 페이지" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button type="button" className="secondary-button" disabled={currentPage === 0}
          onClick={() => setPage(Math.max(0, currentPage - 1))}>이전 정책 판단 페이지</button>
        <span>페이지 {currentPage + 1}/{pageCount}</span>
        <button type="button" className="secondary-button" disabled={currentPage + 1 === pageCount}
          onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}>다음 정책 판단 페이지</button>
      </nav>}
      {!events.length ? <EmptyState title="필터와 일치하는 기록이 없습니다">필터를 변경하여 캡처한 다른 기록을 확인하세요.</EmptyState>
        : <div className="event-list" style={{ minWidth: 0 }}>{visibleEvents.map(event => <GatewayEvent key={event.eventId} event={event} />)}</div>}
    </>}
  </div>
}

function GatewayEvent({ event }: { event: GatewayPolicyEvent }) {
  const reasonsDiffer = event.reasonCode !== null && event.decisionReasonCode !== null && event.reasonCode !== event.decisionReasonCode
  const label = event.decision === 'UNKNOWN' ? 'UNKNOWN · 판독 불가'
    : event.decision === 'ERROR' ? 'ERROR · 운영 오류' : `기록된 ${event.decision}`
  return <details style={{ minWidth: 0 }}>
    <summary style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', overflowWrap: 'anywhere' }}><strong>#{event.sequence} · {toolLabel(event.toolName)}</strong><Badge tone={event.decision === 'UNKNOWN' || event.decision === 'ERROR' ? 'amber' : 'muted'}>{label}</Badge><time dateTime={event.occurredAt}>{event.occurredAt}</time></summary>
    <DataTable caption={`정책 이벤트 ${event.sequence} 기록`} headings={['항목', '기록값']} rows={[
      ['이벤트 reasonCode', <code>{reasonLabel(event.reasonCode)}</code>],
      ['policyDecision.reasonCode', <code>{reasonLabel(event.decisionReasonCode)}</code>],
      ['Event ID', <code>{event.eventId}</code>], ['Trace ID', <code>{event.traceId}</code>],
      ['Run ID', <code>{event.runId}</code>], ['CaseRun ID', <code>{event.testCaseRunId ?? '기록 없음'}</code>],
      ['Payload digest', <code>{event.payloadDigest}</code>], ['Event hash', <code>{event.eventHash}</code>],
      ['Previous event hash', <code>{event.prevEventHash ?? '기록 없음'}</code>],
    ]} />
    {reasonsDiffer && <Notice title="사유 두 값이 다르게 기록되어 있습니다." tone="amber">각 위치의 원문을 표시하며 어느 값에도 우선순위를 부여하지 않습니다.</Notice>}
    <GatewayStages event={event} />
    <GatewayCalls sequence={event.sequence} details={event.callDetails} />
    <p className="muted">사유는 의미를 재해석하지 않은 기록값입니다. 저장된 단계와 호출 출처는 실제 실행·전달 결과를 확정하지 않습니다.</p>
  </details>
}

function GatewayStages({ event }: { event: GatewayPolicyEvent }) {
  const details = event.stageDetails
  return <section aria-label={`정책 이벤트 ${event.sequence} 평가 단계`} style={{ minWidth: 0, overflowWrap: 'anywhere', padding: 12 }}>
    <h3>평가 단계</h3>
    {details.status === 'absent' ? <p className="muted">단계 상세 기록 없음</p>
      : details.status === 'unreadable' ? <Notice title="단계 상세 판독 불가" tone="amber">단계 기록이 불완전하거나 서로 맞지 않습니다. 전체 판단과 사유는 기록된 값을 유지합니다.</Notice>
        : <>
          <p>저장된 평가 방식: <strong>{details.mode}</strong></p>
          {details.mode === 'BASELINE' && details.observedFailure && <Notice title="관측 위반 기록" tone="amber">
            <code>{details.observedFailure.stage}</code> · <code>{details.observedFailure.reasonCode}</code>
            <p>OBSERVED는 관측 검사입니다. 이 위반만으로 전체 판단이 DENY가 되는 것은 아닙니다.</p>
          </Notice>}
          <ol style={{ paddingInlineStart: 24 }}>
            {gatewayStages.map((stage, index) => {
              const baselineRow = details.mode === 'BASELINE' ? details.stageOutcomes[index] : undefined
              const evaluated = details.mode === 'ENFORCE' ? index < details.evaluatedStages.length : baselineRow !== undefined
              const terminal = details.failedStage === stage
              let outcome = '미평가'
              if (evaluated && details.mode === 'ENFORCE') outcome = terminal ? `기록된 ${event.decision}` : '평가됨'
              if (baselineRow) {
                switch (baselineRow.outcomeType) {
                  case 'PASS': outcome = 'PASS'; break
                  case 'SKIPPED': outcome = 'SKIPPED · 관측 검사 생략'; break
                  case 'ERROR': outcome = 'ERROR · 운영 오류'; break
                  case 'DENY': outcome = baselineRow.enforcement === 'OBSERVED' ? 'DENY · 관측 위반' : 'DENY · 집행 거절'; break
                }
              }
              const reason = baselineRow?.reasonCode ?? (details.mode === 'ENFORCE' && terminal ? event.decisionReasonCode : null)
              return <li key={stage} style={{ paddingBlock: 8 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <strong>{stage}</strong>
                  {baselineRow && <span>{baselineRow.enforcement}</span>}
                  <Badge tone={terminal || baselineRow?.outcomeType === 'DENY' ? 'amber' : 'muted'}>{outcome}</Badge>
                </div>
                {reason !== null && <p>기록된 사유: <code>{reason}</code></p>}
              </li>
            })}
          </ol>
          {details.mode === 'ENFORCE' && <p className="muted">‘평가됨’은 저장된 평가 목록에 포함된 단계입니다. 각 단계의 개별 결과와 사유는 별도로 기록되지 않았습니다.</p>}
          <p className="muted">‘미평가’는 확인된 평가 종료 뒤의 후속 단계입니다. 상세가 없는 기록에서 미평가를 추정하지 않습니다.</p>
        </>}
  </section>
}

function GatewayCalls({ sequence, details }: { sequence: number; details: GatewayCallDetails }) {
  return <section aria-label={`정책 이벤트 ${sequence} 호출 출처`} style={{ minWidth: 0, overflowWrap: 'anywhere', padding: 12 }}>
    <h3>호출 출처</h3>
    {details.status === 'absent' ? <p className="muted">호출 출처 기록 없음</p>
      : details.status === 'unreadable' ? <Notice title="호출 출처 확인 불가" tone="amber">호출 식별자나 연결된 기록의 문맥을 확인할 수 없습니다.</Notice>
        : details.status === 'ambiguous' ? <Notice title="호출 출처 연결 모호함" tone="amber">
          <p>Tool Call ID: <code>{details.toolCallId}</code></p>
          <p>동일 ID의 기록: 정책 {details.counts.policies}건 · 요청 {details.counts.requests}건 · 응답 {details.counts.responses}건</p>
          <p>이 정책 판단에 대응하는 시도를 구분할 수 없습니다. 기록 건수는 실제 실행·전달 횟수가 아닙니다.</p>
        </Notice>
          : <>
            <p>Tool Call ID: <code>{details.toolCallId}</code></p>
            <dl>{[details.proposal, details.request, details.response].filter((ref): ref is CallEventRef => ref !== null).map(ref => <div key={ref.eventId} style={{ paddingBlock: 8 }}>
              <dt><strong>{ref.eventType}</strong></dt>
              <dd style={{ marginInlineStart: 0 }}>
                <p>Event ID: <code>{ref.eventId}</code></p>
                <p>순서 #{ref.sequence} · <time dateTime={ref.occurredAt}>{ref.occurredAt}</time></p>
                <p>Payload digest: <code>{ref.payloadDigest}</code></p>
                <p>Event hash: <code>{ref.eventHash}</code></p>
                <p>Previous event hash: <code>{ref.prevEventHash ?? '기록 없음'}</code></p>
              </dd>
            </div>)}</dl>
            {details.request === null && <p className="muted">캡처 범위에서 연결된 TOOL_REQUEST 기록 없음</p>}
            {details.response === null && <p className="muted">캡처 범위에서 연결된 TOOL_RESPONSE 기록 없음</p>}
          </>}
    <p className="muted">같은 조회 범위에서 명시적으로 연결된 기록만 표시합니다. 기록 부재는 실제 미호출이나 미전달을 뜻하지 않습니다.</p>
  </section>
}
