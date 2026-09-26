import { FinsecApiClient, FinsecApiError } from './client'
import type { ExecutionEvent } from './contracts'

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

  it('starts a run with the B execution request contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: {
        runId: 'run-42',
        status: 'QUEUED',
        statusUrl: '/api/v1/test-runs/run-42',
        streamUrl: '/api/v1/test-runs/run-42/events',
      },
      traceId: 'trace-start',
      timestamp: '2026-09-01T00:00:00Z',
    }))
    const client = new FinsecApiClient('http://api.test')

    const registered = await client.startTestRun({
      releaseId: 'release-1',
      suiteId: 'suite-1',
      mode: 'BASELINE',
      contractVersionId: null,
      caseIds: [],
      randomSeed: 42,
    }, 'role-b-console')

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/test-runs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        releaseId: 'release-1',
        suiteId: 'suite-1',
        mode: 'BASELINE',
        contractVersionId: null,
        caseIds: [],
        randomSeed: 42,
      }),
    }))
    expect(registered).toEqual({
      runId: 'run-42',
      status: 'QUEUED',
      statusUrl: '/api/v1/test-runs/run-42',
      streamUrl: '/api/v1/test-runs/run-42/events',
    })
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Actor-Id')).toBe('role-b-console')
    expect(headers.get('Idempotency-Key')).toBe('test-run-start-00000000-0000-4000-8000-000000000001')
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
