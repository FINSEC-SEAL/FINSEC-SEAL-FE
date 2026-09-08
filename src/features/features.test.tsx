import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import type { Agent, PendingRecovery, Release } from '../api/contracts'
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
        const event = { data: JSON.stringify(payload) } as MessageEvent
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
      expect(stream.url).toContain('/api/v1/test-runs/run-1/events')

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
