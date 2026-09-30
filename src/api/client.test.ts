import { FinsecApiClient, FinsecApiError, RunStartError } from './client'
import type { ExecutionEvent, TestRun, TestRunStart } from './contracts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function historyEvent(sequence: number, runId = 'run-1'): ExecutionEvent {
  return {
    schemaVersion: '1.0', eventId: `event-${sequence}`, traceId: 'trace-1', runId,
    testCaseRunId: null, sequence, occurredAt: '2026-09-01T00:00:00Z',
    eventType: 'MODEL_REQUEST', toolName: null, input: null, output: null,
    payloadDigest: `sha256:${'a'.repeat(64)}`, policyDecision: null, reasonCode: null,
    metadata: {}, prevEventHash: null, eventHash: `sha256:${'b'.repeat(64)}`,
  }
}

const runId = '0198f1e2-0000-7000-8000-000000000123'
const runInput: TestRunStart = {
  releaseId: 'release-1', suiteId: 'suite-1', mode: 'BASELINE',
  contractVersionId: null, caseIds: [], randomSeed: 42,
}
const runReceipt = {
  runId, status: 'QUEUED', statusUrl: `/api/v1/test-runs/${runId}`,
  streamUrl: `/api/v1/test-runs/${runId}/events`,
}
const cancelledRun: TestRun = {
  id: runId, releaseId: 'release-1', suiteId: 'suite-1', contractVersionId: null,
  mode: 'BASELINE', status: 'CANCELLED', agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`,
  releaseFingerprint: `sha256:${'2'.repeat(64)}`, fixtureVersion: '1.0',
  fixtureDigest: `sha256:${'3'.repeat(64)}`, totalCases: 12, completedCases: 0,
  operationalErrorCount: 0, latestSequence: 2, latestEventType: 'RUN_CANCEL_REQUESTED',
  eventHeadHash: `sha256:${'4'.repeat(64)}`, summary: { cancelledCases: 12 },
  startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:00:01Z',
  createdAt: '2026-09-01T00:00:00Z',
}
function reviewerEnvelope() {
  return { data: {
    csrfToken: 'PRIVATE_CSRF_CANARY', actorId: 'verified-reviewer',
    workspaceId: '0198f1e2-0000-7000-8000-000000000001', role: 'AI_SECURITY_REVIEWER',
    expiresAt: Math.floor(Date.now() / 1000) + 1200,
  }, traceId: 'trace-session', timestamp: '2026-09-27T00:00:00Z' }
}

describe('FinsecApiClient', () => {
  it('adds actor and a unique idempotency key before a mutation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: {
        id: 'agent-id',
        agentKey: 'loan-agent',
        name: 'Loan Agent',
        purposeSummary: 'Review',
        status: 'ACTIVE',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
      traceId: 'trace-id',
      timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    await client.createAgent({
      agentKey: 'loan-agent',
      name: 'Loan Agent',
      purposeSummary: 'Review',
    }, 'role-a-console')

    const [url, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(url).toBe('http://api.test/api/v1/agents')
    expect(init?.method).toBe('POST')
    expect(headers.get('X-Actor-Id')).toBe('role-a-console')
    expect(headers.get('Idempotency-Key')).toBe('agent-create-00000000-0000-4000-8000-000000000001')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('preserves the platform problem code and trace ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      title: 'Conflict',
      status: 409,
      detail: 'The immutable release changed',
      code: 'RELEASE_CHANGED',
      traceId: 'trace-409',
      retryable: false,
    }, 409))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.fingerprint('release-id', 'role-a-console')).rejects.toMatchObject({
      name: 'FinsecApiError',
      status: 409,
      code: 'RELEASE_CHANGED',
      traceId: 'trace-409',
      retryable: false,
    } satisfies Partial<FinsecApiError>)
  })

  it('reads the selected Release detail with an encoded ID and actor header', async () => {
    const data = {
      id: 'release/selected', agentId: 'agent-1', version: '1.2.0',
      businessPurpose: 'Document review', manifestSchemaVersion: '1.1',
      agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
      releaseFingerprint: `sha256:${'b'.repeat(64)}`,
      safetyContractHash: null, lifecycleState: 'ANALYZED',
      effectiveStatus: 'NEEDS_REVALIDATION', revalidationReason: null,
      analyzedAt: '2026-09-01T00:00:00Z', lastTestedAt: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data, traceId: 'trace-detail', timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.releaseDetail('release/selected', 'role-a-console')).resolves.toEqual(data)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/releases/release%2Fselected',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const init = fetchMock.mock.calls[0]![1]
    const headers = new Headers(init?.headers)
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(headers.get('X-Actor-Id')).toBe('role-a-console')
    expect(headers.get('Idempotency-Key')).toBeNull()
  })

  it('preserves a failed Release detail problem for the live view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: 404, code: 'RELEASE_NOT_FOUND', detail: 'Release does not exist',
      traceId: 'trace-detail-error', retryable: false,
    }, 404))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.releaseDetail('missing', 'role-a-console')).rejects.toMatchObject({
      status: 404, code: 'RELEASE_NOT_FOUND', traceId: 'trace-detail-error', retryable: false,
    } satisfies Partial<FinsecApiError>)
  })

  it('reads the server Release diff with encoded IDs and nullable component digests', async () => {
    const data = {
      against: 'release/old', releaseId: 'release/new', meaningfulChange: true,
      components: [{
        component: 'serverToolCatalogHash', jsonPointers: ['/serverToolCatalog'],
        oldDigest: null, newDigest: `sha256:${'a'.repeat(64)}`,
        changed: true, redactedSummary: 'Canonical digest changed; raw sensitive values are redacted',
      }],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data, traceId: 'trace-diff', timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.releaseDiff('release/new', 'release/old', 'role-a-console')).resolves.toEqual(data)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/releases/release%2Fnew/diff?against=release%2Fold',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(headers.get('X-Actor-Id')).toBe('role-a-console')
    expect(headers.get('Idempotency-Key')).toBeNull()
  })

  it('preserves a failed Release diff response for the live view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: 422, code: 'VALIDATION_ERROR', detail: 'Release diff requires the same Agent',
      traceId: 'trace-diff-error', retryable: false,
    }, 422))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.releaseDiff('current', 'other', 'role-a-console')).rejects.toMatchObject({
      status: 422, code: 'VALIDATION_ERROR', traceId: 'trace-diff-error', retryable: false,
    } satisfies Partial<FinsecApiError>)
  })

  it('never clicks an old Attestation export after cancellation during blob download', async () => {
    const response = new Response('synthetic report', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="attestation.json"' },
    })
    let completeBlob!: (blob: Blob) => void
    const blob = vi.spyOn(response, 'blob').mockReturnValue(new Promise(resolve => { completeBlob = resolve }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const controller = new AbortController()
    const client = new FinsecApiClient('http://api.test')

    const exportPromise = client.downloadAttestation('release-old', 'json', 'role-a-console', controller.signal)
    await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce())
    controller.abort()
    completeBlob(new Blob(['synthetic report']))

    await expect(exportPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(click).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/releases/release-old/evidence-export?format=json',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('authenticates recovery lookup without persisting the operator key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: [], traceId: 'trace-id', timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    await client.pendingRecoveries('x'.repeat(32), 'operator:platform')

    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Operator-Recovery-Key')).toBe('x'.repeat(32))
    expect(headers.get('X-Actor-Id')).toBe('operator:platform')
    expect(init?.method).toBeUndefined()
  })

  it('lists ready suites for a release', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: {
        items: [{
          id: 'suite-1',
          releaseId: 'release-1',
          version: '1.0',
          status: 'READY',
          suiteHash: 'sha256:abc',
          caseCount: 12,
        }],
        nextCursor: null,
      },
      traceId: 'trace-suite',
      timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    const suites = await client.listTestSuites('release-1', 'role-b-console', { status: 'READY', limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/releases/release-1/test-suites?status=READY&limit=20', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    expect(suites).toEqual([{ id: 'suite-1', releaseId: 'release-1', version: '1.0', status: 'READY', suiteHash: 'sha256:abc', caseCount: 12 }])
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Actor-Id')).toBe('role-b-console')
  })

  it('lists runs for a release with filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: {
        items: [{
          id: 'run-1',
          releaseId: 'release-1',
          suiteId: 'suite-1',
          mode: 'BASELINE',
          status: 'COMPLETED',
          totalCases: 10,
          completedCases: 10,
          operationalErrorCount: 0,
          latestSequence: 80,
          startedAt: '2026-09-01T00:00:00Z',
          completedAt: '2026-09-01T00:05:00Z',
        }],
        nextCursor: null,
      },
      traceId: 'trace-runs',
      timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    const runs = await client.listTestRuns('release-1', 'role-b-console', { mode: 'BASELINE', status: 'COMPLETED', limit: 10 })

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/releases/release-1/test-runs?mode=BASELINE&status=COMPLETED&limit=10', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    expect(runs).toEqual([{ id: 'run-1', releaseId: 'release-1', suiteId: 'suite-1', mode: 'BASELINE', status: 'COMPLETED', totalCases: 10, completedCases: 10, operationalErrorCount: 0, latestSequence: 80, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:05:00Z' }])
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Actor-Id')).toBe('role-b-console')
  })

  it('confirms one HTTPS cookie session and starts with its actor and CSRF, never the reviewer key', async () => {
    const sessionBody = reviewerEnvelope()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse({ data: runReceipt }, 202))
    const client = new FinsecApiClient('https://api.test')
    const session = await client.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')
    const registered = await client.startTestRun(runInput, session, 'test-run-start-fixed-key')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [index, [url, init]] of fetchMock.mock.calls.slice(0, 2).entries()) {
      expect(url).toBe('https://api.test/api/v1/reviewer-session')
      expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store' })
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Contract-Reviewer-Key')).toBe(index === 0 ? 'PRIVATE_REVIEWER_KEY_CANARY' : null)
    }
    expect(fetchMock).toHaveBeenLastCalledWith('https://api.test/api/v1/test-runs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(runInput), credentials: 'include', redirect: 'error', cache: 'no-store',
    }))
    expect(registered).toEqual(runReceipt)
    const [, init] = fetchMock.mock.calls[2]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Actor-Id')).toBe('verified-reviewer')
    expect(headers.get('X-CSRF-Token')).toBe('PRIVATE_CSRF_CANARY')
    expect(headers.get('Idempotency-Key')).toBe('test-run-start-fixed-key')
    expect(headers.has('X-Contract-Reviewer-Key')).toBe(false)
    expect(JSON.stringify(fetchMock.mock.calls.map(([url]) => url))).not.toMatch(/PRIVATE_CSRF_CANARY|PRIVATE_REVIEWER_KEY_CANARY/)
  })

  it('cancels a Run with the exact confirmed session and does not retry the POST', async () => {
    const sessionBody = reviewerEnvelope()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse({ data: cancelledRun }))
    const client = new FinsecApiClient('https://api.test', { maxRetries: 3 })
    const session = await client.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')

    await expect(client.cancelTestRun(runId, session, 'test-run-cancel-fixed-key')).resolves.toEqual(cancelledRun)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://api.test/api/v1/test-runs/${runId}:cancel`,
      expect.objectContaining({
        method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
      }),
    )
    const [, init] = fetchMock.mock.calls[2]!
    const headers = new Headers(init?.headers)
    expect(init?.body).toBeUndefined()
    expect(headers.get('X-Actor-Id')).toBe('verified-reviewer')
    expect(headers.get('X-CSRF-Token')).toBe('PRIVATE_CSRF_CANARY')
    expect(headers.get('Idempotency-Key')).toBe('test-run-cancel-fixed-key')
    expect(headers.has('X-Contract-Reviewer-Key')).toBe(false)
  })

  it('does not send a Run when HTTPS, same-client provenance, expiry, or key validation fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const local = new FinsecApiClient('http://api.test')
    await expect(local.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')).rejects.toMatchObject({
      code: 'CONTRACT_SESSION_HTTPS_REQUIRED',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    const sessionBody = reviewerEnvelope()
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionBody)).mockResolvedValueOnce(jsonResponse(sessionBody))
    const client = new FinsecApiClient('https://api.test')
    const session = await client.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')
    const other = new FinsecApiClient('https://api.test')
    await expect(other.startTestRun(runInput, session, 'fixed-key')).rejects.toMatchObject({ kind: 'session' })
    await expect(client.startTestRun(runInput, { ...session }, 'fixed-key')).rejects.toMatchObject({ kind: 'session' })
    await expect(client.startTestRun(runInput, session, 'invalid/key')).rejects.toMatchObject({ kind: 'invalid' })
    const now = vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt * 1000)
    try {
      await expect(client.startTestRun(runInput, session, 'fixed-key')).rejects.toMatchObject({ kind: 'session' })
    } finally { now.mockRestore() }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('turns a reflected-secret 403 into a fixed reconnect error without automatic POST retry', async () => {
    const sessionBody = reviewerEnvelope()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse({ code: 'CONTRACT_AUTH_REQUIRED',
        detail: 'PRIVATE_REVIEWER_KEY_CANARY PRIVATE_CSRF_CANARY' }, 403))
    const client = new FinsecApiClient('https://api.test')
    const session = await client.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')
    let error: unknown
    try { await client.startTestRun(runInput, session, 'fixed-key') } catch (cause) { error = cause }
    expect(error).toBeInstanceOf(RunStartError)
    expect(error).toMatchObject({ kind: 'session', status: 403 })
    expect(String(error)).not.toMatch(/PRIVATE_REVIEWER_KEY_CANARY|PRIVATE_CSRF_CANARY/)
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_REVIEWER_KEY_CANARY|PRIVATE_CSRF_CANARY/)
    await expect(client.startTestRun(runInput, session, 'fixed-key')).rejects.toMatchObject({ kind: 'session' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('holds an ambiguous network outcome for an explicit same-body, same-key retry', async () => {
    const sessionBody = reviewerEnvelope()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      .mockRejectedValueOnce(new TypeError('PRIVATE_CSRF_CANARY network failure'))
      .mockResolvedValueOnce(jsonResponse({ data: runReceipt }, 202))
    const client = new FinsecApiClient('https://api.test', { maxRetries: 3 })
    const session = await client.connectRunReviewerSession('PRIVATE_REVIEWER_KEY_CANARY')
    let error: unknown
    try { await client.startTestRun(runInput, session, 'fixed-key') } catch (cause) { error = cause }
    expect(error).toMatchObject({ kind: 'unknown', status: null })
    expect(String(error)).not.toContain('PRIVATE_CSRF_CANARY')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await expect(client.startTestRun(runInput, session, 'fixed-key')).resolves.toEqual(runReceipt)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const first = fetchMock.mock.calls[2]![1], retry = fetchMock.mock.calls[3]![1]
    expect(first?.body).toBe(retry?.body)
    expect(new Headers(first?.headers).get('Idempotency-Key'))
      .toBe(new Headers(retry?.headers).get('Idempotency-Key'))
  })

  it('loads every event through the first history head while a live Run advances', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => historyEvent(index + 1))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: firstPage, headSequence: 1003, nextCursor: 1000,
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: [historyEvent(1001), historyEvent(1002), historyEvent(1003), historyEvent(1004)],
        headSequence: 1004, nextCursor: null,
      } }))
    const client = new FinsecApiClient('http://api.test')

    const snapshot = await client.eventHistory('run-1', 'role-a-console')

    expect(snapshot.headSequence).toBe(1003)
    expect(snapshot.nextCursor).toBeNull()
    expect(snapshot.items).toHaveLength(1003)
    expect(snapshot.items.map((event) => event.sequence)).toEqual(
      Array.from({ length: 1003 }, (_, index) => index + 1),
    )
    expect(snapshot.items.at(-1)?.eventId).toBe('event-1003')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://api.test/api/v1/test-runs/run-1/event-history?after=0&limit=1000',
      'http://api.test/api/v1/test-runs/run-1/event-history?after=1000&limit=1000',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe('role-a-console')
    }
  })

  it('loads a complete contiguous catch-up after a nonzero Run cursor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: Array.from({ length: 1000 }, (_, index) => historyEvent(index + 1001)),
        headSequence: 2002, nextCursor: 2000,
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: [historyEvent(2001), historyEvent(2002)],
        headSequence: 2002, nextCursor: null,
      } }))
    const client = new FinsecApiClient('http://api.test')

    const caughtUp = await client.eventHistory('run-1', 'role-a-console', 1000)

    expect(caughtUp.headSequence).toBe(2002)
    expect(caughtUp.items).toHaveLength(1002)
    expect(caughtUp.items[0]?.sequence).toBe(1001)
    expect(caughtUp.items.at(-1)?.sequence).toBe(2002)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://api.test/api/v1/test-runs/run-1/event-history?after=1000&limit=1000',
      'http://api.test/api/v1/test-runs/run-1/event-history?after=2000&limit=1000',
    ])
  })

  it('accepts an empty catch-up at the current head and rejects invalid local cursors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: {
      items: [], headSequence: 10, nextCursor: null,
    } }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.eventHistory('run-1', 'role-a-console', 10)).resolves.toEqual({
      items: [], headSequence: 10, nextCursor: null,
    })
    await expect(client.eventHistory('run-1', 'role-a-console', -1)).rejects.toThrow(/cursor/)
    await expect(client.eventHistory('run-1', 'role-a-console', 1.5)).rejects.toThrow(/cursor/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns an empty event snapshot for an empty Run', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: {
      items: [], headSequence: 0, nextCursor: null,
    } }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.eventHistory('run-1', 'role-a-console')).resolves.toEqual({
      items: [], headSequence: 0, nextCursor: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sequence gap', { items: [historyEvent(2)], headSequence: 2, nextCursor: null }],
    ['terminal page before head', { items: [historyEvent(1)], headSequence: 2, nextCursor: null }],
    ['foreign Run', { items: [historyEvent(1, 'other-run')], headSequence: 1, nextCursor: null }],
    ['duplicate event ID', { items: [historyEvent(1), { ...historyEvent(2), eventId: 'event-1' }], headSequence: 2, nextCursor: null }],
    ['stalled cursor', { items: Array.from({ length: 1000 }, (_, index) => historyEvent(index + 1)), headSequence: 1001, nextCursor: 999 }],
  ])('rejects an invalid history %s', async (_case, page) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: page }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.eventHistory('run-1', 'role-a-console')).rejects.toThrow(/Event history/)
  })

  it('rejects a missing later history page instead of returning a partial snapshot', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: Array.from({ length: 1000 }, (_, index) => historyEvent(index + 1)),
        headSequence: 1001, nextCursor: 1000,
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        items: [], headSequence: 1001, nextCursor: null,
      } }))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.eventHistory('run-1', 'role-a-console')).rejects.toThrow(/incomplete/)
  })

  it('preserves 410 STREAM_CURSOR_EXPIRED without retrying the expired cursor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      status: 410, code: 'STREAM_CURSOR_EXPIRED', title: 'Gone', retryable: true,
    }, 410))
    const client = new FinsecApiClient('http://api.test')

    await expect(client.eventHistory('run-1', 'role-a-console')).rejects.toMatchObject({
      name: 'FinsecApiError', status: 410, code: 'STREAM_CURSOR_EXPIRED', retryable: true,
    } satisfies Partial<FinsecApiError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lists replay comparisons for a release', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: {
        items: [{
          baselineRunId: 'baseline-1',
          replayRunId: 'replay-1',
          category: 'FA-04',
          comparable: false,
          mismatchReasons: ['POLICY_VERSION_MISMATCH'],
        }],
      },
      traceId: 'trace-replay',
      timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    const comparisons = await client.listReplayComparisons('release-1', 'role-d-console')

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/releases/release-1/replay-comparisons', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    expect(comparisons).toEqual([{ baselineRunId: 'baseline-1', replayRunId: 'replay-1', category: 'FA-04', comparable: false, mismatchReasons: ['POLICY_VERSION_MISMATCH'] }])
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Actor-Id')).toBe('role-d-console')
  })

  it('retries network failures before succeeding', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('temporary network issue'))
      .mockResolvedValue(jsonResponse({
        data: [{
          id: 'agent-id',
          agentKey: 'loan-agent',
          name: 'Loan Agent',
          purposeSummary: 'Review',
          status: 'ACTIVE',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        }],
        traceId: 'trace-id',
        timestamp: '2026-09-01T00:00:00Z',
      }))
    const client = new FinsecApiClient('http://api.test', { maxRetries: 1, retryDelayMs: 0 })

    await expect(client.listAgents('role-a-console')).resolves.toEqual([{
      id: 'agent-id',
      agentKey: 'loan-agent',
      name: 'Loan Agent',
      purposeSummary: 'Review',
      status: 'ACTIVE',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('wraps timeouts as a retryable FinsecApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    const client = new FinsecApiClient('http://api.test', { timeoutMs: 1, maxRetries: 0, retryDelayMs: 0 })

    await expect(client.fingerprint('release-id', 'role-a-console')).rejects.toMatchObject({
      name: 'FinsecApiError',
      status: 408,
      code: 'REQUEST_TIMEOUT',
      retryable: true,
    } satisfies Partial<FinsecApiError>)
  })
})
