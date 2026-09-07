export type ContractVersionState = 'CANDIDATE' | 'VALIDATED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED'
export type ContractValidationStatus = 'VALID' | 'INVALID' | 'WARN'
export type ContractIssueSeverity = 'ERROR' | 'WARNING'
export type ContractChangeKind = 'ADDED' | 'REMOVED' | 'MODIFIED'

export interface ContractVersionIdentity {
  readonly versionId: string
  readonly workspaceId: string
  readonly releaseId: string
  readonly contractKey: string
  readonly version: number
}

export interface ContractVersionSummary {
  readonly identity: ContractVersionIdentity
  readonly state: ContractVersionState
  readonly policyHash: string
  readonly resourceHash: string
}

export interface ContractBaseline {
  readonly identity: ContractVersionIdentity
  readonly policyHash: string
}

export interface ContractIssue {
  readonly jsonPointer: string
  readonly code: string
  readonly severity: ContractIssueSeverity
  readonly message: string
}

export interface ContractValidation {
  readonly status: ContractValidationStatus
  readonly issues: readonly ContractIssue[]
}

export interface ContractReviewMetadata {
  readonly actorId: string
  readonly role: string
  readonly comment: string
  readonly decision: string
}

export interface ContractChange {
  readonly pointer: string
  readonly kind: ContractChangeKind
  readonly beforeJson: string | null
  readonly afterJson: string | null
}

export interface StoredContractReview extends ContractVersionSummary {
  readonly storedPolicyJson: string
  readonly canonicalPolicyJson: string
  readonly baseline: ContractBaseline | null
  readonly validation: ContractValidation | null
  readonly review: ContractReviewMetadata | null
  readonly changes: readonly ContractChange[]
}

export interface ContractProblem {
  readonly code: string
  readonly traceId?: string
  readonly retryable: boolean
}

