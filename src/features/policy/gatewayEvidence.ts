import type { TestRun } from '../../api/contracts'

export interface GatewayRunOption {
  readonly id: string
  readonly releaseId: string
  readonly mode: TestRun['mode']
  readonly status: string
}

export interface GatewayPolicyEvent {
  readonly eventId: string
  readonly traceId: string
  readonly runId: string
  readonly testCaseRunId: string | null
  readonly sequence: number
  readonly occurredAt: string
  readonly toolName: string | null
  readonly decision: 'ALLOW' | 'DENY' | 'ERROR' | 'UNKNOWN'
  readonly reasonCode: string | null
  readonly decisionReasonCode: string | null
  readonly payloadDigest: string
  readonly eventHash: string
  readonly prevEventHash: string | null
}

export interface GatewayRunEvidence {
  /** Run metadata is observed separately from the first history head. */
  readonly run: GatewayRunOption & { readonly contractVersionId: string | null }
  readonly headSequence: number
  readonly events: readonly GatewayPolicyEvent[]
}

export interface GatewayEvidenceApi {
  listRuns(releaseId: string, actorId: string, signal?: AbortSignal): Promise<readonly GatewayRunOption[]>
  loadRun(releaseId: string, runId: string, actorId: string, signal?: AbortSignal): Promise<GatewayRunEvidence>
}

type ErrorCode = 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'INCOMPLETE_HISTORY'
  | 'LIMIT_EXCEEDED' | 'REQUEST_FAILED' | 'REQUEST_ABORTED'
const messages: Record<ErrorCode, string> = {
  INVALID_REQUEST: '조회할 릴리스와 실행, 요청자 정보를 확인해 주세요.',
  INVALID_RESPONSE: '서버의 실행 기록 형식을 확인할 수 없습니다. 다시 조회해 주세요.',
  INCOMPLETE_HISTORY: '조회 범위의 기록이 완전하지 않습니다. 다시 조회해 주세요.',
  LIMIT_EXCEEDED: '기록이 화면 조회 한도를 초과했습니다. 전체 기록을 표시할 수 없습니다.',
  REQUEST_FAILED: '실행 기록을 조회하지 못했습니다. 연결과 접근 권한을 확인해 주세요.',
  REQUEST_ABORTED: '실행 기록 조회가 중단되었습니다.',
}

export class GatewayEvidenceError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'GatewayEvidenceError' }
}

const modes: readonly TestRun['mode'][] = ['BASELINE', 'SEAL_REPLAY', 'HELD_OUT', 'REGRESSION']
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hashPattern = /^sha256:[0-9a-f]{64}$/
const maxRuns = 10_000
const maxHistoryEvents = 100_000
const historyPageSize = 1_000
function fail(code: ErrorCode = 'INVALID_RESPONSE'): never { throw new GatewayEvidenceError(code) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function string(value: unknown, max = 100): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail()
  return value
}
function nullableLabel(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 100) fail()
  return value
}
function uuid(value: unknown): string {
  const result = string(value)
  if (!uuidPattern.test(result)) fail()
  return result.toLowerCase()
}
function hash(value: unknown): string {
  const result = string(value)
  if (!hashPattern.test(result)) fail()
  return result
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function items(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) fail()
  return value
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('REQUEST_ABORTED') }
function checkedInput<T>(read: () => T): T {
  try { return read() } catch { return fail('INVALID_REQUEST') }
}
function readRun(value: unknown, releaseId: string): GatewayRunOption {
  const row = object(value)
  const mode = string(row.mode) as TestRun['mode']
  if (!modes.includes(mode) || uuid(row.releaseId) !== releaseId) fail()
  return Object.freeze({ id: uuid(row.id), releaseId, mode, status: string(row.status) })
}
function readDecision(policy: Record<string, unknown>): GatewayPolicyEvent['decision'] {
  if (!Object.hasOwn(policy, 'decisionType')) {
    return policy.allowed === true ? 'ALLOW' : policy.allowed === false ? 'DENY' : 'UNKNOWN'
  }
  if (policy.decisionType === 'ALLOW' && policy.allowed === true) return 'ALLOW'
  if ((policy.decisionType === 'DENY' || policy.decisionType === 'ERROR') && policy.allowed === false) {
    return policy.decisionType
  }
  return 'UNKNOWN'
}
function readEvent(value: unknown, runId: string): GatewayPolicyEvent & { readonly eventType: string } {
  const row = object(value)
  if (row.schemaVersion !== '1.0' || uuid(row.runId) !== runId) fail()
  const occurredAt = string(row.occurredAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) fail()
  const policy = row.policyDecision !== null && typeof row.policyDecision === 'object'
    && !Array.isArray(row.policyDecision) ? row.policyDecision as Record<string, unknown> : {}
  // Reason codes are recorded text, not a closed enum or an inferred security outcome.
  const nestedReason = typeof policy.reasonCode === 'string' && policy.reasonCode.length <= 100
    ? policy.reasonCode : null
  return Object.freeze({
    eventType: string(row.eventType), eventId: uuid(row.eventId), traceId: uuid(row.traceId), runId,
    testCaseRunId: row.testCaseRunId === null ? null : uuid(row.testCaseRunId),
    sequence: integer(row.sequence), occurredAt, toolName: nullableLabel(row.toolName),
    decision: readDecision(policy),
    reasonCode: nullableLabel(row.reasonCode), decisionReasonCode: nestedReason,
    payloadDigest: hash(row.payloadDigest), eventHash: hash(row.eventHash),
    prevEventHash: row.prevEventHash === null ? null : hash(row.prevEventHash),
  })
}

