import {
  ContractWireError,
  readContractHash,
  readContractIdentity,
  readContractListResponse,
  readContractProblem,
  readContractUuid,
  readContractVersionResponse,
  readStoredContractReviewResponse,
} from './wire'

const identity = {
  versionId: '019903ac-abcd-7000-8000-000000000003',
  workspaceId: '019903ac-abcd-7000-8000-000000000001',
  releaseId: '019903ac-abcd-7000-8000-000000000002',
  contractKey: 'loan-review',
  version: 7,
}
const otherId = '019903ac-abcd-7000-8000-000000000004'
const policyHash = `sha256:${'a'.repeat(64)}`
const resourceHash = `sha256:${'b'.repeat(64)}`
const changedHash = `sha256:${'c'.repeat(64)}`
const canary = 'SYNTHETIC_PRIVATE_REVIEWER_CANARY'

function envelope<T>(data: T) {
  return { data, traceId: otherId, timestamp: '2026-09-07T05:00:00.123456789Z' }
}

// Mirrors the existing A platform Version wire shape, not the C review projection.
function platformVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: identity.versionId,
    workspaceId: identity.workspaceId,
    releaseId: identity.releaseId,
    contractKey: identity.contractKey,
    version: identity.version,
    state: 'CANDIDATE', policyHash, resourceHash,
    policy: { contractId: identity.contractKey, version: identity.version, private: canary },
    basePolicyHash: null,
    validation: { privateProof: canary },
    review: { sessionId: canary },
    ...overrides,
  }
}

// C exposes JSON text and limited metadata; baseline is intentionally a different key/version gap.
function storedReview() {
  return {
    identity: { ...identity }, state: 'APPROVED', policyHash, resourceHash,
    storedPolicyJson: '{ "contractId": "loan-review", "version": 7 }',
    canonicalPolicyJson: '{"contractId":"loan-review","version":7}',
    baseline: { identity: { ...identity, versionId: otherId, contractKey: 'earlier-policy', version: 1 }, policyHash: changedHash },
    validation: {
      status: 'WARN',
      issues: [{ jsonPointer: '/purpose', code: 'SYNTHETIC_WARNING', severity: 'WARNING', message: 'Stored warning' }],
    },
    review: { actorId: 'reviewer', role: 'AI_SECURITY_REVIEWER', comment: '검토한 변경', decision: 'APPROVED', sessionId: canary },
    changes: [{ pointer: '/version', kind: 'MODIFIED', beforeJson: '1', afterJson: '7' }],
  }
}

function reviewResponse(overrides: Record<string, unknown> = {}) {
  return envelope({ ...storedReview(), ...overrides })
}

function expectInvalid(action: () => unknown) {
  expect(action).toThrow(ContractWireError)
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ContractWireError)
    expect(String(error)).toBe('ContractWireError: Contract response or request identity is invalid')
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain(canary)
  }
}

