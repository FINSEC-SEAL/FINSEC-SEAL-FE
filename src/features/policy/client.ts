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
): PreparedContractMutation {
  return checkedInput(() => {
    if (!['validate', 'approve', 'reject'].includes(action)) throw invalidRequest()
    const identity = readContractIdentity(review.identity)
    const hash = readContractHash(review.resourceHash)
    if (action !== 'validate' && (typeof comment !== 'string' || comment.length > 1000
      || comment.trim().length === 0 || comment !== comment.trim())) throw invalidRequest()
    const body = action === 'validate' ? '{}' : JSON.stringify({ comment })
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

  private async request<T>(
    path: string,
    reviewerKey: string,
    read: (payload: unknown) => T,
    operation?: PreparedContractMutation,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = checkedInput(() => {
      if (typeof reviewerKey !== 'string' || reviewerKey.length === 0) throw invalidRequest()
      const result = new Headers({ Accept: 'application/json', 'X-Contract-Reviewer-Key': reviewerKey })
      if (operation) {
        result.set('Content-Type', operation.contentType)
        result.set('If-Match', operation.ifMatch)
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
      if (response.status !== 200) throw invalidRequest()
      return read(payload)
    } catch {
      throw new ContractRequestError(response.status,
        { code: 'CONTRACT_RESPONSE_INVALID', retryable: false }, 'unknown')
    }
  }
}
