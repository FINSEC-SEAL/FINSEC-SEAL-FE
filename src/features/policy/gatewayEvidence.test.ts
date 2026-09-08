import { GatewayEvidenceClient, GatewayEvidenceError, gatewayStages } from './gatewayEvidence'
import type { GatewayStage } from './gatewayEvidence'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = (n: number) => `sha256:${String(n).padStart(64, '0')}`
const releaseId = id(101), runId = id(201), actor = 'gateway-reader'
const canary = 'SYNTHETIC_PRIVATE_CANARY'
const run = (extra: Record<string, unknown> = {}) => ({
  id: runId, releaseId, mode: 'SEAL_REPLAY', status: 'RUNNING', contractVersionId: id(301),
  latestSequence: 999, summary: { private: canary }, ...extra,
})
const event = (sequence: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0', eventId: id(1000 + sequence), traceId: id(401), runId,
  testCaseRunId: id(501), sequence, occurredAt: '2026-09-08T01:02:03.123456Z',
  eventType: 'POLICY_EVALUATED', toolName: 'CUSTOMER_DATA_READ',
  policyDecision: { allowed: false, reasonCode: 'CUSTOMER_SCOPE_VIOLATION', unused: canary },
  reasonCode: 'CUSTOMER_SCOPE_VIOLATION', input: { private: canary }, output: canary,
  metadata: { gateway: 'c', private: canary, attackOutcome: 'ATTACK_BLOCKED' },
  payloadDigest: digest(sequence + 100), eventHash: digest(sequence),
  prevEventHash: sequence === 1 ? null : digest(sequence - 1), ...extra,
})
const envelope = (data: unknown) => new Response(JSON.stringify({ data, traceId: id(601), timestamp: '2026-09-08T00:00:00Z' }))
const history = (items: unknown[], headSequence = items.length, nextCursor: number | null = null) => ({ items, headSequence, nextCursor })
const client = () => new GatewayEvidenceClient('http://localhost:8080')
const storedStages: GatewayStage[] = ['PREFLIGHT', 'TOOL', 'OPERATION', 'BUSINESS_CONTEXT', 'OBJECT_SCOPE',
  'FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'WORKFLOW', 'HUMAN_BOUNDARY', 'TOOL_TRUST']
const observed = new Set<GatewayStage>(['OBJECT_SCOPE', 'FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'HUMAN_BOUNDARY'])
function enforce(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { evaluationMode: 'ENFORCE', decisionType: 'ALLOW', allowed: true, reasonCode: 'ALLOW',
    evaluatedStages: [...storedStages], ...extra }
}
function baseline(observedStage?: GatewayStage, terminal?: GatewayStage,
  terminalType: 'DENY' | 'ERROR' = 'ERROR'): Record<string, unknown> {
  let skipped = false
  const rows = storedStages.slice(0, terminal ? storedStages.indexOf(terminal) + 1 : undefined).map(stage => {
    const enforcement = observed.has(stage) ? 'OBSERVED' : 'ENFORCED'
    if (stage === terminal) return { stage, enforcement, outcomeType: terminalType, reasonCode: 'stored terminal reason' }
    if (stage === observedStage) { skipped = true; return { stage, enforcement, outcomeType: 'DENY', reasonCode: 'observed reason' } }
    return { stage, enforcement, outcomeType: skipped && observed.has(stage) ? 'SKIPPED' : 'PASS' }
  })
  return { evaluationMode: 'BASELINE', decisionType: terminal ? terminalType : 'ALLOW', allowed: !terminal,
    reasonCode: terminal ? 'stored terminal reason' : 'BASELINE_ALLOW', stageOutcomes: rows,
    ...(terminal ? { failedStage: terminal, failedCheck: terminal } : {}),
    ...(observedStage ? { observedFailedStage: observedStage, observedReasonCode: 'observed reason' } : {}) }
}
async function policyProjection(policyDecision: unknown) {
  responses(run(), history([event(1, { policyDecision, reasonCode: '' })]))
  return (await client().loadRun(releaseId, runId, actor)).events[0]!
}
function linked(sequence: number, eventType: string, extra: Record<string, unknown> = {}):
  Record<string, unknown> & { occurredAt: string; eventHash: string } {
  return event(sequence, { eventType, policyDecision: enforce(),
    metadata: { toolCallId: id(1001), input: canary, deliveryState: canary, successfulSecurityBlock: true }, ...extra })
}
function callHistory() {
  return [linked(1, 'TOOL_PROPOSED', { metadata: null }), linked(2, 'POLICY_EVALUATED'),
    linked(3, 'TOOL_REQUEST'), linked(4, 'TOOL_RESPONSE')]
}
function responses(...data: unknown[]) {
  const mock = vi.spyOn(globalThis, 'fetch')
  for (const page of data) mock.mockResolvedValueOnce(envelope(page))
  return mock
}

describe('Gateway stored-evidence client', () => {
  it('reads every Run page, forwards the opaque cursor and sends only GET requests with the actor', async () => {
    const cursor = '2026-09-08T00:00:00Z|opaque+/='
    const fetch = responses({ items: [run()], nextCursor: cursor },
      { items: [run({ id: id(202) })], nextCursor: null })
    const result = await client().listRuns(releaseId, actor)
    expect(result.map(r => r.id)).toEqual([runId, id(202)])
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get('cursor')).toBe(cursor)
    for (const [url, init] of fetch.mock.calls) {
      expect(new URL(String(url)).pathname).toBe(`/api/v1/releases/${releaseId}/test-runs`)
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe(actor)
    }
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it.each([
    ['duplicate Run', { items: [run()], nextCursor: null }],
    ['wrong Release', { items: [run({ id: id(202), releaseId: id(999) })], nextCursor: null }],
    ['repeated cursor', { items: [run({ id: id(202) })], nextCursor: 'a' }],
    ['empty continuation', { items: [], nextCursor: 'b' }],
    ['malformed cursor', { items: [run({ id: id(202) })], nextCursor: 3 }],
  ])('rejects %s without returning a partial Run list', async (_name, second) => {
    responses({ items: [run()], nextCursor: 'a' }, second)
    await expect(client().listRuns(releaseId, actor)).rejects.toBeInstanceOf(GatewayEvidenceError)
  })

  it('rejects cursor cycles and a failed intermediate Run page', async () => {
    const fetch = responses({ items: [run()], nextCursor: 'a' },
      { items: [run({ id: id(202) })], nextCursor: 'b' },
      { items: [run({ id: id(203) })], nextCursor: 'a' })
    await expect(client().listRuns(releaseId, actor)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    fetch.mockReset().mockResolvedValueOnce(envelope({ items: [run()], nextCursor: 'a' }))
      .mockResolvedValueOnce(new Response(canary, { status: 503 }))
    await expect(client().listRuns(releaseId, actor)).rejects.toThrow('실행 기록을 조회하지 못했습니다.')
  })

  it('checks all event sequences before filtering, captures the first head and omits later growth', async () => {
    const fetch = responses(run(), history([event(1, { eventType: 'RUN_STARTED' }), event(2)], 3, 2),
      history([event(3), event(4)], 4))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(3)
    expect(result.events.map(e => e.sequence)).toEqual([2, 3])
    expect(String(fetch.mock.calls[2]![0]).endsWith('/event-history?after=2&limit=1000')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/test-runs/${runId}`, `/api/v1/test-runs/${runId}/event-history`, `/api/v1/test-runs/${runId}/event-history`,
    ])
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe(actor)
    }
    expect(result.run).toEqual({ id: runId, releaseId, mode: 'SEAL_REPLAY', status: 'RUNNING', contractVersionId: id(301) })
    expect(result.events[0]).toMatchObject({ runId, eventId: id(1002), traceId: id(401), testCaseRunId: id(501),
      payloadDigest: digest(102), eventHash: digest(2), prevEventHash: digest(1) })
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${canary}|ATTACK_BLOCKED|latestSequence|metadata|eventType`))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.run)).toBe(true)
    expect(Object.isFrozen(result.events)).toBe(true)
    expect(Object.isFrozen(result.events[0])).toBe(true)
  })

  it('verifies blank-label non-policy events before preserving empty and null policy labels across pages', async () => {
    const fetch = responses(run(), history([event(1, { eventType: 'RUN_STARTED', toolName: '', reasonCode: '', policyDecision: null })], 4, 1),
      history([
        event(2, { toolName: '', reasonCode: '', policyDecision: { decisionType: 'ERROR', allowed: false, reasonCode: '' } }),
        event(3, { toolName: null, reasonCode: null, policyDecision: { decisionType: 'ALLOW', allowed: true, reasonCode: null } }),
        event(4),
      ], 4))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(4)
    expect(result.events.map(value => [value.sequence, value.toolName, value.reasonCode, value.decisionReasonCode, value.decision]))
      .toEqual([[2, '', '', '', 'ERROR'], [3, null, null, null, 'ALLOW'],
        [4, 'CUSTOMER_DATA_READ', 'CUSTOMER_SCOPE_VIOLATION', 'CUSTOMER_SCOPE_VIOLATION', 'DENY']])
    expect(result.events[0]).toMatchObject({ eventId: id(1002), testCaseRunId: id(501), runId,
      eventHash: digest(2), prevEventHash: digest(1) })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(String(fetch.mock.calls[2]![0])).toContain('after=1&limit=1000')
    expect(Object.isFrozen(result.events)).toBe(true)
    expect(Object.isFrozen(result.events[0])).toBe(true)
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it.each(['toolName', 'reasonCode'])('still rejects invalid %s types and overlong non-policy labels', async field => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    for (const value of [undefined, 42, false, {}, [], 'x'.repeat(101)]) {
      fetch.mockReset().mockResolvedValueOnce(envelope(run())).mockResolvedValueOnce(envelope(history([
        event(1, { eventType: 'RUN_STARTED', toolName: '', reasonCode: '', [field]: value }), event(2),
      ])))
      await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it.each([
    { eventType: '' }, { eventId: '' }, { payloadDigest: '' }, { sequence: 1 }, { prevEventHash: digest(99) },
  ])('keeps required strings, source identifiers and chain invariants strict after optional blanks: %j', async invalid => {
    responses(run(), history([event(1, { eventType: 'RUN_STARTED', toolName: '', reasonCode: '' }), event(2, invalid)]))
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toBeInstanceOf(GatewayEvidenceError)
  })

  it('does not accept an empty cursor merely because event labels may be empty', async () => {
    responses(run(), { items: [event(1, { toolName: '', reasonCode: '' })], headSequence: 2, nextCursor: '' })
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('tolerates first-page rows beyond its earlier range query, without fetching a later prefix', async () => {
    const fetch = responses(run(), history([event(1), event(2)], 1, 2))
    expect((await client().loadRun(releaseId, runId, actor)).events.map(e => e.sequence)).toEqual([1])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['empty snapshot', history([], 0)],
    ['empty head before concurrent append', history([event(1)], 0)],
    ['no policy events', history([event(1, { eventType: 'RUN_STARTED', policyDecision: null })])],
  ] as const)('represents %s as an empty captured policy projection', async (_name, page) => {
    responses(run({ mode: 'BASELINE', contractVersionId: null }), page)
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(page.headSequence)
    expect(result.events).toEqual([])
    expect(result.run.mode).toBe('BASELINE')
    expect(result.run.contractVersionId).toBeNull()
  })

  it.each([
    ['missing initial sequence', history([event(2)], 2)],
    ['gap in non-policy events', history([event(1), event(3, { eventType: 'TOOL_REQUEST' })], 3)],
    ['duplicate sequence', history([event(1), event(1)], 2)],
    ['duplicate event ID', history([event(1), event(2, { eventId: id(1001) })], 2)],
    ['wrong Run', history([event(1, { runId: id(999) })])],
    ['broken hash pointer', history([event(1), event(2, { prevEventHash: digest(77) })], 2)],
    ['missing page', history([event(1)], 2)],
    ['non-progressing cursor', history([event(1)], 2, 0)],
    ['skipping cursor', history([event(1)], 3, 2)],
    ['empty continuation', history([], 1, 1)],
    ['negative head', history([], -1)],
    ['unsafe head', history([], Number.MAX_SAFE_INTEGER + 1)],
    ['fractional cursor', history([event(1)], 2, 1.5)],
    ['string sequence', history([event(1, { sequence: '1' })])],
    ['invalid source digest', history([event(1, { payloadDigest: 'bad' })])],
    ['unsupported envelope version', history([event(1, { schemaVersion: '2.0' })])],
  ])('rejects %s instead of presenting complete evidence', async (_name, page) => {
    responses(run(), page)
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toBeInstanceOf(GatewayEvidenceError)
  })

  it('rejects a regressing head and a later missing page', async () => {
    const fetch = responses(run(), history([event(1)], 3, 1), history([event(2)], 2))
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' })
    fetch.mockReset().mockResolvedValueOnce(envelope(run()))
      .mockResolvedValueOnce(envelope(history([event(1)], 3, 1)))
      .mockResolvedValueOnce(envelope(history([event(2)], 3)))
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' })
  })

  it.each([410, 403, 500])('never converts HTTP %s or its private error body into successful empty history', async status => {
    responses(run()).mockResolvedValueOnce(new Response(JSON.stringify({ detail: canary }), { status }))
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'REQUEST_FAILED' })
  })

  it.each([{ id: id(202) }, { releaseId: id(102) }, { contractVersionId: 'invalid' }])(
    'rejects mismatched/invalid Run projection before reading history: %j', async extra => {
      const fetch = responses(run(extra))
      await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      expect(fetch).toHaveBeenCalledTimes(1)
    })

  it.each([true, false, 'true', 'DENY', 1, null, undefined])('uses literal boolean decisions only: %j', async allowed => {
    responses(run(), history([event(1, { policyDecision: { allowed, reasonCode: 'UNFAMILIAR_CODE', unused: canary },
      reasonCode: 'POLICY_EVALUATION_TIMEOUT' })]))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events[0]).toMatchObject({ decision: allowed === true ? 'ALLOW' : allowed === false ? 'DENY' : 'UNKNOWN',
      reasonCode: 'POLICY_EVALUATION_TIMEOUT', decisionReasonCode: 'UNFAMILIAR_CODE' })
    expect(JSON.stringify(result)).not.toMatch(/ATTACK_BLOCKED|quarantine|evaluationTrace|blockRate/)
  })

  it.each([
    { decisionType: 'ALLOW', allowed: true, expected: 'ALLOW' },
    { decisionType: 'DENY', allowed: false, expected: 'DENY' },
    { decisionType: 'ERROR', allowed: false, expected: 'ERROR' },
    { decisionType: 'ALLOW', allowed: false, expected: 'UNKNOWN' },
    { decisionType: 'DENY', allowed: true, expected: 'UNKNOWN' },
    { decisionType: 'ERROR', allowed: true, expected: 'UNKNOWN' },
  ])('requires agreement between explicit $decisionType and allowed=$allowed', async ({ decisionType, allowed, expected }) => {
    responses(run(), history([event(1, { policyDecision: { decisionType, allowed } })]))
    expect((await client().loadRun(releaseId, runId, actor)).events[0]?.decision).toBe(expected)
  })

  it.each(['ALLOW', 'DENY', 'ERROR'])('keeps explicit %s unknown for every non-boolean allowed shape', async decisionType => {
    const invalid = [undefined, null, 'true', 'false', 0, 1, {}, []]
    responses(run(), history(invalid.map((allowed, index) => event(index + 1, { policyDecision: { decisionType, allowed } }))))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events.map(value => value.decision)).toEqual(invalid.map(() => 'UNKNOWN'))
  })

  it.each([null, '', 'UNSUPPORTED', 'error', ' ERROR', 'ERROR ', 0, true, false, {}, []]
    .map(decisionType => ({ decisionType })))('never falls back for malformed explicit type $decisionType', async ({ decisionType }) => {
    responses(run(), history([true, false].map((allowed, index) => event(index + 1, { policyDecision: { decisionType, allowed } }))))
    expect((await client().loadRun(releaseId, runId, actor)).events.map(value => value.decision)).toEqual(['UNKNOWN', 'UNKNOWN'])
  })

  it('distinguishes an own undefined decisionType from an absent or inherited key', async () => {
    // Preserve these object shapes through the parsed-transport seam; JSON serialization omits undefined.
    const explicit = { allowed: false, decisionType: undefined }
    const inherited = Object.create({ decisionType: 'ERROR' }) as Record<string, unknown>
    inherited.allowed = false
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(run()))
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: history([
        event(1, { policyDecision: explicit }), event(2, { policyDecision: inherited }),
        event(3, { policyDecision: { allowed: false } }),
      ]) }) } as Response)
    expect(Object.hasOwn(explicit, 'decisionType')).toBe(true)
    expect(Object.hasOwn(inherited, 'decisionType')).toBe(false)
    expect((await client().loadRun(releaseId, runId, actor)).events.map(value => value.decision))
      .toEqual(['UNKNOWN', 'DENY', 'DENY'])
  })

  it('does not infer decisions from operational reasons, FAILED state, mode or security-credit metadata', async () => {
    const policies = [
      { allowed: true }, { allowed: false }, {},
      { decisionType: 'ALLOW', allowed: true }, { decisionType: 'DENY', allowed: false },
      { decisionType: 'ERROR', allowed: false }, { decisionType: null, allowed: false },
    ]
    responses(run({ status: 'FAILED', mode: 'BASELINE' }), history(policies.map((policy, index) => event(index + 1, {
      policyDecision: { ...policy, reasonCode: 'POLICY_EVALUATION_TIMEOUT', successfulSecurityBlock: true },
      reasonCode: 'ATTACK_BLOCKED', metadata: { gateway: 'c', decisionType: 'ERROR', successfulSecurityBlock: true },
    }))))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events.map(value => value.decision)).toEqual(['ALLOW', 'DENY', 'UNKNOWN', 'ALLOW', 'DENY', 'ERROR', 'UNKNOWN'])
    expect(result.events.every(value => value.reasonCode === 'ATTACK_BLOCKED'
      && value.decisionReasonCode === 'POLICY_EVALUATION_TIMEOUT')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/successfulSecurityBlock|metadata|gateway/)
  })

  it('projects ERROR as immutable source-linked evidence without raw payloads, malformed detail values or block credit', async () => {
    const original = event(1, {
      input: { private: canary }, output: { private: canary },
      metadata: { gateway: 'c', toolCallId: canary, private: canary, successfulSecurityBlock: true },
      policyDecision: { decisionType: 'ERROR', allowed: false, reasonCode: 'INVALID_REQUEST_SCHEMA',
        successfulSecurityBlock: true, evaluatedStages: [canary], evaluatedChecks: [canary],
        stageOutcomes: [{ stage: canary }], failedStage: canary, failedCheck: canary,
        toolCallId: canary, private: canary },
      reasonCode: 'POLICY_EVALUATION_TIMEOUT',
    })
    responses(run(), history([original]))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events[0]).toEqual({ eventId: id(1001), traceId: id(401), runId, testCaseRunId: id(501), sequence: 1,
      occurredAt: original.occurredAt, toolName: 'CUSTOMER_DATA_READ', decision: 'ERROR',
      reasonCode: 'POLICY_EVALUATION_TIMEOUT', decisionReasonCode: 'INVALID_REQUEST_SCHEMA',
      payloadDigest: digest(101), eventHash: digest(1), prevEventHash: null,
      stageDetails: { status: 'unreadable' }, callDetails: { status: 'unreadable', toolCallId: null } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.events)).toBe(true)
    expect(Object.isFrozen(result.events[0])).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${canary}|metadata|input|output|evaluatedStages|evaluatedChecks|stageOutcomes|failedStage|failedCheck|successfulSecurityBlock`))
  })

  it('preserves recorded reason codes without constructing evaluation order or security outcomes', async () => {
    const reasons = ['TOOL_NOT_ALLOWED', 'CUSTOMER_SCOPE_VIOLATION', 'FIELD_SCOPE_VIOLATION',
      'RECORD_LIMIT_EXCEEDED', 'EXTERNAL_EGRESS_DENIED', 'HUMAN_ONLY_ACTION', 'INVALID_WORKFLOW_STAGE',
      'UNTRUSTED_TOOL', 'TOOL_INTEGRITY_FAILURE', 'POLICY_EVALUATION_TIMEOUT', '<b>UNKNOWN</b>']
    responses(run(), history(reasons.map((reasonCode, i) => event(i + 1,
      { reasonCode, policyDecision: { allowed: false, reasonCode } }))))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events.map(e => e.reasonCode)).toEqual(reasons)
    expect(result.events.every(e => e.decision === 'DENY')).toBe(true)
    expect(result.events.every(e => e.reasonCode === e.decisionReasonCode)).toBe(true)
  })

  it.each([null, [], { decision: 'ALIEN' }, { allowed: 'false', reasonCode: { private: canary } }])(
    'keeps an unfamiliar policy shape explicitly unknown: %j', async policyDecision => {
      responses(run(), history([event(1, { policyDecision, reasonCode: null })]))
      expect((await client().loadRun(releaseId, runId, actor)).events[0]).toMatchObject({ decision: 'UNKNOWN', decisionReasonCode: null })
    })

  it('retains no aliases even when a transport supplies mutable parsed objects', async () => {
    const originalRun = run(), originalEvent = event(1)
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: originalRun }) } as Response)
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: history([originalEvent]) }) } as Response)
    const result = await client().loadRun(releaseId, runId, actor)
    originalRun.status = 'FAILED'; originalEvent.policyDecision.allowed = true; originalEvent.reasonCode = 'changed'
    expect(result.run.status).toBe('RUNNING')
    expect(result.events[0]).toMatchObject({ decision: 'DENY', reasonCode: 'CUSTOMER_SCOPE_VIOLATION' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed responses and safe resource limits without returning partial evidence', async () => {
    const fetch = responses(run(), history([], 100_001))
    await expect(client().loadRun(releaseId, runId, actor)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    fetch.mockReset().mockResolvedValueOnce(new Response(canary))
    await expect(client().listRuns(releaseId, actor)).rejects.toThrow('실행 기록을 조회하지 못했습니다.')
    fetch.mockReset().mockResolvedValueOnce(envelope({ items: [], nextCursor: undefined }))
    await expect(client().listRuns(releaseId, actor)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('never sends invalid inputs or already aborted requests and never exposes transport errors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(client().listRuns('../wrong', actor)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(client().listRuns(releaseId, 'bad\nactor')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const controller = new AbortController(); controller.abort(canary)
    await expect(client().loadRun(releaseId, runId, actor, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRejectedValueOnce(new Error(canary))
    await expect(client().listRuns(releaseId, actor)).rejects.toThrow('실행 기록을 조회하지 못했습니다.')
    expect(() => new GatewayEvidenceClient('https://reader:secret@example.test')).toThrow(GatewayEvidenceError)
  })

  it('discards a late response after abort even if fetch ignores the signal', async () => {
    let resolve!: (value: Response) => void
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const controller = new AbortController()
    const pending = client().listRuns(releaseId, actor, controller.signal)
    controller.abort(canary)
    resolve(envelope({ items: [run()], nextCursor: null }))
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(fetch.mock.calls[0]![1]?.signal).toBe(controller.signal)
  })
})

describe('Gateway recorded stage details', () => {
  it('exports the frozen exact stage order and preserves full ENFORCE ALLOW without invented row outcomes', async () => {
    expect(gatewayStages).toEqual(storedStages)
    expect(Object.isFrozen(gatewayStages)).toBe(true)
    const result = await policyProjection(enforce({ evaluatedChecks: [...storedStages] }))
    expect(result).toMatchObject({ decision: 'ALLOW', reasonCode: '', decisionReasonCode: 'ALLOW',
      stageDetails: { status: 'valid', mode: 'ENFORCE', evaluatedStages: storedStages, failedStage: null } })
    expect(JSON.stringify(result.stageDetails)).not.toMatch(/PASS|outcomeType|reasonCode/)
    expect(Object.isFrozen(result.stageDetails)).toBe(true)
    if (result.stageDetails.status === 'valid' && result.stageDetails.mode === 'ENFORCE') {
      expect(Object.isFrozen(result.stageDetails.evaluatedStages)).toBe(true)
    }
  })

  it.each(storedStages)('preserves the exact terminal prefix through %s', async stage => {
    const evaluatedStages = storedStages.slice(0, storedStages.indexOf(stage) + 1)
    const decisionType = stage === 'PREFLIGHT' || stage === 'TOOL_TRUST' ? 'ERROR' : 'DENY'
    const result = await policyProjection(enforce({ decisionType, allowed: false, reasonCode: ' raw Reason ',
      evaluatedStages, evaluatedChecks: evaluatedStages, failedStage: stage, failedCheck: stage }))
    expect(result).toMatchObject({ decision: decisionType, decisionReasonCode: ' raw Reason ',
      stageDetails: { status: 'valid', mode: 'ENFORCE', evaluatedStages, failedStage: stage } })
    if (stage === 'OBJECT_SCOPE') expect(JSON.stringify(result.stageDetails)).not.toContain('FIELD_SCOPE')
  })

  it.each([
    ['empty prefix', { evaluatedStages: [] }], ['overlong prefix', { evaluatedStages: [...storedStages, 'TOOL_TRUST'] }],
    ['gap', { evaluatedStages: ['PREFLIGHT', 'OPERATION'] }], ['duplicate', { evaluatedStages: ['PREFLIGHT', 'PREFLIGHT'] }],
    ['reversed', { evaluatedStages: ['TOOL', 'PREFLIGHT'] }], ['unknown stage', { evaluatedStages: ['FUTURE'] }],
    ['null prefix', { evaluatedStages: null }], ['wrong prefix type', { evaluatedStages: {} }],
    ['incomplete ALLOW', { evaluatedStages: ['PREFLIGHT'] }], ['ALLOW terminal', { failedStage: 'TOOL_TRUST' }],
    ['explicit null terminal', { failedStage: null }], ['alias without primary', { failedCheck: 'TOOL_TRUST' }],
    ['null checks alias', { evaluatedChecks: null }], ['mismatched checks alias', { evaluatedChecks: ['PREFLIGHT'] }],
    ['foreign rows', { stageOutcomes: [] }], ['foreign observed key', { observedFailedStage: 'OBJECT_SCOPE' }],
    ['null observed key', { observedReasonCode: null }], ['unknown mode', { evaluationMode: 'FUTURE' }],
    ['null mode', { evaluationMode: null }], ['wrong ALLOW sentinel', { reasonCode: 'BASELINE_ALLOW' }],
    ['blank terminal reason', { reasonCode: '  ' }], ['long terminal reason', { reasonCode: 'r'.repeat(101) }],
    ['overall inconsistency', { allowed: false }],
  ] as const)('keeps %s unreadable without changing the existing overall decision', async (_label, extra) => {
    const result = await policyProjection(enforce(extra))
    expect(result.stageDetails).toEqual({ status: 'unreadable' })
    expect(result.decision).toBe(Object.hasOwn(extra, 'allowed') ? 'UNKNOWN' : 'ALLOW')
  })

  it.each([
    ['missing terminal', { evaluatedStages: ['PREFLIGHT'], decisionType: 'ERROR', allowed: false, reasonCode: 'error' }],
    ['empty ERROR', { evaluatedStages: [], decisionType: 'ERROR', allowed: false, reasonCode: 'error' }],
    ['terminal mismatch', { evaluatedStages: ['PREFLIGHT', 'TOOL'], failedStage: 'PREFLIGHT', decisionType: 'DENY', allowed: false, reasonCode: 'deny' }],
    ['terminal alias mismatch', { evaluatedStages: ['PREFLIGHT'], failedStage: 'PREFLIGHT', failedCheck: 'TOOL', decisionType: 'ERROR', allowed: false, reasonCode: 'error' }],
    ['PREFLIGHT DENY', { evaluatedStages: ['PREFLIGHT'], failedStage: 'PREFLIGHT', decisionType: 'DENY', allowed: false, reasonCode: 'deny' }],
  ] as const)('does not invent evaluated details for %s', async (_label, extra) => {
    expect((await policyProjection(enforce(extra))).stageDetails).toEqual({ status: 'unreadable' })
  })

  it.each([
    { allowed: false }, { allowed: true, evaluatedChecks: ['PREFLIGHT'], failedCheck: 'PREFLIGHT' },
    { decisionType: 'ERROR', allowed: false, failedCheck: null },
  ])('keeps primary-absent legacy detail absent: %j', async policy => {
    expect((await policyProjection(policy)).stageDetails).toEqual({ status: 'absent' })
  })

  it.each([{ evaluationMode: 'ENFORCE' }, { evaluatedStages: ['PREFLIGHT'] }, { failedStage: null },
    { observedFailedStage: null }, { stageOutcomes: null }, { evaluationMode: 'BASELINE', stageOutcomes: [] }])(
    'marks started but incomplete primary detail unreadable: %j', async partial => {
      expect((await policyProjection({ allowed: false, reasonCode: 'recorded', ...partial })).stageDetails).toEqual({ status: 'unreadable' })
    })

  it('preserves BASELINE full PASS rows as recorded and does not infer mode from Run metadata', async () => {
    const result = await policyProjection(baseline())
    expect(result.decision).toBe('ALLOW')
    expect(result.stageDetails).toEqual({ status: 'valid', mode: 'BASELINE', failedStage: null, observedFailure: null,
      stageOutcomes: storedStages.map(stage => ({ stage, enforcement: observed.has(stage) ? 'OBSERVED' : 'ENFORCED',
        outcomeType: 'PASS', reasonCode: null })) })
  })

  it.each([...observed])('preserves %s observation and only skips subsequent OBSERVED stages', async stage => {
    const result = await policyProjection(baseline(stage))
    expect(result).toMatchObject({ decision: 'ALLOW', decisionReasonCode: 'BASELINE_ALLOW', stageDetails: {
      status: 'valid', mode: 'BASELINE', failedStage: null, observedFailure: { stage, reasonCode: 'observed reason' },
    } })
    if (result.stageDetails.status !== 'valid' || result.stageDetails.mode !== 'BASELINE') throw new Error('Expected BASELINE detail')
    expect(result.stageDetails.stageOutcomes).toHaveLength(11)
    expect(result.stageDetails.stageOutcomes.filter(row => row.outcomeType === 'SKIPPED').map(row => row.stage))
      .toEqual(storedStages.slice(storedStages.indexOf(stage) + 1).filter(next => observed.has(next)))
    expect(result.stageDetails.stageOutcomes[10]).toEqual({ stage: 'TOOL_TRUST', enforcement: 'ENFORCED', outcomeType: 'PASS', reasonCode: null })
  })

  it.each([
    ['PREFLIGHT', 'ERROR', undefined], ['TOOL', 'DENY', undefined],
    ['WORKFLOW', 'DENY', 'OBJECT_SCOPE'], ['TOOL_TRUST', 'ERROR', 'FIELD_SCOPE'],
    ['OBJECT_SCOPE', 'ERROR', undefined],
  ] as const)('preserves BASELINE terminal %s %s alongside any earlier observation', async (stage, type, prior) => {
    const result = await policyProjection(baseline(prior, stage, type))
    expect(result).toMatchObject({ decision: type, stageDetails: { status: 'valid', mode: 'BASELINE', failedStage: stage,
      observedFailure: prior ? { stage: prior, reasonCode: 'observed reason' } : null } })
    if (result.stageDetails.status === 'valid' && result.stageDetails.mode === 'BASELINE') {
      expect(result.stageDetails.stageOutcomes).toHaveLength(storedStages.indexOf(stage) + 1)
      expect(result.stageDetails.stageOutcomes.at(-1)).toMatchObject({ stage, outcomeType: type, reasonCode: 'stored terminal reason' })
    }
  })

  it.each([
    ['PASS reason null', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[0]!.reasonCode = null }],
    ['PASS reason text', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[0]!.reasonCode = 'unexpected' }],
    ['wrong enforcement', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[4]!.enforcement = 'ENFORCED' }],
    ['unearned SKIPPED', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[4]!.outcomeType = 'SKIPPED' }],
    ['unknown outcome', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[0]!.outcomeType = 'FUTURE' }],
    ['wrong stage', (p: Record<string, unknown>) => { (p.stageOutcomes as Record<string, unknown>[])[0]!.stage = 'TOOL' }],
    ['short ALLOW', (p: Record<string, unknown>) => { (p.stageOutcomes as unknown[]).pop() }],
    ['foreign ENFORCE array', (p: Record<string, unknown>) => { p.evaluatedStages = [] }],
    ['foreign ENFORCE alias', (p: Record<string, unknown>) => { p.evaluatedChecks = [] }],
    ['invented observed pair', (p: Record<string, unknown>) => { p.observedFailedStage = 'OBJECT_SCOPE'; p.observedReasonCode = 'reason' }],
    ['explicit null observed key', (p: Record<string, unknown>) => { p.observedFailedStage = null }],
  ] as const)('rejects malformed BASELINE %s without upgrading ALLOW', async (_label, mutate) => {
    const policy = baseline(); mutate(policy)
    const result = await policyProjection(policy)
    expect(result.decision).toBe('ALLOW')
    expect(result.stageDetails).toEqual({ status: 'unreadable' })
  })

  it.each(['missing observed reason', 'mismatched observed reason', 'later PASS', 'SKIPPED reason', 'later observed ERROR']) (
    'rejects observed-prefix inconsistency: %s', async change => {
      const policy = baseline('OBJECT_SCOPE')
      const rows = policy.stageOutcomes as Record<string, unknown>[]
      if (change === 'missing observed reason') delete policy.observedReasonCode
      if (change === 'mismatched observed reason') policy.observedReasonCode = 'different'
      if (change === 'later PASS') rows[5]!.outcomeType = 'PASS'
      if (change === 'SKIPPED reason') rows[5]!.reasonCode = null
      if (change === 'later observed ERROR') { rows[5]!.outcomeType = 'ERROR'; rows[5]!.reasonCode = 'error' }
      expect((await policyProjection(policy)).stageDetails).toEqual({ status: 'unreadable' })
    })

  it.each(['wrong overall', 'wrong terminal reason', 'failed alias', 'terminal not last', 'null terminal']) (
    'rejects BASELINE terminal inconsistency: %s', async change => {
      const policy = baseline('OBJECT_SCOPE', 'WORKFLOW', 'DENY')
      if (change === 'wrong overall') { policy.decisionType = 'ERROR' }
      if (change === 'wrong terminal reason') policy.reasonCode = 'different'
      if (change === 'failed alias') policy.failedCheck = 'TOOL'
      if (change === 'null terminal') policy.failedStage = null
      if (change === 'terminal not last') (policy.stageOutcomes as unknown[]).push({ stage: 'HUMAN_BOUNDARY', enforcement: 'OBSERVED', outcomeType: 'SKIPPED' })
      expect((await policyProjection(policy)).stageDetails).toEqual({ status: 'unreadable' })
    })
})

describe('Gateway explicit captured-history call references', () => {
  it('joins one call across pages with only exact immutable event references and GET history requests', async () => {
    const rows = callHistory()
    const fetch = responses(run(), history(rows.slice(0, 2), 4, 2), history(rows.slice(2), 4))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(4)
    const expected = (index: number, eventType: string) => ({ eventId: id(1000 + index), eventType, sequence: index,
      occurredAt: rows[index - 1]!.occurredAt, payloadDigest: digest(index + 100), eventHash: digest(index),
      prevEventHash: index === 1 ? null : digest(index - 1) })
    expect(result.events[0]!.callDetails).toEqual({ status: 'valid', toolCallId: id(1001),
      proposal: expected(1, 'TOOL_PROPOSED'), request: expected(3, 'TOOL_REQUEST'), response: expected(4, 'TOOL_RESPONSE') })
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [, init] of fetch.mock.calls) { expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined() }
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${canary}|metadata|input|output|deliveryState|successfulSecurityBlock|ATTACK_BLOCKED`))
    const detail = result.events[0]!.callDetails
    expect(Object.isFrozen(detail)).toBe(true)
    if (detail.status === 'valid') {
      expect(Object.isFrozen(detail.proposal)).toBe(true)
      expect(Object.isFrozen(detail.request)).toBe(true)
      expect(Object.isFrozen(detail.response)).toBe(true)
    }
  })

  it.each([null, undefined, {}, { adjacentEvent: id(1001) }])('keeps metadata %j without an explicit link absent', async metadata => {
    responses(run(), history([event(1, { metadata })]))
    expect((await client().loadRun(releaseId, runId, actor)).events[0]!.callDetails).toEqual({ status: 'absent' })
  })
  it.each([[], 'bad', 42, false, { toolCallId: null }, { toolCallId: '' }, { toolCallId: canary },
    { toolCallId: [] }, { toolCallId: true }, { toolCallId: 123 }])('keeps malformed metadata %j unreadable without raw contents', async metadata => {
    responses(run(), history([event(1, { metadata })]))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events[0]!.callDetails).toEqual({ status: 'unreadable', toolCallId: null })
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it('distinguishes an own undefined call key from an inherited key without repairing either', async () => {
    const inherited = Object.create({ toolCallId: id(1001) }) as Record<string, unknown>
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(run()))
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: history([
        event(1, { metadata: { toolCallId: undefined } }), event(2, { metadata: inherited }),
      ]) }) } as Response)
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events.map(row => row.callDetails)).toEqual([{ status: 'unreadable', toolCallId: null }, { status: 'absent' }])
  })

  it.each([
    ['missing proposal', { eventType: 'RUN_STARTED' }], ['wrong proposal type', { eventType: 'TOOL_REQUEST' }],
    ['proposal case', { testCaseRunId: id(999) }], ['proposal null case', { testCaseRunId: null }],
    ['proposal trace', { traceId: id(999) }], ['proposal tool', { toolName: 'DOCUMENT_READER' }],
    ['proposal null tool', { toolName: null }], ['proposal blank tool', { toolName: '' }],
  ] as const)('does not expose refs for %s', async (_label, extra) => {
    const rows = callHistory(); rows[0] = linked(1, 'TOOL_PROPOSED', { metadata: null, ...extra })
    responses(run(), history(rows))
    expect((await client().loadRun(releaseId, runId, actor)).events[0]!.callDetails)
      .toEqual({ status: 'unreadable', toolCallId: id(1001) })
  })

  it.each([
    ['request case', 2, { testCaseRunId: id(999) }], ['response trace', 3, { traceId: id(999) }],
    ['response tool', 3, { toolName: 'DOCUMENT_READER' }], ['policy null case', 1, { testCaseRunId: null }],
    ['policy null tool', 1, { toolName: null }], ['policy empty tool', 1, { toolName: '' }],
  ] as const)('keeps %s a per-card conflict without invalidating complete history', async (_label, index, extra) => {
    const rows = callHistory(); rows[index] = { ...rows[index]!, ...extra }
    responses(run(), history(rows))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(4)
    expect(result.events[0]!.callDetails).toEqual({ status: 'unreadable', toolCallId: id(1001) })
  })

  it.each(['POLICY_EVALUATED', 'TOOL_REQUEST', 'TOOL_RESPONSE'])('reports counts without arbitrarily selecting duplicate %s', async eventType => {
    const rows = [...callHistory(), linked(5, eventType)]
    responses(run(), history(rows))
    const result = await client().loadRun(releaseId, runId, actor)
    const counts = { policies: eventType === 'POLICY_EVALUATED' ? 2 : 1,
      requests: eventType === 'TOOL_REQUEST' ? 2 : 1, responses: eventType === 'TOOL_RESPONSE' ? 2 : 1 }
    expect(result.events.every(row => JSON.stringify(row.callDetails) === JSON.stringify({ status: 'ambiguous', toolCallId: id(1001), counts }))).toBe(true)
    const detail = result.events[0]!.callDetails
    if (detail.status === 'ambiguous') expect(Object.isFrozen(detail.counts)).toBe(true)
    expect(JSON.stringify(detail)).not.toMatch(/proposal|eventId|eventHash/)
    if (eventType === 'POLICY_EVALUATED') expect(result.events[0]!.callDetails).toBe(result.events[1]!.callDetails)
  })

  it('gives context conflict priority over multiple matching attempts', async () => {
    responses(run(), history([...callHistory(), linked(5, 'TOOL_REQUEST', { traceId: id(999) })]))
    expect((await client().loadRun(releaseId, runId, actor)).events[0]!.callDetails).toEqual({ status: 'unreadable', toolCallId: id(1001) })
  })

  it('keeps historical receipt request/response before a later policy explicitly ambiguous', async () => {
    responses(run(), history([linked(1, 'TOOL_PROPOSED'), linked(2, 'TOOL_REQUEST'),
      linked(3, 'TOOL_RESPONSE'), linked(4, 'POLICY_EVALUATED')]))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.headSequence).toBe(4)
    expect(result.events[0]!.callDetails).toEqual({ status: 'ambiguous', toolCallId: id(1001),
      counts: { policies: 1, requests: 1, responses: 1 } })
  })

  it.each([
    ['response without request', ['TOOL_PROPOSED', 'POLICY_EVALUATED', 'TOOL_RESPONSE']],
    ['response before request', ['TOOL_PROPOSED', 'POLICY_EVALUATED', 'TOOL_RESPONSE', 'TOOL_REQUEST']],
    ['proposal after policy', ['POLICY_EVALUATED', 'TOOL_PROPOSED', 'TOOL_REQUEST']],
  ] as const)('does not promote %s to valid references', async (label, types) => {
    const proposalId = label === 'proposal after policy' ? id(1002) : id(1001)
    responses(run(), history(types.map((type, index) => linked(index + 1, type, { metadata: { toolCallId: proposalId } }))))
    expect((await client().loadRun(releaseId, runId, actor)).events[0]!.callDetails).toEqual({ status: 'unreadable', toolCallId: proposalId })
  })

  it.each([2, 3])('preserves missing slots at captured head %s without interpreting execution or delivery', async head => {
    const rows = callHistory()
    responses(run(), history(rows.slice(0, 2), head, 2), history(rows.slice(2), 4))
    // At head 2 the loader completes after its first page; later mocked records are outside the snapshot.
    const result = await client().loadRun(releaseId, runId, actor)
    const details = result.events[0]!.callDetails
    expect(result.headSequence).toBe(head)
    expect(details.status).toBe('valid')
    if (details.status === 'valid') {
      expect(details.request?.eventId ?? null).toBe(head === 3 ? id(1003) : null)
      expect(details.response).toBeNull()
    }
    expect(JSON.stringify(result)).not.toMatch(/noCall|noLeak|quarantin|deliveredToAgent|successfulSecurityBlock/)
  })

  it('does not guess links for adjacent unkeyed records or malformed records from another call', async () => {
    responses(run(), history([linked(1, 'TOOL_PROPOSED'), linked(2, 'POLICY_EVALUATED'),
      linked(3, 'TOOL_REQUEST', { metadata: {} }), linked(4, 'TOOL_RESPONSE', { metadata: { toolCallId: canary } })]))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events[0]!.callDetails).toMatchObject({ status: 'valid', request: null, response: null })
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it('does not let a proposal appearing beyond the captured head repair a missing link', async () => {
    responses(run(), history([linked(1, 'POLICY_EVALUATED', { metadata: { toolCallId: id(1002) } }),
      linked(2, 'TOOL_PROPOSED')], 1))
    const result = await client().loadRun(releaseId, runId, actor)
    expect(result.events[0]!.callDetails).toEqual({ status: 'unreadable', toolCallId: id(1002) })
  })

  it('detaches nested stage, observed and call references from mutable transport input', async () => {
    const policy = baseline('OBJECT_SCOPE'), rows = callHistory()
    rows[1] = linked(2, 'POLICY_EVALUATED', { policyDecision: policy })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(run()))
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: history(rows) }) } as Response)
    const result = await client().loadRun(releaseId, runId, actor)
    const before = JSON.stringify(result)
    ;(policy.stageOutcomes as Record<string, unknown>[])[4]!.reasonCode = canary
    policy.observedReasonCode = canary; rows[2]!.eventHash = digest(999)
    rows[1]!.metadata = { toolCallId: id(999), input: canary, deliveryState: canary, successfulSecurityBlock: true }
    expect(JSON.stringify(result)).toBe(before)
    const stages = result.events[0]!.stageDetails
    if (stages.status !== 'valid' || stages.mode !== 'BASELINE') throw new Error('Expected BASELINE detail')
    expect(Object.isFrozen(stages.stageOutcomes)).toBe(true)
    expect(stages.stageOutcomes.every(row => Object.isFrozen(row))).toBe(true)
    expect(Object.isFrozen(stages.observedFailure)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(canary)
  })
})