describe('contract response projections', () => {
  it('maps A flat ids to selected identities while discarding policy and private evidence', () => {
    const result = readContractListResponse(envelope([
      platformVersion(), platformVersion({ id: otherId, version: 8 }),
    ]), identity.releaseId)
    expect(result).toEqual([
      { identity, state: 'CANDIDATE', policyHash, resourceHash },
      { identity: { ...identity, versionId: otherId, version: 8 }, state: 'CANDIDATE', policyHash, resourceHash },
    ])
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(result[0]).not.toHaveProperty('policy')
    expect(result[0]).not.toHaveProperty('review')
    expect(readContractListResponse(envelope([]), identity.releaseId)).toEqual([])
  })

  it('reads C nested identity and limited metadata with no same-key or adjacent-version requirement', () => {
    const result = readStoredContractReviewResponse(reviewResponse(), identity)
    expect(result.identity).toEqual(identity)
    expect(result.baseline?.identity).toEqual({ ...identity, versionId: otherId, contractKey: 'earlier-policy', version: 1 })
    expect(result.validation).toEqual(storedReview().validation)
    expect(result.review).toEqual({ actorId: 'reviewer', role: 'AI_SECURITY_REVIEWER', comment: '검토한 변경', decision: 'APPROVED' })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(result.changes).toEqual(storedReview().changes)
  })

  it('preserves explicit absent evidence and a root addition even for version seven', () => {
    const result = readStoredContractReviewResponse(reviewResponse({
      baseline: null, validation: null, review: null,
      changes: [{ pointer: '', kind: 'ADDED', beforeJson: null, afterJson: 'null' }],
    }), identity)
    expect(result.baseline).toBeNull()
    expect(result.validation).toBeNull()
    expect(result.review).toBeNull()
    expect(result.changes).toEqual([{ pointer: '', kind: 'ADDED', beforeJson: null, afterJson: 'null' }])
  })

  it.each(['CANDIDATE', 'VALIDATED', 'APPROVED', 'REJECTED', 'SUPERSEDED'])('preserves the actual %s state without inventing approval evidence', state => {
    expect(readContractVersionResponse(envelope(platformVersion({ state })), identity).state).toBe(state)
    expect(readStoredContractReviewResponse(reviewResponse({ state, validation: null, review: null }), identity)).toMatchObject({ state, validation: null, review: null })
  })

  it('accepts changed state and resource hash for the same selected A mutation target', () => {
    expect(readContractVersionResponse(envelope(platformVersion({ state: 'VALIDATED', resourceHash: changedHash })), identity))
      .toEqual({ identity, state: 'VALIDATED', policyHash, resourceHash: changedHash })
    // Semantic INVALID validation may legitimately leave the A version CANDIDATE.
    expect(readContractVersionResponse(envelope(platformVersion({ state: 'CANDIDATE', resourceHash: changedHash })), identity).state).toBe('CANDIDATE')
  })

  it('keeps all policy and diff JSON text exactly without parsing numeric or Unicode content', () => {
    const raw = ' \r\n{"name":"가 café", "line":"one\\r\\ntwo", "quote":"\\\"", "big":9007199254740993, "fraction":1.0000000000000001, "tiny":1e-500}\r\n'
    const canonical = '{"big":9007199254740993,"name":"가 café"}'
    const changes = [
      { pointer: '/a~1b~0c', kind: 'MODIFIED', beforeJson: raw, afterJson: canonical },
      { pointer: '/removed', kind: 'REMOVED', beforeJson: 'null', afterJson: null },
      { pointer: '/added', kind: 'ADDED', beforeJson: null, afterJson: '1.0000000000000001' },
    ]
    const result = readStoredContractReviewResponse(reviewResponse({ storedPolicyJson: raw, canonicalPolicyJson: canonical, changes }), identity)
    expect(result.storedPolicyJson).toBe(raw)
    expect(result.canonicalPolicyJson).toBe(canonical)
    expect(result.changes).toEqual(changes)
    expect(result.changes[0]?.beforeJson).toContain('1e-500')
    expect(result.changes[1]?.beforeJson).toBe('null')
    expect(result.changes[1]?.afterJson).toBeNull()
  })

  it('copies and freezes every exposed nested collection and record', () => {
    const input = storedReview()
    const result = readStoredContractReviewResponse(envelope(input), identity)
    input.identity.contractKey = 'changed'
    input.baseline.identity.contractKey = 'changed'
    input.validation.issues[0]!.message = 'changed'
    input.validation.issues.push({ jsonPointer: '', code: 'changed', severity: 'ERROR', message: 'changed' })
    input.review.comment = 'changed'
    input.changes[0]!.afterJson = '999'
    expect(result.identity.contractKey).toBe('loan-review')
    expect(result.baseline?.identity.contractKey).toBe('earlier-policy')
    expect(result.validation?.issues).toHaveLength(1)
    expect(result.validation?.issues[0]?.message).toBe('Stored warning')
    expect(result.review?.comment).toBe('검토한 변경')
    expect(result.changes[0]?.afterJson).toBe('7')
    for (const value of [result, result.identity, result.baseline, result.baseline?.identity,
      result.validation, result.validation?.issues, result.validation?.issues[0], result.review,
      result.changes, result.changes[0]]) expect(Object.isFrozen(value)).toBe(true)
    expect(Reflect.set(result.identity, 'version', 99)).toBe(false)
    expect(result.identity.version).toBe(7)
    const source = platformVersion()
    const list = readContractListResponse(envelope([source]), identity.releaseId)
    source.contractKey = 'changed'
    expect(list[0]?.identity.contractKey).toBe('loan-review')
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list[0])).toBe(true)
    expect(Object.isFrozen(list[0]?.identity)).toBe(true)
  })
})

