import { GatewayEvidenceClient, GatewayEvidenceError } from './gatewayEvidence'

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

  it('projects ERROR as immutable source-linked evidence without raw payloads, stages, calls or block credit', async () => {
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
      payloadDigest: digest(101), eventHash: digest(1), prevEventHash: null })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.events)).toBe(true)
    expect(Object.isFrozen(result.events[0])).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${canary}|metadata|input|output|toolCallId|evaluatedStages|evaluatedChecks|stageOutcomes|failedStage|failedCheck|successfulSecurityBlock`))
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
