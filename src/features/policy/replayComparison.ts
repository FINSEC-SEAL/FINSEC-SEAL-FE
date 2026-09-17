import { GatewayEvidenceClient, readDecision, type GatewayRunOption } from './gatewayEvidence'

export interface ReplayPolicyEvent {
  readonly eventId: string
  readonly eventType: 'POLICY_EVALUATED'
  readonly toolName: string | null
  readonly occurredAt: string
  readonly payloadDigest: string
  readonly decision: ReturnType<typeof readDecision>
  readonly decisionEncoding: 'explicit' | 'legacy' | 'unreadable'
  readonly evaluationMode: 'BASELINE' | 'ENFORCE' | null
  readonly eventReasonCode: string | null
  readonly policyReasonCode: string | null
}

export interface ReplayPolicySide {
  readonly runId: string
  readonly caseRunId: string
  readonly mode: GatewayRunOption['mode']
  readonly runStatus: 'COMPLETED'
  readonly caseStatus: 'PASSED' | 'FAILED_SECURITY' | 'FAILED_FUNCTIONAL' | 'ERROR' | 'CANCELLED'
  readonly policyDecisions: readonly ReplayPolicyEvent[]
}

export interface StoredReplayPolicyComparison {
  readonly replayRunId: string
  readonly replayLinkId: string
  readonly findingId: string
  readonly releaseId: string
  readonly comparable: boolean
  readonly mismatchReasons: readonly string[]
  readonly baseline: ReplayPolicySide
  readonly replay: ReplayPolicySide
}

export interface ReplayComparisonApi {
  listRuns(releaseId: string, actorId: string, signal?: AbortSignal): Promise<readonly GatewayRunOption[]>
  comparison(releaseId: string, replayRunId: string, signal?: AbortSignal): Promise<StoredReplayPolicyComparison>
}

type ErrorCode = 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'REQUEST_FAILED' | 'REQUEST_ABORTED' | 'LIMIT_EXCEEDED'
const messages: Record<ErrorCode, string> = {
  INVALID_REQUEST: '조회할 릴리스와 Replay Run을 확인해 주세요.',
  INVALID_RESPONSE: '저장된 비교 응답의 식별자나 형식을 확인할 수 없습니다.',
  REQUEST_FAILED: '저장된 비교를 조회하지 못했습니다. 연결 상태와 비교 기록의 준비 여부를 확인해 주세요.',
  REQUEST_ABORTED: '저장된 비교 조회가 중단되었습니다.',
  LIMIT_EXCEEDED: '비교 기록이 화면 조회 한도를 초과했습니다. 일부 기록으로 비교를 표시하지 않습니다.',
}
export class ReplayComparisonError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'ReplayComparisonError' }
}

const modes = ['BASELINE', 'SEAL_REPLAY', 'HELD_OUT', 'REGRESSION'] as const
const terminalCases = ['PASSED', 'FAILED_SECURITY', 'FAILED_FUNCTIONAL', 'ERROR', 'CANCELLED'] as const
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hashPattern = /^sha256:[0-9a-f]{64}$/
const maxEventsPerSide = 10_000
const maxMismatchReasons = 1_000
function fail(code: ErrorCode = 'INVALID_RESPONSE'): never { throw new ReplayComparisonError(code) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 100, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) fail()
  return value
}
function nullableLabel(value: unknown): string | null { return value === null ? null : text(value, 100, true) }
function uuid(value: unknown): string {
  const result = text(value)
  if (!uuidPattern.test(result)) fail()
  return result.toLowerCase()
}
function digest(value: unknown): string {
  const result = text(value)
  if (!hashPattern.test(result)) fail()
  return result
}
function time(value: unknown): string {
  const result = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) fail()
  return result
}
function items(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) fail()
  if (value.length > limit) fail('LIMIT_EXCEEDED')
  return value
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('REQUEST_ABORTED') }
function input<T>(read: () => T): T {
  try { return read() } catch { return fail('INVALID_REQUEST') }
}

