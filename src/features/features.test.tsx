import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api, RunStartError } from '../api/client'
import type { Agent, Attestation, Fingerprint, JsonValue, PendingRecovery, Release, TestRun, ValidationResult } from '../api/contracts'
import type { ReviewerSession } from './policy/reviewerSession'
import { AgentsPage, ReleasesPage } from './AgentsReleases'
import { AuditPage } from './Audit'
import { EvidencePage } from './Evidence'
import { ExecutionPage } from './Execution'
import { RecoveryPage } from './Recovery'

const agent: Agent = {
  id: '0198f200-0000-7000-8000-000000000001',
  agentKey: 'loan-agent',
  name: 'Loan Agent',
  purposeSummary: 'Document completeness only',
  status: 'ACTIVE',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const release: Release = {
  id: '0198f200-0000-7000-8000-000000000002',
  agentId: agent.id,
  version: '1.0.0',
  businessPurpose: 'Document completeness only',
  manifestSchemaVersion: '1.0',
  agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
  releaseFingerprint: `sha256:${'b'.repeat(64)}`,
  safetyContractHash: null,
  lifecycleState: 'BLOCKED',
  effectiveStatus: 'BLOCKED',
  revalidationReason: null,
  analyzedAt: '2026-09-01T00:00:00Z',
  lastTestedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}
const effectRunId = '0198f200-0000-7000-8000-000000000010'

function runReviewer(overrides: Partial<ReviewerSession> = {}): ReviewerSession {
  return {
    kind: 'session', actorId: 'verified-run-reviewer',
    workspaceId: '0198f1e2-0000-7000-8000-000000000001', role: 'AI_SECURITY_REVIEWER',
    csrfToken: 'PRIVATE_CSRF_CANARY', expiresAt: Math.floor(Date.now() / 1000) + 1200,
    ...overrides,
  }
}

function readyRunStart() {
  vi.spyOn(api, 'listTestSuites').mockResolvedValue([
    { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
  ])
  vi.spyOn(api, 'listTestRuns').mockResolvedValue([])
  vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
}

function effectAttestation(document: Record<string, JsonValue>, stale = false): Attestation {
  return {
    id: '0198f200-0000-7000-8000-000000000003',
    releaseDecisionId: '0198f200-0000-7000-8000-000000000004',
    document,
    documentHash: `sha256:${'c'.repeat(64)}`,
    generatedAt: '2026-09-01T00:00:00Z',
    disclaimerVersion: 'finsec-internal/v1',
    stale,
    invalidation: stale ? { reason: 'MODEL_CHANGE' } : null,
  }
}

function observedCounts(exfiltration: JsonValue): JsonValue[] {
  return [{
    metric: 'UnauthorizedRecordExposureCount', calculatorVersion: 'mvp-metrics/1',
    status: 'AVAILABLE', value: 2, sourceTestRunIds: [effectRunId],
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
  }, exfiltration]
}

describe('Role A feature consoles', () => {
  it('registers an Agent through the idempotent API client', async () => {
    const create = vi.spyOn(api, 'createAgent').mockResolvedValue(agent)
    const changed = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AgentsPage agents={[]} actorId="role-a-console" onChanged={changed} onSelect={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '+ Agent 등록' }))
    await user.type(screen.getByLabelText('Agent key'), 'loan-agent')
    await user.type(screen.getByLabelText('표시 이름'), 'Loan Agent')
    await user.type(screen.getByLabelText('업무 목적'), 'Document completeness only')
    await user.click(screen.getByRole('button', { name: '등록' }))

    expect(create).toHaveBeenCalledWith({
      agentKey: 'loan-agent',
      name: 'Loan Agent',
      purposeSummary: 'Document completeness only',
    }, 'role-a-console')
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  })

  it('rejects malformed manifest JSON before it reaches the backend', async () => {
    vi.spyOn(api, 'listReleases').mockResolvedValue([])
    const create = vi.spyOn(api, 'createRelease')
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(screen.getByLabelText('Release manifest JSON'))
    await user.paste('{not-json')
    await user.click(screen.getByRole('button', { name: 'Draft Release 등록' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Manifest JSON 문법을 확인하세요.')
    expect(create).not.toHaveBeenCalled()
  })

  it('renders the backend manifest issue path contract', async () => {
    vi.spyOn(api, 'listReleases').mockResolvedValue([release])
    vi.spyOn(api, 'validateRelease').mockResolvedValue({
      valid: false,
      issues: [{ path: '/model/parameters/temperature', code: 'TYPE', severity: 'ERROR', message: 'temperature must be a JSON number' }],
    })
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    await user.click(screen.getByRole('button', { name: 'Manifest 검증' }))

    expect(await screen.findByText('/model/parameters/temperature')).toBeInTheDocument()
    expect(screen.getByText('temperature must be a JSON number')).toBeInTheDocument()
  })

  it.each([
    ['TESTING', 'REMEDIATION'],
    ['REMEDIATION', 'REMEDIATION'],
    ['DECISION_PENDING', 'DECISION_PENDING'],
  ] as const)('shows Release lifecycle %s and effective status %s separately', async (lifecycleState, effectiveStatus) => {
    vi.spyOn(api, 'listReleases').mockResolvedValue([{ ...release, lifecycleState, effectiveStatus }])
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    const detail = document.querySelector('.release-detail')
    expect(detail).not.toBeNull()
    const lifecycleRow = within(detail as HTMLElement).getByText('Release 단계').closest('div')
    const effectiveRow = within(detail as HTMLElement).getByText('현재 유효 상태').closest('div')
    expect(lifecycleRow?.querySelector('dd')).toHaveTextContent(lifecycleState.replaceAll('_', ' '))
    expect(effectiveRow?.querySelector('dd')).toHaveTextContent(effectiveStatus.replaceAll('_', ' '))
    expect(lifecycleRow?.querySelector('.status')).toHaveClass('status--neutral')
    expect(effectiveRow?.querySelector('.status')).toHaveClass('status--neutral')
    expect(within(detail as HTMLElement).queryByText('최종 판정')).not.toBeInTheDocument()
  })

  it('discards a late validation result after another Release is selected', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    vi.spyOn(api, 'listReleases').mockResolvedValue([release, nextRelease])
    let complete!: (result: ValidationResult) => void
    vi.spyOn(api, 'validateRelease').mockReturnValue(new Promise(resolve => { complete = resolve }))
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    await user.click(screen.getByRole('button', { name: 'Manifest 검증' }))
    await user.click(screen.getByRole('button', { name: /v2\.0\.0/ }))
    await act(async () => complete({ valid: false, issues: [{ path: '/wrong-release', code: 'TYPE', severity: 'ERROR', message: 'Only Release A failed' }] }))

    expect(screen.getByRole('heading', { name: 'v2.0.0' })).toBeInTheDocument()
    expect(screen.queryByText('/wrong-release')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manifest 검증' })).toBeEnabled()
  })

  it('discards a late fingerprint when the selected Release changes', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    vi.spyOn(api, 'listReleases').mockResolvedValue([release, nextRelease])
    let complete!: (result: Fingerprint) => void
    vi.spyOn(api, 'fingerprint').mockReturnValue(new Promise(resolve => { complete = resolve }))
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    await user.click(screen.getByRole('button', { name: 'Fingerprint 확인' }))
    await user.click(screen.getByRole('button', { name: /v2\.0\.0/ }))
    await act(async () => complete({ canonicalizationVersion: '1.0', agentArtifactFingerprint: 'sha256:old', releaseFingerprint: 'sha256:old', safetyContractHash: null, components: { staleComponent: 'sha256:old' } }))

    expect(screen.getByRole('heading', { name: 'v2.0.0' })).toBeInTheDocument()
    expect(screen.queryByText('staleComponent')).not.toBeInTheDocument()
  })

  it('ignores the previous Agent inventory when its response arrives after switching', async () => {
    const otherAgent = { ...agent, id: 'agent-2', name: 'Other Agent', agentKey: 'other-agent' }
    const otherRelease = { ...release, id: 'release-3', agentId: otherAgent.id, version: '3.0.0' }
    let complete!: (result: Release[]) => void
    vi.spyOn(api, 'listReleases').mockImplementation(id => id === agent.id
      ? new Promise(resolve => { complete = resolve })
      : Promise.resolve([otherRelease]))
    const inventory = vi.fn()
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent, otherAgent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={inventory} />)

    await user.selectOptions(screen.getByLabelText('Agent'), otherAgent.id)
    expect(await screen.findByRole('button', { name: /v3\.0\.0/ })).toBeInTheDocument()
    await act(async () => complete([release]))

    expect(screen.queryByRole('button', { name: /v1\.0\.0/ })).not.toBeInTheDocument()
    expect(inventory).toHaveBeenCalledTimes(1)
    expect(inventory).toHaveBeenCalledWith([otherRelease], otherAgent.id)
  })

  it('does not replace a newer explicit Release selection with a late create result', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    const createdRelease = { ...release, id: 'release-created', version: '3.0.0' }
    vi.spyOn(api, 'listReleases').mockResolvedValue([release, nextRelease, createdRelease])
    let complete!: (result: Release) => void
    vi.spyOn(api, 'createRelease').mockReturnValue(new Promise(resolve => { complete = resolve }))
    let completeValidation!: (result: ValidationResult) => void
    vi.spyOn(api, 'validateRelease').mockReturnValue(new Promise(resolve => { completeValidation = resolve }))
    const onReleaseSelect = vi.fn()
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent}
      onReleaseInventory={vi.fn()} onReleaseSelect={onReleaseSelect} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    await user.click(screen.getByLabelText('Release manifest JSON'))
    await user.paste('{}')
    await user.click(screen.getByRole('button', { name: 'Draft Release 등록' }))
    await user.click(screen.getByRole('button', { name: /v2\.0\.0/ }))
    await user.click(screen.getByRole('button', { name: 'Manifest 검증' }))
    await act(async () => complete(createdRelease))

    expect(screen.getByRole('heading', { name: 'v2.0.0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manifest 검증' })).toBeDisabled()
    expect(onReleaseSelect).toHaveBeenLastCalledWith(nextRelease)
    await act(async () => completeValidation({ valid: true, issues: [] }))
    expect(screen.getByText('✓ Manifest valid')).toBeInTheDocument()
  })

  it('does not show a late create failure beneath a newly selected Release', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    vi.spyOn(api, 'listReleases').mockResolvedValue([release, nextRelease])
    let rejectCreate!: (error: Error) => void
    vi.spyOn(api, 'createRelease').mockReturnValue(new Promise((_, reject) => { rejectCreate = reject }))
    const user = userEvent.setup()
    render(<ReleasesPage agents={[agent]} actorId="role-a-console" initialAgent={agent} onReleaseInventory={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /v1\.0\.0/ }))
    await user.click(screen.getByLabelText('Release manifest JSON'))
    await user.paste('{}')
    await user.click(screen.getByRole('button', { name: 'Draft Release 등록' }))
    await user.click(screen.getByRole('button', { name: /v2\.0\.0/ }))
    await act(async () => rejectCreate(new Error('old create failed')))

    expect(screen.getByRole('heading', { name: 'v2.0.0' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loads ready suites and recent runs for the active release in execution console', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
      { id: 'suite-2', releaseId: release.id, version: '1.1', status: 'READY', suiteHash: 'sha256:suite-2', caseCount: 8 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([
      { id: 'run-1', releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE', status: 'COMPLETED', totalCases: 12, completedCases: 12, operationalErrorCount: 0, latestSequence: 20, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:02:00Z' },
    ])
    vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    expect(await screen.findByRole('option', { name: /1\.0 · READY · 12 cases/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /BASELINE · COMPLETED · 12\/12/ })).toBeInTheDocument()
  })

  it('applies run filters and refreshes recent runs from the current release', async () => {
    const listSuites = vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    const listRuns = vi.spyOn(api, 'listTestRuns').mockResolvedValue([
      { id: 'run-1', releaseId: release.id, suiteId: 'suite-1', mode: 'HELD_OUT', status: 'COMPLETED', totalCases: 12, completedCases: 12, operationalErrorCount: 0, latestSequence: 20, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:02:00Z' },
    ])
    vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
    const user = userEvent.setup()
    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    await user.selectOptions(screen.getByLabelText('Run mode filter'), 'HELD_OUT')
    await user.selectOptions(screen.getByLabelText('Run status filter'), 'COMPLETED')
    await user.click(screen.getByRole('button', { name: '목록 새로고침' }))

      expect(listSuites).toHaveBeenCalledWith(release.id, 'role-b-console', { status: 'READY', limit: 20 })
    expect(listRuns).toHaveBeenLastCalledWith(release.id, 'role-b-console', { mode: 'HELD_OUT', status: 'COMPLETED', limit: 10 })
  })

  it('requires a READY suite before starting a B run', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'DRAFT', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([])
    vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
    const start = vi.spyOn(api, 'startTestRun')
    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled()
    expect(start).not.toHaveBeenCalled()
  })

  it('requires a confirmed reviewer session for a READY LIVE Run and uses its actor', async () => {
    readyRunStart()
    const session = runReviewer()
    const connect = vi.spyOn(api, 'connectRunReviewerSession').mockResolvedValue(session)
    const start = vi.spyOn(api, 'startTestRun').mockRejectedValue(new RunStartError('rejected', 400))
    const user = userEvent.setup()
    render(<ExecutionPage releases={[release]} actorId="untrusted-page-actor" />)

    expect(await screen.findByRole('option', { name: /1\.0 · READY/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled()
    expect(screen.getByText(/HTTPS API 연결이 필요합니다/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Run 검토자 키'), 'PRIVATE_REVIEWER_KEY_CANARY')
    await user.click(screen.getByRole('button', { name: '검토자 세션 연결' }))
    await waitFor(() => expect(screen.getByText('verified-run-reviewer')).toBeInTheDocument())
    expect(connect).toHaveBeenCalledWith('PRIVATE_REVIEWER_KEY_CANARY')
    expect(screen.getByLabelText('Run 검토자 키')).toHaveValue('')
    expect(document.body.innerHTML).not.toContain('PRIVATE_REVIEWER_KEY_CANARY')
    expect(document.body.innerHTML).not.toContain('PRIVATE_CSRF_CANARY')
    expect(screen.getByRole('button', { name: '실행 시작' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '실행 시작' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    const [input, credential, idempotencyKey] = start.mock.calls[0]!
    expect(credential).toBe(session)
    expect(input).toMatchObject({ releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE' })
    expect(idempotencyKey).toMatch(/^test-run-start-[0-9a-f-]{36}$/)
  })

  it('retains an unknown Run body and key across form changes for explicit same-key retry', async () => {
    readyRunStart()
    const connect = vi.spyOn(api, 'connectRunReviewerSession').mockResolvedValue(runReviewer())
    const start = vi.spyOn(api, 'startTestRun')
      .mockRejectedValueOnce(new RunStartError('unknown'))
      .mockRejectedValueOnce(new RunStartError('rejected', 400))
    const user = userEvent.setup()
    render(<ExecutionPage releases={[release]} actorId="untrusted-page-actor" />)

    await screen.findByRole('option', { name: /1\.0 · READY/ })
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 시작' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '실행 시작' }))
    const retry = await screen.findByRole('button', { name: '같은 요청 다시 확인' })
    expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Run mode'), 'HELD_OUT')
    connect.mockResolvedValueOnce(runReviewer({ actorId: 'different-reviewer' }))
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByText('different-reviewer')).toBeInTheDocument())
    expect(retry).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(retry).toBeEnabled())
    await user.click(retry)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0])
    expect(start.mock.calls[1]![1]).toBe(start.mock.calls[0]![1])
    expect(start.mock.calls[1]![2]).toBe(start.mock.calls[0]![2])
    expect(start.mock.calls[1]![0].mode).toBe('BASELINE')
    await waitFor(() => expect(screen.queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument())
  })

  it('clears a rejected or expired Run session and requires explicit reconnect', async () => {
    readyRunStart()
    const connect = vi.spyOn(api, 'connectRunReviewerSession')
      .mockResolvedValueOnce(runReviewer())
      .mockResolvedValueOnce(runReviewer({ csrfToken: 'NEW_PRIVATE_CSRF' }))
      .mockResolvedValueOnce(runReviewer({ expiresAt: Math.floor(Date.now() / 1000) - 1 }))
    const start = vi.spyOn(api, 'startTestRun').mockRejectedValueOnce(new RunStartError('session', 403))
    const user = userEvent.setup()
    render(<ExecutionPage releases={[release]} actorId="untrusted-page-actor" />)

    await screen.findByRole('option', { name: /1\.0 · READY/ })
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 시작' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '실행 시작' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled())
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/다시 연결해 주세요/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 시작' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled())
    expect(connect).toHaveBeenCalledTimes(3)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('ignores a late reviewer connection after the Execution page unmounts', async () => {
    readyRunStart()
    let resolveOld!: (session: ReviewerSession) => void
    const connect = vi.spyOn(api, 'connectRunReviewerSession')
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(runReviewer({ actorId: 'new-reviewer' }))
    const user = userEvent.setup()
    const old = render(<ExecutionPage releases={[release]} actorId="role-a-console" />)
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    old.unmount()
    render(<ExecutionPage releases={[release]} actorId="role-a-console" />)
    await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
    await waitFor(() => expect(screen.getByText('new-reviewer')).toBeInTheDocument())
    await act(async () => resolveOld(runReviewer({ actorId: 'stale-reviewer' })))
    expect(screen.getByText('new-reviewer')).toBeInTheDocument()
    expect(screen.queryByText('stale-reviewer')).not.toBeInTheDocument()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('loads replay comparisons for the current release', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([])
    const listReplayComparisons = vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([
      { baselineRunId: 'run-baseline', replayRunId: 'run-replay', category: 'FA-03', comparable: false, mismatchReasons: ['MODEL_CONFIG_MISMATCH'] },
    ])

    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    expect(await screen.findByText('FA-03')).toBeInTheDocument()
    expect(screen.getByText(/MODEL_CONFIG_MISMATCH/)).toBeInTheDocument()
    expect(listReplayComparisons).toHaveBeenCalledWith(release.id, 'role-b-console')
  })

  it('opens the replay run directly from a replay comparison item', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([])
    vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([
      { baselineRunId: 'run-baseline', replayRunId: 'run-replay', category: 'FA-03', comparable: false, mismatchReasons: ['MODEL_CONFIG_MISMATCH'] },
    ])
    vi.spyOn(api, 'testRun').mockResolvedValue({
      id: 'run-replay', releaseId: release.id, suiteId: 'suite-1', contractVersionId: null, mode: 'SEAL_REPLAY', status: 'COMPLETED',
      agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`, releaseFingerprint: `sha256:${'2'.repeat(64)}`, fixtureVersion: '1.0', fixtureDigest: `sha256:${'3'.repeat(64)}`,
      totalCases: 12, completedCases: 12, operationalErrorCount: 0, latestSequence: 20, latestEventType: 'RUN_COMPLETED',
      eventHeadHash: `sha256:${'4'.repeat(64)}`, summary: {}, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:02:00Z', createdAt: '2026-09-01T00:00:00Z',
    })
    vi.spyOn(api, 'eventHistory').mockResolvedValue({ items: [], headSequence: 20, nextCursor: null })
    vi.spyOn(api, 'verifyEventChain').mockResolvedValue({ runId: 'run-replay', valid: true, eventCount: 0, firstInvalidSequence: null, headHash: `sha256:${'4'.repeat(64)}` })
    vi.spyOn(api, 'runOracleResults').mockResolvedValue([])
    vi.spyOn(api, 'runFindings').mockResolvedValue([])
    const user = userEvent.setup()

    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    await user.click(await screen.findByRole('button', { name: 'Replay run 열기' }))

    expect(screen.getByLabelText('Test Run ID')).toHaveValue('run-replay')
    expect(await screen.findByText(/execution events/)).toBeInTheDocument()
  })

  it('filters oracle and finding results by the selected classifications', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([
      { id: 'run-1', releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE', status: 'COMPLETED', totalCases: 12, completedCases: 12, operationalErrorCount: 0, latestSequence: 20, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:02:00Z' },
    ])
    vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
    vi.spyOn(api, 'testRun').mockResolvedValue({
      id: 'run-1', releaseId: release.id, suiteId: 'suite-1', contractVersionId: null, mode: 'BASELINE', status: 'COMPLETED',
      agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`, releaseFingerprint: `sha256:${'2'.repeat(64)}`, fixtureVersion: '1.0', fixtureDigest: `sha256:${'3'.repeat(64)}`,
      totalCases: 12, completedCases: 12, operationalErrorCount: 0, latestSequence: 20, latestEventType: 'RUN_COMPLETED',
      eventHeadHash: `sha256:${'4'.repeat(64)}`, summary: {}, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:02:00Z', createdAt: '2026-09-01T00:00:00Z',
    })
    vi.spyOn(api, 'eventHistory').mockResolvedValue({ items: [], headSequence: 20, nextCursor: null })
    vi.spyOn(api, 'verifyEventChain').mockResolvedValue({ runId: 'run-1', valid: true, eventCount: 0, firstInvalidSequence: null, headHash: `sha256:${'4'.repeat(64)}` })
    vi.spyOn(api, 'runOracleResults').mockResolvedValue([
      { id: 'oracle-1', runId: 'run-1', testCaseRunId: 'case-1', sourceEventId: null, oracleType: 'EXFILTRATION', oracleVersion: '1.0', outcome: 'ATTACK_SUCCESS', reasonCode: 'EXFIL', invariantId: 'INV-01', evidence: {}, evidenceDigest: `sha256:${'5'.repeat(64)}`, evaluatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'oracle-2', runId: 'run-1', testCaseRunId: 'case-2', sourceEventId: null, oracleType: 'NORMAL_TASK', oracleVersion: '1.0', outcome: 'NORMAL_SUCCESS', reasonCode: 'OK', invariantId: 'INV-02', evidence: {}, evidenceDigest: `sha256:${'6'.repeat(64)}`, evaluatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
    ])
    vi.spyOn(api, 'runFindings').mockResolvedValue([
      { id: 'finding-1', releaseId: release.id, sourceOracleResultId: 'oracle-1', category: 'FA-04', severity: 'HIGH', title: 'Outbound exfiltration', status: 'OPEN', violatedInvariant: 'INV-01', rootCause: {}, findingGroupKey: null, firstSeenRunId: 'run-1', latestSeenRunId: 'run-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'finding-2', releaseId: release.id, sourceOracleResultId: 'oracle-2', category: 'FA-02', severity: 'LOW', title: 'Benign note', status: 'TRIAGED', violatedInvariant: 'INV-02', rootCause: {}, findingGroupKey: null, firstSeenRunId: 'run-1', latestSeenRunId: 'run-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    ])
    const user = userEvent.setup()

    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    await user.click(await screen.findByRole('button', { name: 'Run 조회' }))
    await user.selectOptions(screen.getByLabelText('Oracle outcome filter'), 'ATTACK_SUCCESS')
    await user.selectOptions(screen.getByLabelText('Finding category filter'), 'FA-04')
    await user.selectOptions(screen.getByLabelText('Finding severity filter'), 'HIGH')
    await user.selectOptions(screen.getByLabelText('Finding status filter'), 'OPEN')

    expect(screen.getByText('EXFILTRATION')).toBeInTheDocument()
    expect(screen.queryByText('NORMAL_TASK')).not.toBeInTheDocument()
    expect(screen.getByText('FA-04 · Outbound exfiltration')).toBeInTheDocument()
    expect(screen.queryByText('FA-02 · Benign note')).not.toBeInTheDocument()
  })

  it('cancels an active Run through the confirmed reviewer session', async () => {
    const nativeEventSource = globalThis.EventSource
    class MockEventSource {
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null
      constructor(public url: string) {}
      addEventListener() {}
      close() {}
    }
    // @ts-expect-error test-only EventSource replacement
    globalThis.EventSource = MockEventSource
    const activeRun: TestRun = {
      id: effectRunId, releaseId: release.id, suiteId: 'suite-1', contractVersionId: null,
      mode: 'BASELINE', status: 'RUNNING', agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`,
      releaseFingerprint: `sha256:${'2'.repeat(64)}`, fixtureVersion: '1.0',
      fixtureDigest: `sha256:${'3'.repeat(64)}`, totalCases: 12, completedCases: 5,
      operationalErrorCount: 0, latestSequence: 10, latestEventType: 'RUN_STARTED',
      eventHeadHash: `sha256:${'4'.repeat(64)}`, summary: {},
      startedAt: '2026-09-01T00:00:00Z', completedAt: null, createdAt: '2026-09-01T00:00:00Z',
    }
    const cancelledRun: TestRun = {
      ...activeRun, status: 'CANCELLED', completedAt: '2026-09-01T00:01:00Z',
      latestSequence: 11, latestEventType: 'RUN_CANCEL_REQUESTED', summary: { cancelledCases: 7 },
    }

    try {
      vi.spyOn(api, 'listTestSuites').mockResolvedValue([
        { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
      ])
      vi.spyOn(api, 'listTestRuns').mockResolvedValue([{
        id: effectRunId, releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE', status: 'RUNNING',
        totalCases: 12, completedCases: 5, operationalErrorCount: 0, latestSequence: 10,
        startedAt: '2026-09-01T00:00:00Z', completedAt: null,
      }])
      vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
      vi.spyOn(api, 'testRun').mockResolvedValue(activeRun)
      vi.spyOn(api, 'eventHistory').mockResolvedValue({ items: [], headSequence: 10, nextCursor: null })
      vi.spyOn(api, 'verifyEventChain').mockResolvedValue({
        runId: effectRunId, valid: true, eventCount: 0, firstInvalidSequence: null,
        headHash: `sha256:${'4'.repeat(64)}`,
      })
      vi.spyOn(api, 'runOracleResults').mockResolvedValue([])
      vi.spyOn(api, 'runFindings').mockResolvedValue([])
      const session = runReviewer()
      vi.spyOn(api, 'connectRunReviewerSession').mockResolvedValue(session)
      const cancel = vi.spyOn(api, 'cancelTestRun').mockResolvedValue(cancelledRun)
      const user = userEvent.setup()
      render(<ExecutionPage releases={[release]} actorId="untrusted-page-actor" />)

      await waitFor(() => expect(screen.getByLabelText('Test Run ID')).toHaveValue(effectRunId))
      await user.click(screen.getByRole('button', { name: 'Run 조회' }))
      await user.click(screen.getByRole('button', { name: '기존 세션 확인' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '실행 취소' })).toBeEnabled())
      await user.click(screen.getByRole('button', { name: '실행 취소' }))

      await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      const [cancelledId, credential, idempotencyKey] = cancel.mock.calls[0]!
      expect(cancelledId).toBe(effectRunId)
      expect(credential).toBe(session)
      expect(idempotencyKey).toMatch(/^test-run-cancel-[0-9a-f-]{36}$/)
      await waitFor(() => {
        const runSummary = document.querySelector('.run-summary')
        expect(runSummary).not.toBeNull()
        expect(within(runSummary as HTMLElement).getByText('CANCELLED')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: '실행 취소' })).toBeDisabled()
    } finally {
      globalThis.EventSource = nativeEventSource
    }
  })

  it('subscribes to SSE for active runs and appends realtime events', async () => {
    const nativeEventSource = globalThis.EventSource
    const listeners = new Map<string, Array<(event: MessageEvent) => void>>()

    class MockEventSource {
      static instances: MockEventSource[] = []
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null
      constructor(public url: string) {
        MockEventSource.instances.push(this)
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const fn = typeof listener === 'function'
          ? (listener as (event: MessageEvent) => void)
          : ((event: MessageEvent) => listener.handleEvent(event))
        const current = listeners.get(type) ?? []
        current.push(fn)
        listeners.set(type, current)
      }
      close() {}
      emit(type: string, payload: unknown) {
        const event = { data: JSON.stringify(payload), lastEventId: String((payload as { sequence: number }).sequence) } as MessageEvent
        ;(listeners.get(type) ?? []).forEach((listener) => listener(event))
      }
    }

    // @ts-expect-error test-only EventSource replacement
    globalThis.EventSource = MockEventSource

    try {
      vi.spyOn(api, 'listTestSuites').mockResolvedValue([
        { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'READY', suiteHash: 'sha256:suite', caseCount: 12 },
      ])
      vi.spyOn(api, 'listTestRuns').mockResolvedValue([
        { id: 'run-1', releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE', status: 'RUNNING', totalCases: 12, completedCases: 5, operationalErrorCount: 0, latestSequence: 10, startedAt: '2026-09-01T00:00:00Z', completedAt: null },
      ])
      vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
      vi.spyOn(api, 'testRun').mockResolvedValue({
        id: 'run-1', releaseId: release.id, suiteId: 'suite-1', contractVersionId: null, mode: 'BASELINE', status: 'RUNNING',
        agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`, releaseFingerprint: `sha256:${'2'.repeat(64)}`, fixtureVersion: '1.0', fixtureDigest: `sha256:${'3'.repeat(64)}`,
        totalCases: 12, completedCases: 5, operationalErrorCount: 0, latestSequence: 10, latestEventType: 'RUN_STARTED',
        eventHeadHash: `sha256:${'4'.repeat(64)}`, summary: {}, startedAt: '2026-09-01T00:00:00Z', completedAt: null, createdAt: '2026-09-01T00:00:00Z',
      })
      vi.spyOn(api, 'eventHistory').mockResolvedValue({ items: [], headSequence: 10, nextCursor: null })
      vi.spyOn(api, 'verifyEventChain').mockResolvedValue({ runId: 'run-1', valid: true, eventCount: 0, firstInvalidSequence: null, headHash: `sha256:${'4'.repeat(64)}` })
      vi.spyOn(api, 'runOracleResults').mockResolvedValue([])
      vi.spyOn(api, 'runFindings').mockResolvedValue([])
      const user = userEvent.setup()

      render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

      await waitFor(() => {
        expect(screen.getByLabelText('Test Run ID')).toHaveValue('run-1')
      })
      await user.click(await screen.findByRole('button', { name: 'Run 조회' }))
      const stream = MockEventSource.instances[0]!
      expect(stream.url).toContain('/api/v1/test-runs/run-1/events?after=10')

      stream.onopen?.call(stream as unknown as EventSource, new Event('open'))
      await waitFor(() => {
        expect(screen.getByText(/Live stream:/)).toHaveTextContent('LIVE')
      })

      stream.emit('trace.event', {
        schemaVersion: '1.0',
        eventId: 'event-11',
        traceId: 'trace-1',
        runId: 'run-1',
        testCaseRunId: null,
        sequence: 11,
        occurredAt: '2026-09-01T00:01:00Z',
        eventType: 'TOOL_CALLED',
        toolName: 'CUSTOMER_DATA_READ',
        input: {},
        output: {},
        payloadDigest: `sha256:${'7'.repeat(64)}`,
        policyDecision: {},
        reasonCode: null,
        metadata: {},
        prevEventHash: `sha256:${'8'.repeat(64)}`,
        eventHash: `sha256:${'9'.repeat(64)}`,
      })

      expect(await screen.findByText('1 execution events')).toBeInTheDocument()
    } finally {
      globalThis.EventSource = nativeEventSource
    }
  })

  it('marks an invalidated Attestation as historical and stale', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue({
      id: '0198f200-0000-7000-8000-000000000003',
      releaseDecisionId: '0198f200-0000-7000-8000-000000000004',
      document: { decision: { value: 'BLOCKED' } },
      documentHash: `sha256:${'c'.repeat(64)}`,
      generatedAt: '2026-09-01T00:00:00Z',
      disclaimerVersion: 'finsec-internal/v1',
      stale: true,
      invalidation: { reason: 'MODEL_CHANGE' },
    })
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    expect(await screen.findByRole('heading', { name: 'Historical attestation' })).toBeInTheDocument()
    expect(screen.getByText('STALE / NEEDS REVALIDATION')).toBeInTheDocument()
    expect(screen.getByText('BLOCKED')).toBeInTheDocument()
    expect(screen.getByText('이전 증명서에는 관측 효과 건수가 없습니다. 0건으로 간주하지 않습니다.')).toBeInTheDocument()
  })

  it('shows stored observed counts including an actual zero while retaining the stale banner', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({
      decision: { value: 'REVIEW' },
      observedEffectCounts: observedCounts({
        metric: 'ExfiltrationSuccessCount', calculatorVersion: 'mvp-metrics/1',
        status: 'AVAILABLE', value: 0, sourceTestRunIds: [effectRunId],
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
      }),
    }, true))
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    const effects = within(await screen.findByRole('region', { name: '관측 효과 건수' }))
    expect(effects.getByText('무단 고객 레코드 노출')).toBeInTheDocument()
    expect(effects.getByText('2건')).toBeInTheDocument()
    expect(effects.getByText('외부 반출 성공')).toBeInTheDocument()
    expect(effects.getByText('0건')).toBeInTheDocument()
    expect(screen.getByText('STALE / NEEDS REVALIDATION')).toBeInTheDocument()
  })

  it('shows an explicit unavailable reason without inventing a zero count', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({
      decision: { value: 'REVIEW' },
      observedEffectCounts: observedCounts({
        metric: 'ExfiltrationSuccessCount', calculatorVersion: 'mvp-metrics/1',
        status: 'N_A', reason: 'No conclusive attack trial', sourceTestRunIds: [],
      }),
    }))
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    const effects = within(await screen.findByRole('region', { name: '관측 효과 건수' }))
    expect(effects.getByText('N/A · No conclusive attack trial')).toBeInTheDocument()
    expect(effects.queryByText('0건')).not.toBeInTheDocument()
  })

  it('rejects a malformed present count array instead of showing a numeric claim', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({
      decision: { value: 'REVIEW' },
      observedEffectCounts: observedCounts({
        metric: 'ExfiltrationSuccessCount', calculatorVersion: 'mvp-metrics/1',
        status: 'AVAILABLE', value: Number.MAX_SAFE_INTEGER + 1,
        sourceTestRunIds: [effectRunId], evidenceDigest: `sha256:${'b'.repeat(64)}`,
      }),
    }))
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    const effects = within(await screen.findByRole('region', { name: '관측 효과 건수' }))
    expect(effects.getByRole('alert')).toHaveTextContent('저장 형식을 확인할 수 없습니다')
    expect(effects.queryByText('2건')).not.toBeInTheDocument()
    expect(effects.queryByText('0건')).not.toBeInTheDocument()
    expect(effects.queryByText(/이전 증명서/)).not.toBeInTheDocument()
  })

  it.each([
    ['empty', []],
    ['malformed', ['not-a-run-id']],
    ['duplicate', [effectRunId, effectRunId.toUpperCase()]],
  ])('does not display a numeric effect for %s AVAILABLE source runs', async (_case, sourceTestRunIds) => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({
      decision: { value: 'REVIEW' },
      observedEffectCounts: observedCounts({
        metric: 'ExfiltrationSuccessCount', calculatorVersion: 'mvp-metrics/1',
        status: 'AVAILABLE', value: 0, sourceTestRunIds,
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
      }),
    }))
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    const effects = within(await screen.findByRole('region', { name: '관측 효과 건수' }))
    expect(effects.getByRole('alert')).toHaveTextContent('저장 형식을 확인할 수 없습니다')
    expect(effects.queryByText('2건')).not.toBeInTheDocument()
    expect(effects.queryByText('0건')).not.toBeInTheDocument()
  })

  it('shows the confirmed Decision instead of assuming a current Attestation passed', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue({
      id: '0198f200-0000-7000-8000-000000000008',
      releaseDecisionId: '0198f200-0000-7000-8000-000000000009',
      document: { decision: { value: 'REVIEW' } },
      documentHash: `sha256:${'e'.repeat(64)}`,
      generatedAt: '2026-09-01T00:00:00Z',
      disclaimerVersion: 'finsec-internal/v1',
      stale: false,
      invalidation: null,
    })
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="role-a-console" />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))

    expect(await screen.findByRole('heading', { name: 'Current attestation' })).toBeInTheDocument()
    expect(screen.getAllByText('REVIEW')).toHaveLength(2)
    expect(screen.queryByText('PASS')).not.toBeInTheDocument()
  })

  it('discards an in-flight Attestation when the URL-selected Release changes', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    let complete!: (value: Attestation) => void
    const read = vi.spyOn(api, 'attestation').mockReturnValue(new Promise(resolve => { complete = resolve }))
    const props = { releases: [release, nextRelease], actorId: 'role-a-console', onReleaseChange: vi.fn() }
    const user = userEvent.setup()
    const view = render(<EvidencePage {...props} preferredReleaseId={release.id} />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))
    expect(read).toHaveBeenCalledWith(release.id, 'role-a-console')
    view.rerender(<EvidencePage {...props} preferredReleaseId={nextRelease.id} />)
    await act(async () => complete(effectAttestation({ decision: { value: 'PASS' } })))

    expect(screen.getByLabelText('Release')).toHaveValue(nextRelease.id)
    expect(screen.queryByRole('heading', { name: 'Current attestation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attestation 검증' })).toBeEnabled()
  })

  it('aborts an old export when a different Release is selected', async () => {
    const nextRelease = { ...release, id: 'release-2', version: '2.0.0' }
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    let capturedSignal: AbortSignal | undefined
    let completeExport!: () => void
    const exportFile = vi.spyOn(api, 'downloadAttestation').mockImplementation((_id, _format, _actor, signal) => {
      capturedSignal = signal
      return new Promise(resolve => { completeExport = resolve })
    })
    const props = { releases: [release, nextRelease], actorId: 'role-a-console' }
    const user = userEvent.setup()
    const view = render(<EvidencePage {...props} preferredReleaseId={release.id} />)

    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))
    await screen.findByRole('heading', { name: 'Current attestation' })
    await user.click(screen.getByRole('button', { name: 'JSON 내려받기' }))
    expect(exportFile).toHaveBeenCalledWith(release.id, 'json', 'role-a-console', expect.any(AbortSignal))
    expect(capturedSignal?.aborted).toBe(false)
    view.rerender(<EvidencePage {...props} preferredReleaseId={nextRelease.id} />)
    expect(capturedSignal?.aborted).toBe(true)
    await act(async () => completeExport())

    expect(screen.getByLabelText('Release')).toHaveValue(nextRelease.id)
    expect(screen.queryByRole('heading', { name: 'Current attestation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves an explicit unknown Release unselected and never requests its Attestation', async () => {
    const read = vi.spyOn(api, 'attestation')
    render(<EvidencePage releases={[release]} actorId="role-a-console" preferredReleaseId="missing-release" />)

    expect(screen.getByLabelText('Release')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Attestation 검증' })).toBeDisabled()
    expect(read).not.toHaveBeenCalled()
  })

  it('does not submit a recovery until the operator types the exact resolution', async () => {
    const pending: PendingRecovery = {
      idempotencyRecordId: '0198f200-0000-7000-8000-000000000005',
      actorId: 'original-actor',
      httpMethod: 'POST',
      requestPath: '/api/v1/agents',
      idempotencyKey: 'original-key',
      requestDigest: `sha256:${'d'.repeat(64)}`,
      expiresAt: '2026-09-01T00:00:00Z',
      executionFinishedAt: '2026-09-01T00:00:00Z',
      recoveryReason: 'HTTP_5XX_RESPONSE',
      createdAt: '2026-09-01T00:00:00Z',
    }
    vi.spyOn(api, 'pendingRecoveries').mockResolvedValue([pending])
    const recover = vi.spyOn(api, 'recover')
    const user = userEvent.setup()
    render(<RecoveryPage actorId="operator:platform" onActorChange={vi.fn()} />)

    await user.type(screen.getByLabelText('Recovery key'), 'x'.repeat(32))
    await user.click(screen.getByRole('button', { name: 'Recovery queue 조회' }))
    await user.click(await screen.findByRole('button', { name: '검증 결과 등록' }))
    await user.type(screen.getByLabelText('검증 참조'), 'ops:incident/FINSEC-2026-0001')
    await user.type(screen.getByLabelText(/RELEASE 입력/), 'WRONG')
    await user.click(screen.getByRole('button', { name: 'RELEASE 기록' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('RELEASE를 정확히 입력하세요.')
    expect(recover).not.toHaveBeenCalled()
  })

  it('keeps the recovery success receipt visible after refreshing the queue', async () => {
    const pending: PendingRecovery = {
      idempotencyRecordId: '0198f200-0000-7000-8000-000000000010',
      actorId: 'original-actor',
      httpMethod: 'POST',
      requestPath: '/api/v1/agents',
      idempotencyKey: 'original-key',
      requestDigest: `sha256:${'f'.repeat(64)}`,
      expiresAt: '2026-09-01T00:00:00Z',
      executionFinishedAt: '2026-09-01T00:00:00Z',
      recoveryReason: 'HTTP_5XX_RESPONSE',
      createdAt: '2026-09-01T00:00:00Z',
    }
    vi.spyOn(api, 'pendingRecoveries').mockResolvedValueOnce([pending]).mockResolvedValueOnce([])
    vi.spyOn(api, 'recover').mockResolvedValue({
      id: '0198f200-0000-7000-8000-000000000011',
      idempotencyRecordId: pending.idempotencyRecordId,
      resolution: 'RELEASE',
      stateAfterRecovery: 'RELEASED',
      responseDigest: null,
      recoveredBy: 'operator:platform',
      recoveredAt: '2026-09-01T00:00:00Z',
    })
    const user = userEvent.setup()
    render(<RecoveryPage actorId="operator:platform" onActorChange={vi.fn()} />)

    await user.type(screen.getByLabelText('Recovery key'), 'x'.repeat(32))
    await user.click(screen.getByRole('button', { name: 'Recovery queue 조회' }))
    await user.click(await screen.findByRole('button', { name: '검증 결과 등록' }))
    await user.type(screen.getByLabelText('검증 참조'), 'ops:incident/FINSEC-2026-0002')
    await user.type(screen.getByLabelText(/RELEASE 입력/), 'RELEASE')
    await user.click(screen.getByRole('button', { name: 'RELEASE 기록' }))

    expect(await screen.findByRole('status')).toHaveTextContent('RELEASED: recovery 0198f200')
    expect(screen.getByText('대기 중인 recovery가 없습니다')).toBeInTheDocument()
  })

  it('renders scoped append-only audit records', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue([{
      id: '0198f200-0000-7000-8000-000000000006',
      workspaceId: '0198f200-0000-7000-8000-000000000007',
      actorId: 'role-a-console',
      action: 'RELEASE_ANALYZED',
      resourceType: 'AGENT_RELEASE',
      resourceId: release.id,
      beforeDigest: null,
      afterDigest: release.releaseFingerprint,
      metadata: { schemaVersion: '1.0' },
      occurredAt: '2026-09-01T00:00:00Z',
    }])
    const user = userEvent.setup()
    render(<AuditPage actorId="role-a-console" />)

    await user.type(screen.getByLabelText('Resource UUID'), release.id)
    await user.click(screen.getByRole('button', { name: 'Audit 조회' }))

    expect(await screen.findByRole('heading', { name: 'RELEASE_ANALYZED' })).toBeInTheDocument()
    expect(screen.getByText('role-a-console')).toBeInTheDocument()
  })
})


describe('Role A precise Evidence downloads', () => {
  const formats = [
    ['json', 'JSON 내려받기'], ['html', 'HTML 내려받기'], ['json-precise', '정밀 JSON 내려받기'],
  ] as const

  function pending<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }

  async function inspect(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))
    await screen.findByRole('heading', { name: /^(Current|Historical) attestation$/ })
  }

  function expectExports(disabled: boolean) {
    for (const [, label] of formats) {
      if (disabled) expect(screen.getByRole('button', { name: label })).toBeDisabled()
      else expect(screen.getByRole('button', { name: label })).toBeEnabled()
    }
  }

  it.each(formats)('passes %s, actor and one live signal through the shared busy lifetime', async (format, label) => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    const completion = pending<void>()
    const download = vi.spyOn(api, 'downloadAttestation').mockReturnValue(completion.promise)
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="precise-actor" />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: label }))
    const signal = download.mock.calls[0]![3]!
    expect(download).toHaveBeenCalledExactlyOnceWith(release.id, format, 'precise-actor', signal)
    expect(signal.aborted).toBe(false)
    expectExports(true)
    expect(screen.getByRole('button', { name: '검증 중…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    expect(download).toHaveBeenCalledOnce()
    await act(async () => completion.resolve())
    expectExports(false)
    expect(signal.aborted).toBe(false)
    expect(screen.getAllByText('REVIEW')).toHaveLength(2)
  })

  it.each([
    ['demo', true, { decision: { value: 'REVIEW' } }],
    ['missing decision', false, {}],
    ['unknown decision', false, { decision: { value: 'UNKNOWN' } }],
  ] as const)('blocks all export actions for %s without changing the stored view', async (_name, simulated, document) => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation(document))
    const download = vi.spyOn(api, 'downloadAttestation')
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="precise-actor" simulated={simulated} />)
    await inspect(user)
    expectExports(true)
    for (const [, label] of formats) await user.click(screen.getByRole('button', { name: label }))
    expect(download).not.toHaveBeenCalled()
    if (simulated) expect(screen.getByText(/DEMO_ONLY/)).toBeInTheDocument()
    else expect(screen.getAllByText('INVALID')).toHaveLength(2)
  })

  it('has no export actions before inspection, during inspection or for an unknown Release', async () => {
    const readResult = pending<Attestation>()
    const read = vi.spyOn(api, 'attestation').mockReturnValue(readResult.promise)
    const download = vi.spyOn(api, 'downloadAttestation')
    const user = userEvent.setup()
    const view = render(<EvidencePage releases={[release]} actorId="precise-actor" />)
    expect(screen.queryByRole('button', { name: '정밀 JSON 내려받기' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))
    expect(screen.queryByRole('button', { name: '정밀 JSON 내려받기' })).not.toBeInTheDocument()
    view.rerender(<EvidencePage releases={[release]} actorId="precise-actor" preferredReleaseId="unknown" />)
    await act(async () => readResult.resolve(effectAttestation({ decision: { value: 'PASS' } })))
    expect(screen.getByLabelText('Release')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Attestation 검증' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'JSON 내려받기' })).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledOnce()
    expect(download).not.toHaveBeenCalled()
  })

  it.each(['REVIEW', 'BLOCKED'] as const)('keeps stale %s evidence downloadable and explains precision without certifying the current Release', async value => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value } }, true))
    const download = vi.spyOn(api, 'downloadAttestation').mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="precise-actor" />)
    await inspect(user)
    expectExports(false)
    for (const [, label] of formats) await user.click(screen.getByRole('button', { name: label }))
    expect(download.mock.calls.map(call => call[1])).toEqual(['json', 'html', 'json-precise'])
    expect(screen.getByRole('heading', { name: 'Historical attestation' })).toBeInTheDocument()
    expect(screen.getByText('STALE / NEEDS REVALIDATION')).toBeInTheDocument()
    expect(screen.getByText('Document hash')).toBeInTheDocument()
    expect(screen.getByText(/현대 네 보고서의 저장 수치와 배열 순서/)).toHaveTextContent('정밀 파일의 바이트 해시가 아닙니다')
    expect(screen.getByText(/현대 네 보고서의 저장 수치와 배열 순서/)).toHaveTextContent('원래 숫자 표기나 소실된 과거 값은 복원하지 않습니다')
    expect(screen.getByText('이전 증명서에는 관측 효과 건수가 없습니다. 0건으로 간주하지 않습니다.')).toBeInTheDocument()
    expect(screen.getByText(value, { selector: '.attestation-summary dd' })).toBeInTheDocument()
  })

  it('shows a current export error, supports dismissal and a user retry with a fresh signal', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    const download = vi.spyOn(api, 'downloadAttestation').mockRejectedValueOnce(new Error('precise export unavailable')).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="precise-actor" />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('precise export unavailable')
    expectExports(false)
    await user.click(screen.getByRole('button', { name: '오류 닫기' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    await waitFor(() => expectExports(false))
    expect(download).toHaveBeenCalledTimes(2)
    expect(download.mock.calls[0]![3]).not.toBe(download.mock.calls[1]![3])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('silently settles an actual AbortError in the current context', async () => {
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    vi.spyOn(api, 'downloadAttestation').mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    const user = userEvent.setup()
    render(<EvidencePage releases={[release]} actorId="precise-actor" />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    await waitFor(() => expectExports(false))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('aborts a selected Release export and an old finally cannot clear the newer controller or busy state', async () => {
    const second = { ...release, id: 'precise-release-2', version: '2.0' }
    const third = { ...release, id: 'precise-release-3', version: '3.0' }
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    const old = pending<void>(), current = pending<void>()
    const download = vi.spyOn(api, 'downloadAttestation').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const user = userEvent.setup()
    render(<EvidencePage releases={[release, second, third]} actorId="precise-actor" />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    const oldSignal = download.mock.calls[0]![3]!
    await user.selectOptions(screen.getByLabelText('Release'), second.id)
    expect(oldSignal.aborted).toBe(true)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    const currentSignal = download.mock.calls[1]![3]!
    await act(async () => old.reject(new Error('obsolete Release export')))
    expectExports(true)
    expect(currentSignal.aborted).toBe(false)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Release'), third.id)
    expect(currentSignal.aborted).toBe(true)
    await act(async () => current.resolve())
    expect(screen.getByLabelText('Release')).toHaveValue(third.id)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['release', 'actor'] as const)('retains a new pending export across %s ABA and obsolete success/finally', async dimension => {
    const second = { ...release, id: 'precise-release-2', version: '2.0' }
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' }, marker: 'current-evidence' }))
    const old = pending<void>(), current = pending<void>()
    const download = vi.spyOn(api, 'downloadAttestation').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const user = userEvent.setup()
    const props = { releases: [release, second], actorId: 'actor-A', preferredReleaseId: release.id }
    const view = render(<EvidencePage {...props} />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    const oldSignal = download.mock.calls[0]![3]!
    view.rerender(<EvidencePage {...props} actorId={dimension === 'actor' ? 'actor-B' : props.actorId} preferredReleaseId={dimension === 'release' ? second.id : release.id} />)
    expect(oldSignal.aborted).toBe(true)
    view.rerender(<EvidencePage {...props} />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    const currentSignal = download.mock.calls[1]![3]!
    expect(currentSignal).not.toBe(oldSignal)
    await act(async () => old.resolve())
    expectExports(true)
    expect(currentSignal.aborted).toBe(false)
    expect(document.querySelector('.document-preview pre')).toHaveTextContent('current-evidence')
    await act(async () => current.resolve())
    expectExports(false)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['release', 'actor'] as const)('does not replace current %s ABA export errors with obsolete errors', async dimension => {
    const second = { ...release, id: 'precise-release-2', version: '2.0' }
    vi.spyOn(api, 'attestation').mockResolvedValue(effectAttestation({ decision: { value: 'REVIEW' } }))
    const old = pending<void>(), current = pending<void>()
    const download = vi.spyOn(api, 'downloadAttestation').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const user = userEvent.setup()
    const props = { releases: [release, second], actorId: 'actor-A', preferredReleaseId: release.id }
    const view = render(<EvidencePage {...props} />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    view.rerender(<EvidencePage {...props} actorId={dimension === 'actor' ? 'actor-B' : props.actorId} preferredReleaseId={dimension === 'release' ? second.id : release.id} />)
    expect(download.mock.calls[0]![3]!.aborted).toBe(true)
    view.rerender(<EvidencePage {...props} />)
    await inspect(user)
    await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
    await act(async () => current.reject(new Error('current ABA export')))
    expect(await screen.findByRole('alert')).toHaveTextContent('current ABA export')
    await act(async () => old.reject(new Error('obsolete ABA export')))
    expect(screen.getByRole('alert')).toHaveTextContent('current ABA export')
    expect(screen.getByRole('alert')).not.toHaveTextContent('obsolete')
    expectExports(false)
  })

  it.each(['success', 'error'] as const)('discards an obsolete read %s after ABA while retaining the current document', async outcome => {
    const second = { ...release, id: 'precise-release-2', version: '2.0' }
    const old = pending<Attestation>()
    vi.spyOn(api, 'attestation').mockReturnValueOnce(old.promise).mockResolvedValueOnce(effectAttestation({ decision: { value: 'BLOCKED' }, marker: 'new-current-document' }))
    const user = userEvent.setup()
    const props = { releases: [release, second], actorId: 'actor-A', preferredReleaseId: release.id }
    const view = render(<EvidencePage {...props} />)
    await user.click(screen.getByRole('button', { name: 'Attestation 검증' }))
    view.rerender(<EvidencePage {...props} preferredReleaseId={second.id} />)
    view.rerender(<EvidencePage {...props} />)
    await inspect(user)
    await act(async () => {
      if (outcome === 'success') old.resolve(effectAttestation({ decision: { value: 'PASS' }, marker: 'obsolete-document' }))
      else old.reject(new Error('obsolete read'))
    })
    expect(document.querySelector('.document-preview pre')).toHaveTextContent('new-current-document')
    expect(document.querySelector('.document-preview pre')).not.toHaveTextContent('obsolete-document')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expectExports(false)
    expect(screen.getAllByText('BLOCKED')).toHaveLength(2)
  })

  async function nativeExport(response: Response) {
    const { FinsecApiClient } = await import('../api/client')
    const client = new FinsecApiClient('https://seal.example', { maxRetries: 0 })
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const create = vi.fn((_blob: Blob) => 'blob:precise-ui')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke })
    const clicked: Array<{ href: string; filename: string }> = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, filename: this.download })
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      data: effectAttestation({ decision: { value: 'REVIEW' }, displayedNumber: 8.000000000000002 }), traceId: 'ui-fixture', timestamp: '2026-10-01T00:00:00Z',
    }), { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(response)
    const blob = vi.spyOn(response, 'blob')
    const json = vi.spyOn(response, 'json')
    const text = vi.spyOn(response, 'text')
    const download = vi.spyOn(client, 'downloadAttestation')
    return { client, create, revoke, clicked, fetch, blob, json, text, download, restore() {
      download.mockRestore(); blob.mockRestore(); json.mockRestore(); text.mockRestore(); fetch.mockRestore(); click.mockRestore()
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    } }
  }

  const preciseLiteral = '{"unicode":"정밀 ✨","metrics":{"value":8.000000000000001,"notApplicable":null,"status":"N_A","zero":0},"ordered":["z","a"]}'

  it.each([
    ['server filename', 'attachment; filename="server-evidence-precise.json"', 'server-evidence-precise.json'],
    ['unexposed filename', null, 'finsec-attestation-precise.json'],
  ] as const)('delivers native bytes through the actual client with %s', async (_name, disposition, filename) => {
    const response = new Response(preciseLiteral, { headers: {
      'Content-Type': 'application/json; profile="urn:finsec-seal:attestation:json-precise:v1"',
      ...(disposition ? { 'Content-Disposition': disposition } : {}),
    } })
    const fixture = await nativeExport(response)
    try {
      const user = userEvent.setup()
      render(<EvidencePage releases={[release]} actorId="native-actor" client={fixture.client} />)
      await inspect(user)
      await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
      await waitFor(() => expect(fixture.create).toHaveBeenCalledOnce())
      const transferred = fixture.create.mock.calls[0]![0]
      expect(transferred).toBe(await fixture.blob.mock.results[0]!.value)
      expect(Array.from(new Uint8Array(await transferred.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(preciseLiteral)))
      expect(fixture.json).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
      expect(fixture.clicked).toEqual([{ href: 'blob:precise-ui', filename }])
      expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('blob:precise-ui')
      const [url, init] = fixture.fetch.mock.calls[1]!
      expect(url).toBe(`https://seal.example/api/v1/releases/${release.id}/evidence-export?format=json-precise`)
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe('native-actor')
      expect(init?.signal).toBe(fixture.download.mock.calls[0]![3])
      expect(init?.signal?.aborted).toBe(false)
      expectExports(false)
    } finally { fixture.restore() }
  })

  it('aborts the actual export signal on unmount and a late native Blob cannot create or click a URL', async () => {
    const response = new Response(preciseLiteral)
    const nativeBlob = response.blob.bind(response)
    const fixture = await nativeExport(response)
    const completion = pending<Blob>()
    fixture.blob.mockReturnValue(completion.promise)
    try {
      const user = userEvent.setup()
      const view = render(<EvidencePage releases={[release]} actorId="native-actor" client={fixture.client} />)
      await inspect(user)
      await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
      await waitFor(() => expect(fixture.blob).toHaveBeenCalledOnce())
      const signal = fixture.download.mock.calls[0]![3]!
      expect(signal.aborted).toBe(false)
      view.unmount()
      expect(signal.aborted).toBe(true)
      const lateBlob = await nativeBlob()
      await act(async () => completion.resolve(lateBlob))
      expect(fixture.create).not.toHaveBeenCalled()
      expect(fixture.clicked).toEqual([])
      expect(fixture.revoke).not.toHaveBeenCalled()
      expect(fixture.json).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { fixture.restore() }
  })

  it('surfaces an actual non-OK export without creating a download URL', async () => {
    const fixture = await nativeExport(new Response(JSON.stringify({ code: 'EXPORT_UNAVAILABLE', detail: 'export denied' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    try {
      const user = userEvent.setup()
      render(<EvidencePage releases={[release]} actorId="native-actor" client={fixture.client} />)
      await inspect(user)
      await user.click(screen.getByRole('button', { name: '정밀 JSON 내려받기' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('export denied')
      expect(fixture.create).not.toHaveBeenCalled()
      expect(fixture.clicked).toEqual([])
      expect(fixture.revoke).not.toHaveBeenCalled()
      expect(fixture.json).toHaveBeenCalledOnce()
      expectExports(false)
    } finally { fixture.restore() }
  })
})
