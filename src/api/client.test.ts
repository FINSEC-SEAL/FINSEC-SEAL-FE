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
})

