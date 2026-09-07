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
  ValidationResult,
} from './contracts'

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
          if (attempt < maxRetries && error.retryable) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
            continue
          }
          throw error
        }
        return ((await response.json()) as ApiEnvelope<T>).data
      } catch (error) {
        lastError = error
        if (error instanceof FinsecApiError && error.retryable && attempt < maxRetries) {
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
  startTestRun(input: TestRunStart, actorId: string): Promise<TestRunRegistered> { return this.request('/api/v1/test-runs', { method:'POST', body:JSON.stringify(input) }, { actorId, idempotencyKey:newIdempotencyKey('test-run-start') }) }
  eventHistory(runId: string, actorId: string): Promise<EventHistory> { return this.request(`/api/v1/test-runs/${encodeURIComponent(runId)}/event-history?after=0&limit=100`, {}, { actorId }) }
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

  async downloadAttestation(releaseId: string, format: 'json' | 'html', actorId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/releases/${encodeURIComponent(releaseId)}/evidence-export?format=${format}`,
      { headers: { 'X-Actor-Id': actorId } },
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
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const name = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `finsec-attestation.${format}`
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = name
    link.click()
    URL.revokeObjectURL(href)
  }
}

export const api = new FinsecApiClient()
export type PlatformClient = Pick<FinsecApiClient,
  'listAgents' | 'createAgent' | 'archiveAgent' | 'listReleases' | 'createRelease' | 'validateRelease' | 'analyzeRelease' | 'fingerprint' | 'attestation' | 'downloadAttestation' | 'audit' | 'pendingRecoveries' | 'recover' | 'listTestSuites' | 'listTestRuns' | 'listReplayComparisons' | 'startTestRun' | 'testRun'
>
