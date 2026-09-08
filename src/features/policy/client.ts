import {
  readContractHash,
  readContractIdentity,
  readContractListResponse,
  readContractProblem,
  readContractUuid,
  readContractVersionResponse,
  readStoredContractReviewResponse,
  type ContractProblem,
  type ContractVersionIdentity,
  type ContractVersionSummary,
  type StoredContractReview,
} from './wire'

const defaultBaseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080'
const prefix = '/api/v1/platform/contracts'
export type ContractAction = 'validate' | 'approve' | 'reject'
export type RequestOutcome = 'not_sent' | 'rejected' | 'unknown'

export interface GenerationOperationReference {
  readonly operationId: string
  readonly kind: 'CONTRACT' | 'PATCH'
  readonly releaseId: string
}
interface OperationFields extends GenerationOperationReference {
  readonly statusUrl: string
  readonly retryable: boolean
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}
interface GenerationIssue { readonly code: string }
interface CandidateResult {
  readonly issues: readonly GenerationIssue[]
  readonly contractVersionId: string
  readonly policyHash: string
  readonly resourceHash: string
}
type SuccessfulOperation = OperationFields & {
  readonly status: 'SUCCEEDED'; readonly errorCode: null; readonly errorStage: null
}
export type ProposedPatchOperation = SuccessfulOperation & {
  readonly kind: 'PATCH'; readonly outcome: 'PROPOSED'
  readonly result: CandidateResult & { readonly assessment: 'PROPOSED'; readonly patchProposalId: string }
}
export type GenerationOperation =
  | (OperationFields & { readonly status: 'QUEUED' | 'RUNNING'; readonly outcome: null; readonly result: null;
      readonly errorCode: null; readonly errorStage: null })
  | (SuccessfulOperation & { readonly kind: 'CONTRACT'; readonly outcome: 'VALID' | 'WARN';
      readonly result: CandidateResult & { readonly assessment: 'VALID' | 'WARN' } })
  | ProposedPatchOperation
  | (SuccessfulOperation & { readonly kind: 'CONTRACT'; readonly outcome: 'INVALID';
      readonly result: { readonly assessment: 'INVALID'; readonly issues: readonly GenerationIssue[] } })
  | (SuccessfulOperation & { readonly kind: 'PATCH'; readonly outcome: 'INVALID' | 'NO_CHANGE_NEEDED';
      readonly result: { readonly assessment: 'INVALID' | 'NO_CHANGE_NEEDED'; readonly issues: readonly GenerationIssue[] } })
  | (OperationFields & { readonly status: 'FAILED' | 'RECOVERY_REQUIRED'; readonly outcome: null; readonly result: null;
      readonly errorCode: string; readonly errorStage: 'SOURCE' | 'GENERATION' | 'PERSISTENCE' | 'PROVIDER' | 'ADMISSION' | 'WORKER' })

// Generated request identity is local admission intent, never a guarantee of replay after server TTL expiry.
const preparedGenerations = new WeakSet<object>()
class InitialGenerationRequest {
  readonly kind = 'CONTRACT'
  readonly contentType = 'application/json'
  readonly body = JSON.stringify({ templateKey: 'loan-review/1' })
  constructor(readonly releaseId: string, readonly idempotencyKey: string) {
    preparedGenerations.add(this); Object.freeze(this)
  }
}
class PatchGenerationRequest {
  readonly kind = 'PATCH'
  readonly contentType = 'application/json'
  readonly releaseId: string
  readonly body: string
  constructor(readonly findingId: string, readonly baseIdentity: ContractVersionIdentity, readonly idempotencyKey: string) {
    this.releaseId = baseIdentity.releaseId
    this.body = JSON.stringify({ baseContractVersionId: baseIdentity.versionId })
    preparedGenerations.add(this); Object.freeze(this)
  }
}
export type PreparedInitialGeneration = InitialGenerationRequest
export type PreparedPatchGeneration = PatchGenerationRequest
export type PreparedGeneration = PreparedInitialGeneration | PreparedPatchGeneration