describe('contract identity and response rejection', () => {
  it('shares exact metadata validation with client input checks and returns a detached identity', () => {
    const input = { ...identity, contractKey: ' loan-review ', version: 2147483647 }
    const result = readContractIdentity(input)
    input.contractKey = 'changed'
    expect(result.contractKey).toBe(' loan-review ')
    expect(result.version).toBe(2147483647)
    expect(readContractUuid(identity.versionId.toUpperCase())).toBe(identity.versionId)
    expect(readContractHash(resourceHash)).toBe(resourceHash)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([null, undefined, [], '', 'bad-id', 7, `${otherId}/review`, `{${otherId}}`, ` ${otherId}`, `${otherId}\n`]
    .map(value => ({ value })))('rejects malformed UUID input $value', ({ value }) => {
    expectInvalid(() => readContractUuid(value))
  })

  it.each([null, undefined, '', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `"${resourceHash}"`, `${resourceHash}\n`])('rejects malformed digest input %s', value => {
    expectInvalid(() => readContractHash(value))
  })

  it.each([0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, Infinity, NaN, '7', null])('rejects non-positive-int32 metadata version %s', version => {
    expectInvalid(() => readContractIdentity({ ...identity, version }))
  })

  it.each(['', ' \t\n', 'x'.repeat(101), null])('rejects invalid contract keys without repairing them', contractKey => {
    expectInvalid(() => readContractIdentity({ ...identity, contractKey }))
  })

  it.each(['versionId', 'workspaceId', 'releaseId', 'contractKey', 'version'])('binds every selected %s field on both A and C responses', key => {
    const altered = { ...identity, [key]: key === 'version' ? 8 : key === 'contractKey' ? 'other' : otherId }
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse({ identity: altered }), identity))
    const flatKey = key === 'versionId' ? 'id' : key
    expectInvalid(() => readContractVersionResponse(envelope(platformVersion({ [flatKey]: altered[key as keyof typeof altered] })), identity))
  })

  it('rejects mismatched release, mixed workspace and duplicate listed IDs without partial data', () => {
    expectInvalid(() => readContractListResponse(envelope([platformVersion()]), otherId))
    expectInvalid(() => readContractListResponse(envelope([platformVersion(), platformVersion({ id: otherId, workspaceId: otherId })]), identity.releaseId))
    expectInvalid(() => readContractListResponse(envelope([platformVersion(), platformVersion()]), identity.releaseId))
    expectInvalid(() => readContractListResponse(envelope([platformVersion(), platformVersion({ id: otherId, releaseId: otherId })]), identity.releaseId))
  })

  it.each(['identity', 'state', 'policyHash', 'resourceHash', 'storedPolicyJson', 'canonicalPolicyJson', 'baseline', 'validation', 'review', 'changes'])('requires C own field %s rather than treating absence as null', name => {
    const source: Record<string, unknown> = { ...storedReview() }
    delete source[name]
    expectInvalid(() => readStoredContractReviewResponse(envelope(source), identity))
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse({ [name]: undefined }), identity))
  })

  it.each(['id', 'workspaceId', 'releaseId', 'contractKey', 'version', 'state', 'policyHash', 'resourceHash'])('requires A own field %s', name => {
    const source: Record<string, unknown> = platformVersion()
    delete source[name]
    expectInvalid(() => readContractVersionResponse(envelope(source), identity))
  })

  it.each([null, [], {}, { data: [] }, { data: [], traceId: 7, timestamp: 'now' }, { data: [], traceId: otherId, timestamp: null }]
    .map(value => ({ value })))('rejects malformed success envelopes', ({ value }) => {
    expectInvalid(() => readContractListResponse(value, identity.releaseId))
  })

  it('rejects inherited fields and accessors without executing a payload getter', () => {
    expectInvalid(() => readContractIdentity(Object.create(identity)))
    const getter = vi.fn(() => identity.versionId)
    const source = { ...identity }
    Object.defineProperty(source, 'versionId', { get: getter })
    expectInvalid(() => readContractIdentity(source))
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'DRAFT' }, { identity: [] }, { storedPolicyJson: {} }, { canonicalPolicyJson: '' },
    { baseline: [] }, { validation: [] }, { review: [] }, { changes: {} },
    { policyHash: canary }, { resourceHash: null },
  ])('rejects malformed consumed C fields with safe fixed errors', overrides => {
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse(overrides), identity))
  })

  it.each(['versionId', 'workspaceId', 'releaseId'])('rejects a baseline with invalid %s scope', key => {
    const base = storedReview().baseline
    const value = key === 'versionId' ? identity.versionId : otherId
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse({ baseline: { ...base, identity: { ...base.identity, [key]: value } } }), identity))
  })
})

