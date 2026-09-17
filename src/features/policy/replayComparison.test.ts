import { ReplayComparisonClient } from './replayComparison'

const releaseId = '019903ac-abcd-7000-8000-000000000001'
const baselineRunId = '019903ac-abcd-7000-8000-000000000010'
const replayRunId = '019903ac-abcd-7000-8000-000000000011'
const caseId = '019903ac-abcd-7000-8000-000000000020'
const eventId = '019903ac-abcd-7000-8000-000000000030'
const secondEventId = '019903ac-abcd-7000-8000-000000000031'
const hash = `sha256:${'a'.repeat(64)}`
const at = '2026-09-17T00:00:00Z'
const canary = 'SYNTHETIC_REPLAY_EXCLUDED_CANARY'
const client = new ReplayComparisonClient('https://api.test')

function event(value: unknown = { decisionType: 'DENY', allowed: false, reasonCode: 'CUSTOMER_SCOPE_VIOLATION', evaluationMode: 'ENFORCE', private: canary }) {
  return { eventId, eventType: 'POLICY_EVALUATED', toolName: 'CUSTOMER_DATA_READ' as string | null,
    value, payloadDigest: hash, reasonCode: 'CUSTOMER_SCOPE_VIOLATION' as string | null, occurredAt: at }
}
function side(runId: string, mode: string) {
  return { runId, caseRunId: caseId, mode, runStatus: 'COMPLETED', caseStatus: 'PASSED', policyDecisions: [event()],
    securityOutcome: canary, functionalOutcome: canary, apiResponses: [{ value: canary }], stateChanges: [{ value: canary }], oracleResults: [{ outcome: canary }] }
}
function detail() {
  return { releaseId, replayRunId, replayLinkId: caseId, findingId: secondEventId,
    comparable: true, mismatchReasons: [] as string[], baseline: side(baselineRunId, 'BASELINE'), replay: side(replayRunId, 'SEAL_REPLAY'),
    category: canary, severity: canary, difference: { attackMitigated: true, private: canary } }
}
function response(data: unknown = detail(), status = 200) {
  return new Response(JSON.stringify({ data, traceId: eventId, timestamp: at }), { status })
}
function fetchDetail(data = detail()) { return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data)) }

