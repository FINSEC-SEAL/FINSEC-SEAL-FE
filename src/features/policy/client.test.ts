import { ContractRequestError, ContractReviewClient, prepareContractMutation, type ContractAction, type PreparedContractMutation } from './client'

const identity = {
  versionId: '019903ac-abcd-7000-8000-000000000003',
  workspaceId: '019903ac-abcd-7000-8000-000000000001',
  releaseId: '019903ac-abcd-7000-8000-000000000002',
  contractKey: 'loan-review', version: 7,
}
const traceId = '019903ac-abcd-7000-8000-000000000004'
const policyHash = `sha256:${'a'.repeat(64)}`
const resourceHash = `sha256:${'b'.repeat(64)}`
const changedHash = `sha256:${'c'.repeat(64)}`
const reviewerKey = 'SYNTHETIC_REVIEWER_KEY_CANARY_0123456789'
const client = new ContractReviewClient('https://api.test/')

function envelope(data: unknown) {
  return { data, traceId, timestamp: '2026-09-07T05:00:00Z' }
}

function version(overrides: Record<string, unknown> = {}) {
  return { id: identity.versionId, workspaceId: identity.workspaceId, releaseId: identity.releaseId,
    contractKey: identity.contractKey, version: identity.version, state: 'VALIDATED', policyHash, resourceHash,
    policy: { private: reviewerKey }, validation: {}, review: {}, ...overrides }
}

function review(overrides: Record<string, unknown> = {}) {
  return { identity: { ...identity }, state: 'CANDIDATE', policyHash, resourceHash,
    storedPolicyJson: '{ "version": 7 }', canonicalPolicyJson: '{"version":7}',
    baseline: null, validation: null, review: null,
    changes: [{ pointer: '', kind: 'ADDED', beforeJson: null, afterJson: '{"version":7}' }], ...overrides }
}

function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function operation(action: ContractAction = 'validate') {
  return prepareContractMutation(action, { identity, resourceHash }, action === 'validate' ? undefined : '정책 변경 검토')
}

function assertSafeError(error: unknown) {
  expect(error).toBeInstanceOf(ContractRequestError)
  expect(error).not.toHaveProperty('cause')
  expect(String(error)).not.toContain(reviewerKey)
  expect(JSON.stringify(error)).not.toContain(reviewerKey)
}

