import { StrictMode } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import type { DecisionProposal, DecisionView, JsonValue, MetricValue, MetricsView, Release, TrialBit } from '../api/contracts'
import { AssurancePage } from './Assurance'
import { AssuranceEvidence, filteredProposalSnapshot, RequiredCohortEvidence } from './AssuranceEvidence'

const A = '0198f200-0000-7000-8000-000000000101'
const B = '0198f200-0000-7000-8000-000000000102'
const RUN = '0198f200-0000-7000-8000-000000000103'
const CASE = '0198f200-0000-7000-8000-000000000104'
const ORACLE = '0198f200-0000-7000-8000-000000000105'
const EVENT = '0198f200-0000-7000-8000-000000000106'
const CR = '0198f200-0000-7000-8000-000000000107'
const fingerprint = `sha256:${'c'.repeat(64)}`
const release = (id: string, version: string): Release => ({
  id, agentId: CASE, version, businessPurpose: 'Document completeness', manifestSchemaVersion: '1.1',
  agentArtifactFingerprint: fingerprint, releaseFingerprint: fingerprint, safetyContractHash: null,
  lifecycleState: 'VERIFYING', effectiveStatus: 'VERIFYING', revalidationReason: null,
  analyzedAt: null, lastTestedAt: null, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
})
const releases = [release(A, '1.0.0'), release(B, '2.0.0')]
const absent = (name: string): MetricValue => ({ name, status: 'N_A', reason: 'NO_CONCLUSIVE_TRIALS', numerator: null, denominator: null, value: null, sourceRunIds: [] })
function view(id = A): MetricsView {
  return { releaseId: id, metrics: {
    attackSuccessRate: absent('ASR'), attackBlockRate: absent('ABR'), heldOutAttackSuccessRate: absent('HeldOutASR'),
    normalTaskSuccessRate: absent('NTSR'), falseBlockRate: absent('FBR'), operationalErrorRate: absent('OperationalErrorRate'),
    unauthorizedRecordExposureCount: null, sensitiveFieldExposureCount: null, exfiltrationSuccessCount: null,
    highImpactMutationCount: null, normalConclusiveTrials: 0, trials: [],
  } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function proposal(id = A, snapshot: JsonValue = { release: { id }, decision: { ruleTrace: [] } }): DecisionProposal {
  return { releaseId: id, proposedDecision: 'REVIEW', gatePolicyVersion: 'mvp-gate/1', inputDigest: fingerprint, inputSnapshot: snapshot }
}
function confirmed(id = A): DecisionView {
  return { id: ORACLE, releaseId: id, decision: 'BLOCKED', gatePolicyVersion: 'mvp-gate/1', inputDigest: `sha256:${'d'.repeat(64)}`,
    proposedAt: '2026-09-30T00:00:00Z', confirmedBy: 'reviewer', confirmedAt: '2026-09-30T00:00:00Z' }
}
async function choose(id: string) { await userEvent.selectOptions(screen.getByLabelText('Assurance Release'), id) }
async function settle<T>(request: ReturnType<typeof deferred<T>>, value: T) { await act(async () => { request.resolve(value); await request.promise }) }
async function fail<T>(request: ReturnType<typeof deferred<T>>) { await act(async () => { request.reject(new Error('OLD_RELEASE_FAILURE')); await request.promise.catch(() => {}) }) }
function reports(): MetricsView {
  const orderedTrials: TrialBit[] = [
    { runId: RUN, testCaseId: CASE, caseRunId: CR, trialIndex: 0, successBit: 1, exclusionReason: null, secondaryInconclusive: true },
    { runId: RUN, testCaseId: CASE, caseRunId: B, trialIndex: 1, successBit: null, exclusionReason: 'OPERATIONAL_ERROR', secondaryInconclusive: false },
    { runId: RUN, testCaseId: CASE, caseRunId: A, trialIndex: 2, successBit: 0, exclusionReason: null, secondaryInconclusive: false },
  ]
  return { ...view(),
    policyLatency: { status: 'AVAILABLE', reason: null, observedEventCount: 3, invalidEventCount: 0, averageMs: 1.123456789,
      p50Ms: 0, p95Ms: 2.123456789, p99Ms: 2.123456789, sourceRunIds: [RUN], sourceEventIds: [EVENT] },
    completionRate: { status: 'AVAILABLE', reason: null, numerator: 2, denominator: 8, value: 0.25,
      cancelledTrials: 1, unmaterializedTrials: 3, sourceRunIds: [RUN] },
    trialSuccessDistribution: { status: 'AVAILABLE', reason: null, sourceRunIds: [RUN], cases: [
      { status: 'AVAILABLE', reason: null, runId: RUN, mode: 'HELD_OUT', testCaseId: CASE, caseKey: 'FA-04-hidden', caseType: 'ATTACK',
        category: 'FA-04', partition: 'HELD_OUT', successBits: [1, null, 0], orderedTrials, successCount: 1, trials: 2, excludedTrials: 1 },
    ], categories: [{ status: 'AVAILABLE', reason: null, mode: 'HELD_OUT', caseType: 'ATTACK', category: 'FA-04',
      successBits: [1, null, 0], orderedTrials, successCount: 1, trials: 2, excludedTrials: 1, sourceRunIds: [RUN] }] },
    attackRateBreakdown: { status: 'AVAILABLE', reason: null, sourceRunIds: [RUN], groups: [
      { status: 'AVAILABLE', reason: null, mode: 'SEAL_REPLAY', category: 'FA-02', partition: 'SEED', numerator: 0, denominator: 3,
        value: 0, anySuccess: false, excludedTrials: 1, sourceRunIds: [RUN] },
      { status: 'N_A', reason: 'NO_CONCLUSIVE_ATTACK_TRIALS', mode: 'SEAL_REPLAY', category: 'FA-05', partition: 'MUTATION',
        numerator: null, denominator: null, value: null, anySuccess: null, excludedTrials: 2, sourceRunIds: [] },
    ] },
    criticalInvariantAnySuccess: { invariants: [
      { gcId: 'GC-03', invariantId: 'INV-04', status: 'AVAILABLE', reason: null, anySuccess: true, sourceRunIds: [RUN],
        sourceCaseRunIds: [CR], sourceOracleResultIds: [ORACLE], sourceEventIds: [EVENT] },
      { gcId: 'GC-01', invariantId: 'INV-01', status: 'N_A', reason: 'NEGATIVE_PROOF_UNAVAILABLE', anySuccess: null,
        sourceRunIds: [], sourceCaseRunIds: [], sourceOracleResultIds: [], sourceEventIds: [] },
    ] },
  }
}

function reportsWithSecondGroup(): MetricsView {
  const input = reports(), report = input.trialSuccessDistribution!
  const first = report.cases[0]!
  const second = { ...first, runId: B, testCaseId: ORACLE, caseKey: 'FA-05-second', category: 'FA-05',
    orderedTrials: first.orderedTrials.map((bit, index) => ({ ...bit, runId: B, testCaseId: ORACLE,
      caseRunId: [CASE, ORACLE, RUN][index]! })) }
  report.cases.push(second)
  report.categories.push({ ...report.categories[0]!, category: 'FA-05', orderedTrials: second.orderedTrials, sourceRunIds: [B] })
  report.sourceRunIds = [RUN, B]
  return input
}

describe('D-EVIDENCE-001 / TC-MET-002 and TC-MET-003: stored report fidelity', () => {
  it('preserves precision, real zero, fractions, ordered null bits and full linked IDs without mutating input', () => {
    const input = reports()
    const original = JSON.stringify(input)
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Policy latency')).getByText('1.123456789 ms')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Policy latency')).getByText('0 ms')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Completion rate')).getByText('2/8 terminal non-cancelled / scheduled trials')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Completion rate')).getByText('0.25')).toBeInTheDocument()
    const distribution = screen.getByLabelText('Trial success distribution')
    expect(within(distribution).getAllByText('Ordered bits: [1, ?, 0]')).toHaveLength(2)
    expect(within(distribution).getAllByText(/OPERATIONAL_ERROR/)).toHaveLength(2)
    expect(within(distribution).getAllByText(/SECONDARY_INCONCLUSIVE/)).toHaveLength(2)
    expect(within(screen.getByLabelText('Attack rate breakdown')).getByText('0/3')).toBeInTheDocument()
    const gc = screen.getByLabelText('Critical invariant evidence')
    const positive = within(gc).getByText('GC-03').closest('tr')!
    for (const id of [RUN, CR, ORACLE, EVENT]) expect(within(positive).getByText(id)).toBeInTheDocument()
    expect(within(positive).getByText('true')).toBeInTheDocument()
    expect(within(gc).getByText(/NEGATIVE_PROOF_UNAVAILABLE/)).toBeInTheDocument()
    expect(JSON.stringify(input)).toBe(original)
  })

  it('keeps N_A authoritative even when fields contain available-looking numeric values', () => {
    const input = reports()
    input.policyLatency!.status = 'N_A'; input.policyLatency!.reason = 'MISSING_OR_INVALID_DURATION'
    input.completionRate!.status = 'N_A'; input.completionRate!.reason = 'INCONSISTENT_TRIAL_COUNTS'
    input.attackRateBreakdown!.groups[0]!.status = 'N_A'; input.attackRateBreakdown!.groups[0]!.reason = 'REPLAY_NOT_COMPARABLE'
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Policy latency')).queryByText('1.123456789 ms')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Policy latency')).getByText(/MISSING_OR_INVALID_DURATION/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Completion rate')).queryByText('0.25')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Attack rate breakdown')).queryByText('0/3')).not.toBeInTheDocument()
  })

  it.each(['OPERATIONAL_ERROR', 'INCONCLUSIVE_ORACLE', 'CANCELLED', 'NON_TERMINAL_CASE', 'REPLAY_NOT_COMPARABLE'])('retains excluded %s as a null bit', reason => {
    const input = reports()
    input.trialSuccessDistribution!.cases[0]!.orderedTrials[1]!.exclusionReason = reason
    render(<AssuranceEvidence reports={input} />)
    const row = within(screen.getByLabelText('Trial success distribution')).getAllByText(/Ordered bits/)[0]!.parentElement!
    expect(within(row).getByText(new RegExp(reason))).toBeInTheDocument()
    expect(within(row).getByText('Ordered bits: [1, ?, 0]')).toBeInTheDocument()
  })

  it.each([undefined, null, { status: 'AVAILABLE', sourceRunIds: {} }, { status: 'AVAILABLE', averageMs: -1 }])('degrades malformed or omitted optional reports without invented zeros: %j', bad => {
    const input = { ...view(), policyLatency: bad, completionRate: bad, trialSuccessDistribution: bad, attackRateBreakdown: bad, criticalInvariantAnySuccess: bad } as unknown as MetricsView
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Policy latency')).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Critical invariant evidence')).queryByText('false')).not.toBeInTheDocument()
    expect(screen.queryByText('0 ms')).not.toBeInTheDocument()
  })

  it.each(['cases', 'categories'] as const)('rejects impossible AVAILABLE %s counts and misassociated ordered bits', collection => {
    const malformed: Array<Record<string, unknown>> = [
      { successCount: null }, { trials: null }, { trials: 0 }, { successCount: 3 },
      { successCount: 0 }, { trials: 3, excludedTrials: 0 },
      { successBits: [0, null, 1] }, { successBits: [1, null] },
      { orderedTrials: [{ ...reports().trialSuccessDistribution!.cases[0]!.orderedTrials[0]!, runId: ORACLE }, ...reports().trialSuccessDistribution!.cases[0]!.orderedTrials.slice(1)] },
    ]
    for (const fields of malformed) {
      const input = reports()
      Object.assign(input.trialSuccessDistribution![collection][0]!, fields)
      const ui = render(<AssuranceEvidence reports={input} />)
      const report = screen.getByLabelText('Trial success distribution')
      expect(within(report).getByText(/N\/A/)).toBeInTheDocument()
      expect(within(report).queryByText('AVAILABLE')).not.toBeInTheDocument()
      expect(within(report).queryByText('1/2')).not.toBeInTheDocument()
      ui.unmount()
    }
  })

  it.each(['cases', 'categories'] as const)('rejects all-null AVAILABLE %s vectors with bounded but contradictory counts', collection => {
    const input = reports()
    const row = input.trialSuccessDistribution![collection][0]!
    row.successBits = [null]
    row.orderedTrials = [{ ...row.orderedTrials[1]! }]
    row.successCount = 0; row.trials = 1; row.excludedTrials = 0
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Trial success distribution')).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Trial success distribution')).queryByText('0/1')).not.toBeInTheDocument()
  })

  it.each(['parent-empty', 'category-extra-source', 'blank-run', 'blank-test-case', 'blank-case-run'] as const)('rejects %s distribution source identities without deriving values', defect => {
    const input = reports(), report = input.trialSuccessDistribution!
    const row = report.cases[0]!
    if (defect === 'parent-empty') report.sourceRunIds = []
    if (defect === 'category-extra-source') report.categories[0]!.sourceRunIds.push(ORACLE)
    if (defect === 'blank-run') {
      row.runId = ' '; report.sourceRunIds = [' ']; report.categories[0]!.sourceRunIds = [' ']
      row.orderedTrials.forEach(bit => { bit.runId = ' ' })
    }
    if (defect === 'blank-test-case') { row.testCaseId = ''; row.orderedTrials.forEach(bit => { bit.testCaseId = '' }) }
    if (defect === 'blank-case-run') row.orderedTrials[0]!.caseRunId = ' '
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Trial success distribution')).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Trial success distribution')).queryByText('1/2')).not.toBeInTheDocument()
  })

  it.each(['N_A-parent-with-available', 'available-parent-with-N_A', 'parent-empty', 'group-extra-source'] as const)('rejects %s attack breakdown associations', defect => {
    const input = reports(), report = input.attackRateBreakdown!
    if (defect === 'N_A-parent-with-available') { report.status = 'N_A'; report.reason = 'NO_CONCLUSIVE_ATTACK_TRIALS' }
    if (defect === 'available-parent-with-N_A') report.groups = [report.groups[1]!]
    if (defect === 'parent-empty') report.sourceRunIds = []
    if (defect === 'group-extra-source') report.groups[0]!.sourceRunIds.push(ORACLE)
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Attack rate breakdown')
    expect(within(rendered).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(rendered).queryByText('AVAILABLE')).not.toBeInTheDocument()
    expect(within(rendered).queryByText('0/3')).not.toBeInTheDocument()
  })

  it('preserves all-N_A attack groups and their ordered sources rather than creating a zero rate', () => {
    const input = reports(), group = input.attackRateBreakdown!.groups[1]!
    group.sourceRunIds = [B, RUN]
    input.attackRateBreakdown = { status: 'N_A', reason: 'NO_CONCLUSIVE_ATTACK_TRIALS', groups: [group], sourceRunIds: [B, RUN] }
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText('Attack rate breakdown')
    expect(within(report).getAllByText(/NO_CONCLUSIVE_ATTACK_TRIALS/)).toHaveLength(2)
    expect(within(report).queryByText('0/0')).not.toBeInTheDocument()
    expect(Array.from(report.querySelector('tbody')!.querySelectorAll('code'), node => node.textContent)).toEqual([B, RUN])
  })

  it.each(['contradictory-available', 'identical-available', 'N_A'] as const)('rejects the whole attack report for %s duplicate dimensions', kind => {
    const input = reports(), report = input.attackRateBreakdown!
    if (kind === 'N_A') {
      const group = report.groups[1]!
      report.status = 'N_A'; report.reason = 'NO_CONCLUSIVE_ATTACK_TRIALS'
      report.groups = [group, { ...group, sourceRunIds: [] }]
    } else {
      const group = report.groups[0]!
      group.denominator = 1; group.value = 0
      report.groups.push({ ...group, numerator: kind === 'contradictory-available' ? 1 : 0,
        value: kind === 'contradictory-available' ? 1 : 0, anySuccess: kind === 'contradictory-available', sourceRunIds: [RUN] })
    }
    const original = JSON.stringify(input)
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Attack rate breakdown')
    expect(within(rendered).getByText('N/A — 보고서가 없거나 저장 형식을 확인할 수 없습니다.')).toBeInTheDocument()
    expect(within(rendered).queryByRole('table')).not.toBeInTheDocument()
    for (const value of ['AVAILABLE', '0/1', '1/1', 'false', 'true']) expect(within(rendered).queryByText(value)).not.toBeInTheDocument()
    expect(JSON.stringify(input)).toBe(original)
  })

  it.each(['mode', 'partition'] as const)('preserves same-category attack groups differing only in %s', dimension => {
    const input = reports(), report = input.attackRateBreakdown!, first = report.groups[0]!
    const second = { ...first, numerator: 1, value: 1 / 3, anySuccess: true, sourceRunIds: [B],
      mode: dimension === 'mode' ? 'BASELINE' : first.mode,
      partition: dimension === 'partition' ? 'MUTATION' : first.partition }
    report.groups = [first, second, report.groups[1]!]; report.sourceRunIds = [B, RUN]
    const original = JSON.stringify(input)
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Attack rate breakdown')
    expect(within(rendered).getByText('AVAILABLE')).toBeInTheDocument()
    const table = within(rendered).getByRole('table', { name: 'Mode / category / partition별 공격 성공률' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText('0/3')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('false')).toBeInTheDocument()
    expect(within(rows[0]!).getByText(RUN)).toBeInTheDocument()
    expect(within(rows[1]!).getByText(`${second.mode} · FA-02 · ${second.partition}`)).toBeInTheDocument()
    expect(within(rows[1]!).getByText('1/3')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Server value: 0.3333333333333333')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('true')).toBeInTheDocument()
    expect(within(rows[1]!).getByText(B)).toBeInTheDocument()
    expect(within(rows[2]!).getByText(/NO_CONCLUSIVE_ATTACK_TRIALS/)).toBeInTheDocument()
    expect(Array.from(rendered.querySelectorAll(':scope > details code'), node => node.textContent)).toEqual([B, RUN])
    expect(JSON.stringify(input)).toBe(original)
  })

  it.each([['positive-false', 1, false], ['positive-null', 1, null], ['zero-true', 0, true]] as const)('rejects %s AVAILABLE attack anySuccess contradictions', (_label, numerator, anySuccess) => {
    const input = reports(), group = input.attackRateBreakdown!.groups[0]!
    group.numerator = numerator; group.denominator = 1; group.value = numerator; group.anySuccess = anySuccess
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText('Attack rate breakdown')
    expect(within(report).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(report).queryByText('1/1')).not.toBeInTheDocument()
    expect(within(report).queryByText('0/1')).not.toBeInTheDocument()
    expect(within(report).queryByText('false')).not.toBeInTheDocument()
  })

  it.each(['latency-runs', 'latency-events', 'completion-runs', 'attack-group-runs'] as const)('keeps source-free AVAILABLE %s reports unavailable', defect => {
    const input = reports()
    if (defect === 'latency-runs') input.policyLatency!.sourceRunIds = []
    if (defect === 'latency-events') input.policyLatency!.sourceEventIds = []
    if (defect === 'completion-runs') input.completionRate!.sourceRunIds = []
    if (defect === 'attack-group-runs') input.attackRateBreakdown!.groups[0]!.sourceRunIds = []
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText(defect.startsWith('latency') ? 'Policy latency' : defect.startsWith('completion') ? 'Completion rate' : 'Attack rate breakdown')
    expect(within(report).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(report).queryByText('1.123456789 ms')).not.toBeInTheDocument()
    expect(within(report).queryByText('2/8 terminal non-cancelled / scheduled trials')).not.toBeInTheDocument()
    expect(within(report).queryByText('0/3')).not.toBeInTheDocument()
  })

  it.each([{ numerator: 1, denominator: 1, value: 1, cancelledTrials: 1, unmaterializedTrials: 1 },
    { numerator: 0, denominator: 3, value: 0, cancelledTrials: 2, unmaterializedTrials: 2 }])('rejects overallocated AVAILABLE completion slots: %j', counts => {
    const input = reports()
    Object.assign(input.completionRate!, counts)
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText('Completion rate')
    expect(within(report).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(report).queryByText(/terminal non-cancelled/)).not.toBeInTheDocument()
  })

  it.each(['completion', 'attack'] as const)('rejects an AVAILABLE %s server value contradicting its fraction', family => {
    const input = reports()
    if (family === 'completion') input.completionRate!.value = 0.75
    else input.attackRateBreakdown!.groups[0]!.value = 1
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText(family === 'completion' ? 'Completion rate' : 'Attack rate breakdown')).getByText(/N\/A/)).toBeInTheDocument()
  })

  it('preserves valid fractional parsed precision and positive attack evidence without replacing values', () => {
    const input = reports()
    Object.assign(input.completionRate!, { numerator: 1, denominator: 3, value: 0.3333333333333333, cancelledTrials: 0, unmaterializedTrials: 1 })
    Object.assign(input.attackRateBreakdown!.groups[0]!, { numerator: 1, denominator: 3, value: 0.3333333333333333, anySuccess: true })
    const original = JSON.stringify(input)
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Completion rate')).getByText('0.3333333333333333')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Attack rate breakdown')).getByText('true')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Attack rate breakdown')).getByText('Server value: 0.3333333333333333')).toBeInTheDocument()
    expect(JSON.stringify(input)).toBe(original)
  })

  it('rejects reversed latency quantiles while preserving valid zero latency and precision', () => {
    const input = reports()
    input.policyLatency!.p95Ms = 3
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Policy latency')).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Policy latency')).queryByText('3 ms')).not.toBeInTheDocument()
  })

  it('rejects a mismatched case identity and an N_A parent containing AVAILABLE children', () => {
    for (const mismatch of ['identity', 'parent-status']) {
      const input = reports()
      if (mismatch === 'identity') input.trialSuccessDistribution!.cases[0]!.orderedTrials[0]!.testCaseId = ORACLE
      else input.trialSuccessDistribution!.status = 'N_A'
      const ui = render(<AssuranceEvidence reports={input} />)
      expect(within(screen.getByLabelText('Trial success distribution')).getByText(/N\/A/)).toBeInTheDocument()
      expect(within(screen.getByLabelText('Trial success distribution')).queryByText(/Ordered bits/)).not.toBeInTheDocument()
      ui.unmount()
    }
  })

  it('preserves partial AVAILABLE distributions and all-N_A null bits independently of generic ABR availability', () => {
    const input = reports()
    const excluded = { ...input.trialSuccessDistribution!.cases[0]!, status: 'N_A' as const, reason: 'NO_CONCLUSIVE_TRIALS',
      testCaseId: ORACLE, caseKey: 'FA-05-excluded', category: 'FA-05', successCount: null, trials: null, excludedTrials: 1, successBits: [null],
      orderedTrials: [{ runId: RUN, testCaseId: ORACLE, caseRunId: EVENT, trialIndex: 0, successBit: null, exclusionReason: 'CANCELLED', secondaryInconclusive: false }] }
    const excludedCategory = { status: excluded.status, reason: excluded.reason, mode: excluded.mode, caseType: excluded.caseType,
      category: excluded.category, successBits: excluded.successBits, orderedTrials: excluded.orderedTrials,
      successCount: null, trials: null, excludedTrials: 1, sourceRunIds: [RUN] }
    input.trialSuccessDistribution!.cases.push(excluded)
    input.trialSuccessDistribution!.categories.push(excludedCategory)
    const ui = render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Trial success distribution')).getByText('FA-05-excluded')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Attack rate breakdown')).getByText('0/3')).toBeInTheDocument()
    ui.unmount()
    input.trialSuccessDistribution = { status: 'N_A', reason: 'NO_CONCLUSIVE_TRIALS', cases: [excluded], categories: [excludedCategory], sourceRunIds: [RUN] }
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText('Trial success distribution')
    expect(within(report).getAllByText('Ordered bits: [?]')).toHaveLength(2)
    expect(within(report).getAllByText(/CANCELLED/)).toHaveLength(2)
    expect(within(report).queryByText('0/0')).not.toBeInTheDocument()
    expect(within(report).getAllByText(RUN).length).toBeGreaterThan(0)
  })

  it.each(['foreign-case-run', 'foreign-test-case', 'foreign-bit', 'foreign-exclusion', 'foreign-secondary', 'foreign-category',
    'duplicate-header', 'duplicate-global-case-run', 'duplicate-category', 'duplicate-slot', 'descending-slot',
    'missing-category', 'extra-category', 'unrelated-category-source', 'unrelated-parent-source'] as const)('rejects %s frozen distribution graph evidence', defect => {
    const input = ['duplicate-global-case-run', 'duplicate-category', 'missing-category', 'unrelated-category-source'].includes(defect)
      ? reportsWithSecondGroup() : reports()
    const report = input.trialSuccessDistribution!
    const item = report.categories[0]!
    item.orderedTrials = item.orderedTrials.map(bit => ({ ...bit }))
    if (defect === 'foreign-case-run') item.orderedTrials[0]!.caseRunId = ORACLE
    if (defect === 'foreign-test-case') item.orderedTrials[0]!.testCaseId = ORACLE
    if (defect === 'foreign-bit') { item.successBits = [0, null, 0]; item.orderedTrials[0]!.successBit = 0; item.successCount = 0 }
    if (defect === 'foreign-exclusion') item.orderedTrials[1]!.exclusionReason = 'CANCELLED'
    if (defect === 'foreign-secondary') item.orderedTrials[0]!.secondaryInconclusive = false
    if (defect === 'foreign-category') item.category = 'FA-05'
    if (defect === 'duplicate-header') {
      const first = report.cases[0]!
      const second = { ...first, caseKey: 'second-case',
        orderedTrials: first.orderedTrials.map((bit, index) => ({ ...bit,
          caseRunId: [CASE, ORACLE, RUN][index]!, trialIndex: index + 3 })) }
      report.cases.push(second)
      item.orderedTrials = [...first.orderedTrials, ...second.orderedTrials]
      item.successBits = [1, null, 0, 1, null, 0]; item.successCount = 2; item.trials = 4; item.excludedTrials = 2
      item.sourceRunIds = [RUN]
    }
    if (defect === 'duplicate-global-case-run') report.cases[1]!.orderedTrials[0]!.caseRunId = CR
    if (defect === 'duplicate-category') report.categories[1] = { ...item }
    if (defect === 'duplicate-slot') {
      report.cases[0]!.orderedTrials[2]!.trialIndex = 1; item.orderedTrials[2]!.trialIndex = 1
    }
    if (defect === 'descending-slot') {
      report.cases[0]!.orderedTrials[0]!.trialIndex = 4; item.orderedTrials[0]!.trialIndex = 4
    }
    if (defect === 'missing-category') report.categories.pop()
    if (defect === 'extra-category') report.categories.push({ ...item, category: 'FA-05' })
    if (defect === 'unrelated-category-source') item.sourceRunIds.push(B)
    if (defect === 'unrelated-parent-source') report.sourceRunIds.push(ORACLE)
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Trial success distribution')
    expect(within(rendered).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(rendered).queryByText('1/2')).not.toBeInTheDocument()
  })

  it('preserves two populated category groups with their own exact Run membership', () => {
    render(<AssuranceEvidence reports={reportsWithSecondGroup()} />)
    const report = screen.getByLabelText('Trial success distribution')
    expect(within(report).getByText('FA-05-second')).toBeInTheDocument()
    expect(within(report).getAllByText('Ordered bits: [1, ?, 0]')).toHaveLength(4)
  })

  it.each(['existing-group', 'empty-new-group'] as const)('rejects an unobserved empty case row in %s', kind => {
    const input = reports(), report = input.trialSuccessDistribution!
    const empty = { ...report.cases[0]!, status: 'N_A' as const, reason: 'NO_CONCLUSIVE_TRIALS',
      testCaseId: ORACLE, caseKey: 'phantom', category: kind === 'existing-group' ? 'FA-04' : 'FA-05',
      successBits: [], orderedTrials: [], successCount: null, trials: null, excludedTrials: 0 }
    report.cases.push(empty)
    if (kind === 'empty-new-group') report.categories.push({ ...report.categories[0]!, status: 'N_A',
      reason: 'NO_CONCLUSIVE_TRIALS', category: 'FA-05', successBits: [], orderedTrials: [],
      successCount: null, trials: null, excludedTrials: 0, sourceRunIds: [] })
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Trial success distribution')
    expect(within(rendered).getByText(/N\/A/)).toBeInTheDocument()
    expect(within(rendered).queryByText('phantom')).not.toBeInTheDocument()
    expect(within(rendered).queryByText('FA-04-hidden')).not.toBeInTheDocument()
  })

  it('preserves shared case/category tuples, per-case gaps/nonzero starts and index resets across Runs', () => {
    const input = reports(), report = input.trialSuccessDistribution!
    report.cases[0]!.orderedTrials.forEach((bit, index) => { bit.trialIndex = 5 + index * 2 })
    const second = { ...report.cases[0]!, runId: B, testCaseId: ORACLE, caseKey: 'FA-04-second',
      orderedTrials: report.cases[0]!.orderedTrials.map((bit, index) => ({ ...bit, runId: B, testCaseId: ORACLE,
        caseRunId: [CASE, ORACLE, RUN][index]!, trialIndex: index })) }
    report.cases.push(second)
    const category = report.categories[0]!
    category.orderedTrials = [...report.cases[0]!.orderedTrials, ...second.orderedTrials]
    category.successBits = [1, null, 0, 1, null, 0]; category.successCount = 2; category.trials = 4; category.excludedTrials = 2
    category.sourceRunIds = [B, RUN]; report.sourceRunIds = [B, RUN]
    const original = JSON.stringify(input)
    render(<AssuranceEvidence reports={input} />)
    const rendered = screen.getByLabelText('Trial success distribution')
    expect(within(rendered).getByText('FA-04-second')).toBeInTheDocument()
    expect(within(rendered).getByText('Ordered bits: [1, ?, 0, 1, ?, 0]')).toBeInTheDocument()
    expect(within(rendered).getAllByText(/Trial 5:/)).toHaveLength(2)
    expect(within(rendered).getAllByText(/Trial 0:/)).toHaveLength(2)
    expect(JSON.stringify(input)).toBe(original)
  })

  it('preserves empty invalid-metadata N_A rows with observed parent sources and queued/active completion', () => {
    const input = reports()
    input.trialSuccessDistribution = { status: 'N_A', reason: 'INVALID_TRIAL_METADATA', cases: [], categories: [], sourceRunIds: [RUN] }
    input.attackRateBreakdown = { status: 'N_A', reason: 'NO_CONCLUSIVE_ATTACK_TRIALS', sourceRunIds: [RUN], groups: [
      { status: 'N_A', reason: 'NO_CONCLUSIVE_ATTACK_TRIALS', mode: 'HELD_OUT', category: 'FA-04', partition: 'HELD_OUT',
        numerator: null, denominator: null, value: null, anySuccess: null, excludedTrials: 1, sourceRunIds: [] },
    ] }
    Object.assign(input.completionRate!, { numerator: 0, denominator: 3, value: 0, cancelledTrials: 0, unmaterializedTrials: 1 })
    const ui = render(<AssuranceEvidence reports={input} />)
    const distribution = screen.getByLabelText('Trial success distribution')
    expect(within(distribution).getByText(/INVALID_TRIAL_METADATA/)).toBeInTheDocument()
    expect(within(distribution).getByText(RUN)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Completion rate')).getByText('0/3 terminal non-cancelled / scheduled trials')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Attack rate breakdown')).queryByText('false')).not.toBeInTheDocument()
    ui.unmount()
    input.completionRate!.unmaterializedTrials = 3
    render(<AssuranceEvidence reports={input} />)
    expect(within(screen.getByLabelText('Completion rate')).getByText('0/3 terminal non-cancelled / scheduled trials')).toBeInTheDocument()
  })

  it.each(['source-free-positive', 'source-free-negative', 'linked-negative', 'wrong-invariant', 'unknown-positive'] as const)('keeps %s GC evidence unavailable under the current positive-only report contract', kind => {
    const input = reports()
    const row = input.criticalInvariantAnySuccess!.invariants[0]!
    if (kind.startsWith('source-free')) row.sourceRunIds = row.sourceCaseRunIds = row.sourceOracleResultIds = row.sourceEventIds = []
    if (kind.includes('negative')) row.anySuccess = false
    if (kind === 'wrong-invariant') row.invariantId = 'INV-01'
    if (kind === 'unknown-positive') row.status = 'N_A'
    render(<AssuranceEvidence reports={input} />)
    const report = screen.getByLabelText('Critical invariant evidence')
    expect(within(report).queryByText('true')).not.toBeInTheDocument()
    expect(within(report).queryByText('false')).not.toBeInTheDocument()
    expect(within(report).getAllByText(/N\/A/)).toHaveLength(4)
  })

  it('preserves server GC and full multi-source ordering without sorting or truncating IDs', () => {
    const input = reports()
    input.policyLatency!.sourceRunIds = [B, RUN, A]
    input.policyLatency!.sourceEventIds = [ORACLE, EVENT]
    render(<AssuranceEvidence reports={input} />)
    const policy = screen.getByLabelText('Policy latency')
    expect(Array.from(within(policy).getByText('Run').parentElement!.querySelectorAll('code'), node => node.textContent)).toEqual([B, RUN, A])
    expect(Array.from(within(policy).getByText('Event').parentElement!.querySelectorAll('code'), node => node.textContent)).toEqual([ORACLE, EVENT])
    const gc = screen.getByLabelText('Critical invariant evidence')
    expect(Array.from(gc.querySelectorAll('tbody tr > td:first-child'), node => node.firstChild!.textContent)).toEqual(['GC-03', 'GC-01', 'GC-02', 'GC-04'])
  })

  it('handles empty report collections as reported and keeps certification unavailable despite observed threshold', () => {
    const input = reports()
    input.trialSuccessDistribution = { status: 'N_A', reason: 'NO_OBSERVED_TRIALS', cases: [], categories: [], sourceRunIds: [] }
    input.attackRateBreakdown = { status: 'N_A', reason: 'NO_OBSERVED_ATTACK_TRIALS', groups: [], sourceRunIds: [] }
    render(<><AssuranceEvidence reports={input} /><RequiredCohortEvidence snapshot={{ criticalTrialCoverage: {
      complete: false, observedRequirementMet: true, status: 'N_A', reason: 'REQUIRED_COHORT_CERTIFICATION_UNAVAILABLE',
      requiredCategoriesPresent: true, cases: [{ testCaseId: CASE, category: 'FA-04', partition: 'HELD_OUT', mode: 'HELD_OUT', requiredTrials: 3, conclusiveTrials: 3, complete: true, reason: null }],
    } }} /></>)
    expect(screen.getByText(/NO_OBSERVED_TRIALS/)).toBeInTheDocument()
    const cohort = screen.getByLabelText('Required cohort evidence')
    expect(within(cohort).getByText(/REQUIRED_COHORT_CERTIFICATION_UNAVAILABLE/)).toBeInTheDocument()
    expect(within(cohort).getByText('Server complete').parentElement).toHaveTextContent('false')
    expect(within(cohort).getByText('Observed requirement met').parentElement).toHaveTextContent('true')
  })

  it.each([null, {}, { status: 'AVAILABLE', cases: {} }, { complete: 'true' }, { observedRequirementMet: 'true' },
    { cases: [{ testCaseId: CASE, category: 'FA-04', partition: 'HELD_OUT', mode: null, requiredTrials: -1, conclusiveTrials: 3, complete: true, reason: null }] },
    { cases: [{ testCaseId: CASE, category: 'FA-04', partition: 'HELD_OUT', mode: null, requiredTrials: 3, conclusiveTrials: null, complete: true, reason: null }] },
  ])('keeps malformed cohort shapes unavailable without synthesizing threshold data: %j', malformed => {
    const coverage = malformed === null ? null : Object.keys(malformed).length === 0 ? {} : { complete: false, observedRequirementMet: true, requiredCategoriesPresent: true,
      status: 'N_A', reason: 'REQUIRED_COHORT_CERTIFICATION_UNAVAILABLE', cases: [], ...malformed }
    render(<RequiredCohortEvidence snapshot={{ criticalTrialCoverage: coverage } as JsonValue} />)
    const report = screen.getByLabelText('Required cohort evidence')
    expect(within(report).getByText(/보고서가 없거나 형식이 올바르지 않습니다/)).toBeInTheDocument()
    expect(within(report).queryByText('Server complete')).not.toBeInTheDocument()
    expect(within(report).queryByText('PASS')).not.toBeInTheDocument()
    expect(within(report).queryByText('0 / 0')).not.toBeInTheDocument()
  })
})