describe('stored validation and diff shape', () => {
  it.each([
    { status: 'VALID', issues: [] },
    { status: 'WARN', issues: [{ jsonPointer: '', code: 'WARNING_CODE', severity: 'WARNING', message: 'Warning' }] },
    { status: 'INVALID', issues: [
      { jsonPointer: '/outputPolicy/allowedFields', code: 'EXCESSIVE_PRIVILEGE', severity: 'ERROR', message: 'Stored violation' },
      { jsonPointer: '/purpose', code: 'WARNING_CODE', severity: 'WARNING', message: 'Warning' },
    ] },
  ])('preserves the stored $status status and issues', validation => {
    expect(readStoredContractReviewResponse(reviewResponse({ validation }), identity).validation).toEqual(validation)
  })

  it.each([
    { status: 'INVALID', issues: [] }, { status: 'WARN', issues: [] }, { status: 'UNKNOWN', issues: [] },
    { status: 'VALID', issues: [{ jsonPointer: '', code: 'X', severity: 'ERROR', message: 'X' }] },
    { status: 'WARN', issues: [{ jsonPointer: '', code: 'X', severity: 'WARN', message: 'X' }] },
    { status: 'INVALID', issues: [{ jsonPointer: '', code: 'X', severity: 'ERROR' }] },
    { status: 'VALID', issues: null },
  ])('rejects inconsistent or malformed validation evidence', validation => {
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse({ validation }), identity))
  })

  it.each([
    { pointer: '', kind: 'ADDED', beforeJson: 'null', afterJson: '{}' },
    { pointer: '', kind: 'ADDED', beforeJson: null, afterJson: null },
    { pointer: '/x', kind: 'REMOVED', beforeJson: '1', afterJson: 'null' },
    { pointer: '/x', kind: 'MODIFIED', beforeJson: null, afterJson: '1' },
    { pointer: '/x', kind: 'MODIFIED', beforeJson: '1', afterJson: null },
    { pointer: '/x', kind: 'ADDED', afterJson: '{}' },
    { pointer: '/x', kind: 'ADD', beforeJson: null, afterJson: '{}' },
    { pointer: '/x', kind: 'ADDED', beforeJson: null, afterJson: {} },
    { pointer: 'x', kind: 'MODIFIED', beforeJson: '1', afterJson: '2' },
    { pointer: '/~2x', kind: 'MODIFIED', beforeJson: '1', afterJson: '2' },
    { pointer: '/x~', kind: 'MODIFIED', beforeJson: '1', afterJson: '2' },
  ])('rejects invalid change pointers, enums or absence sides', change => {
    expectInvalid(() => readStoredContractReviewResponse(reviewResponse({ changes: [change] }), identity))
  })
})

describe('safe contract problem projection', () => {
  it.each([
    [400, 'VALIDATION_ERROR'], [403, 'CONTRACT_AUTH_REQUIRED'], [403, 'OPERATOR_AUTH_REQUIRED'],
    [404, 'RESOURCE_NOT_FOUND'], [409, 'RESOURCE_CONFLICT'], [409, 'RELEASE_CHANGED'],
    [409, 'INVALID_STATE_TRANSITION'], [409, 'EVIDENCE_INCOMPLETE'],
    [409, 'IDEMPOTENCY_CONFLICT'], [409, 'IDEMPOTENCY_IN_PROGRESS'],
    [400, 'CONTRACT_REVIEW_INVALID_REQUEST'], [409, 'CONTRACT_REVIEW_STORED_VERSION_INVALID'],
    [409, 'CONTRACT_REVIEW_BASELINE_UNAVAILABLE'], [503, 'CONTRACT_REVIEW_UNSAFE_TRANSACTION'],
    [503, 'CONTRACT_REVIEW_UNAVAILABLE'], [500, 'INTERNAL_ERROR'], [500, 'CONFIGURATION_ERROR'],
    [422, 'MANIFEST_INVALID'], [422, 'SECRET_DETECTED'], [410, 'STREAM_CURSOR_EXPIRED'],
  ])('preserves real HTTP %i code %s while dropping arbitrary server fields', (status, code) => {
    const input = { status, code, traceId: otherId, retryable: true, detail: canary, title: canary, instance: canary, errors: [canary] }
    const result = readContractProblem(input, status as number)
    expect(result).toEqual({ code, traceId: otherId, retryable: true })
    expect(Object.isFrozen(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(canary)
    input.traceId = identity.versionId
    expect(result.traceId).toBe(otherId)
  })

  it('supports the access filter omission of retryable and drops invalid trace text', () => {
    expect(readContractProblem({ status: 403, code: 'CONTRACT_AUTH_REQUIRED', traceId: otherId }, 403))
      .toEqual({ code: 'CONTRACT_AUTH_REQUIRED', traceId: otherId, retryable: false })
    expect(readContractProblem({ code: 'RESOURCE_CONFLICT', traceId: canary, retryable: 'true' }, 409))
      .toEqual({ code: 'RESOURCE_CONFLICT', retryable: false })
  })

  it.each([null, [], `<html>${canary}</html>`, {}, { code: canary },
    { code: 'CONTRACT_REVIEW_REVIEW_UNAVAILABLE' },
    { code: 'RESOURCE_CONFLICT', status: 200 },
    Object.create({ code: 'RESOURCE_CONFLICT' }),
  ].map(value => ({ value })))('uses a safe fallback for unknown or malformed problems', ({ value }) => {
    const result = readContractProblem(value, 409)
    expect(result).toEqual({ code: 'UNKNOWN_ERROR', retryable: false })
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it('does not treat problem content as a successful HTTP result', () => {
    expect(readContractProblem({ code: 'RESOURCE_CONFLICT' }, 200)).toEqual({ code: 'UNKNOWN_ERROR', retryable: false })
  })
})
