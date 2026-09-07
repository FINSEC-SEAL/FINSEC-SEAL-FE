import { FinsecApiClient, FinsecApiError } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

    const suites = await client.listTestSuites('release-1', 'role-b-console')

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/releases/release-1/test-suites', expect.objectContaining({
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

