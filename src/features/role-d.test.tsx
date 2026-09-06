import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import type { Finding, MetricValue, Release } from '../api/contracts'
import { AssurancePage } from './Assurance'
import { FindingsPage } from './Findings'

const release: Release = {
  id: '0198f200-0000-7000-8000-000000000101',
  agentId: '0198f200-0000-7000-8000-000000000102',
  version: '1.0.0',
  businessPurpose: 'Document completeness only',
  manifestSchemaVersion: '1.1',
  agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
  releaseFingerprint: `sha256:${'b'.repeat(64)}`,
  safetyContractHash: null,
  lifecycleState: 'VERIFYING',
  effectiveStatus: 'VERIFYING',
  revalidationReason: null,
  analyzedAt: '2026-09-07T00:00:00Z',
  lastTestedAt: '2026-09-07T00:00:00Z',
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
}

const finding: Finding = {
  id: '0198f200-0000-7000-8000-000000000103',
  releaseId: release.id,
  sourceOracleResultId: '0198f200-0000-7000-8000-000000000104',
  category: 'FA-04', severity: 'CRITICAL', title: 'Classified data received by external collector', status: 'OPEN',
  violatedInvariant: 'INV-04', rootCause: { reasonCode: 'EXFIL_PAYLOAD_RECEIVED' }, findingGroupKey: 'sha256:group',
  firstSeenRunId: '0198f200-0000-7000-8000-000000000105', latestSeenRunId: '0198f200-0000-7000-8000-000000000105',
  createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
}

const unavailable = (name: string): MetricValue => ({ name, status: 'N_A', numerator: null, denominator: null, value: null, reason: 'NO_CONCLUSIVE_TRIALS', sourceRunIds: [] })

describe('Role D console', () => {
  it('opens a Finding with its deterministic Oracle evidence', async () => {
    vi.spyOn(api, 'findings').mockResolvedValue([finding])
    vi.spyOn(api, 'finding').mockResolvedValue({
      finding,
      oracleResult: {
        id: finding.sourceOracleResultId, runId: finding.firstSeenRunId, testCaseRunId: 'case-run', sourceEventId: 'source-event',
        oracleType: 'EXFILTRATION', oracleVersion: '1.0', outcome: 'ATTACK_SUCCESS', reasonCode: 'EXFIL_PAYLOAD_RECEIVED',
        invariantId: 'INV-04', evidence: { sensitiveTokenCount: 1 }, evidenceDigest: `sha256:${'c'.repeat(64)}`,
        evaluatedAt: '2026-09-07T00:00:00Z', createdAt: '2026-09-07T00:00:00Z',
      },
      relatedFindings: [],
    })
    const user = userEvent.setup()
    render(<FindingsPage releases={[release]} actorId="role-d-console" />)

    expect(screen.getByRole('option', { name: 'FA-04 · 외부 정보 유출' })).toBeInTheDocument()
    await user.click(await screen.findByText(/Classified data received/))
    expect(await screen.findByText('EXFIL_PAYLOAD_RECEIVED')).toBeInTheDocument()
    expect(screen.getByText(/sensitiveTokenCount/)).toBeInTheDocument()
  })

  it('prefers the Release selected in the shared console context', async () => {
    const older = { ...release, id: '0198f200-0000-7000-8000-000000000199', version: '0.9.0' }
    vi.spyOn(api, 'findings').mockResolvedValue([])
    render(<FindingsPage releases={[older, release]} actorId="role-d-console" preferredReleaseId={release.id} />)

    expect(await screen.findByLabelText('Finding Release')).toHaveValue(release.id)
  })

  it('renders unavailable metrics as N/A rather than a misleading zero', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue({ releaseId: release.id, metrics: {
      attackSuccessRate: unavailable('ASR'), attackBlockRate: unavailable('ABR'), heldOutAttackSuccessRate: unavailable('HeldOutASR'),
      normalTaskSuccessRate: unavailable('NTSR'), falseBlockRate: unavailable('FBR'), operationalErrorRate: unavailable('OperationalErrorRate'),
      unauthorizedRecordExposureCount: 0, sensitiveFieldExposureCount: 0, exfiltrationSuccessCount: 0, highImpactMutationCount: 0,
      normalConclusiveTrials: 0, trials: [],
    } })
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    expect((await screen.findAllByText('N/A')).length).toBe(6)
    expect(screen.getByText(/N\/A는 0이 아니라/)).toBeInTheDocument()
  })

  it('shows replay comparability and mismatch reasons when B/C evidence is available', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue({
      releaseId: release.id,
      metrics: {
        attackSuccessRate: unavailable('ASR'), attackBlockRate: unavailable('ABR'), heldOutAttackSuccessRate: unavailable('HeldOutASR'),
        normalTaskSuccessRate: unavailable('NTSR'), falseBlockRate: unavailable('FBR'), operationalErrorRate: unavailable('OperationalErrorRate'),
        unauthorizedRecordExposureCount: 0, sensitiveFieldExposureCount: 0, exfiltrationSuccessCount: 0, highImpactMutationCount: 0,
        normalConclusiveTrials: 0, trials: [],
      },
      replaySummary: {
        totalCount: 1, comparableCount: 0, nonComparableCount: 1, evidenceComplete: false,
        items: [{ baselineRunId: 'baseline-run', replayRunId: 'replay-run', category: 'FA-04', comparable: false, mismatchReasons: ['POLICY_VERSION_MISMATCH'] }],
      },
    })
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    expect(await screen.findByText('NON-COMPARABLE')).toBeInTheDocument()
    expect(screen.getByText('POLICY VERSION MISMATCH')).toBeInTheDocument()
    expect(screen.getByText('Review required')).toBeInTheDocument()
  })
})