describe('stored Replay policy comparison transport', () => {
  it('reads the exact D61 GET and omits all outcome and raw fields from an immutable projection', async () => {
    const data = detail()
    data.comparable = false; data.mismatchReasons = ['MODEL_CONFIG_MISMATCH', 'custom reason']
    data.baseline.policyDecisions = [event({ allowed: true, reasonCode: 'BASELINE_ALLOW', private: canary })]
    const fetch = fetchDetail(data)
    const result = await client.comparison(releaseId, replayRunId)
    expect(fetch).toHaveBeenCalledWith(`https://api.test/api/v1/replays/${replayRunId}/comparison`, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: undefined,
    })
    expect(result.comparable).toBe(false)
    expect(result.mismatchReasons).toEqual(data.mismatchReasons)
    expect(result.baseline.policyDecisions[0]).toMatchObject({ decision: 'ALLOW', decisionEncoding: 'legacy', evaluationMode: null })
    expect(result.replay.policyDecisions[0]).toMatchObject({ decision: 'DENY', decisionEncoding: 'explicit', evaluationMode: 'ENFORCE', eventId, payloadDigest: hash })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(Object.keys(result)).toEqual(['replayRunId', 'replayLinkId', 'findingId', 'releaseId', 'comparable', 'mismatchReasons', 'baseline', 'replay'])
    expect(Object.keys(result.replay.policyDecisions[0]!)).not.toEqual(expect.arrayContaining(['value', 'sequence', 'traceId', 'eventHash']))
    for (const value of [result, result.mismatchReasons, result.baseline, result.replay, result.replay.policyDecisions, result.replay.policyDecisions[0]]) expect(Object.isFrozen(value)).toBe(true)
  })

  it.each([
    [{ decisionType: 'ALLOW', allowed: true }, 'ALLOW', 'explicit'],
    [{ decisionType: 'DENY', allowed: false }, 'DENY', 'explicit'],
    [{ decisionType: 'ERROR', allowed: false }, 'ERROR', 'explicit'],
    [{ allowed: true }, 'ALLOW', 'legacy'], [{ allowed: false }, 'DENY', 'legacy'],
    [{ decisionType: 'ERROR', allowed: true }, 'UNKNOWN', 'unreadable'],
    [{ decisionType: 'ALLOW', allowed: false }, 'UNKNOWN', 'unreadable'],
    [{ decisionType: 'OTHER', allowed: true }, 'UNKNOWN', 'unreadable'],
    [{ decisionType: null, allowed: false }, 'UNKNOWN', 'unreadable'],
    [{ reasonCode: 'ALLOW', successfulSecurityBlock: true }, 'UNKNOWN', 'unreadable'],
    [{ allowed: 'false' }, 'UNKNOWN', 'unreadable'], [null, 'UNKNOWN', 'unreadable'],
    [[], 'UNKNOWN', 'unreadable'], [42, 'UNKNOWN', 'unreadable'], [undefined, 'UNKNOWN', 'unreadable'],
  ])('preserves the stored decision semantics for %j', async (value, decision, decisionEncoding) => {
    const data = detail(); data.replay.policyDecisions = [{ ...event(null), value }]; fetchDetail(data)
    expect((await client.comparison(releaseId, replayRunId)).replay.policyDecisions[0]).toMatchObject({ decision, decisionEncoding })
  })

  it('preserves source array order, separate reasons, empty labels, nullable labels and an allowed baseline mode', async () => {
    const data = detail(); data.baseline.mode = 'SEAL_REPLAY'; data.baseline.policyDecisions = []
    data.replay.caseStatus = 'ERROR'
    data.replay.policyDecisions = [{ ...event({ allowed: false, reasonCode: 'OTHER', evaluationMode: 'OTHER' }), eventId: secondEventId, toolName: '', reasonCode: '' },
      { ...event(null), toolName: null, reasonCode: null }]
    fetchDetail(data)
    const result = await client.comparison(releaseId, replayRunId)
    expect(result.baseline).toMatchObject({ mode: 'SEAL_REPLAY', policyDecisions: [] })
    expect(result.replay.policyDecisions.map(row => row.eventId)).toEqual([secondEventId, eventId])
    expect(result.replay.policyDecisions[0]).toMatchObject({ toolName: '', eventReasonCode: '', policyReasonCode: 'OTHER', evaluationMode: null })
    expect(result.replay.policyDecisions[1]).toMatchObject({ toolName: null, eventReasonCode: null, policyReasonCode: null, decision: 'UNKNOWN' })
  })

  const invalid: [string, (data: ReturnType<typeof detail>) => void][] = [
    ['Release mismatch', data => { data.releaseId = caseId }], ['top Run mismatch', data => { data.replayRunId = caseId }],
    ['side Run mismatch', data => { data.replay.runId = baselineRunId }], ['replay mode', data => { data.replay.mode = 'BASELINE' }],
    ['baseline invalid mode', data => { data.baseline.mode = 'OTHER' }], ['active baseline', data => { data.baseline.runStatus = 'RUNNING' }],
    ['active replay', data => { data.replay.runStatus = 'RUNNING' }], ['active case', data => { data.replay.caseStatus = 'EXECUTING' }],
    ['missing side', data => { Object.assign(data, { baseline: null }) }], ['invalid Link ID', data => { data.replayLinkId = 'bad' }],
    ['invalid Case ID', data => { data.replay.caseRunId = 'bad' }], ['invalid Finding ID', data => { data.findingId = 'bad' }],
    ['invalid comparable', data => { Object.assign(data, { comparable: 'true' }) }],
    ['contradictory reasons', data => { data.mismatchReasons = ['MISMATCH'] }], ['absent reasons', data => { Object.assign(data, { mismatchReasons: null }) }],
    ['missing policy list', data => { Object.assign(data.replay, { policyDecisions: null }) }],
    ['event type', data => { data.replay.policyDecisions[0]!.eventType = 'TOOL_RESPONSE' }],
    ['event UUID', data => { data.replay.policyDecisions[0]!.eventId = 'bad' }],
    ['digest', data => { data.replay.policyDecisions[0]!.payloadDigest = 'bad' }],
    ['timestamp', data => { data.replay.policyDecisions[0]!.occurredAt = 'invalid' }],
    ['tool type', data => { Object.assign(data.replay.policyDecisions[0]!, { toolName: 1 }) }],
    ['duplicate event', data => { data.replay.policyDecisions.push(event()) }],
  ]
  it.each(invalid)('rejects %s without returning partial evidence', async (_name, change) => {
    const data = detail(); change(data); fetchDetail(data)
    await expect(client.comparison(releaseId, replayRunId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('fails explicitly on oversized evidence instead of truncating it', async () => {
    const data = detail(); data.replay.policyDecisions = Array.from({ length: 10_001 }, () => event()); fetchDetail(data)
    await expect(client.comparison(releaseId, replayRunId)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it.each([['bad', replayRunId], [releaseId, '../other']])('does not fetch malformed input', async (release, run) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(client.comparison(release, run)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['file:///tmp/api', 'https://user:secret@api.test', 'https://api.test?token=x', 'https://api.test#fragment'])('rejects unsafe base %s', base => {
    expect(() => new ReplayComparisonClient(base)).toThrow('조회할 릴리스와 Replay Run')
  })
  it.each([202, 404, 409, 500])('safely rejects HTTP %i without copying body details', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ detail: canary }, status))
    const error = await client.comparison(releaseId, replayRunId).catch(error => error)
    expect(error.code).toBe('REQUEST_FAILED'); expect(error.message).not.toContain(canary)
  })
  it('handles invalid JSON and network failure without exposing raw errors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(canary, { status: 200 }))
      .mockRejectedValueOnce(new Error(canary))
    await expect(client.comparison(releaseId, replayRunId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const error = await client.comparison(releaseId, replayRunId).catch(error => error)
    expect(error.code).toBe('REQUEST_FAILED'); expect(error.message).not.toContain(canary); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('honors abort before fetch and after a fetch that ignores cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(client.comparison(releaseId, replayRunId, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
    const active = new AbortController()
    fetch.mockImplementation(async () => { active.abort(); return response() })
    await expect(client.comparison(releaseId, replayRunId, active.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
  })
  it('reuses the existing paginated listing and exposes only actual SEAL_REPLAY options', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ items: [
      { id: baselineRunId, releaseId, mode: 'BASELINE', status: 'COMPLETED' },
      { id: replayRunId, releaseId, mode: 'SEAL_REPLAY', status: 'RUNNING' },
    ], nextCursor: null }))
    expect(await client.listRuns(releaseId, 'viewer')).toEqual([{ id: replayRunId, releaseId, mode: 'SEAL_REPLAY', status: 'RUNNING' }])
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.test/api/v1/releases/${releaseId}/test-runs?limit=100`)
  })
})