export function prepareInitialGeneration(releaseId: string): PreparedInitialGeneration {
  return checkedInput(() => new InitialGenerationRequest(readContractUuid(releaseId),
    `contract-generate-${readContractUuid(crypto.randomUUID())}`))
}
export function preparePatchGeneration(findingId: string, base: ContractVersionIdentity): PreparedPatchGeneration {
  return checkedInput(() => new PatchGenerationRequest(readContractUuid(findingId), readContractIdentity(base),
    `patch-generate-${readContractUuid(crypto.randomUUID())}`))
}

// These are public machine codes emitted by A GenerationWorker and C validators, not code-shaped arbitrary text.
const generationErrorCodes = new Set([
  'RESOURCE_NOT_FOUND', 'RESOURCE_CONFLICT', 'MANIFEST_INVALID', 'RELEASE_CHANGED', 'INVALID_STATE_TRANSITION',
  'EVIDENCE_INCOMPLETE', 'SECRET_DETECTED', 'STREAM_CURSOR_EXPIRED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS',
  'OPERATOR_AUTH_REQUIRED', 'CONFIGURATION_ERROR', 'VALIDATION_ERROR', 'INTERNAL_ERROR',
  'INVALID_REQUEST', 'UNSAFE_TRANSACTION', 'SOURCE_UNAVAILABLE', 'REQUEST_TOO_LARGE', 'MODEL_CALL_FAILURE',
  'MODEL_RESPONSE_INVALID', 'PROCESSING_FAILURE', 'UNSUPPORTED_TEMPLATE', 'RELEASE_NOT_ANALYZED',
  'SOURCE_BINDING_MISMATCH', 'UNSUPPORTED_PURPOSE', 'SOURCE_CONTENT_INVALID', 'SOURCE_BINDING_INVALID',
  'BASE_VERSION_INVALID', 'INVALID_SOURCE', 'INVALID_IDENTITY', 'RELEASE_BINDING_MISMATCH', 'PROMPT_BUILD_FAILURE',
  'RESPONSE_TOO_LARGE', 'MALFORMED_RESPONSE', 'IDENTITY_MISMATCH', 'EVIDENCE_BINDING_MISMATCH',
  'GENERATION_INTERNAL_ERROR', 'GENERATION_DISABLED', 'AUTHORITY_EXPIRED', 'EXECUTION_UNCERTAIN',
])
const generationIssueCodes = new Set([
  'VALIDATION_ISSUE', 'TYPE', 'UNSUPPORTED_SCHEMA_VERSION', 'DUPLICATE_VALUE', 'UNKNOWN_FIELD',
  'CONTRACT_ID_REQUIRED', 'CONTRACT_VERSION_REQUIRED', 'CONTRACT_VERSION_INVALID', 'PURPOSE_REQUIRED', 'PURPOSE_MISMATCH',
  'TEMPLATE_VERSION_REQUIRED', 'TEMPLATE_VERSION_MISMATCH', 'VALIDATOR_VERSION_REQUIRED', 'VALIDATOR_VERSION_MISMATCH',
  'REQUIRED_TOOL_MISSING', 'TOOL_NOT_IN_RELEASE_CATALOG', 'HUMAN_ONLY_TOOL_ALLOWED', 'CASE_SCOPE_REQUIRED',
  'CASE_SCOPE_EXCEEDS_TEMPLATE', 'DOCUMENT_SCOPE_REQUIRED', 'DOCUMENT_SCOPE_EXCEEDS_TEMPLATE',
  'CUSTOMER_SCOPE_REQUIRED', 'CUSTOMER_SCOPE_EXCEEDS_TEMPLATE', 'FIELD_NOT_IN_TOOL_OUTPUT', 'REQUIRED_FIELD_MISSING',
  'FIELD_EXCEEDS_TEMPLATE', 'DENY_UNKNOWN_FIELDS_REQUIRED', 'CARDINALITY_LIMIT_INVALID', 'CARDINALITY_EXCEEDS_TEMPLATE',
  'CARDINALITY_LIMIT_REQUIRED', 'EGRESS_POLICY_REQUIRED', 'EXTERNAL_EGRESS_NOT_DENIED', 'EGRESS_DESTINATIONS_REQUIRED',
  'EGRESS_DESTINATION_CONFLICT', 'REQUIRED_WORKFLOW_STAGE_MISSING', 'WORKFLOW_STAGE_EXCEEDS_TEMPLATE',
  'HIGH_IMPACT_TOOL_NOT_IN_CATALOG', 'HIGH_IMPACT_MODE_INVALID', 'LOAN_DECISION_POLICY_REQUIRED', 'LOAN_DECISION_POLICY_INVALID',
  'TRUSTED_TOOL_REQUIRED', 'REQUIRED_TRUST_LEVEL_MISSING', 'UNTRUSTED_LEVEL_ALLOWED', 'REQUIRED_REVIEW_STATUS_MISSING',
  'REVIEW_STATUS_EXCEEDS_TEMPLATE', 'POLICY_TOOL_NOT_IN_RELEASE_CATALOG', 'SOURCE_INELIGIBLE', 'SOURCE_BINDING_INVALID',
  'CANDIDATE_INVALID', 'CANDIDATE_EXPLANATION_REQUIRED', 'BASE_POLICY_BINDING_INVALID', 'EMPTY_PATCH_CHANGED_POLICY',
  'PATCH_INVALID', 'RESULT_SEMANTIC_INVALID', 'STRUCTURAL_POLICY_INVALID',
])
const generationErrorStages = ['SOURCE', 'GENERATION', 'PERSISTENCE', 'PROVIDER', 'ADMISSION', 'WORKER'] as const
function operationRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest()
  return value as Record<string, unknown>
}
function own(source: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidRequest()
  return descriptor.value
}
function operationTime(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalidRequest()
  return value
}
function operationReference(value: unknown): GenerationOperationReference {
  const source = operationRecord(value), kind = own(source, 'kind')
  if (kind !== 'CONTRACT' && kind !== 'PATCH') throw invalidRequest()
  return Object.freeze({ operationId: readContractUuid(own(source, 'operationId')), kind,
    releaseId: readContractUuid(own(source, 'releaseId')) })
}
function safeGenerationCode(value: unknown, known: ReadonlySet<string>, fallback: string): string {
  if (typeof value !== 'string') throw invalidRequest()
  return known.has(value) ? value : fallback
}
function readGenerationOperation(value: unknown, expected: Pick<GenerationOperationReference, 'kind' | 'releaseId'>
  & { readonly operationId?: string }): GenerationOperation {
  const envelope = operationRecord(value)
  readContractUuid(own(envelope, 'traceId')); operationTime(own(envelope, 'timestamp'))
  const source = operationRecord(own(envelope, 'data')), reference = operationReference(source)
  if (reference.kind !== expected.kind || reference.releaseId !== expected.releaseId
    || (expected.operationId !== undefined && reference.operationId !== expected.operationId)) throw invalidRequest()
  const statusUrl = own(source, 'statusUrl')
  if (typeof statusUrl !== 'string' || statusUrl !== `/api/v1/operations/${reference.operationId}`) throw invalidRequest()
  const retryable = own(source, 'retryable')
  if (typeof retryable !== 'boolean') throw invalidRequest()
  const createdAt = operationTime(own(source, 'createdAt'))
  const start = own(source, 'startedAt'), finish = own(source, 'finishedAt')
  const startedAt = start === null ? null : operationTime(start), finishedAt = finish === null ? null : operationTime(finish)
  const common = { ...reference, statusUrl, retryable, createdAt, startedAt, finishedAt }
  const status = own(source, 'status'), outcome = own(source, 'outcome'), result = own(source, 'result')
  const errorCode = own(source, 'errorCode'), errorStage = own(source, 'errorStage')
  const candidateFields = ['contractVersionId', 'policyHash', 'resourceHash', 'patchProposalId']
  if (candidateFields.some(key => Object.hasOwn(source, key))) throw invalidRequest()
  if (status === 'QUEUED' || status === 'RUNNING') {
    if (outcome !== null || result !== null || errorCode !== null || errorStage !== null || finishedAt !== null
      || (status === 'QUEUED' ? startedAt !== null : startedAt === null)) throw invalidRequest()
    return Object.freeze({ ...common, status, outcome: null, result: null, errorCode: null, errorStage: null })
  }
  if (finishedAt === null) throw invalidRequest()
  if (status === 'FAILED' || status === 'RECOVERY_REQUIRED') {
    if (outcome !== null || result !== null || !generationErrorStages.includes(errorStage as typeof generationErrorStages[number])
      || (startedAt === null && !(status === 'FAILED' && errorStage === 'ADMISSION'))) throw invalidRequest()
    return Object.freeze({ ...common, status, outcome: null, result: null,
      errorCode: safeGenerationCode(errorCode, generationErrorCodes, 'UNKNOWN_ERROR'),
      errorStage: errorStage as typeof generationErrorStages[number] })
  }
  if (status !== 'SUCCEEDED' || startedAt === null || errorCode !== null || errorStage !== null) throw invalidRequest()
  const data = operationRecord(result), assessment = own(data, 'assessment'), rawIssues = own(data, 'issues')
  if (assessment !== outcome || !Array.isArray(rawIssues)) throw invalidRequest()
  const issues = Object.freeze(rawIssues.map(issue => Object.freeze({
    code: safeGenerationCode(own(operationRecord(issue), 'code'), generationIssueCodes, 'VALIDATION_ISSUE'),
  })))
  const success = { ...common, status, errorCode: null, errorStage: null } as const
  if ((reference.kind === 'CONTRACT' && (outcome === 'VALID' || outcome === 'WARN'))
    || (reference.kind === 'PATCH' && outcome === 'PROPOSED')) {
    const candidate = { issues, contractVersionId: readContractUuid(own(data, 'contractVersionId')),
      policyHash: readContractHash(own(data, 'policyHash')), resourceHash: readContractHash(own(data, 'resourceHash')) }
    if (reference.kind === 'PATCH' && outcome === 'PROPOSED') return Object.freeze({ ...success, kind: 'PATCH', outcome,
      result: Object.freeze({ ...candidate, assessment: outcome, patchProposalId: readContractUuid(own(data, 'patchProposalId')) }) })
    if (Object.hasOwn(data, 'patchProposalId')) throw invalidRequest()
    return Object.freeze({ ...success, kind: 'CONTRACT', outcome: outcome as 'VALID' | 'WARN',
      result: Object.freeze({ ...candidate, assessment: outcome as 'VALID' | 'WARN' }) })
  }
  if (candidateFields.some(key => Object.hasOwn(data, key))) throw invalidRequest()
  if (reference.kind === 'CONTRACT' && outcome === 'INVALID') return Object.freeze({ ...success, kind: 'CONTRACT', outcome,
    result: Object.freeze({ assessment: outcome, issues }) })
  if (reference.kind === 'PATCH' && (outcome === 'INVALID' || outcome === 'NO_CHANGE_NEEDED')) return Object.freeze({ ...success, kind: 'PATCH', outcome,
    result: Object.freeze({ assessment: outcome, issues }) })
  throw invalidRequest()
}

