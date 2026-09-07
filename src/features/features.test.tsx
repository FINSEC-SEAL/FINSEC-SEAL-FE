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
    const user = userEvent.setup()
    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    await user.selectOptions(screen.getByLabelText('Run mode filter'), 'HELD_OUT')
    await user.selectOptions(screen.getByLabelText('Run status filter'), 'COMPLETED')
    await user.click(screen.getByRole('button', { name: '목록 새로고침' }))

    expect(listSuites).toHaveBeenCalledWith(release.id, 'role-b-console')
    expect(listRuns).toHaveBeenLastCalledWith(release.id, 'role-b-console', { mode: 'HELD_OUT', status: 'COMPLETED', limit: 10 })
  })

  it('requires a READY suite before starting a B run', async () => {
    vi.spyOn(api, 'listTestSuites').mockResolvedValue([
      { id: 'suite-1', releaseId: release.id, version: '1.0', status: 'DRAFT', suiteHash: 'sha256:suite', caseCount: 12 },
    ])
    vi.spyOn(api, 'listTestRuns').mockResolvedValue([])
    const start = vi.spyOn(api, 'startTestRun')
    render(<ExecutionPage releases={[release]} actorId="role-b-console" />)

    expect(screen.getByRole('button', { name: '실행 시작' })).toBeDisabled()
    expect(start).not.toHaveBeenCalled()
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
