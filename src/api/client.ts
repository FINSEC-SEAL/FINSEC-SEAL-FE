import type {
  Agent,
  AgentCreate,
  ApiEnvelope,
  ApiProblem,
  Attestation,
  AuditRecord,
  Fingerprint,
  Finding,
  FindingDetail,
  JsonValue,
  MetricsView,
  DecisionProposal,
  DecisionValue,
  DecisionView,
  TestRun, EventHistory, EventChainVerification, OracleResult, TestRunStart, TestRunRegistered, TestSuiteSummary, TestRunSummary, ReplayComparison,
  PendingRecovery,
  RecoveryRequest,
  RecoveryResult,
  Release,
  ReleaseDiff,
  ValidationResult,
} from './contracts'
import { ContractReviewClient } from '../features/policy/client'
import { readReviewerSessionCredential, type ReviewerSession } from '../features/policy/reviewerSession'

const defaultBaseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080'

export class FinsecApiError extends Error {
  readonly status: number
  readonly code: string
  readonly traceId?: string
  readonly retryable: boolean

  constructor(status: number, problem: ApiProblem) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`)
    this.name = 'FinsecApiError'
    this.status = status
    this.code = problem.code ?? 'UNKNOWN_ERROR'
    this.traceId = problem.traceId
    this.retryable = problem.retryable ?? false
  }
}

export type RunStartFailure = 'session' | 'invalid' | 'rejected' | 'unknown'

const runStartMessages: Record<RunStartFailure, string> = {
  session: '검토자 세션이 만료되었거나 철회되었습니다. 다시 연결해 주세요.',
  invalid: '검토자 세션 또는 실행 요청을 확인해 주세요.',
  rejected: '실행 요청이 거절되었습니다. 입력과 현재 상태를 확인해 주세요.',
  unknown: '실행 요청의 처리 여부가 불명확합니다. 같은 요청으로 확인하거나 Run 기록을 검토해 주세요.',
}

/** Only fixed messages leave the Run-start transport; response bodies may contain secrets. */
export class RunStartError extends Error {
  constructor(readonly kind: RunStartFailure, readonly status: number | null = null) {
    super(runStartMessages[kind])
    this.name = 'RunStartError'
  }
}

export type RunCancelFailure = 'session' | 'invalid' | 'rejected' | 'unknown'

const runCancelMessages: Record<RunCancelFailure, string> = {
  session: '검토자 세션이 만료되었거나 철회되었습니다. 다시 연결해 주세요.',
  invalid: '검토자 세션 또는 취소 요청을 확인해 주세요.',
  rejected: '취소 요청이 거절되었습니다. Run의 현재 상태를 확인해 주세요.',
  unknown: '취소 요청의 처리 여부가 불명확합니다. Run 상태를 다시 조회해 주세요.',
}

/** Only fixed messages leave the Run-cancel transport; response bodies may contain secrets. */
export class RunCancelError extends Error {
  constructor(readonly kind: RunCancelFailure, readonly status: number | null = null) {
    super(runCancelMessages[kind])
    this.name = 'RunCancelError'
  }
}

export interface RequestContext {
  actorId: string
  idempotencyKey?: string
  operatorRecoveryKey?: string
}

export interface FinsecApiClientOptions {
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof TypeError) return true
  if (error instanceof Error) {
    return /(fetch|network|Failed to fetch|aborted|timeout|temporar)/i.test(error.message)
  }
  return false
}

export class FinsecApiClient {
  private reviewerClient?: ContractReviewClient
  private readonly confirmedRunSessions = new WeakSet<ReviewerSession>()

  constructor(
    private readonly baseUrl = defaultBaseUrl,
    private readonly options: FinsecApiClientOptions = {},
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    context?: RequestContext,
  ): Promise<T> {
    const { timeoutMs = 30000, maxRetries = 2, retryDelayMs = 250 } = this.options
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (context?.actorId) headers.set('X-Actor-Id', context.actorId)
    if (context?.idempotencyKey) headers.set('Idempotency-Key', context.idempotencyKey)
    if (context?.operatorRecoveryKey) {
      headers.set('X-Operator-Recovery-Key', context.operatorRecoveryKey)
    }
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
        if (!response.ok) {
          let problem: ApiProblem = { status: response.status, title: response.statusText }
          try {
            problem = (await response.json()) as ApiProblem
          } catch {
            // Preserve the status when an intermediary returns a non-JSON response.
          }
          const error = new FinsecApiError(response.status, problem)
          if (attempt < maxRetries && error.retryable && error.code !== 'STREAM_CURSOR_EXPIRED') {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
            continue
          }
          throw error
        }
        return ((await response.json()) as ApiEnvelope<T>).data
      } catch (error) {
        lastError = error
        if (error instanceof FinsecApiError && error.code === 'STREAM_CURSOR_EXPIRED') {
          throw error
        }
        if (error instanceof FinsecApiError && error.retryable
          && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
          continue
        }
        if (isRetryableNetworkError(error) && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
          continue
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          const timeoutError = new FinsecApiError(408, {
            title: 'Request timed out',
            detail: 'The request timed out while waiting for a response.',
            code: 'REQUEST_TIMEOUT',
            retryable: true,
          })
          throw timeoutError
        }
        if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
          const timeoutError = new FinsecApiError(408, {
            title: 'Request timed out',
            detail: error.message,
            code: 'REQUEST_TIMEOUT',
            retryable: true,
          })
          throw timeoutError
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError instanceof Error ? lastError : new FinsecApiError(500, {
      title: 'Request failed',
      detail: 'The request failed without a usable response.',
      code: 'REQUEST_FAILED',
      retryable: false,
    })
  }

  listAgents(actorId: string): Promise<Agent[]> {
    return this.request('/api/v1/agents', {}, { actorId })
  }

  createAgent(input: AgentCreate, actorId: string): Promise<Agent> {
    return this.request('/api/v1/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }, { actorId, idempotencyKey: newIdempotencyKey('agent-create') })
  }

  archiveAgent(agentId: string, actorId: string): Promise<Agent> {
    return this.request(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    }, { actorId, idempotencyKey: newIdempotencyKey('agent-archive') })
  }

  listReleases(agentId: string, actorId: string): Promise<Release[]> {
    return this.request(`/api/v1/agents/${encodeURIComponent(agentId)}/releases`, {}, { actorId })
  }

  releaseDetail(releaseId: string, actorId: string): Promise<Release> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}`, {}, { actorId })
  }

  createRelease(agentId: string, manifest: JsonValue, actorId: string): Promise<Release> {
    return this.request(`/api/v1/agents/${encodeURIComponent(agentId)}/releases`, {
      method: 'POST',
      body: JSON.stringify(manifest),
    }, { actorId, idempotencyKey: newIdempotencyKey('release-create') })
  }

  validateRelease(releaseId: string, actorId: string): Promise<ValidationResult> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}:validate`, {
      method: 'POST',
      body: '{}',
    }, { actorId, idempotencyKey: newIdempotencyKey('release-validate') })
  }

  analyzeRelease(releaseId: string, actorId: string): Promise<Release> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}:analyze`, {
      method: 'POST',
      body: '{}',
    }, { actorId, idempotencyKey: newIdempotencyKey('release-analyze') })
  }

  fingerprint(releaseId: string, actorId: string): Promise<Fingerprint> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/fingerprint`, {}, { actorId })
  }

  releaseDiff(releaseId: string, againstId: string, actorId: string): Promise<ReleaseDiff> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/diff?against=${encodeURIComponent(againstId)}`, {}, { actorId })
  }

  listTestSuites(releaseId: string, actorId: string, filters: { status?: string; limit?: number; cursor?: string } = {}): Promise<TestSuiteSummary[]> {
    const params = new URLSearchParams()
    if (filters.status) params.set('status', filters.status)
    if (filters.limit) params.set('limit', String(filters.limit))
    if (filters.cursor) params.set('cursor', filters.cursor)
    const query = params.size ? `?${params.toString()}` : ''
    return this.request<{ items: TestSuiteSummary[] }>(`/api/v1/releases/${encodeURIComponent(releaseId)}/test-suites${query}`, {}, { actorId })
      .then((response) => response.items)
  }

  listTestRuns(releaseId: string, actorId: string, filters: { mode?: TestRun['mode']; status?: string; limit?: number; cursor?: string } = {}): Promise<TestRunSummary[]> {
    const params = new URLSearchParams()
    if (filters.mode) params.set('mode', filters.mode)
    if (filters.status) params.set('status', filters.status)
    if (filters.limit) params.set('limit', String(filters.limit))
    if (filters.cursor) params.set('cursor', filters.cursor)
    const query = params.size ? `?${params.toString()}` : ''
    return this.request<{ items: TestRunSummary[] }>(`/api/v1/releases/${encodeURIComponent(releaseId)}/test-runs${query}`, {}, { actorId })
      .then((response) => response.items)
  }

  listReplayComparisons(releaseId: string, actorId: string): Promise<ReplayComparison[]> {
    return this.request<{ items: ReplayComparison[] }>(`/api/v1/releases/${encodeURIComponent(releaseId)}/replay-comparisons`, {}, { actorId })
      .then((response) => response.items)
  }

  testRun(runId: string, actorId: string): Promise<TestRun> { return this.request(`/api/v1/test-runs/${encodeURIComponent(runId)}`, {}, { actorId }) }

  async connectRunReviewerSession(reviewerKey?: string): Promise<ReviewerSession> {
    this.reviewerClient ??= new ContractReviewClient(this.baseUrl)
    const session = await this.reviewerClient.connectReviewerSession(reviewerKey)
    this.confirmedRunSessions.add(session)
    return session
  }

  /** A sent Run start is never retried here; callers retain its body/key for an explicit same-key retry. */
  async startTestRun(input: TestRunStart, session: ReviewerSession, idempotencyKey: string): Promise<TestRunRegistered> {
    if (!this.confirmedRunSessions.has(session)) throw new RunStartError('session')
    let reviewer: ReviewerSession
    try { reviewer = readReviewerSessionCredential(session) }
    catch { throw new RunStartError('session') }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new RunStartError('invalid')
    let body: string
    try {
      body = JSON.stringify(input)
      if (!body) throw new Error()
    } catch { throw new RunStartError('invalid') }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30000)
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/v1/test-runs`, {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json',
          'X-Actor-Id': reviewer.actorId, 'X-CSRF-Token': reviewer.csrfToken,
          'Idempotency-Key': idempotencyKey,
        },
        body, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.confirmedRunSessions.delete(session)
          throw new RunStartError('session', response.status)
        }
        if (response.status >= 400 && response.status < 500
          && ![408, 409, 425, 429].includes(response.status)) throw new RunStartError('rejected', response.status)
        throw new RunStartError('unknown', response.status)
      }
      if (response.status !== 202) throw new RunStartError('unknown', response.status)
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
        throw new RunStartError('unknown', response.status)
      }
      const data = (payload as { data: unknown }).data
      if (!data || typeof data !== 'object') throw new RunStartError('unknown', response.status)
      const receipt = data as Record<string, unknown>
      const runId = receipt.runId
      if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)
        || receipt.status !== 'QUEUED' || receipt.statusUrl !== `/api/v1/test-runs/${runId}`
        || receipt.streamUrl !== `/api/v1/test-runs/${runId}/events`) throw new RunStartError('unknown', response.status)
      return { runId, status: 'QUEUED', statusUrl: receipt.statusUrl, streamUrl: receipt.streamUrl }
    } catch (error) {
      if (error instanceof RunStartError) throw error
      throw new RunStartError('unknown')
    } finally { clearTimeout(timeout) }
  }

  /** A sent Run cancellation is never retried here because its outcome may already be committed. */
  async cancelTestRun(runId: string, session: ReviewerSession, idempotencyKey: string): Promise<TestRun> {
    if (!this.confirmedRunSessions.has(session)) throw new RunCancelError('session')
    let reviewer: ReviewerSession
    try { reviewer = readReviewerSessionCredential(session) }
    catch { throw new RunCancelError('session') }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new RunCancelError('invalid')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30000)
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/v1/test-runs/${encodeURIComponent(runId)}:cancel`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Actor-Id': reviewer.actorId,
          'X-CSRF-Token': reviewer.csrfToken,
          'Idempotency-Key': idempotencyKey,
        },
        credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.confirmedRunSessions.delete(session)
          throw new RunCancelError('session', response.status)
        }
        if (response.status >= 400 && response.status < 500
          && ![408, 409, 425, 429].includes(response.status)) throw new RunCancelError('rejected', response.status)
        throw new RunCancelError('unknown', response.status)
      }
      if (response.status !== 200) throw new RunCancelError('unknown', response.status)
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
        throw new RunCancelError('unknown', response.status)
      }
      const data = (payload as { data: unknown }).data
      if (!data || typeof data !== 'object') throw new RunCancelError('unknown', response.status)
      const cancelled = data as TestRun
      if (cancelled.id !== runId || cancelled.status !== 'CANCELLED') {
        throw new RunCancelError('unknown', response.status)
      }
      return cancelled
    } catch (error) {
      if (error instanceof RunCancelError) throw error
      throw new RunCancelError('unknown')
    } finally { clearTimeout(timeout) }
  }

  async eventHistory(runId: string, actorId: string, after = 0): Promise<EventHistory> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('Event history cursor is invalid')
    }
    const limit = 1000
    const items: EventHistory['items'] = []
    const eventIds = new Set<string>()
    let cursor = after
    let snapshotHead: number | null = null
    let pages = 0

    while (true) {
      if (snapshotHead !== null && pages >= Math.max(1, Math.ceil((snapshotHead - after) / limit))) {
        throw new Error('Event history snapshot is incomplete')
      }
      const page = await this.request<EventHistory>(
        `/api/v1/test-runs/${encodeURIComponent(runId)}/event-history?after=${cursor}&limit=${limit}`,
        {}, { actorId },
      )
      pages += 1
      if (!Number.isSafeInteger(page.headSequence) || page.headSequence < cursor
        || !Array.isArray(page.items) || page.items.length > limit) {
        throw new Error('Event history page is invalid')
      }
      snapshotHead ??= page.headSequence
      if (page.headSequence < snapshotHead) {
        throw new Error('Event history page is invalid')
      }
      if (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor)
        || page.nextCursor <= cursor || page.items.length !== limit)) {
        throw new Error('Event history cursor is invalid')
      }

      let expectedSequence = cursor + 1
      for (const event of page.items) {
        if (!event || event.runId !== runId || event.sequence !== expectedSequence
          || typeof event.eventId !== 'string' || !event.eventId || eventIds.has(event.eventId)) {
          throw new Error('Event history sequence is invalid')
        }
        eventIds.add(event.eventId)
        if (event.sequence <= snapshotHead) items.push(event)
        expectedSequence += 1
      }
      if (page.items.length && page.headSequence < page.items[page.items.length - 1]!.sequence) {
        throw new Error('Event history page is invalid')
      }
      if (page.nextCursor !== null
        && page.nextCursor !== page.items[page.items.length - 1]?.sequence) {
        throw new Error('Event history cursor is invalid')
      }
      if (items.length === snapshotHead - after) {
        return { items, headSequence: snapshotHead, nextCursor: null }
      }
      if (page.nextCursor === null) {
        throw new Error('Event history snapshot is incomplete')
      }
      cursor = page.nextCursor
    }
  }
  verifyEventChain(runId: string, actorId: string): Promise<EventChainVerification> { return this.request(`/api/v1/test-runs/${encodeURIComponent(runId)}/events:verify`, {}, { actorId }) }
  runFindings(runId: string, actorId: string): Promise<Finding[]> { return this.request<{items:Finding[]}>(`/api/v1/test-runs/${encodeURIComponent(runId)}/findings`, {}, { actorId }).then(v=>v.items) }
  runOracleResults(runId: string, actorId: string): Promise<OracleResult[]> { return this.request<{items:OracleResult[]}>(`/api/v1/test-runs/${encodeURIComponent(runId)}/oracle-results`, {}, { actorId }).then(v=>v.items) }

  findings(releaseId: string, actorId: string, filters: { category?: string; status?: string } = {}): Promise<Finding[]> {
    const params = new URLSearchParams({ releaseId })
    if (filters.category) params.set('category', filters.category)
    if (filters.status) params.set('status', filters.status)
    return this.request<{ items: Finding[] }>(`/api/v1/findings?${params}`, {}, { actorId })
      .then((response) => response.items)
  }

  finding(findingId: string, actorId: string): Promise<FindingDetail> {
    return this.request(`/api/v1/findings/${encodeURIComponent(findingId)}`, {}, { actorId })
  }

  triageFinding(findingId: string, comment: string, actorId: string): Promise<Finding> {
    return this.request(`/api/v1/findings/${encodeURIComponent(findingId)}:triage`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }, { actorId, idempotencyKey: newIdempotencyKey('finding-triage') })
  }

  metrics(releaseId: string, actorId: string): Promise<MetricsView> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/metrics`, {}, { actorId })
  }

  evaluateDecision(releaseId: string, actorId: string): Promise<DecisionProposal> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/decision:evaluate`, {
      method: 'POST',
      body: '{}',
    }, { actorId, idempotencyKey: newIdempotencyKey('decision-evaluate') })
  }

  confirmDecision(releaseId: string, inputDigest: string, decision: DecisionValue, comment: string, actorId: string): Promise<DecisionView> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/decision:confirm`, {
      method: 'POST',
      headers: { 'If-Match': inputDigest },
      body: JSON.stringify({ decision, comment }),
    }, { actorId, idempotencyKey: newIdempotencyKey('decision-confirm') })
  }

  attestation(releaseId: string, actorId: string): Promise<Attestation> {
    return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/attestation`, {}, { actorId })
  }

  audit(resourceType: string, resourceId: string, actorId: string): Promise<AuditRecord[]> {
    const params = new URLSearchParams({ resourceType, resourceId, limit: '50' })
    return this.request(`/api/v1/audit-records?${params}`, {}, { actorId })
  }

  pendingRecoveries(operatorKey: string, actorId: string): Promise<PendingRecovery[]> {
    return this.request('/api/v1/platform/idempotency-recoveries/pending', {}, {
      actorId,
      operatorRecoveryKey: operatorKey,
    })
  }

  recover(input: RecoveryRequest, operatorKey: string, actorId: string): Promise<RecoveryResult> {
    return this.request('/api/v1/platform/idempotency-recoveries', {
      method: 'POST',
      body: JSON.stringify(input),
    }, {
      actorId,
      operatorRecoveryKey: operatorKey,
      idempotencyKey: newIdempotencyKey('operator-recovery'),
    })
  }

  async downloadAttestation(releaseId: string, format: 'json' | 'html', actorId: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/releases/${encodeURIComponent(releaseId)}/evidence-export?format=${format}`,
      { headers: { 'X-Actor-Id': actorId }, signal },
    )
    if (!response.ok) {
      let problem: ApiProblem = { status: response.status, title: response.statusText }
      try {
        problem = (await response.json()) as ApiProblem
      } catch {
        // Preserve the status when an intermediary returns a non-JSON response.
      }
      throw new FinsecApiError(response.status, problem)
    }
    const blob = await response.blob()
    if (signal?.aborted) throw new DOMException('Attestation export cancelled', 'AbortError')
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const name = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `finsec-attestation.${format}`
    const href = URL.createObjectURL(blob)
    try {
      if (signal?.aborted) throw new DOMException('Attestation export cancelled', 'AbortError')
      const link = document.createElement('a')
      link.href = href
      link.download = name
      link.click()
    } finally {
      URL.revokeObjectURL(href)
    }
  }
}

export const api = new FinsecApiClient()
export type PlatformClient = Pick<FinsecApiClient,
  'listAgents' | 'createAgent' | 'archiveAgent' | 'listReleases' | 'createRelease' | 'validateRelease' | 'analyzeRelease' | 'fingerprint' | 'attestation' | 'downloadAttestation' | 'audit' | 'pendingRecoveries' | 'recover' | 'listTestSuites' | 'listTestRuns' | 'listReplayComparisons' | 'startTestRun' | 'cancelTestRun' | 'testRun'
>
