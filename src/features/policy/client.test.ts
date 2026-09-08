import { ContractRequestError, ContractReviewClient, prepareContractMutation, prepareInitialGeneration, preparePatchGeneration,
  type ContractAction, type PreparedContractMutation, type PreparedGeneration, type GenerationOperationReference,
  type ProposedPatchOperation } from './client'

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

const operationId = '019903ac-abcd-7000-8000-000000000005'
const findingId = '019903ac-abcd-7000-8000-000000000006'
const proposalId = '019903ac-abcd-7000-8000-000000000007'
const operationUrl = `/api/v1/operations/${operationId}`
const createdAt = '2026-09-08T20:00:00.123456Z'
const startedAt = '2026-09-08T20:00:01Z', finishedAt = '2026-09-08T20:00:02Z'
function generation(kind: 'CONTRACT' | 'PATCH' = 'CONTRACT', status = 'QUEUED', outcome: string | null = null): Record<string, unknown> {
  const candidate = outcome === 'VALID' || outcome === 'WARN' || outcome === 'PROPOSED'
  return { operationId, kind, releaseId: identity.releaseId, status, statusUrl: operationUrl,
    retryable: false, createdAt, startedAt: status === 'QUEUED' ? null : startedAt,
    finishedAt: ['QUEUED', 'RUNNING'].includes(status) ? null : finishedAt,
    outcome, result: status === 'SUCCEEDED' ? { assessment: outcome, issues: [{ code: 'TYPE', message: reviewerKey }],
      ...(candidate ? { contractVersionId: identity.versionId, policyHash, resourceHash } : {}),
      ...(outcome === 'PROPOSED' ? { patchProposalId: proposalId } : {}), private: reviewerKey } : null,
    errorCode: status === 'FAILED' ? 'MODEL_CALL_FAILURE' : status === 'RECOVERY_REQUIRED' ? 'EXECUTION_UNCERTAIN' : null,
    errorStage: status === 'FAILED' ? 'GENERATION' : status === 'RECOVERY_REQUIRED' ? 'WORKER' : null,
    message: reviewerKey, provider: { raw: reviewerKey } }
}
const generationReference = (kind: 'CONTRACT' | 'PATCH' = 'CONTRACT'): GenerationOperationReference => ({ operationId, kind, releaseId: identity.releaseId })
async function loadGeneration(value: Record<string, unknown>, kind: 'CONTRACT' | 'PATCH' = 'CONTRACT') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(value)))
  return client.generationOperation(generationReference(kind), reviewerKey)
}

