import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { Release } from '../../api/contracts'
import type { GatewayRunOption } from './gatewayEvidence'
import { StoredReplayPolicyPage } from './StoredReplayPolicyPage'
import type { ReplayComparisonApi, ReplayPolicyEvent, StoredReplayPolicyComparison } from './replayComparison'

const releaseId = '019903ac-abcd-7000-8000-000000000001'
const otherReleaseId = '019903ac-abcd-7000-8000-000000000002'
const runId = '019903ac-abcd-7000-8000-000000000011'
const otherRunId = '019903ac-abcd-7000-8000-000000000012'
const staleRunId = '019903ac-abcd-7000-8000-000000000019'
const caseId = '019903ac-abcd-7000-8000-000000000020'
const hash = `sha256:${'a'.repeat(64)}`
const at = '2026-09-17T00:00:00Z'
const canary = 'SYNTHETIC_REPLAY_EXCLUDED_CANARY'
function release(id = releaseId): Release {
  return { id, agentId: caseId, version: id === releaseId ? '1.0' : '2.0', businessPurpose: '서류 검토', manifestSchemaVersion: '1.0',
    agentArtifactFingerprint: hash, releaseFingerprint: hash, safetyContractHash: null, lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW',
    revalidationReason: null, analyzedAt: null, lastTestedAt: null, createdAt: at, updatedAt: at }
}
function run(id = runId, selectedRelease = releaseId): GatewayRunOption { return { id, releaseId: selectedRelease, mode: 'SEAL_REPLAY', status: 'COMPLETED' } }
function event(index = 1, overrides: Partial<ReplayPolicyEvent> = {}): ReplayPolicyEvent {
  return { eventId: `019903ac-abcd-7000-8000-${String(index + 100).padStart(12, '0')}`, eventType: 'POLICY_EVALUATED',
    toolName: `TOOL_${index}`, occurredAt: at, payloadDigest: hash, decision: 'DENY', decisionEncoding: 'explicit', evaluationMode: 'ENFORCE',
    eventReasonCode: 'EVENT_REASON', policyReasonCode: 'POLICY_REASON', ...overrides }
}
function record(selectedRelease = releaseId, selectedRun = runId): StoredReplayPolicyComparison {
  return { releaseId: selectedRelease, replayRunId: selectedRun, replayLinkId: caseId, findingId: otherRunId, comparable: true, mismatchReasons: [],
    baseline: { runId: otherRunId, caseRunId: caseId, mode: 'BASELINE', runStatus: 'COMPLETED', caseStatus: 'PASSED', policyDecisions: [event(1, { toolName: 'BASELINE_TOOL', decision: 'ALLOW', decisionEncoding: 'legacy', evaluationMode: null })] },
    replay: { runId: selectedRun, caseRunId: caseId, mode: 'SEAL_REPLAY', runStatus: 'COMPLETED', caseStatus: 'PASSED', policyDecisions: [event(2, { toolName: 'CURRENT_TOOL' })] } }
}
function client() {
  return { listRuns: vi.fn<ReplayComparisonApi['listRuns']>().mockImplementation(async selectedRelease => [run(runId, selectedRelease), run(otherRunId, selectedRelease)]),
    comparison: vi.fn<ReplayComparisonApi['comparison']>().mockImplementation(async (release, run) => record(release, run)) }
}
const baseProps = { releases: [release(), release(otherReleaseId)], actorId: 'reader', preferredReleaseId: releaseId }
function page(api = client(), props: Partial<typeof baseProps> = {}) { return { api, ...render(<StoredReplayPolicyPage {...baseProps} client={api} {...props} />) } }
async function selectRun(id = runId) { fireEvent.change(await screen.findByLabelText('Replay Run'), { target: { value: id } }) }
function selectRelease(id: string) { fireEvent.change(screen.getByLabelText('Replay Release'), { target: { value: id } }) }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('C stored Replay policy page', () => {
  it('requires explicit Release and Run selections and reports the selected Release', async () => {
    const api = client(), onReleaseChange = vi.fn()
    render(<StoredReplayPolicyPage releases={baseProps.releases} actorId="reader" client={api} onReleaseChange={onReleaseChange} />)
    expect(screen.getByLabelText('Replay Release')).toHaveValue(''); expect(api.listRuns).not.toHaveBeenCalled()
    selectRelease(releaseId)
    expect(onReleaseChange).toHaveBeenCalledWith(releaseId)
    expect(await screen.findByLabelText('Replay Run')).toHaveValue(''); expect(api.comparison).not.toHaveBeenCalled()
    await selectRun()
    expect(await screen.findByText('서버 기록: 비교 가능')).toBeVisible()
    expect(api.comparison).toHaveBeenCalledWith(releaseId, runId, expect.any(AbortSignal))
  })
  it('does not invent an inventory selection from an absent preferred Release', () => {
    const { api } = page(client(), { preferredReleaseId: staleRunId })
    expect(screen.getByLabelText('Replay Release')).toHaveValue(''); expect(api.listRuns).not.toHaveBeenCalled()
  })
  it('keeps all recorded decision states, source references and distinct reasons without exposing excluded values', async () => {
    const data = record()
    const replayEvents = [event(4), event(3, { decision: 'ERROR' }), event(9, { decision: 'UNKNOWN', decisionEncoding: 'unreadable', toolName: null, eventReasonCode: null, policyReasonCode: '' })]
    const api = client()
    api.comparison.mockResolvedValue({ ...data, replay: { ...data.replay, policyDecisions: replayEvents } })
    Object.assign(replayEvents[0]!, { value: { private: canary }, apiResponses: canary, securityOutcome: canary, difference: { attackMitigated: true, private: canary } })
    page(api); await selectRun(); await screen.findByText('서버 기록: 비교 가능')
    const baseline = within(screen.getByRole('region', { name: 'Baseline 정책 기록' }))
    const replay = screen.getByRole('region', { name: 'Replay 정책 기록' })
    expect(baseline.getByText('기록된 ALLOW')).toBeVisible()
    expect(within(replay).getByText('기록된 DENY')).toBeVisible()
    expect(within(replay).getByText('ERROR · 운영 오류')).toBeVisible()
    expect(within(replay).getByText('UNKNOWN · 판독 불가')).toBeVisible()
    expect([...replay.querySelectorAll('summary strong')].map(node => node.textContent)).toEqual(['표시 1 · TOOL_4', '표시 2 · TOOL_3', '표시 3 · Tool 기록 없음'])
    fireEvent.click(within(replay).getByText('표시 1 · TOOL_4'))
    expect(within(replay).getAllByText('EVENT_REASON')[0]).toBeVisible()
    expect(within(replay).getAllByText('POLICY_REASON')[0]).toBeVisible()
    expect(within(replay).getByText(replayEvents[0]!.eventId)).toBeVisible()
    expect(within(replay).getAllByText(hash)[0]).toBeVisible()
    fireEvent.click(within(replay).getByText('표시 3 · Tool 기록 없음'))
    expect(within(replay).getByText('판단 형식 없음 또는 충돌')).toBeVisible()
    expect(within(replay).getByText('빈 문자열')).toBeVisible()
    fireEvent.click(baseline.getByText('표시 1 · BASELINE_TOOL'))
    expect(baseline.getByText('이전 형식: allowed 값')).toBeVisible()
    fireEvent.click(screen.getByText('비교 쌍 출처'))
    expect(screen.getByText('Replay Link ID')).toBeVisible()
    expect(document.body.textContent).not.toContain(canary)
    for (const value of ['ATTACK_BLOCKED', 'attackMitigated', 'Oracle', 'Event hash', 'Trace ID']) expect(document.body.textContent).not.toContain(value)
  })
  it('labels server non-comparability, preserves escaped reasons, and never turns it into an attack verdict', async () => {
    const api = client(), data = record()
    api.comparison.mockResolvedValue({ ...data, comparable: false, mismatchReasons: ['MODEL_CONFIG_MISMATCH', '<img src=x onerror=alert(1)>', ''] })
    page(api); await selectRun()
    expect(await screen.findByText('서버 기록: 비교 불가')).toBeVisible()
    expect(screen.getByText('MODEL_CONFIG_MISMATCH')).toBeVisible()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
    expect(screen.getByLabelText('저장된 비교 불일치 사유').querySelector('img')).toBeNull()
    expect(screen.queryByText('서버 기록: 비교 가능')).not.toBeInTheDocument()
    expect(screen.queryByText('ATTACK_BLOCKED')).not.toBeInTheDocument()
  })
  it.each([50, 51, 101])('paginates %i records independently on each side without dropping order or IDs', async count => {
    const api = client(), data = record(), events = Array.from({ length: count }, (_, i) => event(i + 1))
    api.comparison.mockResolvedValue({ ...data, baseline: { ...data.baseline, policyDecisions: events }, replay: { ...data.replay, policyDecisions: events } })
    page(api); await selectRun(); await screen.findByText('서버 기록: 비교 가능')
    const baseline = screen.getByRole('region', { name: 'Baseline 정책 기록' }), replay = screen.getByRole('region', { name: 'Replay 정책 기록' })
    expect(baseline.querySelectorAll('summary')).toHaveLength(50); expect(replay.querySelectorAll('summary')).toHaveLength(50)
    if (count === 50) { expect(screen.queryByRole('navigation', { name: 'Replay 정책 페이지' })).not.toBeInTheDocument(); return }
    expect(within(replay).getByRole('button', { name: '이전 Replay 정책 페이지' })).toBeDisabled()
    for (let current = 1; current < Math.ceil(count / 50); current++) fireEvent.click(within(replay).getByRole('button', { name: '다음 Replay 정책 페이지' }))
    expect(replay.querySelectorAll('summary')).toHaveLength(1)
    expect(within(replay).getByRole('button', { name: '다음 Replay 정책 페이지' })).toBeDisabled()
    fireEvent.click(within(replay).getByText(`표시 ${count} · TOOL_${count}`))
    expect(within(replay).getByText(events[count - 1]!.eventId)).toBeVisible()
    expect(within(baseline).getByText('표시 1 · TOOL_1')).toBeVisible()
    fireEvent.click(within(baseline).getByRole('button', { name: '다음 Baseline 정책 페이지' }))
    expect(within(baseline).getByText('표시 51 · TOOL_51')).toBeVisible()
    expect(within(replay).getByText(`표시 ${count} · TOOL_${count}`)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '비교 기록 새로고침' }))
    await screen.findByText('서버 기록: 비교 가능')
    expect(within(screen.getByRole('region', { name: 'Replay 정책 기록' })).getByText('표시 1 · TOOL_1')).toBeVisible()
  })
  it('keeps empty policy lists empty and does not infer a decision', async () => {
    const api = client(), data = record()
    api.comparison.mockResolvedValue({ ...data, baseline: { ...data.baseline, policyDecisions: [] }, replay: { ...data.replay, policyDecisions: [] } })
    page(api); await selectRun()
    expect(await screen.findAllByRole('heading', { name: '정책 판단 기록이 없습니다' })).toHaveLength(2)
    expect(screen.queryByText('기록된 ALLOW')).not.toBeInTheDocument(); expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
  it('shows safe listing failure and empty state, and retries without selecting a Run', async () => {
    const api = client(); api.listRuns.mockRejectedValueOnce(new Error(canary)).mockResolvedValueOnce([])
    page(api)
    expect(await screen.findByRole('alert')).toHaveTextContent('Replay Run 목록을 조회하지 못했습니다.')
    expect(document.body.textContent).not.toContain(canary)
    fireEvent.click(screen.getByRole('button', { name: 'Replay Run 목록 새로고침' }))
    expect(await screen.findByRole('heading', { name: '저장된 Replay Run이 없습니다' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Replay Run 목록 새로고침' }))
    expect(await screen.findByLabelText('Replay Run')).toHaveValue(''); expect(api.comparison).not.toHaveBeenCalled()
  })
  it('shows loading and a safe comparison error, then retries the exact pair', async () => {
    const api = client(), pending = deferred<StoredReplayPolicyComparison>(); api.comparison.mockReturnValueOnce(pending.promise)
    page(api); await selectRun()
    expect(screen.getByText('저장된 비교 기록을 불러오는 중')).toBeVisible()
    await act(async () => { pending.reject(new Error(canary)); await pending.promise.catch(() => {}) })
    expect(screen.getByRole('alert')).toHaveTextContent('저장된 비교를 조회하지 못했습니다.')
    expect(document.body.textContent).not.toContain(canary)
    fireEvent.click(screen.getByRole('button', { name: '비교 기록 새로고침' }))
    expect(await screen.findByText('서버 기록: 비교 가능')).toBeVisible(); expect(api.comparison).toHaveBeenCalledTimes(2)
  })

  const scopes = ['run', 'release', 'actor', 'client', 'refresh', 'list refresh', 'removed release', 'unmount'] as const
  it.each(scopes.flatMap(scope => ['success', 'failure'].map(outcome => [scope, outcome] as const)))('rejects late comparison %s / %s after cancellation', async (scope, outcome) => {
    const api = client(), pending = deferred<StoredReplayPolicyComparison>(); api.comparison.mockReturnValueOnce(pending.promise)
    const view = page(api); await selectRun()
    const signal = api.comparison.mock.calls[0]![2]!
    if (scope === 'run') await selectRun(otherRunId)
    if (scope === 'release') selectRelease(otherReleaseId)
    if (scope === 'actor') view.rerender(<StoredReplayPolicyPage {...baseProps} client={api} actorId="next-reader" />)
    if (scope === 'client') view.rerender(<StoredReplayPolicyPage {...baseProps} client={client()} />)
    if (scope === 'refresh') fireEvent.click(screen.getByRole('button', { name: '비교 기록 새로고침' }))
    if (scope === 'list refresh') fireEvent.click(screen.getByRole('button', { name: 'Replay Run 목록 새로고침' }))
    if (scope === 'removed release') view.rerender(<StoredReplayPolicyPage {...baseProps} releases={[]} client={api} />)
    if (scope === 'unmount') view.unmount()
    expect(signal.aborted).toBe(true)
    const stale = record(); const marked = { ...stale, replay: { ...stale.replay, policyDecisions: [event(5, { toolName: 'STALE_COMPARISON' })] } }
    await act(async () => { if (outcome === 'success') pending.resolve(marked); else pending.reject(new Error(canary)); await pending.promise.catch(() => {}) })
    expect(screen.queryByText(/STALE_COMPARISON/)).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(canary)
    if (scope === 'run' || scope === 'refresh') expect(screen.getByText('표시 1 · CURRENT_TOOL')).toBeVisible()
    else expect(screen.queryByText('서버 기록: 비교 가능')).not.toBeInTheDocument()
  })
  const listScopes = ['release', 'preferred release', 'actor', 'client', 'refresh', 'removed release', 'unmount'] as const
  it.each(listScopes.flatMap(scope => ['success', 'failure'].map(outcome => [scope, outcome] as const)))('rejects late listing %s / %s after cancellation', async (scope, outcome) => {
    const api = client(), pending = deferred<readonly GatewayRunOption[]>(); api.listRuns.mockReturnValueOnce(pending.promise)
    const view = page(api), signal = api.listRuns.mock.calls[0]![2]!
    expect(screen.getByText('Replay Run 목록을 불러오는 중')).toBeVisible()
    if (scope === 'release') selectRelease(otherReleaseId)
    if (scope === 'preferred release') view.rerender(<StoredReplayPolicyPage {...baseProps} preferredReleaseId={otherReleaseId} client={api} />)
    if (scope === 'actor') view.rerender(<StoredReplayPolicyPage {...baseProps} actorId="next-reader" client={api} />)
    if (scope === 'client') view.rerender(<StoredReplayPolicyPage {...baseProps} client={client()} />)
    if (scope === 'refresh') fireEvent.click(screen.getByRole('button', { name: 'Replay Run 목록 새로고침' }))
    if (scope === 'removed release') view.rerender(<StoredReplayPolicyPage {...baseProps} releases={[]} client={api} />)
    if (scope === 'unmount') view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { if (outcome === 'success') pending.resolve([run(staleRunId)]); else pending.reject(new Error(canary)); await pending.promise.catch(() => {}) })
    expect(screen.queryByRole('option', { name: new RegExp(staleRunId) })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain(canary)
    expect(api.comparison).not.toHaveBeenCalled()
  })
})