describe('D-BOUNDARY-001 / TC-RPT-002 and TC-RPT-003: filtered proposal and incomplete proof', () => {
  it('preserves recognized explicit nulls while keeping absent keys and unknown nulls omitted', () => {
    const snapshot: JsonValue = { release: { id: A, fingerprint, payload: 'NULL_SECRET_CANARY' }, approvedPatch: null,
      policyLatency: null, remainingFindings: null, replayComparability: null, unknownNull: null }
    const original = JSON.stringify(snapshot)
    const projected = filteredProposalSnapshot(snapshot)
    for (const key of ['approvedPatch', 'policyLatency', 'remainingFindings', 'replayComparability']) expect(projected).toHaveProperty(key, null)
    expect(projected).not.toHaveProperty('completionRate')
    expect(projected).not.toHaveProperty('unknownNull')
    expect(JSON.stringify(projected)).not.toContain('NULL_SECRET_CANARY')
    expect(JSON.stringify(snapshot)).toBe(original)
  })

  it.each(['explicit-null', 'absent'] as const)('retains %s approvedPatch in the actual filtered proposal inspector', async kind => {
    vi.spyOn(api, 'metrics').mockResolvedValue(view(A))
    const snapshot: JsonValue = { release: { id: A, fingerprint, payload: 'INSPECTOR_SECRET_CANARY' }, decision: { ruleTrace: [] }, unknownNull: null }
    if (kind === 'explicit-null') (snapshot as Record<string, JsonValue>).approvedPatch = null
    const candidate = proposal(A, snapshot), original = JSON.stringify(snapshot)
    vi.spyOn(api, 'evaluateDecision').mockResolvedValue(candidate)
    render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await screen.findByLabelText('Decision comment')
    const inspector = screen.getByText(/"release":/, { selector: 'pre' })
    const displayed = JSON.parse(inspector.textContent!)
    if (kind === 'explicit-null') expect(displayed).toHaveProperty('approvedPatch', null)
    else expect(displayed).not.toHaveProperty('approvedPatch')
    expect(displayed).not.toHaveProperty('unknownNull')
    expect(document.body.textContent).not.toContain('INSPECTOR_SECRET_CANARY')
    expect(JSON.stringify(snapshot)).toBe(original)
    expect(candidate.inputDigest).toBe(fingerprint)
  })

  it('keeps original hashes, omitted fraction values and ordered sources while dropping unknown nested payloads', () => {
    const snapshot: JsonValue = { release: { id: A, fingerprint, hiddenPayload: 'SECRET_CANARY' }, agent: { id: CASE, name: 'Agent' },
      policyLatency: { status: 'AVAILABLE', averageMs: 1.123456789, extra: 'HELD_OUT_CANARY' },
      results: { sealReplay: { status: 'AVAILABLE', numerator: 0, denominator: 3, sourceRunIds: [RUN], evidenceDigest: fingerprint, secret: 'CRITICAL_CANARY' } },
      trialSuccessDistribution: { status: 'AVAILABLE', cases: [{ successBits: [1, null, 0], orderedTrials: [{ caseRunId: CR, successBit: null, exclusionReason: 'CANCELLED', payload: 'NESTED_CANARY' }] }] },
      remainingFindings: [{ id: ORACLE, severity: 'HIGH', status: 'OPEN', evidenceDigest: fingerprint, payload: 'FINDING_CANARY' }],
      approvedPatch: { proposalId: B, approvalId: ORACLE, baseHash: fingerprint, resultHash: fingerprint }, unknown: 'TOP_CANARY' }
    const before = JSON.stringify(snapshot)
    const projected = JSON.stringify(filteredProposalSnapshot(snapshot))
    for (const canary of ['SECRET_CANARY', 'HELD_OUT_CANARY', 'CRITICAL_CANARY', 'NESTED_CANARY', 'FINDING_CANARY', 'TOP_CANARY']) expect(projected).not.toContain(canary)
    expect(projected).toContain('1.123456789'); expect(projected).toContain('[1,null,0]'); expect(projected).toContain(fingerprint)
    expect(projected).not.toContain('"value":0')
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('excludes unknown canaries from actual AssurancePage including its proposal inspector', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue({ ...reports(), unknown: 'LIVE_CANARY' } as unknown as MetricsView)
    const snapshot: JsonValue = { release: { id: A, fingerprint, payload: 'SECRET_CANARY' }, decision: { ruleTrace: [], payload: 'RULE_CANARY' },
      criticalTrialCoverage: { complete: false, observedRequirementMet: true, status: 'N_A', reason: 'REQUIRED_COHORT_CERTIFICATION_UNAVAILABLE', requiredCategoriesPresent: true, cases: [], hidden: 'HELD_OUT_CANARY' },
      policyLatency: { status: 'AVAILABLE', averageMs: 1.123456789, payload: 'NESTED_CANARY' } }
    vi.spyOn(api, 'evaluateDecision').mockResolvedValue({ ...proposal(A, snapshot), proposedDecision: 'PASS' })
    render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await screen.findByLabelText('Decision comment')
    for (const canary of ['LIVE_CANARY', 'SECRET_CANARY', 'RULE_CANARY', 'HELD_OUT_CANARY', 'NESTED_CANARY']) expect(document.body.textContent).not.toContain(canary)
    expect(screen.getByText(/필터링한 후보 표시/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Required cohort evidence')).getByText(/REQUIRED_COHORT_CERTIFICATION_UNAVAILABLE/)).toBeInTheDocument()
    expect(screen.getByText(/내부 평가이며 공식 인증이 아닙니다/)).toBeInTheDocument()
  })
})

describe('D-EVIDENCE-002 / UI TC-REL-006: original Release request continuations', () => {
  it.each(['resolve', 'reject'] as const)('ignores old metrics %s and finally while the new Release remains loading', async outcome => {
    const old = deferred<MetricsView>(), next = deferred<MetricsView>()
    vi.spyOn(api, 'metrics').mockImplementation(id => id === A ? old.promise : next.promise)
    render(<AssurancePage releases={releases} actorId="actor" />)
    await choose(B)
    if (outcome === 'resolve') await settle(old, { ...reports(), releaseId: A }); else await fail(old)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByText('OLD_RELEASE_FAILURE')).not.toBeInTheDocument()
    expect(screen.queryByText('1.123456789 ms')).not.toBeInTheDocument()
    await settle(next, view(B))
    expect(screen.getByText('Metrics 새로고침')).toBeEnabled()
    expect(api.metrics).toHaveBeenCalledWith(B, 'actor')
  })

  it.each(['resolve', 'reject'] as const)('guards the first A %s during an actual pending A→B→A same-key transition', async outcome => {
    const old = deferred<MetricsView>(), middle = deferred<MetricsView>(), current = deferred<MetricsView>()
    vi.spyOn(api, 'metrics').mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(current.promise)
    render(<AssurancePage releases={releases} actorId="actor" />)
    await choose(B); await choose(A)
    if (outcome === 'resolve') await settle(old, reports()); else await fail(old)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByText('1.123456789 ms')).not.toBeInTheDocument()
    expect(screen.queryByText('OLD_RELEASE_FAILURE')).not.toBeInTheDocument()
    await settle(current, { ...view(A), metrics: { ...view(A).metrics, highImpactMutationCount: 7 } })
    await settle(middle, view(B))
    expect(screen.queryByText('1.123456789 ms')).not.toBeInTheDocument()
    expect(screen.getByText('High-impact mutations').parentElement).toHaveTextContent('7')
    expect(api.metrics).toHaveBeenNthCalledWith(1, A, 'actor')
    expect(api.metrics).toHaveBeenNthCalledWith(3, A, 'actor')
  })

  it('invalidates original actor requests and preferred Release requests independently', async () => {
    const oldActor = deferred<MetricsView>(), newActor = deferred<MetricsView>(), nextRelease = deferred<MetricsView>()
    vi.spyOn(api, 'metrics').mockReturnValueOnce(oldActor.promise).mockReturnValueOnce(newActor.promise).mockReturnValueOnce(nextRelease.promise)
    const ui = render(<AssurancePage releases={releases} actorId="actor" />)
    ui.rerender(<AssurancePage releases={releases} actorId="changed-actor" />)
    await settle(oldActor, reports())
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByText('1.123456789 ms')).not.toBeInTheDocument()
    await settle(newActor, view(A))
    ui.rerender(<AssurancePage releases={releases} actorId="changed-actor" preferredReleaseId={B} />)
    expect(screen.getByLabelText('Assurance Release')).toHaveValue(B)
    await settle(nextRelease, view(B))
    expect(api.metrics).toHaveBeenNthCalledWith(2, A, 'changed-actor')
    expect(api.metrics).toHaveBeenNthCalledWith(3, B, 'changed-actor')
  })

  it.each(['resolve', 'reject'] as const)('ignores overlapping same-Release StrictMode %s while the newest request remains pending', async outcome => {
    const old = deferred<MetricsView>(), current = deferred<MetricsView>()
    vi.spyOn(api, 'metrics').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<StrictMode><AssurancePage releases={releases} actorId="actor" /></StrictMode>)
    if (outcome === 'resolve') await settle(old, reports()); else await fail(old)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByText('OLD_RELEASE_FAILURE')).not.toBeInTheDocument()
    expect(screen.queryByText('1.123456789 ms')).not.toBeInTheDocument()
    await settle(current, { ...view(), metrics: { ...view().metrics, highImpactMutationCount: 9 } })
    expect(screen.getByText('High-impact mutations').parentElement).toHaveTextContent('9')
  })

  it.each(['metrics', 'evaluate', 'confirm'] as const)('invalidates still-pending %s success and rejection on unmount', async kind => {
    for (const outcome of ['resolve', 'reject']) {
      const pendingMetrics = deferred<MetricsView>(), pendingProposal = deferred<DecisionProposal>(), pendingConfirm = deferred<DecisionView>()
      vi.spyOn(api, 'metrics').mockImplementation(() => kind === 'metrics' ? pendingMetrics.promise : Promise.resolve(view()))
      vi.spyOn(api, 'evaluateDecision').mockImplementation(() => kind === 'evaluate' ? pendingProposal.promise : Promise.resolve(proposal()))
      vi.spyOn(api, 'confirmDecision').mockReturnValue(pendingConfirm.promise)
      const ui = render(<AssurancePage releases={releases} actorId="actor" />)
      if (kind !== 'metrics') {
        await screen.findByText('현재 저장된 평가 근거')
        await userEvent.click(screen.getByText('Decision 평가'))
        if (kind === 'confirm') {
          await userEvent.type(await screen.findByLabelText('Decision comment'), 'comment')
          await userEvent.click(screen.getByText('Decision 확정'))
        }
      }
      expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
      ui.unmount()
      if (kind === 'metrics') { if (outcome === 'resolve') await settle(pendingMetrics, reports()); else await fail(pendingMetrics) }
      else if (kind === 'evaluate') { if (outcome === 'resolve') await settle(pendingProposal, proposal()); else await fail(pendingProposal) }
      else { if (outcome === 'resolve') await settle(pendingConfirm, confirmed()); else await fail(pendingConfirm) }
      expect(screen.queryByLabelText('Assurance Release')).not.toBeInTheDocument()
      expect(screen.queryByText(/confirmed by reviewer|OLD_RELEASE_FAILURE/)).not.toBeInTheDocument()
      vi.restoreAllMocks()
    }
  })

  it.each(['resolve', 'reject'] as const)('ignores old evaluation %s, catch and finally after preferred Release changes', async outcome => {
    vi.spyOn(api, 'metrics').mockResolvedValueOnce(view(A))
    const nextMetrics = deferred<MetricsView>(), old = deferred<DecisionProposal>()
    vi.mocked(api.metrics).mockReturnValueOnce(nextMetrics.promise)
    vi.spyOn(api, 'evaluateDecision').mockReturnValue(old.promise)
    const ui = render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    ui.rerender(<AssurancePage releases={releases} actorId="actor" preferredReleaseId={B} />)
    if (outcome === 'resolve') await settle(old, proposal(A)); else await fail(old)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByLabelText('Decision comment')).not.toBeInTheDocument()
    expect(screen.queryByText('OLD_RELEASE_FAILURE')).not.toBeInTheDocument()
    await settle(nextMetrics, view(B))
  })

  it.each([['evaluate', 'resolve'], ['evaluate', 'reject'], ['confirm', 'resolve'], ['confirm', 'reject']] as const)('guards actor-only pending %s %s and finally on the same Release', async (kind, outcome) => {
    const nextMetrics = deferred<MetricsView>(), oldProposal = deferred<DecisionProposal>(), oldConfirm = deferred<DecisionView>()
    vi.spyOn(api, 'metrics').mockImplementation((_id, actor) => actor === 'actor' ? Promise.resolve(view(A)) : nextMetrics.promise)
    vi.spyOn(api, 'evaluateDecision').mockImplementation(() => kind === 'evaluate' ? oldProposal.promise : Promise.resolve(proposal(A)))
    vi.spyOn(api, 'confirmDecision').mockReturnValue(oldConfirm.promise)
    const ui = render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    expect(api.evaluateDecision).toHaveBeenCalledWith(A, 'actor')
    if (kind === 'confirm') {
      await userEvent.type(await screen.findByLabelText('Decision comment'), 'original actor comment')
      await userEvent.click(screen.getByText('Decision 확정'))
      expect(api.confirmDecision).toHaveBeenCalledWith(A, fingerprint, 'REVIEW', 'original actor comment', 'actor')
    }
    ui.rerender(<AssurancePage releases={releases} actorId="changed-actor" />)
    if (kind === 'evaluate') { if (outcome === 'resolve') await settle(oldProposal, proposal(A)); else await fail(oldProposal) }
    else { if (outcome === 'resolve') await settle(oldConfirm, confirmed(A)); else await fail(oldConfirm) }
    expect(screen.getByLabelText('Assurance Release')).toHaveValue(A)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.queryByLabelText('Decision comment')).not.toBeInTheDocument()
    expect(screen.queryByText(/confirmed by reviewer|OLD_RELEASE_FAILURE/)).not.toBeInTheDocument()
    await settle(nextMetrics, { ...view(A), metrics: { ...view(A).metrics, highImpactMutationCount: 11 } })
    expect(screen.getByText('High-impact mutations').parentElement).toHaveTextContent('11')
    expect(api.metrics).toHaveBeenLastCalledWith(A, 'changed-actor')
  })

  it.each(['resolve', 'reject'] as const)('ignores old confirmation %s without erasing the new proposal or comment', async outcome => {
    vi.spyOn(api, 'metrics').mockImplementation(id => Promise.resolve(view(id)))
    vi.spyOn(api, 'evaluateDecision').mockImplementation(id => Promise.resolve(proposal(id)))
    const old = deferred<DecisionView>()
    vi.spyOn(api, 'confirmDecision').mockReturnValue(old.promise)
    render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await userEvent.type(await screen.findByLabelText('Decision comment'), ' original comment ')
    await userEvent.selectOptions(screen.getByLabelText('Final decision'), 'BLOCKED')
    await userEvent.click(screen.getByText('Decision 확정'))
    expect(api.confirmDecision).toHaveBeenCalledWith(A, fingerprint, 'BLOCKED', 'original comment', 'actor')
    await choose(B)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await userEvent.type(await screen.findByLabelText('Decision comment'), 'new comment')
    if (outcome === 'resolve') await settle(old, confirmed(A)); else await fail(old)
    expect(screen.getByLabelText('Decision comment')).toHaveValue('new comment')
    expect(screen.queryByText(/confirmed by reviewer/)).not.toBeInTheDocument()
    expect(screen.queryByText('OLD_RELEASE_FAILURE')).not.toBeInTheDocument()
  })

  it.each(['resolve', 'reject'] as const)('keeps the new Release loading when the old confirmation %s and finally finish', async outcome => {
    const next = deferred<MetricsView>(), old = deferred<DecisionView>()
    vi.spyOn(api, 'metrics').mockResolvedValueOnce(view(A)).mockReturnValueOnce(next.promise)
    vi.spyOn(api, 'evaluateDecision').mockResolvedValue(proposal(A))
    vi.spyOn(api, 'confirmDecision').mockReturnValue(old.promise)
    render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await userEvent.type(await screen.findByLabelText('Decision comment'), 'original comment')
    await userEvent.click(screen.getByText('Decision 확정'))
    await choose(B)
    if (outcome === 'resolve') await settle(old, confirmed(A)); else await fail(old)
    expect(screen.getByText('Metrics 새로고침')).toBeDisabled()
    expect(screen.getByText('Decision 평가')).toBeDisabled()
    expect(screen.queryByText(/confirmed by reviewer|OLD_RELEASE_FAILURE/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Decision comment')).not.toBeInTheDocument()
    await settle(next, view(B))
    expect(screen.getByText('Metrics 새로고침')).toBeEnabled()
  })

  it.each(['metrics', 'proposal-envelope', 'proposal-snapshot', 'confirm'] as const)('rejects mismatched %s Release identity with no retry', async kind => {
    vi.spyOn(api, 'metrics').mockResolvedValue(view(kind === 'metrics' ? B : A))
    vi.spyOn(api, 'evaluateDecision').mockResolvedValue(kind === 'proposal-envelope' ? proposal(B) : kind === 'proposal-snapshot' ? proposal(A, { release: { id: B } }) : proposal(A))
    vi.spyOn(api, 'confirmDecision').mockResolvedValue(confirmed(B))
    render(<AssurancePage releases={releases} actorId="actor" />)
    if (kind !== 'metrics') {
      await screen.findByText('현재 저장된 평가 근거')
      await userEvent.click(screen.getByText('Decision 평가'))
      if (kind === 'confirm') {
        await userEvent.type(await screen.findByLabelText('Decision comment'), 'comment')
        await userEvent.click(screen.getByText('Decision 확정'))
      }
    }
    expect(await screen.findByText(/Release가 요청과 일치하지 않습니다/)).toBeInTheDocument()
    expect(screen.queryByText(/confirmed by reviewer/)).not.toBeInTheDocument()
    expect(api.metrics).toHaveBeenCalledTimes(1)
  })

  it('accepts a legitimate stricter-confirmation digest and reports current failures without retry', async () => {
    vi.spyOn(api, 'metrics').mockResolvedValue(view())
    vi.spyOn(api, 'evaluateDecision').mockResolvedValue(proposal())
    vi.spyOn(api, 'confirmDecision').mockResolvedValue(confirmed())
    render(<AssurancePage releases={releases} actorId="actor" />)
    await screen.findByText('현재 저장된 평가 근거')
    await userEvent.click(screen.getByText('Decision 평가'))
    await userEvent.type(await screen.findByLabelText('Decision comment'), ' approved ')
    await userEvent.selectOptions(screen.getByLabelText('Final decision'), 'BLOCKED')
    await userEvent.click(screen.getByText('Decision 확정'))
    expect(await screen.findByText('BLOCKED confirmed by reviewer')).toBeInTheDocument()
    expect(api.confirmDecision).toHaveBeenCalledWith(A, fingerprint, 'BLOCKED', 'approved', 'actor')
    vi.mocked(api.evaluateDecision).mockRejectedValueOnce(new Error('CURRENT_RELEASE_FAILURE'))
    await userEvent.click(screen.getByText('Decision 평가'))
    expect(await screen.findByText('CURRENT_RELEASE_FAILURE')).toBeInTheDocument()
    expect(api.evaluateDecision).toHaveBeenCalledTimes(2)
  })
})