const messages: Readonly<Record<string, string>> = {
  CONTRACT_REQUEST_INVALID: '계약 대상과 입력 내용을 확인해 주세요.',
  CONTRACT_RESPONSE_INVALID: '서버의 계약 응답을 확인할 수 없습니다. 최신 상태를 다시 조회해 주세요.',
  CONTRACT_AUTH_REQUIRED: '검토자 키를 확인해 주세요.',
  OPERATOR_AUTH_REQUIRED: '이 계약을 검토할 권한이 없습니다.',
  RESOURCE_NOT_FOUND: '저장된 계약을 찾을 수 없습니다.',
  RESOURCE_CONFLICT: '계약 또는 릴리스가 변경되었습니다. 최신 내용을 다시 검토해 주세요.',
  STALE_RESOURCE: '검토한 계약이 변경되었습니다. 최신 내용을 다시 검토해 주세요.',
  RELEASE_CHANGED: '릴리스가 변경되었습니다. 최신 내용을 다시 검토해 주세요.',
  VALIDATION_SOURCE_CHANGED: '검증 기준이 변경되었습니다. 최신 내용을 다시 검토해 주세요.',
  INVALID_STATE_TRANSITION: '현재 계약 상태에서는 이 작업을 수행할 수 없습니다.',
  IDEMPOTENCY_CONFLICT: '이전 요청과 내용이 다릅니다. 처리 결과를 확인한 뒤 다시 검토해 주세요.',
  IDEMPOTENCY_IN_PROGRESS: '이전 요청이 처리 중이거나 복구가 필요합니다. 서버 상태를 확인해 주세요.',
  NETWORK_ERROR: '서버 응답을 받지 못했습니다. 변경 요청의 처리 여부는 최신 상태에서 확인해 주세요.',
  REQUEST_ABORTED: '응답 대기가 중단되었습니다. 변경 요청이 취소되었다는 의미는 아닙니다.',
}

