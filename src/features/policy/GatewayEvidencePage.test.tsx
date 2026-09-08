import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Release } from '../../api/contracts'
import { GatewayEvidencePage } from './GatewayEvidencePage'
import { GatewayEvidenceClient, gatewayStages, type BaselineStageOutcome, type CallEventRef, type GatewayEvidenceApi, type GatewayPolicyEvent, type GatewayRunEvidence, type GatewayRunOption, type GatewayStageDetails } from './gatewayEvidence'

const releaseId = '019903ac-abcd-7000-8000-000000000001'
const otherReleaseId = '019903ac-abcd-7000-8000-000000000002'
const runId = '019903ac-abcd-7000-8000-000000000010'
const otherRunId = '019903ac-abcd-7000-8000-000000000011'
const caseId = '019903ac-abcd-7000-8000-000000000020'
const otherCaseId = '019903ac-abcd-7000-8000-000000000021'
const versionId = '019903ac-abcd-7000-8000-000000000030'
const hash = `sha256:${'a'.repeat(64)}`
const actorId = 'gateway-reviewer'
const canary = 'SYNTHETIC_GATEWAY_PRIVATE_CANARY'

function release(id = releaseId): Release {
  return { id, agentId: '019903ac-abcd-7000-8000-000000000099', version: id === releaseId ? '1.0' : '2.0',
    businessPurpose: '서류 검토', manifestSchemaVersion: '1.0', agentArtifactFingerprint: hash, releaseFingerprint: hash,
    safetyContractHash: null, lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW', revalidationReason: null,
    analyzedAt: null, lastTestedAt: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }
}

function run(id = runId, selectedRelease = releaseId): GatewayRunOption {
  return { id, releaseId: selectedRelease, mode: 'BASELINE', status: 'COMPLETED' }
}

function event(sequence = 1, overrides: Partial<GatewayPolicyEvent> = {}): GatewayPolicyEvent {
  return { eventId: `019903ac-abcd-7000-8000-${String(100 + sequence).padStart(12, '0')}`,
    traceId: '019903ac-abcd-7000-8000-000000000090', runId, testCaseRunId: caseId,
    sequence, occurredAt: '2026-09-07T22:00:00Z', toolName: 'CUSTOMER_DATA_READ', decision: 'DENY',
    reasonCode: 'CUSTOMER_SCOPE_VIOLATION', decisionReasonCode: 'CUSTOMER_SCOPE_VIOLATION',
    payloadDigest: hash, eventHash: hash, prevEventHash: hash,
    stageDetails: { status: 'absent' }, callDetails: { status: 'absent' }, ...overrides }
}

function evidence(overrides: Partial<GatewayRunEvidence> = {}): GatewayRunEvidence {
  return { run: { ...run(), contractVersionId: versionId }, headSequence: 8,
    events: [event(), event(3, { testCaseRunId: otherCaseId, toolName: 'DOCUMENT_READER', decision: 'ALLOW', reasonCode: 'TOOL_LEVEL_ALLOW', decisionReasonCode: 'TOOL_LEVEL_ALLOW' }),
      event(7, { testCaseRunId: null, toolName: null, decision: 'UNKNOWN', reasonCode: null, decisionReasonCode: null })], ...overrides }
}

