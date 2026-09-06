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
  TestRun, EventHistory, EventChainVerification, OracleResult, TestRunStart, TestRunRegistered,
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

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export class FinsecApiClient {
  constructor(private readonly baseUrl = defaultBaseUrl) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    context?: RequestContext,
  ): Promise<T> {
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
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      let problem: ApiProblem = { status: response.status, title: response.statusText }
      try {
        problem = (await response.json()) as ApiProblem
      } catch {
        // Preserve the status when an intermediary returns a non-JSON response.
      }
      throw new FinsecApiError(response.status, problem)
    }
    return ((await response.json()) as ApiEnvelope<T>).data
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