/** Describes this attempt only; an unknown outcome never authorizes a new-key retry. */
export class ContractRequestError extends Error {
  readonly code: string
  readonly traceId: string | undefined
  readonly retryable: boolean

  constructor(readonly status: number | null, problem: ContractProblem, readonly outcome: RequestOutcome) {
    super(messages[problem.code] ?? (status !== null && status >= 400 && status < 500
      ? '요청이 거절되었습니다. 입력과 권한, 최신 계약 상태를 확인해 주세요.'
      : '요청을 완료하지 못했습니다. 서버 상태를 확인해 주세요.'))
    this.name = 'ContractRequestError'
    this.code = problem.code
    this.traceId = problem.traceId
    this.retryable = problem.retryable
  }
}

function invalidRequest(): ContractRequestError {
  return new ContractRequestError(null, { code: 'CONTRACT_REQUEST_INVALID', retryable: false }, 'not_sent')
}

function checkedInput<T>(read: () => T): T {
  try { return read() } catch { throw invalidRequest() }
}

/** A local immutable request, not a server authorization or a persisted operation. */
class PreparedMutation {
  readonly contentType = 'application/json'

  constructor(
    readonly action: ContractAction,
    readonly identity: ContractVersionIdentity,
    readonly idempotencyKey: string,
    readonly ifMatch: string,
    readonly body: string,
  ) { Object.freeze(this) }
}