describe('stored contract review transport', () => {
  it('binds list and review to the selected release/identity with per-call credentials only', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope([version()])))
      .mockResolvedValueOnce(response(envelope(review()), 200, { ETag: '"unrelated-etag"' }))
    const signal = new AbortController().signal
    const listed = await client.listVersions(identity.releaseId.toUpperCase(), reviewerKey, signal)
    const loaded = await client.review(listed[0]!.identity, reviewerKey, signal)
    expect(listed[0]!.identity).toEqual(identity)
    expect(loaded.resourceHash).toBe(resourceHash)
    expect(prepareContractMutation('validate', loaded).ifMatch).toBe(`"${resourceHash}"`)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `https://api.test/api/v1/platform/contracts?releaseId=${identity.releaseId}`,
      `https://api.test/api/v1/platform/contracts/${identity.versionId}/review`,
    ])
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).not.toContain(reviewerKey)
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
      expect(init?.body).toBeUndefined()
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ accept: 'application/json', 'x-contract-reviewer-key': reviewerKey })
    }
  })

  it('copies the selected target before waiting for the response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(review())))
    const selected = { ...identity }
    const pending = client.review(selected, reviewerKey)
    selected.versionId = traceId
    selected.releaseId = traceId
    expect((await pending).identity).toEqual(identity)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['', '/gateway', 'https://api.test/base/'])('supports the configured API base %j', async base => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope([])))
    await new ContractReviewClient(base).listVersions(identity.releaseId, reviewerKey)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${base.replace(/\/+$/, '')}/api/v1/platform/contracts?releaseId=${identity.releaseId}`)
  })

  it('sends exact approval bytes and the body resource hash while freezing the operation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(version({ state: 'APPROVED', resourceHash: changedHash }))))
    const input = { identity: { ...identity }, resourceHash }
    const comment = '검토\r\n"승인" \\ 변경'
    const prepared = prepareContractMutation('approve', input, comment)
    input.identity.versionId = traceId
    input.resourceHash = changedHash
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.identity)).toBe(true)
    const result = await client.executeMutation(prepared, reviewerKey)
    expect(result.state).toBe('APPROVED')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.test/api/v1/platform/contracts/${identity.versionId}:approve`)
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ comment }), credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      accept: 'application/json', 'x-contract-reviewer-key': reviewerKey,
      'content-type': 'application/json', 'if-match': `"${resourceHash}"`, 'idempotency-key': prepared.idempotencyKey,
    })
    expect(prepared.identity).toEqual(identity)
    expect(JSON.stringify(prepared)).not.toContain(reviewerKey)
  })

  it('never automatically retries an unknown result and preserves the exact operation for explicit retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError(reviewerKey))
      .mockResolvedValueOnce(response(envelope(version({ state: 'REJECTED', resourceHash: changedHash }))))
    const prepared = operation('reject')
    const error: unknown = await client.executeMutation(prepared, reviewerKey).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ status: null, code: 'NETWORK_ERROR', outcome: 'unknown', retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await client.executeMutation(prepared, reviewerKey)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchMock.mock.calls[0]!
    const second = fetchMock.mock.calls[1]!
    expect(second[0]).toBe(first[0])
    expect(second[1]?.body).toBe(first[1]?.body)
    expect(Object.fromEntries(new Headers(second[1]?.headers))).toEqual(Object.fromEntries(new Headers(first[1]?.headers)))
  })

  it('uses a new key and a freshly fetched resource hash for a separate action after validation', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000011')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000012')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope(version({ resourceHash: changedHash }))))
      .mockResolvedValueOnce(response(envelope(review({ state: 'VALIDATED', resourceHash: changedHash, validation: { status: 'VALID', issues: [] } }))))
      .mockResolvedValueOnce(response(envelope(version({ state: 'APPROVED', resourceHash: changedHash }))))
    const validate = operation()
    await client.executeMutation(validate, reviewerKey)
    const fresh = await client.review(identity, reviewerKey)
    const approve = prepareContractMutation('approve', fresh, '새 검증 결과 검토')
    await client.executeMutation(approve, reviewerKey)
    expect(validate.body).toBe('{}')
    expect(approve.idempotencyKey).not.toBe(validate.idempotencyKey)
    expect(approve.ifMatch).toBe(`"${changedHash}"`)
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('If-Match')).toBe(`"${changedHash}"`)
  })

  it('accepts the actual invalid-validation response remaining CANDIDATE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(version({ state: 'CANDIDATE', resourceHash: changedHash }))))
    expect((await client.executeMutation(operation(), reviewerKey)).state).toBe('CANDIDATE')
  })

  it.each([
    [400, 'VALIDATION_ERROR', false, 'rejected'], [403, 'CONTRACT_AUTH_REQUIRED', false, 'rejected'],
    [403, 'OPERATOR_AUTH_REQUIRED', false, 'rejected'], [404, 'RESOURCE_NOT_FOUND', false, 'rejected'],
    [409, 'RESOURCE_CONFLICT', false, 'rejected'], [409, 'RELEASE_CHANGED', false, 'rejected'],
    [409, 'IDEMPOTENCY_CONFLICT', false, 'unknown'], [409, 'IDEMPOTENCY_IN_PROGRESS', true, 'unknown'],
    [422, 'VALIDATION_ERROR', false, 'rejected'], [503, 'CONTRACT_REVIEW_UNAVAILABLE', true, 'unknown'],
  ] as const)('retains safe HTTP %i %s evidence without exposing server detail', async (status, code, retryable, outcome) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      status, code, traceId, retryable, title: reviewerKey, detail: reviewerKey, errors: [{ message: reviewerKey }],
    }, status))
    const error: unknown = await client.executeMutation(operation(), reviewerKey).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ status, code, traceId, retryable, outcome })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([403, 409, 503])('retains HTTP %i with a safe fallback for an HTML or unknown-code failure', async status => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`<html>${reviewerKey}</html>`, { status }))
      .mockResolvedValueOnce(response({ status, code: reviewerKey, traceId: reviewerKey, detail: reviewerKey }, status))
    for (let attempt = 0; attempt < 2; attempt++) {
      const error: unknown = await client.review(identity, reviewerKey).catch(error => error)
      assertSafeError(error)
      expect(error).toMatchObject({ status, code: 'UNKNOWN_ERROR', traceId: undefined, retryable: false, outcome: status < 500 ? 'rejected' : 'unknown' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    () => new Response('{', { status: 200 }),
    () => response({ traceId, timestamp: 'now' }),
    () => response(envelope(version({ id: traceId }))),
    () => response(envelope(version({ releaseId: traceId }))),
    () => response(envelope(version({ state: 'APPROVED' }))),
    () => new Response(null, { status: 204 }),
  ])('treats malformed or mismatched successful mutation responses as unknown outcomes', async makeResponse => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse())
    const error: unknown = await client.executeMutation(operation(), reviewerKey).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID', outcome: 'unknown', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not equate an aborted response wait with cancellation of the server mutation', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw new DOMException(reviewerKey, 'AbortError')
    })
    const error: unknown = await client.executeMutation(operation('approve'), reviewerKey, controller.signal).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ code: 'REQUEST_ABORTED', outcome: 'unknown', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed local targets, operations, and credentials before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const invalidCalls = [
      () => client.listVersions('../other-release', reviewerKey),
      () => client.review({ ...identity, version: 0 }, reviewerKey),
      () => prepareContractMutation('approve', { identity, resourceHash: 'not-a-hash' }, '승인'),
      () => prepareContractMutation('delete' as ContractAction, { identity, resourceHash }),
      () => prepareContractMutation('approve', { identity, resourceHash }, ''),
      () => prepareContractMutation('reject', { identity, resourceHash }, ' 앞뒤 공백 '),
      () => prepareContractMutation('approve', { identity, resourceHash }, 'x'.repeat(1001)),
      () => client.executeMutation({ ...operation() } as PreparedContractMutation, reviewerKey),
      () => new ContractReviewClient(`https://user:${reviewerKey}@api.test`),
      () => new ContractReviewClient('javascript:alert(1)'),
      () => new ContractReviewClient(`https://api.test?key=${reviewerKey}`),
      () => new ContractReviewClient('https://api.test#fragment'),
    ]
    for (const call of invalidCalls) expect(call).toThrow(ContractRequestError)
    await expect(client.listVersions(identity.releaseId, '')).rejects.toMatchObject({ outcome: 'not_sent', code: 'CONTRACT_REQUEST_INVALID' })
    await expect(client.listVersions(identity.releaseId, `${reviewerKey}\r\nInjected: yes`)).rejects.toMatchObject({ outcome: 'not_sent', code: 'CONTRACT_REQUEST_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never stores credentials or emits them to console on success or failure', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const errorLog = vi.spyOn(console, 'error')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope(review())))
      .mockRejectedValueOnce(new Error(reviewerKey))
    const result = await client.review(identity, reviewerKey)
    const failed: unknown = await client.executeMutation(operation(), reviewerKey).catch(error => error)
    assertSafeError(failed)
    expect(JSON.stringify({ client, result, operation: operation() })).not.toContain(reviewerKey)
    expect(storage).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(reviewerKey)
      expect(init?.body ?? '').not.toContain(reviewerKey)
    }
  })
})