/** Read-only projection of stored evidence. It grants no execution or approval authority. */
export class GatewayEvidenceClient implements GatewayEvidenceApi {
  private readonly baseUrl: string

  constructor(baseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080') {
    this.baseUrl = checkedInput(() => {
      const url = new URL(baseUrl || '/', globalThis.location?.origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) fail()
      return url.toString().replace(/\/+$/, '')
    })
  }

  async listRuns(releaseId: string, actorId: string, signal?: AbortSignal): Promise<readonly GatewayRunOption[]> {
    const release = checkedInput(() => uuid(releaseId))
    const result: GatewayRunOption[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (cursor !== null) query.set('cursor', cursor)
      const page = object(await this.request(`/api/v1/releases/${release}/test-runs?${query}`, actorId, signal))
      const rows = items(page.items, 100)
      for (const value of rows) {
        const run = readRun(value, release)
        if (ids.has(run.id)) fail()
        ids.add(run.id); result.push(run)
      }
      cursor = page.nextCursor === null ? null : string(page.nextCursor, 2_000)
      if (cursor !== null) {
        if (rows.length === 0 || cursors.has(cursor)) fail()
        cursors.add(cursor)
      }
      if (result.length > maxRuns || (result.length === maxRuns && cursor !== null)) fail('LIMIT_EXCEEDED')
    } while (cursor !== null)
    checkAbort(signal)
    return Object.freeze(result)
  }

  async loadRun(releaseId: string, runId: string, actorId: string, signal?: AbortSignal): Promise<GatewayRunEvidence> {
    const [release, id] = checkedInput(() => [uuid(releaseId), uuid(runId)] as const)
    const rawRun = object(await this.request(`/api/v1/test-runs/${id}`, actorId, signal))
    const option = readRun(rawRun, release)
    if (option.id !== id) fail()
    const run = Object.freeze({ ...option,
      contractVersionId: rawRun.contractVersionId === null ? null : uuid(rawRun.contractVersionId) })
    const events: GatewayPolicyEvent[] = []
    const ids = new Set<string>()
    let after = 0
    let head: number | undefined
    let previousHash: string | null = null
    do {
      const page = object(await this.request(
        `/api/v1/test-runs/${id}/event-history?after=${after}&limit=${historyPageSize}`, actorId, signal))
      const reportedHead = integer(page.headSequence)
      head ??= reportedHead
      if (head > maxHistoryEvents) fail('LIMIT_EXCEEDED')
      if (reportedHead < head) fail('INCOMPLETE_HISTORY')
      const rows = items(page.items, historyPageSize)
      const cursor = page.nextCursor === null ? null : integer(page.nextCursor)
      // Range and rows are separate server reads. Newer rows may exceed even reportedHead.
      const lastSequence = rows.length === 0 ? after : integer(object(rows[rows.length - 1]).sequence)
      if (cursor !== null && (rows.length === 0 || cursor <= after || cursor !== lastSequence)) fail('INCOMPLETE_HISTORY')
      for (const value of rows) {
        if (after === head) break
        const event = readEvent(value, id)
        if (event.sequence !== after + 1 || ids.has(event.eventId)
          || event.prevEventHash !== previousHash) fail('INCOMPLETE_HISTORY')
        ids.add(event.eventId)
        after = event.sequence
        previousHash = event.eventHash
        if (event.eventType === 'POLICY_EVALUATED') {
          const { eventType: _, ...projection } = event
          events.push(Object.freeze(projection))
        }
      }
      if (after < head && (cursor === null || cursor !== after)) fail('INCOMPLETE_HISTORY')
    } while (after < head)
    checkAbort(signal)
    return Object.freeze({ run, headSequence: head, events: Object.freeze(events) })
  }

  private async request(path: string, actorId: string, signal?: AbortSignal): Promise<unknown> {
    checkAbort(signal)
    const headers = checkedInput(() => new Headers({ Accept: 'application/json', 'X-Actor-Id': string(actorId, 200) }))
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET', headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      })
      checkAbort(signal)
      if (response.status !== 200) fail('REQUEST_FAILED')
      const envelope = object(await response.json())
      checkAbort(signal)
      return envelope.data
    } catch (error) {
      checkAbort(signal)
      if (error instanceof GatewayEvidenceError) throw error
      fail('REQUEST_FAILED')
    }
  }
}