export type PreparedContractMutation = PreparedMutation

export function prepareContractMutation(
  action: ContractAction,
  review: Pick<StoredContractReview, 'identity' | 'resourceHash'>,
  comment?: string,
): PreparedContractMutation
export function prepareContractMutation(
  action: 'approve',
  review: Pick<StoredContractReview, 'identity' | 'resourceHash' | 'policyHash'>,
  comment: string,
  patch: ProposedPatchOperation,
): PreparedContractMutation
export function prepareContractMutation(
  action: ContractAction,
  review: Pick<StoredContractReview, 'identity' | 'resourceHash'> & Partial<Pick<StoredContractReview, 'policyHash'>>,
  comment?: string,
  patch?: ProposedPatchOperation,
): PreparedContractMutation {
  return checkedInput(() => {
    if (!['validate', 'approve', 'reject'].includes(action)) throw invalidRequest()
    const identity = readContractIdentity(review.identity)
    const hash = readContractHash(review.resourceHash)
    if (action !== 'validate' && (typeof comment !== 'string' || comment.length > 1000
      || comment.trim().length === 0 || comment !== comment.trim())) throw invalidRequest()
    let patchProposalId: string | undefined
    if (patch !== undefined) {
      if (action !== 'approve') throw invalidRequest()
      const proposal = operationRecord(patch), result = operationRecord(own(proposal, 'result'))
      if (own(proposal, 'kind') !== 'PATCH' || own(proposal, 'status') !== 'SUCCEEDED'
        || own(proposal, 'outcome') !== 'PROPOSED' || own(result, 'assessment') !== 'PROPOSED'
        || readContractUuid(own(proposal, 'releaseId')) !== identity.releaseId
        || readContractUuid(own(result, 'contractVersionId')) !== identity.versionId
        || readContractHash(own(result, 'policyHash')) !== readContractHash(review.policyHash)) throw invalidRequest()
      patchProposalId = readContractUuid(own(result, 'patchProposalId'))
    }
    const body = action === 'validate' ? '{}' : JSON.stringify({ comment, ...(patchProposalId ? { patchProposalId } : {}) })
    const idempotencyKey = `contract-${action}-${readContractUuid(crypto.randomUUID())}`
    return new PreparedMutation(action, identity, idempotencyKey, `"${hash}"`, body)
  })
}