export class ContractWireError extends Error {
  constructor() {
    super('Contract response or request identity is invalid')
    this.name = 'ContractWireError'
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hashPattern = /^sha256:[0-9a-f]{64}$/
const states = ['CANDIDATE', 'VALIDATED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const
const validationStatuses = ['VALID', 'INVALID', 'WARN'] as const
const severities = ['ERROR', 'WARNING'] as const
const changeKinds = ['ADDED', 'REMOVED', 'MODIFIED'] as const
const problemCodes = new Set([
  'RESOURCE_NOT_FOUND', 'RESOURCE_CONFLICT', 'MANIFEST_INVALID', 'RELEASE_CHANGED',
  'INVALID_STATE_TRANSITION', 'EVIDENCE_INCOMPLETE', 'SECRET_DETECTED', 'STREAM_CURSOR_EXPIRED',
  'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'OPERATOR_AUTH_REQUIRED',
  'CONFIGURATION_ERROR', 'VALIDATION_ERROR', 'INTERNAL_ERROR', 'CONTRACT_AUTH_REQUIRED',
  'CONTRACT_REVIEW_INVALID_REQUEST', 'CONTRACT_REVIEW_UNSAFE_TRANSACTION',
  'CONTRACT_REVIEW_STORED_VERSION_INVALID', 'CONTRACT_REVIEW_BASELINE_UNAVAILABLE',
  'CONTRACT_REVIEW_UNAVAILABLE',
])

function invalid(): never { throw new ContractWireError() }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function field(value: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
  return descriptor.value
}

function string(value: unknown): string {
  if (typeof value !== 'string') invalid()
  return value
}

function nonblank(value: unknown): string {
  const result = string(value)
  if (result.trim().length === 0) invalid()
  return result
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid()
  return value
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid()
  return value as T
}

export function readContractUuid(value: unknown): string {
  const result = string(value)
  if (result.length !== 36 || !uuidPattern.test(result)) invalid()
  return result.toLowerCase()
}

export function readContractHash(value: unknown): string {
  const result = string(value)
  if (result.length !== 71 || !hashPattern.test(result)) invalid()
  return result
}

export function readContractIdentity(value: unknown): ContractVersionIdentity {
  const source = record(value)
  const contractKey = nonblank(field(source, 'contractKey'))
  const version = field(source, 'version')
  if (contractKey.length > 100 || typeof version !== 'number'
      || !Number.isInteger(version) || version < 1 || version > 2147483647) invalid()
  return Object.freeze({
    versionId: readContractUuid(field(source, 'versionId')),
    workspaceId: readContractUuid(field(source, 'workspaceId')),
    releaseId: readContractUuid(field(source, 'releaseId')),
    contractKey,
    version,
  })
}

function envelopeData(value: unknown): unknown {
  const envelope = record(value)
  nonblank(field(envelope, 'traceId'))
  nonblank(field(envelope, 'timestamp'))
  return field(envelope, 'data')
}

function summary(source: Record<string, unknown>, identity: ContractVersionIdentity): ContractVersionSummary {
  return Object.freeze({
    identity,
    state: enumeration(field(source, 'state'), states),
    policyHash: readContractHash(field(source, 'policyHash')),
    resourceHash: readContractHash(field(source, 'resourceHash')),
  })
}

function versionSummary(value: unknown): ContractVersionSummary {
  const source = record(value)
  // A's platform Version uses a flat id; its policy and private evidence are deliberately not copied.
  const identity = readContractIdentity({
    versionId: field(source, 'id'),
    workspaceId: field(source, 'workspaceId'),
    releaseId: field(source, 'releaseId'),
    contractKey: field(source, 'contractKey'),
    version: field(source, 'version'),
  })
  return summary(source, identity)
}

function requireIdentity(actual: ContractVersionIdentity, expected: ContractVersionIdentity): void {
  if (actual.versionId !== expected.versionId || actual.workspaceId !== expected.workspaceId
      || actual.releaseId !== expected.releaseId || actual.contractKey !== expected.contractKey
      || actual.version !== expected.version) invalid()
}

export function readContractListResponse(value: unknown, requestedReleaseId: string): readonly ContractVersionSummary[] {
  const releaseId = readContractUuid(requestedReleaseId)
  const versions = array(envelopeData(value)).map(versionSummary)
  const seen = new Set<string>()
  const workspace = versions[0]?.identity.workspaceId
  for (const version of versions) {
    if (version.identity.releaseId !== releaseId || version.identity.workspaceId !== workspace
        || seen.has(version.identity.versionId)) invalid()
    seen.add(version.identity.versionId)
  }
  return Object.freeze(versions)
}

export function readContractVersionResponse(value: unknown, expectedIdentity: ContractVersionIdentity): ContractVersionSummary {
  const expected = readContractIdentity(expectedIdentity)
  const result = versionSummary(envelopeData(value))
  requireIdentity(result.identity, expected)
  return result
}

function pointer(value: unknown): string {
  const result = string(value)
  if (result !== '' && !/^\/(?:[^~]|~[01])*$/.test(result)) invalid()
  return result
}

function validation(value: unknown): ContractValidation | null {
  if (value === null) return null
  const source = record(value)
  const status = enumeration(field(source, 'status'), validationStatuses)
  const issues = array(field(source, 'issues')).map(value => {
    const issue = record(value)
    return Object.freeze({
      jsonPointer: pointer(field(issue, 'jsonPointer')),
      code: string(field(issue, 'code')),
      severity: enumeration(field(issue, 'severity'), severities),
      message: string(field(issue, 'message')),
    })
  })
  const derived = issues.some(issue => issue.severity === 'ERROR') ? 'INVALID'
    : issues.some(issue => issue.severity === 'WARNING') ? 'WARN' : 'VALID'
  if (status !== derived) invalid()
  return Object.freeze({ status, issues: Object.freeze(issues) })
}

function reviewMetadata(value: unknown): ContractReviewMetadata | null {
  if (value === null) return null
  const source = record(value)
  return Object.freeze({
    actorId: string(field(source, 'actorId')),
    role: string(field(source, 'role')),
    comment: string(field(source, 'comment')),
    decision: string(field(source, 'decision')),
  })
}

function baseline(value: unknown, target: ContractVersionIdentity): ContractBaseline | null {
  if (value === null) return null
  const source = record(value)
  const identity = readContractIdentity(field(source, 'identity'))
  if (identity.versionId === target.versionId || identity.workspaceId !== target.workspaceId
      || identity.releaseId !== target.releaseId) invalid()
  return Object.freeze({ identity, policyHash: readContractHash(field(source, 'policyHash')) })
}

function change(value: unknown): ContractChange {
  const source = record(value)
  const kind = enumeration(field(source, 'kind'), changeKinds)
  const before = field(source, 'beforeJson')
  const after = field(source, 'afterJson')
  const beforeJson = before === null ? null : nonblank(before)
  const afterJson = after === null ? null : nonblank(after)
  if ((kind === 'ADDED' && (beforeJson !== null || afterJson === null))
      || (kind === 'REMOVED' && (beforeJson === null || afterJson !== null))
      || (kind === 'MODIFIED' && (beforeJson === null || afterJson === null))) invalid()
  return Object.freeze({ pointer: pointer(field(source, 'pointer')), kind, beforeJson, afterJson })
}

export function readStoredContractReviewResponse(value: unknown, expectedIdentity: ContractVersionIdentity): StoredContractReview {
  const expected = readContractIdentity(expectedIdentity)
  const source = record(envelopeData(value))
  const identity = readContractIdentity(field(source, 'identity'))
  requireIdentity(identity, expected)
  return Object.freeze({
    ...summary(source, identity),
    storedPolicyJson: nonblank(field(source, 'storedPolicyJson')),
    canonicalPolicyJson: nonblank(field(source, 'canonicalPolicyJson')),
    baseline: baseline(field(source, 'baseline'), identity),
    validation: validation(field(source, 'validation')),
    review: reviewMetadata(field(source, 'review')),
    changes: Object.freeze(array(field(source, 'changes')).map(change)),
  })
}

export function readContractProblem(value: unknown, httpStatus: number): ContractProblem {
  const fallback = Object.freeze({ code: 'UNKNOWN_ERROR', retryable: false })
  if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) return fallback
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  const source = value as Record<string, unknown>
  const own = (name: string): unknown => Object.getOwnPropertyDescriptor(source, name)?.value
  if (Object.hasOwn(source, 'status') && own('status') !== httpStatus) return fallback
  const code = own('code')
  if (typeof code !== 'string' || !problemCodes.has(code)) return fallback
  const trace = own('traceId')
  const traceId = typeof trace === 'string' && trace.length === 36 && uuidPattern.test(trace)
    ? trace.toLowerCase() : undefined
  return Object.freeze({ code, ...(traceId === undefined ? {} : { traceId }), retryable: own('retryable') === true })
}
