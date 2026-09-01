import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import type { Agent, PendingRecovery, Release } from '../api/contracts'
import { AgentsPage, ReleasesPage } from './AgentsReleases'
import { AuditPage } from './Audit'
import { EvidencePage } from './Evidence'
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