function httpOutcome(status: number, code: string): RequestOutcome {
  return status >= 400 && status < 500
    && !['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(code) ? 'rejected' : 'unknown'
}

export class ContractReviewClient {
  private readonly baseUrl: string

  constructor(baseUrl = defaultBaseUrl) {
    this.baseUrl = checkedInput(() => {
      const url = new URL(baseUrl || '/', globalThis.location?.origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) throw invalidRequest()
      return baseUrl.replace(/\/+$/, '')
    })
  }

  listVersions(releaseId: string, reviewerKey: string, signal?: AbortSignal): Promise<readonly ContractVersionSummary[]> {
    const id = checkedInput(() => readContractUuid(releaseId))
    return this.request(`${prefix}?releaseId=${encodeURIComponent(id)}`, reviewerKey,
      payload => readContractListResponse(payload, id), undefined, signal)
  }

  review(identity: ContractVersionIdentity, reviewerKey: string, signal?: AbortSignal): Promise<StoredContractReview> {
    const target = checkedInput(() => readContractIdentity(identity))
    return this.request(`${prefix}/${encodeURIComponent(target.versionId)}/review`, reviewerKey,
      payload => readStoredContractReviewResponse(payload, target), undefined, signal)
  }

  executeMutation(operation: PreparedContractMutation, reviewerKey: string, signal?: AbortSignal): Promise<ContractVersionSummary> {
    if (!(operation instanceof PreparedMutation)) throw invalidRequest()
    return this.request(`${prefix}/${encodeURIComponent(operation.identity.versionId)}:${operation.action}`, reviewerKey,
      payload => {
        const version = readContractVersionResponse(payload, operation.identity)
        const expected = operation.action === 'validate' ? ['CANDIDATE', 'VALIDATED']
          : operation.action === 'approve' ? ['APPROVED'] : ['REJECTED']
        if (!expected.includes(version.state)) throw invalidRequest()
        return version
      }, operation, signal)
  }

  submitGeneration(operation: PreparedGeneration, reviewerKey: string, signal?: AbortSignal): Promise<GenerationOperation> {
    if (!preparedGenerations.has(operation)) throw invalidRequest()
    const path = operation.kind === 'CONTRACT' ? `/api/v1/releases/${operation.releaseId}/contracts:generate`
      : `/api/v1/findings/${operation.findingId}/patch-proposals`
    return this.request(path, reviewerKey, (payload, response) => {
      const result = readGenerationOperation(payload, operation)
      if (response.headers.get('Location') !== result.statusUrl || result.status !== 'QUEUED') throw invalidRequest()
      return result
    }, operation, signal)
  }

  generationOperation(reference: GenerationOperationReference, reviewerKey: string, signal?: AbortSignal): Promise<GenerationOperation> {
    const expected = checkedInput(() => operationReference(reference))
    return this.request(`/api/v1/operations/${expected.operationId}`, reviewerKey,
      payload => readGenerationOperation(payload, expected), undefined, signal)
  }

  private async request<T>(
    path: string,
    reviewerKey: string,
    read: (payload: unknown, response: Response) => T,
    operation?: PreparedContractMutation | PreparedGeneration,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = checkedInput(() => {
      if (typeof reviewerKey !== 'string' || reviewerKey.length === 0) throw invalidRequest()
      const result = new Headers({ Accept: 'application/json', 'X-Contract-Reviewer-Key': reviewerKey })
      if (operation) {
        result.set('Content-Type', operation.contentType)
        if (operation instanceof PreparedMutation) result.set('If-Match', operation.ifMatch)
        result.set('Idempotency-Key', operation.idempotencyKey)
      }
      return result
    })

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: operation ? 'POST' : 'GET', headers, body: operation?.body,
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      })
    } catch {
      throw new ContractRequestError(null, {
        code: signal?.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR', retryable: !signal?.aborted,
      }, 'unknown')
    }

    let payload: unknown
    try { payload = await response.json() } catch { payload = undefined }
    if (!response.ok) {
      const problem = readContractProblem(payload, response.status)
      throw new ContractRequestError(response.status, problem, httpOutcome(response.status, problem.code))
    }
    try {
      const expectedStatus = operation && preparedGenerations.has(operation) ? 202 : 200
      if (response.status !== expectedStatus) throw invalidRequest()
      return read(payload, response)
    } catch {
      throw new ContractRequestError(response.status,
        { code: 'CONTRACT_RESPONSE_INVALID', retryable: false }, 'unknown')
    }
  }
}
