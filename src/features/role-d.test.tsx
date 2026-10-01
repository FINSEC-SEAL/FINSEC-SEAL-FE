import { StrictMode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import type { Finding, FindingDetail, MetricValue, MetricsView, Release } from '../api/contracts'
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
      unauthorizedRecordExposureCount: null, sensitiveFieldExposureCount: null,
      exfiltrationSuccessCount: null, highImpactMutationCount: null,
      normalConclusiveTrials: 0, trials: [],
    } })
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    expect((await screen.findAllByText('N/A')).length).toBe(10)
    expect(screen.getByText(/N\/A는 0이 아니라 정확한 건수를/)).toBeInTheDocument()
  })

  it('preserves evidenced zero and hides unsafe effect count claims', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue({ releaseId: release.id, metrics: {
      attackSuccessRate: unavailable('ASR'), attackBlockRate: unavailable('ABR'), heldOutAttackSuccessRate: unavailable('HeldOutASR'),
      normalTaskSuccessRate: unavailable('NTSR'), falseBlockRate: unavailable('FBR'), operationalErrorRate: unavailable('OperationalErrorRate'),
      unauthorizedRecordExposureCount: null, sensitiveFieldExposureCount: 0,
      exfiltrationSuccessCount: Number.MAX_SAFE_INTEGER + 1, highImpactMutationCount: 2,
      normalConclusiveTrials: 0, trials: [],
    } })
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    await screen.findByText('Observed security effects')
    expect(within(screen.getByText('Unauthorized records').parentElement!).getByText('N/A')).toBeInTheDocument()
    expect(within(screen.getByText('Sensitive fields').parentElement!).getByText('0')).toBeInTheDocument()
    expect(within(screen.getByText('Exfiltrations').parentElement!).getByText('N/A')).toBeInTheDocument()
    expect(within(screen.getByText('High-impact mutations').parentElement!).getByText('2')).toBeInTheDocument()
  })

  it('does not claim exact effects from malformed or omitted legacy counts', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue({ releaseId: release.id, metrics: {
      attackSuccessRate: unavailable('ASR'), attackBlockRate: unavailable('ABR'), heldOutAttackSuccessRate: unavailable('HeldOutASR'),
      normalTaskSuccessRate: unavailable('NTSR'), falseBlockRate: unavailable('FBR'), operationalErrorRate: unavailable('OperationalErrorRate'),
      unauthorizedRecordExposureCount: -1, sensitiveFieldExposureCount: 1.5,
      exfiltrationSuccessCount: 0,
      normalConclusiveTrials: 0, trials: [],
    } } as unknown as MetricsView)
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    await screen.findByText('Observed security effects')
    expect(within(screen.getByText('Unauthorized records').parentElement!).getByText('N/A')).toBeInTheDocument()
    expect(within(screen.getByText('Sensitive fields').parentElement!).getByText('N/A')).toBeInTheDocument()
    expect(within(screen.getByText('Exfiltrations').parentElement!).getByText('0')).toBeInTheDocument()
    expect(within(screen.getByText('High-impact mutations').parentElement!).getByText('N/A')).toBeInTheDocument()
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
        items: [{ baselineRunId: null, replayRunId: 'replay-run', category: 'FA-04', comparable: false, mismatchReasons: ['REPLAY_LINK_MISSING'] }],
      },
    })
    render(<AssurancePage releases={[release]} actorId="role-d-console" />)

    expect(await screen.findByText('NON-COMPARABLE')).toBeInTheDocument()
    expect(screen.getByText('REPLAY LINK MISSING')).toBeInTheDocument()
    expect(screen.getByText(/NO BASELINE/)).toBeInTheDocument()
    expect(screen.getByText('Review required')).toBeInTheDocument()
  })

})