function event(value: unknown): ReplayPolicyEvent {
  const row = object(value)
  if (row.eventType !== 'POLICY_EVALUATED') fail()
  // D's value is policy_decision_json. Missing or unreadable policy content remains UNKNOWN.
  const policy = row.value !== null && typeof row.value === 'object' && !Array.isArray(row.value)
    ? row.value as Record<string, unknown> : {}
  const decision = readDecision(policy)
  return Object.freeze({ eventId: uuid(row.eventId), eventType: 'POLICY_EVALUATED',
    toolName: nullableLabel(row.toolName), occurredAt: time(row.occurredAt), payloadDigest: digest(row.payloadDigest),
    decision, decisionEncoding: decision === 'UNKNOWN' ? 'unreadable' : Object.hasOwn(policy, 'decisionType') ? 'explicit' : 'legacy',
    evaluationMode: policy.evaluationMode === 'BASELINE' || policy.evaluationMode === 'ENFORCE' ? policy.evaluationMode : null,
    eventReasonCode: nullableLabel(row.reasonCode),
    policyReasonCode: typeof policy.reasonCode === 'string' && policy.reasonCode.length <= 100 ? policy.reasonCode : null,
  })
}

function side(value: unknown): ReplayPolicySide {
  const row = object(value)
  if (!modes.includes(row.mode as typeof modes[number]) || row.runStatus !== 'COMPLETED'
    || !terminalCases.includes(row.caseStatus as typeof terminalCases[number])) fail()
  const ids = new Set<string>()
  const policyDecisions = items(row.policyDecisions, maxEventsPerSide).map(value => {
    const recorded = event(value)
    if (ids.has(recorded.eventId)) fail()
    ids.add(recorded.eventId)
    return recorded
  })
  return Object.freeze({ runId: uuid(row.runId), caseRunId: uuid(row.caseRunId), mode: row.mode as typeof modes[number],
    runStatus: 'COMPLETED', caseStatus: row.caseStatus as typeof terminalCases[number], policyDecisions: Object.freeze(policyDecisions) })
}

function comparison(value: unknown, releaseId: string, replayRunId: string): StoredReplayPolicyComparison {
  const envelope = object(value)
  text(envelope.traceId); time(envelope.timestamp)
  const row = object(envelope.data)
  if (uuid(row.releaseId) !== releaseId || uuid(row.replayRunId) !== replayRunId || typeof row.comparable !== 'boolean') fail()
  const mismatchReasons = items(row.mismatchReasons, maxMismatchReasons).map(reason => text(reason, 2_000, true))
  // These combinations follow the existing D response contract; this does not recompute comparability.
  if (row.comparable !== (mismatchReasons.length === 0)) fail()
  const baseline = side(row.baseline), replay = side(row.replay)
  if (replay.runId !== replayRunId || replay.mode !== 'SEAL_REPLAY') fail()
  return Object.freeze({ replayRunId, replayLinkId: uuid(row.replayLinkId), findingId: uuid(row.findingId), releaseId,
    comparable: row.comparable, mismatchReasons: Object.freeze(mismatchReasons), baseline, replay })
}

/** Read-only C projection. D outcomes and raw policy/API/state values never leave this client. */
export class ReplayComparisonClient implements ReplayComparisonApi {
  private readonly baseUrl: string
  private readonly runs: GatewayEvidenceClient

  constructor(baseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080') {
    this.baseUrl = input(() => {
      const url = new URL(baseUrl || '/', globalThis.location?.origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail()
      return url.toString().replace(/\/+$/, '')
    })
    this.runs = new GatewayEvidenceClient(this.baseUrl)
  }

  async listRuns(releaseId: string, actorId: string, signal?: AbortSignal): Promise<readonly GatewayRunOption[]> {
    // The existing listing's optional actor header is not reviewer authentication.
    return Object.freeze((await this.runs.listRuns(releaseId, actorId, signal)).filter(run => run.mode === 'SEAL_REPLAY'))
  }

  async comparison(releaseId: string, replayRunId: string, signal?: AbortSignal): Promise<StoredReplayPolicyComparison> {
    const [release, run] = input(() => [uuid(releaseId), uuid(replayRunId)] as const)
    checkAbort(signal)
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/replays/${run}/comparison`, {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      })
      checkAbort(signal)
      if (response.status !== 200) fail('REQUEST_FAILED')
      let payload: unknown
      try { payload = await response.json() } catch { fail('INVALID_RESPONSE') }
      checkAbort(signal)
      return comparison(payload, release, run)
    } catch (error) {
      checkAbort(signal)
      if (error instanceof ReplayComparisonError) throw error
      fail('REQUEST_FAILED')
    }
  }
}