function client() {
  return {
    listRuns: vi.fn<GatewayEvidenceApi['listRuns']>().mockResolvedValue([run(), run(otherRunId)]),
    loadRun: vi.fn<GatewayEvidenceApi['loadRun']>().mockImplementation(async (selectedRelease, selectedRun) => evidence({ run: { ...run(selectedRun, selectedRelease), contractVersionId: versionId },
      events: [event(1, { runId: selectedRun, reasonCode: `REASON_${selectedRun}`, decisionReasonCode: `REASON_${selectedRun}` })] })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function page(api = client(), props: { releases?: Release[]; actorId?: string; preferredReleaseId?: string; onReleaseChange?: (id: string) => void } = {}) {
  return { api, ...render(<GatewayEvidencePage releases={[release(), release(otherReleaseId)]} actorId={actorId} preferredReleaseId={releaseId} client={api} {...props} />) }
}

async function selectRun(id = runId) {
  fireEvent.change(await screen.findByLabelText('Gateway Run'), { target: { value: id } })
}

function filter(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function enforce(failedStage: 'OBJECT_SCOPE' | 'PREFLIGHT' | null): GatewayStageDetails {
  return { status: 'valid', mode: 'ENFORCE', failedStage,
    evaluatedStages: failedStage === null ? gatewayStages : gatewayStages.slice(0, failedStage === 'PREFLIGHT' ? 1 : 5) }
}

function baseline(terminal = false): GatewayStageDetails {
  const observed = new Set(['OBJECT_SCOPE', 'FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'HUMAN_BOUNDARY'])
  const stageOutcomes: BaselineStageOutcome[] = gatewayStages.slice(0, terminal ? 9 : 11).map(stage => ({
    stage, enforcement: observed.has(stage) ? 'OBSERVED' : 'ENFORCED',
    outcomeType: stage === 'OBJECT_SCOPE' || (terminal && stage === 'WORKFLOW') ? 'DENY'
      : observed.has(stage) ? 'SKIPPED' : 'PASS',
    reasonCode: stage === 'OBJECT_SCOPE' ? 'CUSTOMER_SCOPE_VIOLATION'
      : terminal && stage === 'WORKFLOW' ? 'INVALID_WORKFLOW_STAGE' : null,
  }))
  return { status: 'valid', mode: 'BASELINE', stageOutcomes,
    failedStage: terminal ? 'WORKFLOW' : null,
    observedFailure: { stage: 'OBJECT_SCOPE', reasonCode: 'CUSTOMER_SCOPE_VIOLATION' } }
}

function callRef(eventType: CallEventRef['eventType'], sequence: number): CallEventRef {
  return { eventType, eventId: `019903ac-abcd-7000-8000-${String(900 + sequence).padStart(12, '0')}`,
    sequence, occurredAt: '2026-09-07T22:00:00Z', payloadDigest: hash, eventHash: hash, prevEventHash: hash }
}

function populatedEvent(sequence: number): GatewayPolicyEvent {
  const proposal = callRef('TOOL_PROPOSED', sequence - 1)
  return event(sequence, { stageDetails: enforce(null), decision: 'ALLOW', reasonCode: 'ALLOW', decisionReasonCode: 'ALLOW',
    callDetails: { status: 'valid', toolCallId: proposal.eventId, proposal,
      request: callRef('TOOL_REQUEST', sequence + 1), response: callRef('TOOL_RESPONSE', sequence + 2) } })
}

async function settle(work: () => void) { await act(async () => { work(); await Promise.resolve() }) }

describe('Gateway stored policy evidence page', () => {
  it('requires an available Release and does not query an empty or missing selection', async () => {
    const api = client()
    const view = page(api, { releases: [], preferredReleaseId: undefined })
    expect(screen.getByRole('heading', { name: 'Release를 선택하세요' })).toBeVisible()
    expect(api.listRuns).not.toHaveBeenCalled()
    view.rerender(<GatewayEvidencePage releases={[release()]} actorId={actorId} client={api} />)
    expect(api.listRuns).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Gateway Release'), { target: { value: releaseId } })
    await screen.findByLabelText('Gateway Run')
    expect(api.listRuns).toHaveBeenCalledWith(releaseId, actorId, expect.any(AbortSignal))
    expect(api.loadRun).not.toHaveBeenCalled()
  })

  it('shows loading, empty Run lists, and explicit Run-list refresh', async () => {
    const api = client()
    const pending = deferred<readonly GatewayRunOption[]>()
    api.listRuns.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([run()])
    page(api)
    expect(screen.getByRole('status')).toHaveTextContent('Run 목록을 불러오는 중')
    await settle(() => pending.resolve([]))
    expect(screen.getByRole('heading', { name: '저장된 Run이 없습니다' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Run 목록 새로고침' }))
    await screen.findByLabelText('Gateway Run')
    expect(api.listRuns).toHaveBeenCalledTimes(2)
  })

  it('shows stored metadata, captured history limits and separately recorded reasons with source IDs', async () => {
    const api = client()
    const record = event(2, { decisionReasonCode: 'UNFAMILIAR_RECORDED_REASON', prevEventHash: null })
    api.loadRun.mockResolvedValue(evidence({ run: { ...run(), mode: 'SEAL_REPLAY', status: 'RUNNING', contractVersionId: null }, events: [record] }))
    page(api)
    await selectRun()
    await screen.findByText('캡처한 이력 범위 · head 8')
    expect(screen.getByRole('table', { name: '조회한 Run 기록' })).toHaveTextContent('SEAL_REPLAY')
    expect(screen.getByRole('table', { name: '조회한 Run 기록' })).toHaveTextContent('RUNNING')
    expect(screen.getByText(/Run 정보는 이력과 별도 시점/)).toBeVisible()
    expect(screen.getByText('기록된 DENY')).toBeVisible()
    fireEvent.click(screen.getByText('#2 · CUSTOMER_DATA_READ'))
    const table = screen.getByRole('table', { name: '정책 이벤트 2 기록' })
    expect(table).toHaveTextContent(record.eventId)
    expect(table).toHaveTextContent(record.traceId)
    expect(table).toHaveTextContent(caseId)
    expect(table).toHaveTextContent(hash)
    expect(table).toHaveTextContent('CUSTOMER_SCOPE_VIOLATION')
    expect(table).toHaveTextContent('UNFAMILIAR_RECORDED_REASON')
    expect(screen.getByText('사유 두 값이 다르게 기록되어 있습니다.')).toBeVisible()
    expect(screen.queryByText('ENFORCE')).not.toBeInTheDocument()
    expect(screen.queryByText('COMPARABLE')).not.toBeInTheDocument()
  })

  it('filters by CaseRun, Tool and decision individually and together without changing event association', async () => {
    const api = client()
    api.loadRun.mockResolvedValue(evidence())
    page(api)
    await selectRun()
    await screen.findByText('정책 판단 3건 중 3건 표시')
    filter('CaseRun 필터', JSON.stringify(caseId))
    expect(screen.getByText('정책 판단 3건 중 1건 표시')).toBeVisible()
    expect(screen.getByText('#1 · CUSTOMER_DATA_READ')).toBeVisible()
    expect(screen.queryByText('#3 · DOCUMENT_READER')).not.toBeInTheDocument()
    filter('CaseRun 필터', '')
    filter('Tool 필터', JSON.stringify('DOCUMENT_READER'))
    expect(screen.getByText('#3 · DOCUMENT_READER')).toBeVisible()
    expect(screen.queryByText('#1 · CUSTOMER_DATA_READ')).not.toBeInTheDocument()
    filter('Tool 필터', '')
    filter('판단 필터', 'UNKNOWN')
    expect(screen.getByText('#7 · Tool 기록 없음')).toBeVisible()
    filter('판단 필터', 'ALLOW')
    filter('CaseRun 필터', JSON.stringify(otherCaseId))
    filter('Tool 필터', JSON.stringify('DOCUMENT_READER'))
    expect(screen.getByText('정책 판단 3건 중 1건 표시')).toBeVisible()
    fireEvent.click(screen.getByText('#3 · DOCUMENT_READER'))
    expect(screen.getByRole('table', { name: '정책 이벤트 3 기록' })).toHaveTextContent(event(3).eventId)
    filter('판단 필터', 'DENY')
    expect(screen.getByRole('heading', { name: '필터와 일치하는 기록이 없습니다' })).toBeVisible()
    expect(screen.queryByText('캡처한 범위에 정책 판단 기록이 없습니다')).not.toBeInTheDocument()
  })

  it('keeps four recorded states distinct and preserves ERROR Event and CaseRun links through combined filters', async () => {
    const api = client()
    const error = event(4, { decision: 'ERROR', testCaseRunId: otherCaseId,
      reasonCode: 'POLICY_EVALUATION_TIMEOUT', decisionReasonCode: 'INVALID_REQUEST_SCHEMA' })
    const records = [event(1, { decision: 'ALLOW' }),
      event(2, { decision: 'DENY', toolName: 'DOCUMENT_READER' }), error,
      event(7, { decision: 'UNKNOWN', testCaseRunId: null, toolName: null })]
    api.loadRun.mockResolvedValue(evidence({ events: records }))
    page(api)
    await selectRun()
    await screen.findByText('정책 판단 4건 중 4건 표시')
    expect(within(screen.getByLabelText('판단 필터')).getByRole('option', { name: 'ERROR · 운영 오류' })).toHaveValue('ERROR')
    expect(screen.getByText('기록된 ALLOW')).toBeVisible()
    expect(screen.getByText('기록된 DENY')).toBeVisible()
    const summary = screen.getByText('#4 · CUSTOMER_DATA_READ').closest('summary')!
    expect(within(summary).getByText('ERROR · 운영 오류')).toBeVisible()
    expect(within(summary).queryByText('기록된 DENY')).not.toBeInTheDocument()

    for (const [decision, expectedSummary] of [
      ['ALLOW', '#1 · CUSTOMER_DATA_READ'], ['DENY', '#2 · DOCUMENT_READER'],
      ['UNKNOWN', '#7 · Tool 기록 없음'], ['ERROR', '#4 · CUSTOMER_DATA_READ'],
    ]) {
      filter('판단 필터', decision!)
      expect(screen.getByText('정책 판단 4건 중 1건 표시')).toBeVisible()
      expect(screen.getByText(expectedSummary!)).toBeVisible()
      if (decision === 'DENY') expect(screen.queryByText('#4 · CUSTOMER_DATA_READ')).not.toBeInTheDocument()
    }
    filter('CaseRun 필터', JSON.stringify(otherCaseId))
    filter('Tool 필터', JSON.stringify('CUSTOMER_DATA_READ'))
    expect(screen.getByText('정책 판단 4건 중 1건 표시')).toBeVisible()
    fireEvent.click(screen.getByText('#4 · CUSTOMER_DATA_READ'))
    const table = screen.getByRole('table', { name: '정책 이벤트 4 기록' })
    expect(table).toHaveTextContent(error.eventId)
    expect(table).toHaveTextContent(error.traceId)
    expect(table).toHaveTextContent(runId)
    expect(table).toHaveTextContent(otherCaseId)
    expect(table).not.toHaveTextContent(caseId)
    expect(table).toHaveTextContent('POLICY_EVALUATION_TIMEOUT')
    expect(table).toHaveTextContent('INVALID_REQUEST_SCHEMA')
    expect(screen.getByText('사유 두 값이 다르게 기록되어 있습니다.')).toBeVisible()
    filter('CaseRun 필터', JSON.stringify(caseId))
    expect(screen.getByRole('heading', { name: '필터와 일치하는 기록이 없습니다' })).toBeVisible()
    filter('CaseRun 필터', '')
    filter('Tool 필터', '')
    filter('판단 필터', '')
    expect(screen.getByText('정책 판단 4건 중 4건 표시')).toBeVisible()
  })

  it('keeps null filter values distinct from a literal Tool name that resembles a missing sentinel', async () => {
    const api = client()
    api.loadRun.mockResolvedValue(evidence({ events: [event(1, { toolName: '__missing__' }), event(2, { toolName: null, testCaseRunId: null })] }))
    page(api)
    await selectRun()
    await screen.findByLabelText('Tool 필터')
    filter('Tool 필터', JSON.stringify(null))
    expect(screen.getByText('#2 · Tool 기록 없음')).toBeVisible()
    expect(screen.queryByText('#1 · __missing__')).not.toBeInTheDocument()
    filter('Tool 필터', JSON.stringify('__missing__'))
    expect(screen.getByText('#1 · __missing__')).toBeVisible()
    filter('CaseRun 필터', JSON.stringify(null))
    expect(screen.getByRole('heading', { name: '필터와 일치하는 기록이 없습니다' })).toBeVisible()
  })

  it('preserves and displays empty Tool and reason labels distinctly from null and the all-Tools filter', async () => {
    const api = client()
    const empty = event(1, { toolName: '', reasonCode: '', decisionReasonCode: '', decision: 'ERROR' })
    const missing = event(2, { toolName: null, reasonCode: null, decisionReasonCode: null, decision: 'UNKNOWN' })
    api.loadRun.mockResolvedValue(evidence({ events: [empty, missing] }))
    page(api)
    await selectRun()
    await screen.findByText('정책 판단 2건 중 2건 표시')
    const select = screen.getByLabelText('Tool 필터')
    expect(within(select).getByRole('option', { name: '전체 Tool' })).toHaveValue('')
    expect(within(select).getByRole('option', { name: 'Tool 이름 빈 문자열' })).toHaveValue(JSON.stringify(''))
    expect(within(select).getByRole('option', { name: 'Tool 기록 없음' })).toHaveValue(JSON.stringify(null))
    filter('Tool 필터', JSON.stringify(''))
    expect(screen.getByText('정책 판단 2건 중 1건 표시')).toBeVisible()
    fireEvent.click(screen.getByText('#1 · Tool 이름 빈 문자열'))
    const emptyTable = screen.getByRole('table', { name: '정책 이벤트 1 기록' })
    expect(within(emptyTable).getAllByText('빈 문자열')).toHaveLength(2)
    expect(within(emptyTable).queryByText('없음 또는 문자열이 아님')).not.toBeInTheDocument()
    expect(emptyTable).toHaveTextContent(empty.eventId)
    expect(screen.queryByText('#2 · Tool 기록 없음')).not.toBeInTheDocument()
    filter('Tool 필터', JSON.stringify(null))
    fireEvent.click(screen.getByText('#2 · Tool 기록 없음'))
    const missingTable = screen.getByRole('table', { name: '정책 이벤트 2 기록' })
    expect(within(missingTable).getAllByText('없음 또는 문자열이 아님')).toHaveLength(2)
    expect(within(missingTable).queryByText('빈 문자열')).not.toBeInTheDocument()
    expect(missingTable).toHaveTextContent(missing.eventId)
    filter('Tool 필터', '')
    expect(screen.getByText('정책 판단 2건 중 2건 표시')).toBeVisible()
    expect(empty).toMatchObject({ toolName: '', reasonCode: '', decisionReasonCode: '' })
    expect(missing).toMatchObject({ toolName: null, reasonCode: null, decisionReasonCode: null })
  })

  it.each([50, 51, 101])('renders at most 50 event cards and tables from a complete %i-record snapshot', async count => {
    const api = client()
    const records = Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze(event(index + 1))))
    const head = count + 7 // The verified projection need not include every non-policy event in the captured prefix.
    api.loadRun.mockResolvedValue(evidence({ events: records, headSequence: head }))
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected page transport'))
    const view = page(api)
    await selectRun()
    await screen.findByText(`캡처한 이력 범위 · head ${head}`)
    const pageCount = Math.ceil(count / 50)
    const assertWindow = (pageIndex: number) => {
      const first = pageIndex * 50 + 1
      const last = Math.min(count, first + 49)
      expect(view.container.querySelectorAll('.event-list details')).toHaveLength(last - first + 1)
      expect(view.container.querySelectorAll('.event-list table')).toHaveLength(last - first + 1)
      expect(screen.getByText(`#${first} · CUSTOMER_DATA_READ`)).toBeVisible()
      expect(screen.getByText(`#${last} · CUSTOMER_DATA_READ`)).toBeVisible()
      expect(screen.getByText(`캡처한 이력 범위 · head ${head}`)).toBeVisible()
      expect(screen.getByText(count <= 50 ? `정책 판단 ${count}건 중 ${count}건 표시`
        : `정책 판단 ${count}건 중 ${count}건 일치 · ${first}–${last}건 표시`)).toBeVisible()
      if (pageCount > 1) expect(screen.getByText(`페이지 ${pageIndex + 1}/${pageCount}`)).toBeVisible()
    }
    assertWindow(0)
    if (count <= 50) {
      expect(screen.queryByRole('navigation', { name: '정책 판단 페이지' })).not.toBeInTheDocument()
      expect(view.container).toHaveTextContent(`이벤트 순서 1–${head} 중 정책 판단 ${count}건을 표시합니다.`)
    } else {
      expect(view.container).toHaveTextContent(`이벤트 순서 1–${head} 중 정책 판단 ${count}건을 조회했습니다. 페이지당 최대 50건을 표시합니다.`)
      expect(view.container).not.toHaveTextContent(`정책 판단 ${count}건을 표시합니다.`)
      expect(screen.getByRole('button', { name: '이전 정책 판단 페이지' })).toBeDisabled()
      for (let index = 1; index < pageCount; index++) {
        fireEvent.click(screen.getByRole('button', { name: '다음 정책 판단 페이지' }))
        assertWindow(index)
      }
      const next = screen.getByRole('button', { name: '다음 정책 판단 페이지' })
      expect(next).toBeDisabled()
      fireEvent.click(next)
      assertWindow(pageCount - 1)
    }
    fireEvent.click(screen.getByText(`#${count} · CUSTOMER_DATA_READ`))
    const lastTable = screen.getByRole('table', { name: `정책 이벤트 ${count} 기록` })
    expect(lastTable).toHaveTextContent(records[count - 1]!.eventId)
    expect(lastTable).toHaveTextContent(caseId)
    expect(lastTable).toHaveTextContent(runId)
    expect(lastTable).toHaveTextContent(hash)
    for (let index = pageCount - 2; index >= 0; index--) {
      fireEvent.click(screen.getByRole('button', { name: '이전 정책 판단 페이지' }))
      assertWindow(index)
    }
    if (pageCount > 1) expect(screen.getByRole('button', { name: '이전 정책 판단 페이지' })).toBeDisabled()
    expect(api.listRuns).toHaveBeenCalledTimes(1)
    expect(api.loadRun).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['CaseRun 필터', JSON.stringify(otherCaseId)], ['Tool 필터', JSON.stringify('DOCUMENT_READER')], ['판단 필터', 'ERROR'],
  ])('resets the last page on %s changes and clearing the filter restores the first 50 records', async (label, value) => {
    const api = client()
    const first = event(1, { testCaseRunId: otherCaseId, toolName: 'DOCUMENT_READER', decision: 'ERROR' })
    const records = [first, ...Array.from({ length: 100 }, (_, index) => event(index + 2))]
    api.loadRun.mockResolvedValue(evidence({ events: records, headSequence: 110 }))
    const view = page(api)
    await selectRun()
    await screen.findByText('페이지 1/3')
    fireEvent.click(screen.getByRole('button', { name: '다음 정책 판단 페이지' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 정책 판단 페이지' }))
    expect(screen.getByText('페이지 3/3')).toBeVisible()
    expect(screen.getByText('#101 · CUSTOMER_DATA_READ')).toBeVisible()
    filter(label!, value!)
    expect(screen.getByText('정책 판단 101건 중 1건 표시')).toBeVisible()
    expect(screen.queryByRole('navigation', { name: '정책 판단 페이지' })).not.toBeInTheDocument()
    expect(view.container.querySelectorAll('.event-list details')).toHaveLength(1)
    fireEvent.click(screen.getByText('#1 · DOCUMENT_READER'))
    const firstTable = screen.getByRole('table', { name: '정책 이벤트 1 기록' })
    expect(firstTable).toHaveTextContent(first.eventId)
    expect(firstTable).toHaveTextContent(otherCaseId)
    filter(label!, '')
    expect(screen.getByText('페이지 1/3')).toBeVisible()
    expect(screen.getByText('정책 판단 101건 중 101건 일치 · 1–50건 표시')).toBeVisible()
    expect(view.container.querySelectorAll('.event-list details')).toHaveLength(50)
    expect(view.container.querySelectorAll('.event-list table')).toHaveLength(50)
    expect(screen.getByText('#1 · DOCUMENT_READER')).toBeVisible()
    expect(screen.queryByText('#101 · CUSTOMER_DATA_READ')).not.toBeInTheDocument()
    expect(screen.getByText('캡처한 이력 범위 · head 110')).toBeVisible()
    expect(api.listRuns).toHaveBeenCalledTimes(1)
    expect(api.loadRun).toHaveBeenCalledTimes(1)
  })

  it.each([0, 12])('distinguishes an empty policy projection at head %i from a safety outcome', async headSequence => {
    const api = client()
    api.loadRun.mockResolvedValue(evidence({ headSequence, events: [] }))
    page(api)
    await selectRun()
    await screen.findByText(`캡처한 이력 범위 · head ${headSequence}`)
    expect(screen.getByRole('heading', { name: '캡처한 범위에 정책 판단 기록이 없습니다' })).toBeVisible()
    expect(screen.queryByLabelText('판단 필터')).not.toBeInTheDocument()
    expect(screen.queryByText('기록된 ALLOW')).not.toBeInTheDocument()
    expect(screen.queryByText('ATTACK_BLOCKED')).not.toBeInTheDocument()
  })

  it('renders UNKNOWN, missing reasons and hostile markup inertly; does not render private extras or derive defense', async () => {
    const api = client()
    const hostile = '<img src=x onerror=alert(1)>'
    const record = { ...event(1, { decision: 'UNKNOWN', reasonCode: hostile, decisionReasonCode: null }), input: canary, output: canary, metadata: canary, policyDecision: { extra: canary } }
    const result = { ...evidence({ events: [record, event(3, { reasonCode: 'POLICY_EVALUATION_TIMEOUT', decisionReasonCode: 'POLICY_EVALUATION_TIMEOUT' })] }), summary: canary }
    api.loadRun.mockResolvedValue(result)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const stream = vi.fn()
    vi.stubGlobal('EventSource', stream)
    try {
      const view = page(api)
      await selectRun()
      await screen.findByText('캡처한 이력 범위 · head 8')
      fireEvent.click(screen.getByText('#1 · CUSTOMER_DATA_READ'))
      const table = screen.getByRole('table', { name: '정책 이벤트 1 기록' })
      expect(table).toHaveTextContent(hostile)
      expect(table).toHaveTextContent('없음 또는 문자열이 아님')
      expect(screen.getAllByText('UNKNOWN · 판독 불가').length).toBeGreaterThan(0)
      expect(view.container.querySelector('img, script')).toBeNull()
      expect(view.container).not.toHaveTextContent(canary)
      expect(view.container).not.toHaveTextContent(/ATTACK_BLOCKED|NORMAL_SUCCESS|no-call|no-leak|no-state-delta|격리 성공|차단 성공|ENFORCE|COMPARABLE/)
      expect(storage).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('shows recorded ERROR without exposing raw extras or treating it as a request failure or defense success', async () => {
    const api = client()
    const hostile = '<img src=x onerror=alert(1)>'
    const record = { ...event(5, { decision: 'ERROR', reasonCode: hostile, decisionReasonCode: 'INVALID_REQUEST_SCHEMA' }),
      input: canary, output: canary, metadata: { toolCallId: canary, gateway: 'c', private: canary },
      policyDecision: { decisionType: 'ERROR', allowed: false, successfulSecurityBlock: true,
        evaluatedStages: [canary], evaluatedChecks: [canary], stageOutcomes: [{ stage: canary }],
        failedCheck: canary, failedStage: canary, toolCallId: canary, attackOutcome: 'ATTACK_BLOCKED' } }
    api.loadRun.mockResolvedValue(evidence({ run: { ...run(), status: 'FAILED', contractVersionId: null }, events: [record] }))
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const stream = vi.fn()
    vi.stubGlobal('EventSource', stream)
    try {
      const view = page(api)
      await selectRun()
      await screen.findByText('정책 판단 1건 중 1건 표시')
      const summary = screen.getByText('#5 · CUSTOMER_DATA_READ').closest('summary')!
      expect(within(summary).getByText('ERROR · 운영 오류')).toBeVisible()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('기록된 DENY')).not.toBeInTheDocument()
      fireEvent.click(summary)
      const table = screen.getByRole('table', { name: '정책 이벤트 5 기록' })
      expect(table).toHaveTextContent(hostile)
      expect(table).toHaveTextContent('INVALID_REQUEST_SCHEMA')
      expect(table).toHaveTextContent(record.eventId)
      expect(view.container.querySelector('img, script')).toBeNull()
      expect(view.container.innerHTML).not.toContain(canary)
      expect(view.container).not.toHaveTextContent(/ATTACK_BLOCKED|NORMAL_SUCCESS|no-call|no-leak|no-state-delta|격리 성공|차단 성공|COMPARABLE|successfulSecurityBlock|toolCallId|evaluatedStages|evaluatedChecks|stageOutcomes|failedCheck|failedStage/)
      expect(storage).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('shows fixed list and detail error messages, never arbitrary exceptions, and permits explicit recovery', async () => {
    const api = client()
    api.listRuns.mockRejectedValueOnce(new Error(canary))
    api.loadRun.mockRejectedValueOnce(new Error(canary)).mockResolvedValueOnce(evidence())
    const view = page(api)
    expect(await screen.findByRole('alert')).toHaveTextContent('Run 목록을 조회하지 못했습니다')
    expect(view.container).not.toHaveTextContent(canary)
    fireEvent.click(screen.getByRole('button', { name: 'Run 목록 새로고침' }))
    await selectRun()
    expect(await screen.findByRole('alert')).toHaveTextContent('기록의 완전성을 확인할 수 없습니다')
    expect(view.container).not.toHaveTextContent(canary)
    expect(screen.queryByText('캡처한 범위에 정책 판단 기록이 없습니다')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '판단 이력 새로고침' }))
    await screen.findByText('캡처한 이력 범위 · head 8')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears loaded evidence immediately on refresh and displays the newly captured prefix', async () => {
    const api = client()
    const pending = deferred<GatewayRunEvidence>()
    api.loadRun.mockResolvedValueOnce(evidence()).mockReturnValueOnce(pending.promise)
    page(api)
    await selectRun()
    await screen.findByText('캡처한 이력 범위 · head 8')
    filter('판단 필터', 'DENY')
    fireEvent.click(screen.getByRole('button', { name: '판단 이력 새로고침' }))
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('정책 판단 이력을 불러오는 중')
    await settle(() => pending.resolve(evidence({ headSequence: 10 })))
    expect(screen.getByText('캡처한 이력 범위 · head 10')).toBeVisible()
    expect(screen.getByLabelText('판단 필터')).toHaveValue('')
  })

  it.each(['resolve', 'reject'] as const)('ignores stale Run-list %s after Release change even if abort is ignored', async outcome => {
    const api = client()
    const old = deferred<readonly GatewayRunOption[]>()
    const next = deferred<readonly GatewayRunOption[]>()
    api.listRuns.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const changed = vi.fn()
    page(api, { onReleaseChange: changed })
    const signal = api.listRuns.mock.calls[0]![2]!
    fireEvent.change(screen.getByLabelText('Gateway Release'), { target: { value: otherReleaseId } })
    expect(signal.aborted).toBe(true)
    expect(changed).toHaveBeenCalledWith(otherReleaseId)
    await settle(() => outcome === 'resolve' ? old.resolve([run()]) : old.reject(new Error(canary)))
    expect(screen.getByRole('status')).toHaveTextContent('Run 목록을 불러오는 중')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Gateway Run')).not.toBeInTheDocument()
    await settle(() => next.resolve([run(otherRunId, otherReleaseId)]))
    expect(within(screen.getByLabelText('Gateway Run')).getByRole('option', { name: new RegExp(otherRunId) })).toBeInTheDocument()
  })

  it.each(['resolve', 'reject'] as const)('ignores stale detail %s across Run change without finishing the newer loading state', async outcome => {
    const api = client()
    const old = deferred<GatewayRunEvidence>()
    const next = deferred<GatewayRunEvidence>()
    api.loadRun.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    await selectRun(otherRunId)
    expect(signal.aborted).toBe(true)
    await settle(() => outcome === 'resolve' ? old.resolve(evidence()) : old.reject(new Error(canary)))
    expect(screen.getByRole('status')).toHaveTextContent('정책 판단 이력을 불러오는 중')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await settle(() => next.resolve(evidence({ run: { ...run(otherRunId), contractVersionId: versionId }, headSequence: 11, events: [] })))
    expect(screen.getByText('캡처한 이력 범위 · head 11')).toBeVisible()
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
  })

  it.each(['resolve', 'reject'] as const)('discards stale detail %s after an explicit refresh and retains the new request error', async outcome => {
    const api = client()
    const old = deferred<GatewayRunEvidence>()
    const next = deferred<GatewayRunEvidence>()
    api.loadRun.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    fireEvent.click(screen.getByRole('button', { name: '판단 이력 새로고침' }))
    expect(signal.aborted).toBe(true)
    await settle(() => next.reject(new Error('new failure')))
    expect(screen.getByRole('alert')).toHaveTextContent('정책 판단 이력을 조회하지 못했습니다')
    await settle(() => outcome === 'resolve' ? old.resolve(evidence()) : old.reject(new Error(canary)))
    expect(screen.getByRole('alert')).toHaveTextContent('정책 판단 이력을 조회하지 못했습니다')
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
  })

  it.each(['resolve', 'reject'] as const)('discards stale detail %s after actor changes and sends the new actor to both queries', async outcome => {
    const api = client()
    const old = deferred<GatewayRunEvidence>()
    api.loadRun.mockReturnValueOnce(old.promise).mockResolvedValueOnce(evidence({ headSequence: 13 }))
    const view = page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    view.rerender(<GatewayEvidencePage releases={[release()]} actorId="second-actor" preferredReleaseId={releaseId} client={api} />)
    expect(signal.aborted).toBe(true)
    await selectRun()
    await screen.findByText('캡처한 이력 범위 · head 13')
    await settle(() => outcome === 'resolve' ? old.resolve(evidence()) : old.reject(new Error(canary)))
    expect(api.listRuns).toHaveBeenLastCalledWith(releaseId, 'second-actor', expect.any(AbortSignal))
    expect(api.loadRun).toHaveBeenLastCalledWith(releaseId, runId, 'second-actor', expect.any(AbortSignal))
    expect(screen.getByText('캡처한 이력 범위 · head 13')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['actor', 'resolve'], ['actor', 'reject'], ['refresh', 'resolve'], ['refresh', 'reject'],
  ] as const)('ignores stale list %s/%s while the replacement list is pending', async (change, outcome) => {
    const api = client()
    const old = deferred<readonly GatewayRunOption[]>()
    const next = deferred<readonly GatewayRunOption[]>()
    api.listRuns.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const view = page(api)
    const signal = api.listRuns.mock.calls[0]![2]!
    if (change === 'actor') {
      view.rerender(<GatewayEvidencePage releases={[release()]} actorId="new-actor" preferredReleaseId={releaseId} client={api} />)
    } else fireEvent.click(screen.getByRole('button', { name: 'Run 목록 새로고침' }))
    expect(signal.aborted).toBe(true)
    await settle(() => outcome === 'resolve' ? old.resolve([run()]) : old.reject(new Error(canary)))
    expect(screen.getByRole('status')).toHaveTextContent('Run 목록을 불러오는 중')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await settle(() => next.resolve([run(otherRunId)]))
    expect(within(screen.getByLabelText('Gateway Run')).queryByRole('option', { name: new RegExp(runId) })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Gateway Run')).getByRole('option', { name: new RegExp(otherRunId) })).toBeInTheDocument()
  })

  it.each(['resolve', 'reject'] as const)('discards stale detail %s after Release selection while the new list is pending', async outcome => {
    const api = client()
    const old = deferred<GatewayRunEvidence>()
    const next = deferred<readonly GatewayRunOption[]>()
    api.loadRun.mockReturnValueOnce(old.promise)
    api.listRuns.mockResolvedValueOnce([run()]).mockReturnValueOnce(next.promise)
    page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    fireEvent.change(screen.getByLabelText('Gateway Release'), { target: { value: otherReleaseId } })
    expect(signal.aborted).toBe(true)
    await settle(() => outcome === 'resolve' ? old.resolve(evidence()) : old.reject(new Error(canary)))
    expect(screen.getByRole('status')).toHaveTextContent('Run 목록을 불러오는 중')
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await settle(() => next.resolve([]))
    expect(screen.getByRole('heading', { name: '저장된 Run이 없습니다' })).toBeVisible()
  })

  it('invalidates a removed preferred Release during inventory refresh and does not resurrect it when re-added', async () => {
    const api = client()
    const pending = deferred<GatewayRunEvidence>()
    api.loadRun.mockReturnValueOnce(pending.promise)
    const view = page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    view.rerender(<GatewayEvidencePage releases={[release(otherReleaseId)]} actorId={actorId} preferredReleaseId={releaseId} client={api} />)
    expect(screen.getByLabelText('Gateway Release')).toHaveValue('')
    expect(signal.aborted).toBe(true)
    await settle(() => pending.resolve(evidence()))
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
    view.rerender(<GatewayEvidencePage releases={[release(), release(otherReleaseId)]} actorId={actorId} preferredReleaseId={releaseId} client={api} />)
    expect(screen.getByLabelText('Gateway Release')).toHaveValue('')
    expect(api.listRuns).toHaveBeenCalledTimes(1)
  })

  it('preserves a valid selection across an inventory refresh but follows an external preferred Release change', async () => {
    const api = client()
    const view = page(api)
    await selectRun()
    await screen.findByText('캡처한 이력 범위 · head 8')
    view.rerender(<GatewayEvidencePage releases={[release(otherReleaseId), { ...release(), updatedAt: '2026-09-08T00:00:00Z' }]} actorId={actorId} preferredReleaseId={releaseId} client={api} />)
    expect(screen.getByText('캡처한 이력 범위 · head 8')).toBeVisible()
    expect(api.listRuns).toHaveBeenCalledTimes(1)
    view.rerender(<GatewayEvidencePage releases={[release(), release(otherReleaseId)]} actorId={actorId} preferredReleaseId={otherReleaseId} client={api} />)
    expect(screen.getByLabelText('Gateway Release')).toHaveValue(otherReleaseId)
    expect(screen.queryByText('캡처한 이력 범위 · head 8')).not.toBeInTheDocument()
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(otherReleaseId, actorId, expect.any(AbortSignal)))
  })

  it('discards old client results when the injected client changes', async () => {
    const api = client()
    const replacement = client()
    const old = deferred<GatewayRunEvidence>()
    api.loadRun.mockReturnValueOnce(old.promise)
    replacement.loadRun.mockResolvedValue(evidence({ headSequence: 17 }))
    const view = page(api)
    await selectRun()
    const signal = api.loadRun.mock.calls[0]![3]!
    view.rerender(<GatewayEvidencePage releases={[release()]} actorId={actorId} preferredReleaseId={releaseId} client={replacement} />)
    expect(signal.aborted).toBe(true)
    await selectRun()
    await screen.findByText('캡처한 이력 범위 · head 17')
    await settle(() => old.resolve(evidence()))
    expect(screen.getByText('캡처한 이력 범위 · head 17')).toBeVisible()
  })

  it.each([
    ['list', 'resolve'], ['list', 'reject'], ['detail', 'resolve'], ['detail', 'reject'],
  ] as const)('aborts pending %s on unmount and consumes late %s without writing storage or diagnostics', async (phase, outcome) => {
    const api = client()
    const pendingList = deferred<readonly GatewayRunOption[]>()
    const pendingDetail = deferred<GatewayRunEvidence>()
    if (phase === 'list') api.listRuns.mockReturnValueOnce(pendingList.promise)
    else api.loadRun.mockReturnValueOnce(pendingDetail.promise)
    const errorLog = vi.spyOn(console, 'error')
    const warningLog = vi.spyOn(console, 'warn')
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const view = page(api)
    if (phase === 'detail') await selectRun()
    const signal = phase === 'list' ? api.listRuns.mock.calls[0]![2]! : api.loadRun.mock.calls[0]![3]!
    view.unmount()
    expect(signal.aborted).toBe(true)
    await settle(() => {
      if (phase === 'list') {
        if (outcome === 'resolve') pendingList.resolve([run()])
        else pendingList.reject(new Error(canary))
      } else if (outcome === 'resolve') pendingDetail.resolve(evidence())
      else pendingDetail.reject(new Error(canary))
    })
    expect(view.container).toBeEmptyDOMElement()
    expect(errorLog).not.toHaveBeenCalled()
    expect(warningLog).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })
})

describe('Gateway stage and call details', () => {
  async function show(records: GatewayPolicyEvent[]) {
    const api = client()
    api.loadRun.mockResolvedValue(evidence({ events: records }))
    const view = page(api)
    await selectRun()
    await screen.findByText(`정책 판단 ${records.length}건 중 ${records.length}건 표시`)
    for (const summary of view.container.querySelectorAll('summary')) fireEvent.click(summary)
    return view
  }

  function stages(sequence: number) {
    return within(screen.getByRole('region', { name: `정책 이벤트 ${sequence} 평가 단계` }))
  }

  function stageRow(sequence: number, name: string) {
    return stages(sequence).getByText(name, { exact: true, selector: 'li strong' }).closest('li')!
  }

  it('shows OBJECT_SCOPE as primary and FIELD_SCOPE not evaluated without inventing per-stage PASS', async () => {
    await show([event(2, { stageDetails: enforce('OBJECT_SCOPE') })])
    expect(stages(2).getAllByRole('listitem')).toHaveLength(11)
    expect(stageRow(2, 'PREFLIGHT')).toHaveTextContent('평가됨')
    expect(stageRow(2, 'OBJECT_SCOPE')).toHaveTextContent('기록된 DENY')
    expect(stageRow(2, 'OBJECT_SCOPE')).toHaveTextContent('CUSTOMER_SCOPE_VIOLATION')
    for (const name of ['FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'WORKFLOW', 'HUMAN_BOUNDARY', 'TOOL_TRUST']) {
      expect(stageRow(2, name)).toHaveTextContent('미평가')
      expect(stageRow(2, name)).not.toHaveTextContent('FIELD_SCOPE_VIOLATION')
    }
    expect(stages(2).queryByText('PASS', { exact: true })).not.toBeInTheDocument()
    expect(stages(2).getByText('ENFORCE')).toBeVisible()
    expect(screen.getByRole('table', { name: '조회한 Run 기록' })).toHaveTextContent('BASELINE')
  })

  it('distinguishes a full evaluated ALLOW from terminal operational ERROR', async () => {
    await show([populatedEvent(2), event(8, { decision: 'ERROR', reasonCode: 'INVALID_REQUEST_SCHEMA',
      decisionReasonCode: 'INVALID_REQUEST_SCHEMA', stageDetails: enforce('PREFLIGHT') })])
    expect(stages(2).getAllByText('평가됨')).toHaveLength(11)
    expect(stages(2).queryByText('미평가', { exact: true })).not.toBeInTheDocument()
    expect(stageRow(8, 'PREFLIGHT')).toHaveTextContent('기록된 ERROR')
    expect(stageRow(8, 'PREFLIGHT')).toHaveTextContent('INVALID_REQUEST_SCHEMA')
    expect(stageRow(8, 'TOOL')).toHaveTextContent('미평가')
    expect(screen.getByText('ERROR · 운영 오류', { exact: true, selector: 'summary span' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps observed DENY and SKIPPED distinct from enforced PASS and a later enforced DENY', async () => {
    await show([event(2, { decision: 'ALLOW', reasonCode: 'BASELINE_ALLOW', decisionReasonCode: 'BASELINE_ALLOW', stageDetails: baseline() }),
      event(8, { reasonCode: 'INVALID_WORKFLOW_STAGE', decisionReasonCode: 'INVALID_WORKFLOW_STAGE', stageDetails: baseline(true) })])
    expect(screen.getByText('기록된 ALLOW', { exact: true })).toBeVisible()
    expect(stageRow(2, 'OBJECT_SCOPE')).toHaveTextContent('OBSERVED')
    expect(stageRow(2, 'OBJECT_SCOPE')).toHaveTextContent('DENY · 관측 위반')
    for (const name of ['FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'HUMAN_BOUNDARY']) {
      expect(stageRow(2, name)).toHaveTextContent('SKIPPED · 관측 검사 생략')
      expect(stageRow(2, name)).not.toHaveTextContent('PASS')
    }
    expect(stageRow(2, 'WORKFLOW')).toHaveTextContent('ENFORCED')
    expect(stageRow(2, 'WORKFLOW')).toHaveTextContent('PASS')
    expect(stageRow(8, 'WORKFLOW')).toHaveTextContent('ENFORCED')
    expect(stageRow(8, 'WORKFLOW')).toHaveTextContent('DENY · 집행 거절')
    expect(stageRow(8, 'WORKFLOW')).toHaveTextContent('INVALID_WORKFLOW_STAGE')
    expect(stageRow(8, 'HUMAN_BOUNDARY')).toHaveTextContent('미평가')
    expect(stages(8).getByText('관측 위반 기록')).toBeVisible()
    expect(stageRow(8, 'OBJECT_SCOPE')).toHaveTextContent('CUSTOMER_SCOPE_VIOLATION')
  })

  it('does not invent stage rows for absent or unreadable details or replace raw reason distinctions', async () => {
    await show([event(1, { reasonCode: '', decisionReasonCode: null }), event(2, { decision: 'ALLOW',
      reasonCode: 'TOP_REASON', decisionReasonCode: 'NESTED_REASON', stageDetails: { status: 'unreadable' } })])
    expect(stages(1).getByText('단계 상세 기록 없음')).toBeVisible()
    expect(stages(2).getByText('단계 상세 판독 불가')).toBeVisible()
    expect(stages(1).queryAllByRole('listitem')).toHaveLength(0)
    expect(stages(2).queryAllByRole('listitem')).toHaveLength(0)
    const first = screen.getByRole('table', { name: '정책 이벤트 1 기록' })
    expect(first).toHaveTextContent('빈 문자열')
    expect(first).toHaveTextContent('없음 또는 문자열이 아님')
    const second = screen.getByRole('table', { name: '정책 이벤트 2 기록' })
    expect(second).toHaveTextContent('TOP_REASON')
    expect(second).toHaveTextContent('NESTED_REASON')
    expect(screen.getByText('기록된 ALLOW', { exact: true })).toBeVisible()
  })

  it('shows recorded BASELINE all-PASS and terminal ERROR without labelling the error as an observed denial', async () => {
    const detail = baseline()
    if (detail.status !== 'valid' || detail.mode !== 'BASELINE') throw new Error('Invalid test fixture')
    await show([event(2, { decision: 'ALLOW', reasonCode: 'BASELINE_ALLOW', decisionReasonCode: 'BASELINE_ALLOW',
      stageDetails: { ...detail, observedFailure: null,
        stageOutcomes: detail.stageOutcomes.map(row => ({ ...row, outcomeType: 'PASS', reasonCode: null })) } }),
    event(5, { decision: 'ERROR', reasonCode: 'INVALID_REQUEST_SCHEMA', decisionReasonCode: 'INVALID_REQUEST_SCHEMA',
      stageDetails: { status: 'valid', mode: 'BASELINE', failedStage: 'PREFLIGHT', observedFailure: null,
        stageOutcomes: [{ stage: 'PREFLIGHT', enforcement: 'ENFORCED', outcomeType: 'ERROR', reasonCode: 'INVALID_REQUEST_SCHEMA' }] } })])
    expect(stages(2).getAllByText('PASS', { exact: true })).toHaveLength(11)
    expect(stageRow(5, 'PREFLIGHT')).toHaveTextContent('ERROR · 운영 오류')
    expect(stageRow(5, 'PREFLIGHT')).toHaveTextContent('INVALID_REQUEST_SCHEMA')
    expect(stageRow(5, 'TOOL')).toHaveTextContent('미평가')
    expect(stages(5).queryByText('관측 위반 기록')).not.toBeInTheDocument()
    expect(stageRow(5, 'PREFLIGHT')).not.toHaveTextContent('DENY')
  })

  it('renders at most three call references and makes missing or ambiguous relationships explicit', async () => {
    const linked = populatedEvent(2)
    const proposal = callRef('TOOL_PROPOSED', 4)
    const { container } = await show([linked,
      event(5, { callDetails: { status: 'valid', toolCallId: proposal.eventId, proposal, request: null, response: null } }),
      event(9), event(10, { callDetails: { status: 'unreadable', toolCallId: null } }),
      event(11, { callDetails: { status: 'ambiguous', toolCallId: proposal.eventId, counts: { policies: 2, requests: 3, responses: 1 } } })])
    const calls = (sequence: number) => within(screen.getByRole('region', { name: `정책 이벤트 ${sequence} 호출 출처` }))
    expect(calls(2).getAllByRole('definition')).toHaveLength(3)
    for (const type of ['TOOL_PROPOSED', 'TOOL_REQUEST', 'TOOL_RESPONSE']) expect(calls(2).getByText(type, { exact: true })).toBeVisible()
    expect(calls(5).getAllByRole('definition')).toHaveLength(1)
    expect(calls(5).getByText('캡처 범위에서 연결된 TOOL_REQUEST 기록 없음')).toBeVisible()
    expect(calls(5).getByText('캡처 범위에서 연결된 TOOL_RESPONSE 기록 없음')).toBeVisible()
    expect(calls(9).getByText('호출 출처 기록 없음')).toBeVisible()
    expect(calls(10).getByText('호출 출처 확인 불가')).toBeVisible()
    expect(calls(11).getByText('호출 출처 연결 모호함')).toBeVisible()
    expect(calls(11).getByText('동일 ID의 기록: 정책 2건 · 요청 3건 · 응답 1건')).toBeVisible()
    for (const sequence of [9, 10, 11]) expect(calls(sequence).queryAllByRole('definition')).toHaveLength(0)
    expect(container.innerHTML).not.toMatch(/ATTACK_BLOCKED|NORMAL_SUCCESS|no-call|no-leak|no-state-delta|격리 성공/)
  })

  it.each([50, 51, 101])('retains one table per card and bounded populated detail lists across %i records', async count => {
    const api = client()
    const records = Array.from({ length: count }, (_, i) => populatedEvent(2 + i * 4))
    api.loadRun.mockResolvedValue(evidence({ events: records, headSequence: count * 4 }))
    const { container } = page(api)
    await selectRun()
    await screen.findByText(`캡처한 이력 범위 · head ${count * 4}`)
    function check(size: number, start: number) {
      const cards = container.querySelectorAll('.event-list details')
      expect(cards).toHaveLength(size)
      expect(container.querySelectorAll('table')).toHaveLength(size + 1)
      for (const card of cards) {
        expect(card.querySelectorAll('table')).toHaveLength(1)
        expect(card.querySelectorAll('li')).toHaveLength(11)
        expect(card.querySelectorAll('dd')).toHaveLength(3)
      }
      expect(cards[0]).toHaveTextContent(records[start]!.eventId)
      expect(cards[size - 1]).toHaveTextContent(records[start + size - 1]!.eventId)
    }
    check(50, 0)
    for (let start = 50; start < count; start += 50) {
      fireEvent.click(screen.getByRole('button', { name: '다음 정책 판단 페이지' }))
      check(Math.min(50, count - start), start)
    }
    expect(api.loadRun).toHaveBeenCalledTimes(1)
    filter('판단 필터', 'ALLOW')
    check(50, 0)
    expect(api.loadRun).toHaveBeenCalledTimes(1)
  })

  it('projects real client HTTP history into stage and cross-page call details while discarding hostile unused fields', async () => {
    const id = (n: number) => `019903ac-abcd-7000-8000-${String(800 + n).padStart(12, '0')}`
    const digest = (n: number) => `sha256:${String(n).padStart(64, '0')}`
    const prefix = ['PREFLIGHT', 'TOOL', 'OPERATION', 'BUSINESS_CONTEXT', 'OBJECT_SCOPE']
    const rawEvent = (sequence: number, eventType: string, policyDecision: unknown = null) => ({
      schemaVersion: '1.0', eventId: id(sequence), traceId: id(30), runId, testCaseRunId: caseId,
      sequence, occurredAt: '2026-09-08T01:02:03Z', eventType, toolName: 'CUSTOMER_DATA_READ',
      reasonCode: null, policyDecision, input: { private: canary }, output: { private: canary },
      metadata: eventType === 'TOOL_PROPOSED' ? { private: canary } : { toolCallId: id(1), private: canary,
        deliveryState: 'PENDING', deliveredToAgent: false, successfulSecurityBlock: true },
      payloadDigest: digest(100 + sequence), eventHash: digest(sequence), prevEventHash: sequence === 1 ? null : digest(sequence - 1),
    })
    const events = [rawEvent(1, 'TOOL_PROPOSED'), rawEvent(2, 'POLICY_EVALUATED', {
      decisionType: 'ALLOW', allowed: true, reasonCode: 'ALLOW', evaluationMode: 'ENFORCE', evaluatedStages: [...gatewayStages], unused: canary }),
    rawEvent(3, 'TOOL_REQUEST'), rawEvent(4, 'TOOL_RESPONSE'),
    { ...rawEvent(5, 'POLICY_EVALUATED', { decisionType: 'DENY', allowed: false, reasonCode: 'CUSTOMER_SCOPE_VIOLATION',
      evaluationMode: 'ENFORCE', evaluatedStages: prefix, failedStage: 'OBJECT_SCOPE' }), metadata: { private: canary } },
    { ...rawEvent(6, 'POLICY_EVALUATED', { decisionType: 'ERROR', allowed: false, reasonCode: 'INVALID_REQUEST_SCHEMA',
      evaluationMode: 'ENFORCE', evaluatedStages: [canary], failedStage: canary }), metadata: { private: canary } }]
    const response = (data: unknown) => new Response(JSON.stringify({ data }))
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [run()], nextCursor: null }))
      .mockResolvedValueOnce(response({ ...run(), contractVersionId: versionId }))
      .mockResolvedValueOnce(response({ items: events.slice(0, 2), headSequence: 6, nextCursor: 2 }))
      .mockResolvedValueOnce(response({ items: events.slice(2), headSequence: 6, nextCursor: null }))
    const { container } = render(<GatewayEvidencePage releases={[release()]} actorId={actorId} preferredReleaseId={releaseId}
      client={new GatewayEvidenceClient('http://localhost:8080')} />)
    await selectRun()
    await screen.findByText('정책 판단 3건 중 3건 표시')
    for (const summary of container.querySelectorAll('summary')) fireEvent.click(summary)
    expect(stageRow(5, 'OBJECT_SCOPE')).toHaveTextContent('CUSTOMER_SCOPE_VIOLATION')
    expect(stageRow(5, 'FIELD_SCOPE')).toHaveTextContent('미평가')
    expect(stages(6).getByText('단계 상세 판독 불가')).toBeVisible()
    expect(screen.getByText('ERROR · 운영 오류', { exact: true, selector: 'summary span' })).toBeVisible()
    const calls = within(screen.getByRole('region', { name: '정책 이벤트 2 호출 출처' }))
    expect(calls.getAllByRole('definition')).toHaveLength(3)
    for (const sequence of [1, 3, 4]) expect(calls.getAllByText(id(sequence), { exact: true }).length).toBeGreaterThan(0)
    expect(container.innerHTML).not.toMatch(new RegExp(`${canary}|deliveryState|deliveredToAgent|successfulSecurityBlock|ATTACK_BLOCKED`))
    expect(fetch).toHaveBeenCalledTimes(4)
    filter('판단 필터', 'ERROR')
    expect(screen.getByText('정책 판단 3건 중 1건 표시')).toBeVisible()
    expect(fetch).toHaveBeenCalledTimes(4)
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe(actorId)
    }
  })
})