const secondRelease: Release = { ...release, id: '0198f200-0000-7000-8000-000000000199', version: '2.0.0' }
const testId = (value: number) => `0198f200-0000-7000-8000-${String(value).padStart(12, '0')}`
function evidenceFinding(value: number, title: string, releaseId = release.id): Finding {
  return { ...finding, id: testId(value), sourceOracleResultId: testId(value + 1000), releaseId, title }
}
function evidenceDetail(item: Finding, marker = item.title): FindingDetail {
  return {
    finding: item,
    oracleResult: {
      id: item.sourceOracleResultId, runId: item.firstSeenRunId, testCaseRunId: 'case-run', sourceEventId: 'source-event',
      oracleType: 'EXFILTRATION', oracleVersion: '1.0', outcome: 'ATTACK_SUCCESS', reasonCode: `Oracle:${marker}`,
      invariantId: item.violatedInvariant, evidence: { marker }, evidenceDigest: `sha256:${'c'.repeat(64)}`,
      evaluatedAt: '2026-09-07T00:00:00Z', createdAt: '2026-09-07T00:00:00Z',
    }, relatedFindings: [],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function respond<T>(request: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => { request.resolve(value) })
}
async function settle<T>(request: ReturnType<typeof deferred<T>>, outcome: string, value: T, message = 'old-request-error') {
  await act(async () => { if (outcome === 'success') request.resolve(value); else request.reject(new Error(message)) })
}
const queryButton = () => screen.getByRole('button', { name: '조회' })
const triageButton = () => screen.getByRole('button', { name: 'TRIAGED로 전환' })
const pageFor = (actorId = 'reviewer-X', preferredReleaseId = release.id, inventory = [release, secondRelease]) =>
  <FindingsPage releases={inventory} actorId={actorId} preferredReleaseId={preferredReleaseId} />
async function selectFinding(user: ReturnType<typeof userEvent.setup>, item: Finding) {
  await user.click(await screen.findByRole('row', { name: new RegExp(item.title) }))
}
const contextChanges = [
  { name: 'Release', firstActor: 'reviewer-X', nextActor: 'reviewer-X', nextRelease: secondRelease.id },
  { name: 'actor', firstActor: 'reviewer-X', nextActor: 'reviewer-Y', nextRelease: release.id },
]

describe('D Finding review identity and request lifetime (D-FINDING-001/002)', () => {
  beforeEach(() => { vi.spyOn(api, 'triageFinding').mockRejectedValue(new Error('Unexpected implicit triage')) })

  it('triages only an explicit displayed OPEN Finding with the captured actor and trimmed comment', async () => {
    const item = evidenceFinding(301, 'Explicit finding')
    const result = { ...item, status: 'TRIAGED' as const }
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    vi.spyOn(api, 'finding').mockResolvedValue(evidenceDetail(item))
    const mutation = vi.spyOn(api, 'triageFinding').mockResolvedValue(result)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    await screen.findByText(`Oracle:${item.title}`)
    expect(mutation).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Triage comment'), '  reviewed evidence  ')
    await user.click(triageButton())
    await waitFor(() => expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument())
    expect(mutation).toHaveBeenCalledExactlyOnceWith(item.id, 'reviewed evidence', 'reviewer-X')
    expect(within(screen.getByRole('table')).getByText('TRIAGED')).toBeInTheDocument()
    expect(screen.getByText(`Oracle:${item.title}`)).toBeInTheDocument()
  })

  it('admits one mutation when two native clicks occur before React commits busy state', async () => {
    const item = evidenceFinding(302, 'Single intent')
    const pending = deferred<Finding>()
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    vi.spyOn(api, 'finding').mockResolvedValue(evidenceDetail(item))
    const mutation = vi.spyOn(api, 'triageFinding').mockReturnValue(pending.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    await screen.findByText(`Oracle:${item.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'one review')
    const button = triageButton()
    act(() => { button.click(); button.click() })
    expect(mutation).toHaveBeenCalledExactlyOnceWith(item.id, 'one review', 'reviewer-X')
    expect(queryButton()).toBeDisabled()
    expect(button).toBeDisabled()
    await respond(pending, { ...item, status: 'TRIAGED' })
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
  })

  it('preserves manual filters and clears evidence, counts and comments on same-context reload', async () => {
    const item = evidenceFinding(303, 'Filtered finding')
    const pending = deferred<Finding[]>()
    const list = vi.spyOn(api, 'findings').mockResolvedValueOnce([item]).mockReturnValueOnce(pending.promise)
    vi.spyOn(api, 'finding').mockResolvedValue(evidenceDetail(item))
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    await screen.findByText(`Oracle:${item.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'old draft')
    await user.selectOptions(screen.getByLabelText('Finding category'), 'FA-04')
    await user.selectOptions(screen.getByLabelText('Finding status'), 'OPEN')
    expect(list).toHaveBeenCalledTimes(1)
    await user.click(queryButton())
    expect(list).toHaveBeenNthCalledWith(2, release.id, 'reviewer-X', { category: 'FA-04', status: 'OPEN' })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.queryByText(`Oracle:${item.title}`)).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    await respond(pending, [])
    expect(screen.getByText('Finding이 없습니다')).toBeInTheDocument()
    expect(screen.getByLabelText('Finding summary')).toHaveTextContent('전체0')
    expect(queryButton()).toBeEnabled()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  it('keeps the local Release selection callback and filter values across a Release change', async () => {
    vi.spyOn(api, 'findings').mockResolvedValue([])
    const changed = vi.fn()
    const user = userEvent.setup()
    render(<FindingsPage releases={[release, secondRelease]} actorId="reviewer-X" onReleaseChange={changed} />)
    await screen.findByText('Finding이 없습니다')
    await user.selectOptions(screen.getByLabelText('Finding category'), 'FA-04')
    await user.selectOptions(screen.getByLabelText('Finding status'), 'OPEN')
    await user.selectOptions(screen.getByLabelText('Finding Release'), secondRelease.id)
    await waitFor(() => expect(api.findings).toHaveBeenLastCalledWith(secondRelease.id, 'reviewer-X', { category: 'FA-04', status: 'OPEN' }))
    expect(changed).toHaveBeenCalledExactlyOnceWith(secondRelease.id)
    expect(screen.getByLabelText('Finding Release')).toHaveValue(secondRelease.id)
    expect(screen.getByLabelText('Finding category')).toHaveValue('FA-04')
    expect(screen.getByLabelText('Finding status')).toHaveValue('OPEN')
  })

  it('does not dispatch a stale row or detail action in the same batch as a reload', async () => {
    const item = evidenceFinding(304, 'Invalidated authority')
    const pending = deferred<Finding[]>()
    vi.spyOn(api, 'findings').mockResolvedValueOnce([item]).mockReturnValueOnce(pending.promise)
    const inspect = vi.spyOn(api, 'finding').mockResolvedValue(evidenceDetail(item))
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    await screen.findByText(`Oracle:${item.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'old draft')
    const row = screen.getByRole('row', { name: new RegExp(item.title) })
    const oldTriage = triageButton()
    const query = queryButton()
    act(() => { query.click(); row.click(); oldTriage.click() })
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(api.triageFinding).not.toHaveBeenCalled()
    expect(queryButton()).toBeDisabled()
    await respond(pending, [item])
    expect(queryButton()).toBeEnabled()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
  })

  it('refuses whitespace comments and clears prior comment authority before replacement detail', async () => {
    const first = evidenceFinding(305, 'First comment target')
    const next = evidenceFinding(306, 'Next comment target')
    const pending = deferred<FindingDetail>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, next])
    vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(first)).mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await screen.findByText(`Oracle:${first.title}`)
    await user.type(screen.getByLabelText('Triage comment'), '   ')
    expect(triageButton()).toBeDisabled()
    await user.click(triageButton())
    expect(api.triageFinding).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('Triage comment'))
    await user.type(screen.getByLabelText('Triage comment'), 'old target comment')
    const oldButton = triageButton()
    const nextRow = screen.getByRole('row', { name: new RegExp(next.title) })
    act(() => { nextRow.click(); oldButton.click() })
    expect(api.triageFinding).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.queryByText(`Oracle:${first.title}`)).not.toBeInTheDocument()
    await respond(pending, evidenceDetail(next))
    expect(screen.getByLabelText('Triage comment')).toHaveValue('')
    expect(triageButton()).toBeDisabled()
  })

  it.each(['TRIAGED', 'RESOLVED', 'CLOSED'] as const)('preserves server INCONCLUSIVE and non-OPEN %s without implicit triage', async (status) => {
    const item = { ...evidenceFinding(307, 'Historical non-open evidence'), status }
    const detail = evidenceDetail(item)
    detail.oracleResult.outcome = 'INCONCLUSIVE'
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    vi.spyOn(api, 'finding').mockResolvedValue(detail)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    expect(await screen.findByText('INCONCLUSIVE')).toBeInTheDocument()
    expect(screen.queryByText('ATTACK BLOCKED')).not.toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText(status)).toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'TRIAGED로 전환' })).not.toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  for (const context of contextChanges) {
    it.each(['success', 'failure'])(`ignores stale ${context.name} list %s while the current list remains pending`, async (outcome) => {
      const old = deferred<Finding[]>()
      const current = deferred<Finding[]>()
      const oldItem = evidenceFinding(310, 'Old list canary')
      const currentItem = evidenceFinding(311, 'Current list', context.nextRelease)
      const list = vi.spyOn(api, 'findings').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
      const view = render(pageFor(context.firstActor))
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      expect(list).toHaveBeenNthCalledWith(1, release.id, context.firstActor, { category: undefined, status: undefined })
      expect(list).toHaveBeenNthCalledWith(2, context.nextRelease, context.nextActor, { category: undefined, status: undefined })
      await settle(old, outcome, [oldItem])
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(queryButton()).toBeDisabled()
      await respond(current, [currentItem])
      expect(await screen.findByRole('row', { name: new RegExp(currentItem.title) })).toBeInTheDocument()
      expect(screen.queryByRole('row', { name: new RegExp(oldItem.title) })).not.toBeInTheDocument()
      expect(queryButton()).toBeEnabled()
      expect(api.triageFinding).not.toHaveBeenCalled()
    })

    it.each(['success', 'failure'])(`keeps a real ${context.name} A→B→A lifetime distinct from old A %s`, async (outcome) => {
      const oldA = deferred<Finding[]>()
      const middleB = deferred<Finding[]>()
      const latestA = deferred<Finding[]>()
      const oldItem = evidenceFinding(312, 'Old A canary')
      const middleItem = evidenceFinding(313, 'Middle B canary', context.nextRelease)
      const latestItem = evidenceFinding(314, 'Latest A')
      const list = vi.spyOn(api, 'findings').mockReturnValueOnce(oldA.promise).mockReturnValueOnce(middleB.promise).mockReturnValueOnce(latestA.promise)
      const view = render(pageFor(context.firstActor))
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      expect(list).toHaveBeenCalledTimes(2)
      expect(list).toHaveBeenNthCalledWith(2, context.nextRelease, context.nextActor, { category: undefined, status: undefined })
      view.rerender(pageFor(context.firstActor))
      expect(list).toHaveBeenCalledTimes(3)
      expect(list).toHaveBeenNthCalledWith(3, release.id, context.firstActor, { category: undefined, status: undefined })
      await settle(oldA, outcome, [oldItem])
      await respond(middleB, [middleItem])
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(queryButton()).toBeDisabled()
      await respond(latestA, [latestItem])
      expect(await screen.findByRole('row', { name: new RegExp(latestItem.title) })).toBeInTheDocument()
      expect(screen.queryByRole('row', { name: /Old A canary|Middle B canary/ })).not.toBeInTheDocument()
    })

    it.each(['success', 'failure'])(`retains the current ${context.name} list error when old %s settles and recovers explicitly`, async (outcome) => {
      const old = deferred<Finding[]>()
      const current = deferred<Finding[]>()
      const recovered = evidenceFinding(315, 'Recovered list', context.nextRelease)
      const list = vi.spyOn(api, 'findings').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue([recovered])
      const user = userEvent.setup()
      const view = render(pageFor(context.firstActor))
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      await settle(current, 'failure', [], 'current-list-error')
      await settle(old, outcome, [evidenceFinding(316, 'Old error list canary')])
      expect(screen.getByText('current-list-error')).toBeInTheDocument()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
      expect(queryButton()).toBeEnabled()
      expect(list).toHaveBeenCalledTimes(2)
      await user.click(queryButton())
      expect(await screen.findByRole('row', { name: new RegExp(recovered.title) })).toBeInTheDocument()
      expect(screen.queryByText('current-list-error')).not.toBeInTheDocument()
      expect(list).toHaveBeenNthCalledWith(3, context.nextRelease, context.nextActor, { category: undefined, status: undefined })
    })

    it.each(['success', 'failure'])(`old triage %s cannot unlock a pending new ${context.name} detail`, async (outcome) => {
      const original = evidenceFinding(320, 'Original triage target')
      const next = evidenceFinding(321, 'New detail target', context.nextRelease)
      const oldTriage = deferred<Finding>()
      const nextDetail = deferred<FindingDetail>()
      vi.spyOn(api, 'findings').mockResolvedValueOnce([original]).mockResolvedValueOnce([next])
      vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(original)).mockReturnValueOnce(nextDetail.promise)
      const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(oldTriage.promise)
      const user = userEvent.setup()
      const view = render(pageFor(context.firstActor))
      await selectFinding(user, original)
      await screen.findByText(`Oracle:${original.title}`)
      await user.type(screen.getByLabelText('Triage comment'), 'original intent')
      await user.click(triageButton())
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
      expect(screen.queryByText(`Oracle:${original.title}`)).not.toBeInTheDocument()
      await selectFinding(user, next)
      await settle(oldTriage, outcome, { ...original, title: 'OLD TRIAGE CANARY', status: 'TRIAGED' })
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(queryButton()).toBeDisabled()
      expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
      await respond(nextDetail, evidenceDetail(next))
      expect(screen.getByText(`Oracle:${next.title}`)).toBeInTheDocument()
      expect(screen.getByLabelText('Triage comment')).toHaveValue('')
      expect(mutation).toHaveBeenCalledExactlyOnceWith(original.id, 'original intent', context.firstActor)
    })

    it.each(['success', 'failure'])(`old triage %s preserves new ${context.name} comment and pending mutation`, async (outcome) => {
      const original = evidenceFinding(322, 'Original mutation target')
      const next = evidenceFinding(323, 'Current mutation target', context.nextRelease)
      const oldTriage = deferred<Finding>()
      const currentTriage = deferred<Finding>()
      vi.spyOn(api, 'findings').mockResolvedValueOnce([original]).mockResolvedValueOnce([next])
      vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(original)).mockResolvedValueOnce(evidenceDetail(next))
      const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(oldTriage.promise).mockReturnValueOnce(currentTriage.promise)
      const user = userEvent.setup()
      const view = render(pageFor(context.firstActor))
      await selectFinding(user, original)
      await screen.findByText(`Oracle:${original.title}`)
      await user.type(screen.getByLabelText('Triage comment'), 'original intent')
      await user.click(triageButton())
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      await selectFinding(user, next)
      await screen.findByText(`Oracle:${next.title}`)
      await user.type(screen.getByLabelText('Triage comment'), 'current intent')
      await user.click(triageButton())
      await settle(oldTriage, outcome, { ...original, title: 'OLD TRIAGE CANARY', status: 'TRIAGED' })
      expect(screen.getByLabelText('Triage comment')).toHaveValue('current intent')
      expect(screen.getByText(`Oracle:${next.title}`)).toBeInTheDocument()
      expect(within(screen.getByRole('table')).getByText('OPEN')).toBeInTheDocument()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(screen.queryByText(/OLD TRIAGE CANARY/)).not.toBeInTheDocument()
      expect(queryButton()).toBeDisabled()
      expect(triageButton()).toBeDisabled()
      expect(mutation).toHaveBeenNthCalledWith(2, next.id, 'current intent', context.nextActor)
      await respond(currentTriage, { ...next, status: 'TRIAGED' })
      expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
      expect(within(screen.getByRole('table')).getByText('TRIAGED')).toBeInTheDocument()
      expect(mutation).toHaveBeenCalledTimes(2)
    })

    it.each(['success', 'failure'])(`ignores old triage %s after real ${context.name} A→B→A`, async (outcome) => {
      const original = evidenceFinding(324, 'Original A finding')
      const middle = evidenceFinding(325, 'Middle B finding', context.nextRelease)
      const latest = { ...original, title: 'Latest A finding' }
      const oldTriage = deferred<Finding>()
      const latestDetail = deferred<FindingDetail>()
      const list = vi.spyOn(api, 'findings').mockResolvedValueOnce([original]).mockResolvedValueOnce([middle]).mockResolvedValueOnce([latest])
      vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(original)).mockReturnValueOnce(latestDetail.promise)
      const mutation = vi.spyOn(api, 'triageFinding').mockReturnValue(oldTriage.promise)
      const user = userEvent.setup()
      const view = render(pageFor(context.firstActor))
      await selectFinding(user, original)
      await screen.findByText(`Oracle:${original.title}`)
      await user.type(screen.getByLabelText('Triage comment'), 'old A intent')
      await user.click(triageButton())
      view.rerender(pageFor(context.nextActor, context.nextRelease))
      await screen.findByRole('row', { name: new RegExp(middle.title) })
      expect(list).toHaveBeenNthCalledWith(2, context.nextRelease, context.nextActor, { category: undefined, status: undefined })
      view.rerender(pageFor(context.firstActor))
      await selectFinding(user, latest)
      expect(list).toHaveBeenNthCalledWith(3, release.id, context.firstActor, { category: undefined, status: undefined })
      await settle(oldTriage, outcome, { ...original, title: 'OLD A TRIAGE CANARY', status: 'TRIAGED' })
      expect(queryButton()).toBeDisabled()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      await respond(latestDetail, evidenceDetail(latest))
      await user.type(screen.getByLabelText('Triage comment'), 'new A draft')
      expect(screen.getByLabelText('Triage comment')).toHaveValue('new A draft')
      expect(within(screen.getByRole('table')).getByText('OPEN')).toBeInTheDocument()
      expect(mutation).toHaveBeenCalledExactlyOnceWith(original.id, 'old A intent', context.firstActor)
    })
  }

  it.each(['removed', 'empty'])('invalidates a preferred Release when inventory is %s without old endpoints', async (inventory) => {
    const old = deferred<Finding[]>()
    const current = deferred<Finding[]>()
    const list = vi.spyOn(api, 'findings').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const view = render(pageFor('reviewer-X', secondRelease.id))
    view.rerender(pageFor('reviewer-X', secondRelease.id, inventory === 'empty' ? [] : [release]))
    expect(screen.getByLabelText('Finding Release')).toHaveValue(inventory === 'empty' ? '' : release.id)
    expect(list).toHaveBeenCalledTimes(inventory === 'empty' ? 1 : 2)
    if (inventory !== 'empty') expect(list).toHaveBeenNthCalledWith(2, release.id, 'reviewer-X', { category: undefined, status: undefined })
    await respond(old, [evidenceFinding(330, 'Removed Release canary', secondRelease.id)])
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    if (inventory !== 'empty') {
      await respond(current, [])
      expect(screen.getByText('Finding이 없습니다')).toBeInTheDocument()
      expect(queryButton()).toBeEnabled()
    } else expect(screen.getByText('Release를 선택하세요')).toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('keeps reverse detail %s from the current selection and busy state', async (outcome) => {
    const first = evidenceFinding(331, 'First detail')
    const next = evidenceFinding(332, 'Next detail')
    const old = deferred<FindingDetail>()
    const current = deferred<FindingDetail>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, next])
    const inspect = vi.spyOn(api, 'finding').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await selectFinding(user, next)
    expect(inspect).toHaveBeenNthCalledWith(1, first.id, 'reviewer-X')
    expect(inspect).toHaveBeenNthCalledWith(2, next.id, 'reviewer-X')
    await settle(old, outcome, evidenceDetail(first, 'OLD DETAIL CANARY'))
    expect(screen.queryByText('Oracle:OLD DETAIL CANARY')).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    await respond(current, evidenceDetail(next))
    expect(screen.getByText(`Oracle:${next.title}`)).toBeInTheDocument()
    expect(screen.getByLabelText('Triage comment')).toHaveValue('')
    expect(queryButton()).toBeEnabled()
  })

  it.each(['success', 'failure'])('keeps Finding A→B→A distinct from old detail %s', async (outcome) => {
    const first = evidenceFinding(333, 'Finding A')
    const middle = evidenceFinding(334, 'Finding B')
    const oldA = deferred<FindingDetail>()
    const oldB = deferred<FindingDetail>()
    const latestA = deferred<FindingDetail>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, middle])
    const inspect = vi.spyOn(api, 'finding').mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise).mockReturnValueOnce(latestA.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await selectFinding(user, middle)
    expect(inspect).toHaveBeenNthCalledWith(2, middle.id, 'reviewer-X')
    await selectFinding(user, first)
    expect(inspect).toHaveBeenNthCalledWith(3, first.id, 'reviewer-X')
    await settle(oldA, outcome, evidenceDetail(first, 'OLD A DETAIL CANARY'))
    await respond(oldB, evidenceDetail(middle, 'OLD B DETAIL CANARY'))
    expect(screen.queryByText(/Oracle:OLD/)).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    await respond(latestA, evidenceDetail(first, 'LATEST A DETAIL'))
    expect(screen.getByText('Oracle:LATEST A DETAIL')).toBeInTheDocument()
    expect(screen.getByLabelText('Triage comment')).toHaveValue('')
  })

  it.each(['success', 'failure'])('ignores old triage %s during Finding A→B→A and same-context reload', async (outcome) => {
    const first = evidenceFinding(335, 'Triage finding A')
    const middle = evidenceFinding(336, 'Triage finding B')
    const oldTriage = deferred<Finding>()
    const reload = deferred<Finding[]>()
    vi.spyOn(api, 'findings').mockResolvedValueOnce([first, middle]).mockReturnValueOnce(reload.promise)
    const inspect = vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(first)).mockResolvedValueOnce(evidenceDetail(middle)).mockResolvedValueOnce(evidenceDetail(first, 'NEW A ORACLE'))
    const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(oldTriage.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await screen.findByText(`Oracle:${first.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'old mutation')
    await user.click(triageButton())
    await selectFinding(user, middle)
    await screen.findByText(`Oracle:${middle.title}`)
    await selectFinding(user, first)
    expect(await screen.findByText('Oracle:NEW A ORACLE')).toBeInTheDocument()
    expect(inspect).toHaveBeenNthCalledWith(3, first.id, 'reviewer-X')
    await user.type(screen.getByLabelText('Triage comment'), 'new A draft')
    await user.click(queryButton())
    await settle(oldTriage, outcome, { ...first, title: 'OLD FINDING TRIAGE CANARY', status: 'TRIAGED' })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    await respond(reload, [first, middle])
    expect(queryButton()).toBeEnabled()
    expect(screen.queryByText(/OLD FINDING TRIAGE CANARY/)).not.toBeInTheDocument()
    expect(mutation).toHaveBeenCalledExactlyOnceWith(first.id, 'old mutation', 'reviewer-X')
  })

  it.each(['success', 'failure'])('old same-Release triage %s cannot replace a new Finding Oracle, comment or pending triage', async (outcome) => {
    const first = evidenceFinding(349, 'Previous finding intent')
    const current = evidenceFinding(350, 'Current finding intent')
    const old = deferred<Finding>()
    const latest = deferred<Finding>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, current])
    vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(first)).mockResolvedValueOnce(evidenceDetail(current))
    const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await screen.findByText(`Oracle:${first.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'first finding intent')
    await user.click(triageButton())
    await selectFinding(user, current)
    await screen.findByText(`Oracle:${current.title}`)
    expect(screen.getByLabelText('Triage comment')).toHaveValue('')
    await user.type(screen.getByLabelText('Triage comment'), 'current finding intent')
    await user.click(triageButton())
    await settle(old, outcome, { ...first, title: 'OLD SAME-RELEASE TRIAGE CANARY', status: 'TRIAGED' })
    expect(screen.getByLabelText('Triage comment')).toHaveValue('current finding intent')
    expect(screen.getByText(`Oracle:${current.title}`)).toBeInTheDocument()
    expect(screen.queryByText(`Oracle:${first.title}`)).not.toBeInTheDocument()
    expect(screen.queryByText(/OLD SAME-RELEASE TRIAGE CANARY/)).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    expect(triageButton()).toBeDisabled()
    expect(mutation).toHaveBeenNthCalledWith(1, first.id, 'first finding intent', 'reviewer-X')
    expect(mutation).toHaveBeenNthCalledWith(2, current.id, 'current finding intent', 'reviewer-X')
    await respond(latest, { ...current, status: 'TRIAGED' })
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.getByText(`Oracle:${current.title}`)).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: new RegExp(current.title) })).getByText('TRIAGED')).toBeInTheDocument()
  })

  it.each(['success', 'failure'])('old Finding A triage %s cannot alter the newest A detail or comment after A→B→A', async (outcome) => {
    const first = evidenceFinding(351, 'ABA finding A')
    const middle = evidenceFinding(352, 'ABA finding B')
    const old = deferred<Finding>()
    const latest = deferred<Finding>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, middle])
    const inspect = vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(first)).mockResolvedValueOnce(evidenceDetail(middle)).mockResolvedValueOnce(evidenceDetail(first, 'LATEST ABA ORACLE'))
    const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await screen.findByText(`Oracle:${first.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'old A intent')
    await user.click(triageButton())
    await selectFinding(user, middle)
    await screen.findByText(`Oracle:${middle.title}`)
    expect(inspect).toHaveBeenNthCalledWith(2, middle.id, 'reviewer-X')
    await selectFinding(user, first)
    await screen.findByText('Oracle:LATEST ABA ORACLE')
    expect(inspect).toHaveBeenNthCalledWith(3, first.id, 'reviewer-X')
    await user.type(screen.getByLabelText('Triage comment'), 'latest A intent')
    await user.click(triageButton())
    await settle(old, outcome, { ...first, title: 'OLD ABA TRIAGE CANARY', status: 'TRIAGED' })
    expect(screen.getByLabelText('Triage comment')).toHaveValue('latest A intent')
    expect(screen.getByText('Oracle:LATEST ABA ORACLE')).toBeInTheDocument()
    expect(screen.queryByText(/OLD ABA TRIAGE CANARY/)).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    expect(triageButton()).toBeDisabled()
    expect(mutation).toHaveBeenNthCalledWith(2, first.id, 'latest A intent', 'reviewer-X')
    await respond(latest, { ...first, status: 'TRIAGED' })
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.getByText('Oracle:LATEST ABA ORACLE')).toBeInTheDocument()
  })

  it('retains the current detail error after an older rejection and recovers explicitly', async () => {
    const first = evidenceFinding(337, 'Old rejected detail')
    const current = evidenceFinding(338, 'Current rejected detail')
    const old = deferred<FindingDetail>()
    const latest = deferred<FindingDetail>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, current])
    const inspect = vi.spyOn(api, 'finding').mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise).mockResolvedValueOnce(evidenceDetail(current))
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await selectFinding(user, current)
    await settle(latest, 'failure', evidenceDetail(current), 'current-detail-error')
    await settle(old, 'failure', evidenceDetail(first))
    expect(screen.getByText('current-detail-error')).toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(queryButton()).toBeEnabled()
    expect(inspect).toHaveBeenCalledTimes(2)
    await selectFinding(user, current)
    expect(await screen.findByText(`Oracle:${current.title}`)).toBeInTheDocument()
    expect(screen.queryByText('current-detail-error')).not.toBeInTheDocument()
    expect(inspect).toHaveBeenNthCalledWith(3, current.id, 'reviewer-X')
  })

  it('retains the current triage error, comment and explicit recovery after an old rejection', async () => {
    const first = evidenceFinding(339, 'Old rejected triage')
    const current = evidenceFinding(340, 'Current rejected triage')
    const old = deferred<Finding>()
    const latest = deferred<Finding>()
    vi.spyOn(api, 'findings').mockResolvedValue([first, current])
    vi.spyOn(api, 'finding').mockResolvedValueOnce(evidenceDetail(first)).mockResolvedValueOnce(evidenceDetail(current))
    const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise).mockResolvedValueOnce({ ...current, status: 'TRIAGED' })
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, first)
    await screen.findByText(`Oracle:${first.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'old intent')
    await user.click(triageButton())
    await selectFinding(user, current)
    await screen.findByText(`Oracle:${current.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'current intent')
    await user.click(triageButton())
    await settle(latest, 'failure', current, 'current-triage-error')
    await settle(old, 'failure', first)
    expect(screen.getByText('current-triage-error')).toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Triage comment')).toHaveValue('current intent')
    expect(queryButton()).toBeEnabled()
    expect(triageButton()).toBeEnabled()
    expect(mutation).toHaveBeenCalledTimes(2)
    await user.click(triageButton())
    await waitFor(() => expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument())
    expect(screen.queryByText('current-triage-error')).not.toBeInTheDocument()
    expect(mutation).toHaveBeenNthCalledWith(3, current.id, 'current intent', 'reviewer-X')
  })

  it('rejects a foreign list Release without showing a false zero or foreign evidence', async () => {
    const valid = evidenceFinding(341, 'Valid release list')
    const list = vi.spyOn(api, 'findings').mockResolvedValueOnce([evidenceFinding(342, 'FOREIGN LIST CANARY', secondRelease.id)]).mockResolvedValueOnce([valid])
    const user = userEvent.setup()
    render(pageFor())
    expect(await screen.findByText('선택한 Release와 Finding 목록이 일치하지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
    expect(screen.queryByText(/FOREIGN LIST CANARY/)).not.toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(1)
    await user.click(queryButton())
    expect(await screen.findByRole('row', { name: new RegExp(valid.title) })).toBeInTheDocument()
    expect(screen.getByLabelText('Finding summary')).toHaveTextContent('전체1')
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  const wrongDetails: Array<{ name: string; change: (value: FindingDetail) => FindingDetail }> = [
    { name: 'Finding id', change: (value) => ({ ...value, finding: { ...value.finding, id: testId(900) } }) },
    { name: 'Finding Release', change: (value) => ({ ...value, finding: { ...value.finding, releaseId: secondRelease.id } }) },
    { name: 'Oracle source id', change: (value) => ({ ...value, oracleResult: { ...value.oracleResult, id: testId(901) } }) },
    { name: 'related Finding Release', change: (value) => ({ ...value, relatedFindings: [evidenceFinding(902, 'FOREIGN RELATED CANARY', secondRelease.id)] }) },
  ]
  it.each(wrongDetails)('rejects wrong $name detail without enabling triage, then accepts the valid association', async ({ change }) => {
    const item = evidenceFinding(343, 'Associated detail')
    const invalid = change(evidenceDetail(item, 'INVALID DETAIL CANARY'))
    const inspect = vi.spyOn(api, 'finding').mockResolvedValueOnce(invalid).mockResolvedValueOnce(evidenceDetail(item))
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    expect(await screen.findByText('선택한 Finding과 판정 근거가 일치하지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByText(/INVALID DETAIL CANARY|FOREIGN RELATED CANARY/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
    await selectFinding(user, item)
    expect(await screen.findByText(`Oracle:${item.title}`)).toBeInTheDocument()
    expect(screen.getByLabelText('Triage comment')).toHaveValue('')
    expect(inspect).toHaveBeenNthCalledWith(2, item.id, 'reviewer-X')
  })

  it.each(['Finding id', 'Release id', 'Oracle source id'])('rejects wrong triage %s without mixing Oracle evidence, then recovers explicitly', async (identity) => {
    const item = evidenceFinding(344, 'Associated triage')
    const invalid = { ...item, title: 'INVALID TRIAGE CANARY', status: 'TRIAGED' as const }
    if (identity === 'Finding id') invalid.id = testId(903)
    else if (identity === 'Release id') invalid.releaseId = secondRelease.id
    else invalid.sourceOracleResultId = testId(904)
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    vi.spyOn(api, 'finding').mockResolvedValue(evidenceDetail(item))
    const mutation = vi.spyOn(api, 'triageFinding').mockResolvedValueOnce(invalid).mockResolvedValueOnce({ ...item, status: 'TRIAGED' })
    const user = userEvent.setup()
    render(pageFor())
    await selectFinding(user, item)
    await screen.findByText(`Oracle:${item.title}`)
    await user.type(screen.getByLabelText('Triage comment'), 'current review')
    await user.click(triageButton())
    expect(await screen.findByText('검토 결과가 선택한 Finding과 일치하지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByText(/INVALID TRIAGE CANARY/)).not.toBeInTheDocument()
    expect(screen.getByText(`Oracle:${item.title}`)).toBeInTheDocument()
    expect(screen.getByLabelText('Triage comment')).toHaveValue('current review')
    expect(within(screen.getByRole('table')).getByText('OPEN')).toBeInTheDocument()
    expect(mutation).toHaveBeenCalledTimes(1)
    await user.click(triageButton())
    await waitFor(() => expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument())
    expect(mutation).toHaveBeenNthCalledWith(2, item.id, 'current review', 'reviewer-X')
  })

  it.each(['success', 'failure'])('ignores the discarded StrictMode list generation %s while the active generation is pending', async (outcome) => {
    const discarded = deferred<Finding[]>()
    const active = deferred<Finding[]>()
    const item = evidenceFinding(345, 'StrictMode active finding')
    const list = vi.spyOn(api, 'findings').mockReturnValueOnce(discarded.promise).mockReturnValueOnce(active.promise)
    render(<StrictMode>{pageFor()}</StrictMode>)
    expect(list).toHaveBeenCalledTimes(2)
    await settle(discarded, outcome, [evidenceFinding(346, 'DISCARDED STRICTMODE CANARY')])
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Finding summary')).not.toBeInTheDocument()
    expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
    expect(queryButton()).toBeDisabled()
    await respond(active, [item])
    expect(await screen.findByRole('row', { name: new RegExp(item.title) })).toBeInTheDocument()
    expect(queryButton()).toBeEnabled()
  })

  for (const operation of ['list', 'detail', 'triage'] as const) {
    it.each(['success', 'failure'])(`keeps an unmounted ${operation} %s inert after a fresh mount with the same context`, async (outcome) => {
      const item = evidenceFinding(347, 'Unmounted operation canary')
      const newItem = evidenceFinding(348, 'Fresh mounted finding')
      const oldList = deferred<Finding[]>()
      const oldDetail = deferred<FindingDetail>()
      const oldTriage = deferred<Finding>()
      const freshList = deferred<Finding[]>()
      const list = vi.spyOn(api, 'findings')
      if (operation === 'list') list.mockReturnValueOnce(oldList.promise)
      else list.mockResolvedValueOnce([item])
      list.mockReturnValueOnce(freshList.promise)
      const inspect = vi.spyOn(api, 'finding')
      if (operation === 'detail') inspect.mockReturnValueOnce(oldDetail.promise)
      else inspect.mockResolvedValueOnce(evidenceDetail(item))
      const mutation = vi.spyOn(api, 'triageFinding').mockReturnValueOnce(oldTriage.promise)
      const user = userEvent.setup()
      const oldView = render(pageFor())
      if (operation !== 'list') await selectFinding(user, item)
      if (operation === 'triage') {
        await screen.findByText(`Oracle:${item.title}`)
        await user.type(screen.getByLabelText('Triage comment'), 'old mounted intent')
        await user.click(triageButton())
      }
      oldView.unmount()
      render(pageFor())
      if (operation === 'list') await settle(oldList, outcome, [item])
      else if (operation === 'detail') await settle(oldDetail, outcome, evidenceDetail(item))
      else await settle(oldTriage, outcome, { ...item, status: 'TRIAGED' })
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
      expect(screen.queryByText(`Oracle:${item.title}`)).not.toBeInTheDocument()
      expect(screen.queryByText('old-request-error')).not.toBeInTheDocument()
      expect(queryButton()).toBeDisabled()
      expect(list).toHaveBeenCalledTimes(2)
      expect(mutation).toHaveBeenCalledTimes(operation === 'triage' ? 1 : 0)
      await respond(freshList, [newItem])
      expect(await screen.findByRole('row', { name: new RegExp(newItem.title) })).toBeInTheDocument()
      expect(queryButton()).toBeEnabled()
    })
  }
})