describe('contract generation operation transport', () => {
  it.each(['CONTRACT', 'PATCH'] as const)('prepares immutable exact %s admission, then reads only its canonical ID', async kind => {
    const base = { ...identity }
    const prepared = kind === 'CONTRACT' ? prepareInitialGeneration(identity.releaseId.toUpperCase()) : preparePatchGeneration(findingId.toUpperCase(), base)
    base.versionId = traceId; base.releaseId = traceId
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope(generation(kind)), 202, { Location: operationUrl }))
      .mockResolvedValueOnce(response(envelope(generation(kind, 'RUNNING'))))
    const signal = new AbortController().signal
    const accepted = await client.submitGeneration(prepared, reviewerKey, signal)
    expect(accepted.status).toBe('QUEUED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await client.generationOperation(accepted, reviewerKey, signal)).status).toBe('RUNNING')
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      kind === 'CONTRACT' ? `https://api.test/api/v1/releases/${identity.releaseId}/contracts:generate`
        : `https://api.test/api/v1/findings/${findingId}/patch-proposals`, `https://api.test${operationUrl}`,
    ])
    expect(prepared.body).toBe(JSON.stringify(kind === 'CONTRACT' ? { templateKey: 'loan-review/1' } : { baseContractVersionId: identity.versionId }))
    expect(Object.isFrozen(prepared)).toBe(true)
    if (prepared.kind === 'PATCH') { expect(prepared.baseIdentity).toEqual(identity); expect(Object.isFrozen(prepared.baseIdentity)).toBe(true) }
    const post = fetchMock.mock.calls[0]![1]!, get = fetchMock.mock.calls[1]![1]!
    expect(post).toMatchObject({ method: 'POST', body: prepared.body, credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
    expect(Object.fromEntries(new Headers(post.headers))).toEqual({ accept: 'application/json', 'content-type': 'application/json',
      'x-contract-reviewer-key': reviewerKey, 'idempotency-key': prepared.idempotencyKey })
    expect(get).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
    expect(get.body).toBeUndefined()
    expect(new Headers(get.headers).has('If-Match')).toBe(false)
    expect(new Headers(get.headers).has('Idempotency-Key')).toBe(false)
    expect(JSON.stringify({ prepared, accepted, client })).not.toContain(reviewerKey)
  })

  it.each(['', '/gateway', 'https://api.test/base/'])('preserves generation base prefix %j and copies the GET reference before await', async base => {
    const target = { ...generationReference() }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(generation())))
    const pending = new ContractReviewClient(base).generationOperation(target, reviewerKey)
    target.operationId = traceId; target.releaseId = traceId; target.kind = 'PATCH'
    expect((await pending).operationId).toBe(operationId)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${base.replace(/\/+$/, '')}${operationUrl}`)
  })

  it.each([
    ['CONTRACT', 'QUEUED', null], ['PATCH', 'RUNNING', null],
    ['CONTRACT', 'SUCCEEDED', 'VALID'], ['CONTRACT', 'SUCCEEDED', 'WARN'], ['CONTRACT', 'SUCCEEDED', 'INVALID'],
    ['PATCH', 'SUCCEEDED', 'PROPOSED'], ['PATCH', 'SUCCEEDED', 'INVALID'], ['PATCH', 'SUCCEEDED', 'NO_CHANGE_NEEDED'],
    ['CONTRACT', 'FAILED', null], ['PATCH', 'RECOVERY_REQUIRED', null],
  ] as const)('reads actual %s %s %s without automatic follow-up work', async (kind, status, outcome) => {
    const value = generation(kind, status, outcome), result = await loadGeneration(value, kind)
    expect(result).toMatchObject({ operationId, kind, status, outcome, releaseId: identity.releaseId, statusUrl: operationUrl })
    expect(Object.isFrozen(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(reviewerKey)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    if (result.status === 'SUCCEEDED') {
      expect(result.result.assessment).toBe(outcome)
      expect(result.result.issues).toEqual([{ code: 'TYPE' }])
      expect(Object.isFrozen(result.result)).toBe(true)
      expect(Object.isFrozen(result.result.issues)).toBe(true)
      expect(Object.isFrozen(result.result.issues[0])).toBe(true)
    }
  })

  it('accepts ADMISSION FAILED before worker start and does not compare server time to the browser clock', async () => {
    const value = { ...generation('CONTRACT', 'FAILED'), startedAt: null, errorStage: 'ADMISSION', errorCode: 'AUTHORITY_EXPIRED',
      createdAt: '2099-09-08T20:00:00Z', finishedAt: '2099-09-08T20:00:01Z' }
    const result = await loadGeneration(value)
    expect(result).toMatchObject({ status: 'FAILED', startedAt: null, errorCode: 'AUTHORITY_EXPIRED', errorStage: 'ADMISSION' })
  })

  it.each([
    ['wrong ID', { operationId: traceId }], ['wrong Release', { releaseId: traceId }], ['wrong kind', { kind: 'PATCH' }],
    ['unknown kind', { kind: 'OTHER' }], ['unknown status', { status: 'CANCELLED' }], ['retryable text', { retryable: 'true' }],
    ['QUEUED start', { startedAt }], ['QUEUED finish', { finishedAt }], ['QUEUED outcome', { outcome: 'VALID' }],
    ['QUEUED result', { result: {} }], ['QUEUED error', { errorCode: 'MODEL_CALL_FAILURE' }], ['QUEUED stage', { errorStage: 'SOURCE' }],
    ['null creation', { createdAt: null }], ['invalid timestamp', { createdAt: 'today' }], ['non-ISO timestamp', { createdAt: '2026-09-08' }],
    ['misplaced candidate', { contractVersionId: identity.versionId }],
  ] as const)('rejects %s without returning a partially interpreted Operation', async (_label, extra) => {
    const error: unknown = await loadGeneration({ ...generation(), ...extra }).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID', outcome: 'unknown' })
  })

  it.each(['startedAt', 'finishedAt', 'outcome', 'result', 'errorCode', 'errorStage', 'retryable', 'createdAt', 'operationId']) (
    'requires own Operation field %s even when nullable', async field => {
      const value = generation(); delete value[field]
      await expect(loadGeneration(value)).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID', outcome: 'unknown' })
    })

  it.each([
    ['RUNNING missing start', 'RUNNING', { startedAt: null }],
    ['RUNNING finished', 'RUNNING', { finishedAt }],
    ['FAILED no finish', 'FAILED', { finishedAt: null }],
    ['FAILED no start outside admission', 'FAILED', { startedAt: null }],
    ['RECOVERY no start', 'RECOVERY_REQUIRED', { startedAt: null }],
    ['RECOVERY result', 'RECOVERY_REQUIRED', { result: {} }],
    ['FAILED unknown stage', 'FAILED', { errorStage: 'FUTURE' }],
    ['FAILED missing code', 'FAILED', { errorCode: null }],
    ['FAILED outcome', 'FAILED', { outcome: 'INVALID' }],
    ['SUCCEEDED no start', 'SUCCEEDED', { startedAt: null }],
    ['SUCCEEDED error', 'SUCCEEDED', { errorCode: 'MODEL_CALL_FAILURE' }],
  ] as const)('rejects %s', async (_label, status, extra) => {
    await expect(loadGeneration({ ...generation('CONTRACT', status, status === 'SUCCEEDED' ? 'VALID' : null), ...extra }))
      .rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID', outcome: 'unknown' })
  })

  it.each([
    ['CONTRACT', 'PROPOSED'], ['CONTRACT', 'NO_CHANGE_NEEDED'], ['PATCH', 'VALID'], ['PATCH', 'WARN'], ['PATCH', 'FUTURE'],
  ] as const)('rejects the impossible kind/outcome %s/%s', async (kind, outcome) => {
    await expect(loadGeneration(generation(kind, 'SUCCEEDED', outcome), kind)).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID' })
  })

  it.each([
    ['mismatched assessment', { assessment: 'WARN' }], ['bad candidate ID', { contractVersionId: reviewerKey }],
    ['bad policy hash', { policyHash: reviewerKey }], ['bad resource hash', { resourceHash: null }],
    ['forbidden patch ID', { patchProposalId: proposalId }], ['null issues', { issues: null }], ['wrong issue code', { issues: [{ code: null }] }],
  ] as const)('rejects successful candidate %s', async (_label, extra) => {
    const value = generation('CONTRACT', 'SUCCEEDED', 'VALID')
    value.result = { ...(value.result as object), ...extra }
    await expect(loadGeneration(value)).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID' })
  })

  it.each(['contractVersionId', 'policyHash', 'resourceHash', 'patchProposalId'])('rejects even null %s on a no-candidate result', async field => {
    const value = generation('PATCH', 'SUCCEEDED', 'NO_CHANGE_NEEDED')
    value.result = { ...(value.result as object), [field]: null }
    await expect(loadGeneration(value, 'PATCH')).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID' })
  })

  it.each(['contractVersionId', 'policyHash', 'resourceHash', 'patchProposalId'])('requires proposed patch %s', async field => {
    const value = generation('PATCH', 'SUCCEEDED', 'PROPOSED')
    delete (value.result as Record<string, unknown>)[field]
    await expect(loadGeneration(value, 'PATCH')).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID' })
  })

  it.each([null, '', `https://api.test${operationUrl}`, `https://foreign.test${operationUrl}`, `${operationUrl}?key=x`,
    `${operationUrl}#fragment`, `${operationUrl}/`, `/api/v1/operations/${traceId}`])('rejects noncanonical Location %j without following it', async location => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(generation()), 202,
      location === null ? {} : { Location: location }))
    await expect(client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey))
      .rejects.toMatchObject({ outcome: 'unknown', code: 'CONTRACT_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([null, '', `https://foreign.test${operationUrl}`, `${operationUrl}?key=x`, `/api/v1/operations/${traceId}`]) (
    'rejects noncanonical body statusUrl %j', async statusUrl => {
      await expect(loadGeneration({ ...generation(), statusUrl })).rejects.toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID' })
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    })

  it.each([200, 201, 204])('does not accept POST HTTP %i as generation admission', async status => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(status === 204 ? new Response(null, { status })
      : response(envelope(generation()), status, { Location: operationUrl }))
    await expect(client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('requires GET 200 and treats 202 as admission only, never a terminal snapshot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope(generation()), 202, { Location: operationUrl }))
      .mockResolvedValueOnce(response(envelope(generation('CONTRACT', 'SUCCEEDED', 'VALID')), 202, { Location: operationUrl }))
    await expect(client.generationOperation(generationReference(), reviewerKey)).rejects.toMatchObject({ outcome: 'unknown' })
    await expect(client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([{ releaseId: traceId }, { kind: 'PATCH' }])('binds accepted 202 to its prepared scope: %j', async extra => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope({ ...generation(), ...extra }), 202, { Location: operationUrl }))
    await expect(client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey))
      .rejects.toMatchObject({ outcome: 'unknown', code: 'CONTRACT_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not read inherited or accessor-backed Operation fields', async () => {
    const value = generation()
    delete value.status
    Object.setPrototypeOf(value, { status: 'QUEUED' })
    const getter = vi.fn(() => reviewerKey)
    const accessor = generation(); Object.defineProperty(accessor, 'status', { get: getter })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const data of [value, accessor]) {
      fetchMock.mockResolvedValueOnce({ status: 200, ok: true, json: async () => envelope(data) } as Response)
      const error: unknown = await client.generationOperation(generationReference(), reviewerKey).catch(error => error)
      assertSafeError(error)
      expect(error).toMatchObject({ code: 'CONTRACT_RESPONSE_INVALID', outcome: 'unknown' })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('retains recognized machine codes and replaces uppercase code-shaped canaries without raw message or metadata', async () => {
    const bad = generation('CONTRACT', 'FAILED'); bad.errorCode = reviewerKey
    const failed = await loadGeneration(bad)
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'UNKNOWN_ERROR' })
    const success = generation('PATCH', 'SUCCEEDED', 'INVALID')
    success.result = { assessment: 'INVALID', issues: [{ code: 'PATCH_INVALID', message: reviewerKey },
      { code: reviewerKey, jsonPointer: reviewerKey }, { code: '<script>raw</script>', message: reviewerKey }] }
    const result = await loadGeneration(success, 'PATCH')
    expect(result).toMatchObject({ result: { issues: [{ code: 'PATCH_INVALID' }, { code: 'VALIDATION_ISSUE' }, { code: 'VALIDATION_ISSUE' }] } })
    expect(JSON.stringify({ failed, result })).not.toMatch(new RegExp(`${reviewerKey}|script|message|jsonPointer|provider`))
  })

  it('copies and freezes nested Operation results from mutable transport objects', async () => {
    const value = generation('PATCH', 'SUCCEEDED', 'PROPOSED')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, ok: true,
      json: async () => envelope(value) } as Response)
    const result = await client.generationOperation(generationReference('PATCH'), reviewerKey)
    const original = JSON.stringify(result), raw = value.result as Record<string, unknown>
    raw.contractVersionId = traceId; raw.patchProposalId = traceId; value.releaseId = traceId
    ;(raw.issues as Record<string, unknown>[])[0]!.code = reviewerKey
    expect(JSON.stringify(result)).toBe(original)
    if (result.status !== 'SUCCEEDED') throw new Error('Expected success')
    expect(Object.isFrozen(result.result)).toBe(true)
    expect(Object.isFrozen(result.result.issues)).toBe(true)
    expect(Object.isFrozen(result.result.issues[0])).toBe(true)
  })

  it('rejects invalid or forged generation inputs before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch'), prepared = prepareInitialGeneration(identity.releaseId)
    const badCalls = [
      () => prepareInitialGeneration('../release'), () => preparePatchGeneration('../finding', identity),
      () => preparePatchGeneration(findingId, { ...identity, version: 0 }),
      () => preparePatchGeneration(findingId, { ...identity, workspaceId: 'wrong' }),
      () => client.submitGeneration({ ...prepared } as PreparedGeneration, reviewerKey),
      () => client.submitGeneration(Object.freeze(Object.create(Object.getPrototypeOf(prepared))) as PreparedGeneration, reviewerKey),
      () => client.generationOperation({ ...generationReference(), operationId: '../operation' }, reviewerKey),
      () => client.generationOperation({ ...generationReference(), kind: 'OTHER' } as unknown as GenerationOperationReference, reviewerKey),
    ]
    for (const call of badCalls) expect(call).toThrow(ContractRequestError)
    await expect(client.submitGeneration(prepared, '')).rejects.toMatchObject({ outcome: 'not_sent' })
    await expect(client.generationOperation(generationReference(), `${reviewerKey}\nInjected`)).rejects.toMatchObject({ outcome: 'not_sent' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['lost 202', () => Promise.reject(new Error(reviewerKey)), 'unknown'],
    ['503', () => Promise.resolve(response({ code: reviewerKey, detail: reviewerKey }, 503)), 'unknown'],
    ['malformed 202', () => Promise.resolve(response({ message: reviewerKey }, 202)), 'unknown'],
    ['409 admission ambiguity', () => Promise.resolve(response({ status: 409, code: 'IDEMPOTENCY_CONFLICT' }, 409)), 'unknown'],
    ['definitive 403', () => Promise.resolve(response({ status: 403, code: 'CONTRACT_AUTH_REQUIRED' }, 403)), 'rejected'],
  ] as const)('performs no automatic retry for %s and exposes no raw failure', async (_label, fetch, outcome) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch)
    const error: unknown = await client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ outcome })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an aborted generation wait unknown and retryable true on GET is never another POST', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      controller.abort(); throw new DOMException(reviewerKey, 'AbortError')
    }).mockResolvedValueOnce(response(envelope({ ...generation('PATCH', 'RECOVERY_REQUIRED'), retryable: true })))
    const error: unknown = await client.submitGeneration(prepareInitialGeneration(identity.releaseId), reviewerKey, controller.signal).catch(error => error)
    assertSafeError(error)
    expect(error).toMatchObject({ code: 'REQUEST_ABORTED', outcome: 'unknown', retryable: false })
    expect((await client.generationOperation(generationReference('PATCH'), reviewerKey)).retryable).toBe(true)
    expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'GET'])
  })

  it('binds explicit patch approval to the generated version and policy while using the current review hash', async () => {
    const patch = await loadGeneration(generation('PATCH', 'SUCCEEDED', 'PROPOSED'), 'PATCH')
    if (patch.kind !== 'PATCH' || patch.status !== 'SUCCEEDED' || patch.outcome !== 'PROPOSED') throw new Error('Expected proposed patch')
    const input = { identity: { ...identity }, policyHash, resourceHash: changedHash }
    const prepared = prepareContractMutation('approve', input, '패치 검토 완료', patch)
    input.identity.versionId = traceId; input.resourceHash = resourceHash
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(response(envelope(version({ state: 'APPROVED', resourceHash: changedHash }))))
    await client.executeMutation(prepared, reviewerKey)
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[1]!
    expect(prepared.body).toBe(JSON.stringify({ comment: '패치 검토 완료', patchProposalId: proposalId }))
    expect(init?.body).toBe(prepared.body)
    expect(new Headers(init?.headers).get('If-Match')).toBe(`"${changedHash}"`)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(prepareContractMutation('validate', { identity, resourceHash }).body).toBe('{}')
    expect(prepareContractMutation('reject', { identity, resourceHash }, '거절').body).toBe('{"comment":"거절"}')
    expect(prepareContractMutation('approve', { identity, resourceHash }, '일반 승인').body).toBe('{"comment":"일반 승인"}')
  })

  it.each(['release', 'version', 'policy', 'proposal', 'outcome', 'action'])('rejects mismatched patch approval %s before fetch', mismatch => {
    const patch = generation('PATCH', 'SUCCEEDED', 'PROPOSED')
    const result = patch.result as Record<string, unknown>
    if (mismatch === 'release') patch.releaseId = traceId
    if (mismatch === 'version') result.contractVersionId = traceId
    if (mismatch === 'policy') result.policyHash = changedHash
    if (mismatch === 'proposal') result.patchProposalId = reviewerKey
    if (mismatch === 'outcome') patch.outcome = 'INVALID'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const prepare = prepareContractMutation as (action: ContractAction, target: { identity: typeof identity; resourceHash: string; policyHash: string }, comment: string, proposal: ProposedPatchOperation) => PreparedContractMutation
    expect(() => prepare(mismatch === 'action' ? 'reject' : 'approve', { identity, resourceHash, policyHash }, '확인', patch as unknown as ProposedPatchOperation)).toThrow(ContractRequestError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
