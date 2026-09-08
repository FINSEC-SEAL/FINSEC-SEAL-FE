import type { TestRun } from '../../api/contracts'

export const gatewayStages = Object.freeze(['PREFLIGHT', 'TOOL', 'OPERATION', 'BUSINESS_CONTEXT',
  'OBJECT_SCOPE', 'FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'WORKFLOW', 'HUMAN_BOUNDARY', 'TOOL_TRUST'] as const)
export type GatewayStage = typeof gatewayStages[number]
export interface BaselineStageOutcome {
  readonly stage: GatewayStage
  readonly enforcement: 'ENFORCED' | 'OBSERVED'
  readonly outcomeType: 'PASS' | 'DENY' | 'ERROR' | 'SKIPPED'
  readonly reasonCode: string | null
}
export interface ObservedFailure { readonly stage: GatewayStage; readonly reasonCode: string }
export type GatewayStageDetails =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'valid'; readonly mode: 'ENFORCE'; readonly evaluatedStages: readonly GatewayStage[];
      readonly failedStage: GatewayStage | null }
  | { readonly status: 'valid'; readonly mode: 'BASELINE'; readonly stageOutcomes: readonly BaselineStageOutcome[];
      readonly failedStage: GatewayStage | null; readonly observedFailure: ObservedFailure | null }
export interface CallRecordCounts { readonly policies: number; readonly requests: number; readonly responses: number }
export interface CallEventRef {
  readonly eventId: string
  readonly eventType: 'TOOL_PROPOSED' | 'TOOL_REQUEST' | 'TOOL_RESPONSE'
  readonly sequence: number
  readonly occurredAt: string
  readonly payloadDigest: string
  readonly eventHash: string
  readonly prevEventHash: string | null
}
export type GatewayCallDetails =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly toolCallId: string | null }
  | { readonly status: 'ambiguous'; readonly toolCallId: string; readonly counts: CallRecordCounts }
  | { readonly status: 'valid'; readonly toolCallId: string; readonly proposal: CallEventRef;
      readonly request: CallEventRef | null; readonly response: CallEventRef | null }

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
  readonly stageDetails: GatewayStageDetails
  readonly callDetails: GatewayCallDetails
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
const observedStages = new Set<GatewayStage>(['OBJECT_SCOPE', 'FIELD_SCOPE', 'CARDINALITY', 'EGRESS', 'HUMAN_BOUNDARY'])
const absentStages: GatewayStageDetails = Object.freeze({ status: 'absent' })
const unreadableStages: GatewayStageDetails = Object.freeze({ status: 'unreadable' })
function reason(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && value.trim().length > 0
}
function readStages(policy: Record<string, unknown>, decision: GatewayPolicyEvent['decision']): GatewayStageDetails {
  const has = (key: string) => Object.hasOwn(policy, key)
  if (!['evaluationMode', 'evaluatedStages', 'stageOutcomes', 'failedStage', 'observedFailedStage',
    'observedReasonCode'].some(has)) return absentStages
  if (decision === 'UNKNOWN' || !has('evaluationMode') || !reason(policy.reasonCode)) return unreadableStages
  if (has('failedCheck') && (!has('failedStage') || policy.failedCheck !== policy.failedStage)) return unreadableStages
  if (policy.evaluationMode === 'ENFORCE') {
    if (['stageOutcomes', 'observedFailedStage', 'observedReasonCode'].some(has)
      || !has('evaluatedStages') || !Array.isArray(policy.evaluatedStages)) return unreadableStages
    const stages = policy.evaluatedStages
    if (stages.length === 0 || stages.length > gatewayStages.length
      || stages.some((stage, index) => stage !== gatewayStages[index])) return unreadableStages
    if (has('evaluatedChecks') && (!Array.isArray(policy.evaluatedChecks)
      || policy.evaluatedChecks.length !== stages.length
      || policy.evaluatedChecks.some((stage, index) => stage !== stages[index]))) return unreadableStages
    const last = stages[stages.length - 1] as GatewayStage
    if (decision === 'ALLOW') {
      if (stages.length !== gatewayStages.length || has('failedStage') || policy.reasonCode !== 'ALLOW') return unreadableStages
    } else if (!has('failedStage') || policy.failedStage !== last
      || (decision === 'DENY' && last === 'PREFLIGHT')) return unreadableStages
    return Object.freeze({ status: 'valid', mode: 'ENFORCE',
      evaluatedStages: Object.freeze([...stages] as GatewayStage[]), failedStage: decision === 'ALLOW' ? null : last })
  }
  if (policy.evaluationMode !== 'BASELINE' || has('evaluatedStages') || has('evaluatedChecks')
    || !has('stageOutcomes') || !Array.isArray(policy.stageOutcomes)
    || policy.stageOutcomes.length === 0 || policy.stageOutcomes.length > gatewayStages.length) return unreadableStages
  const outcomes: BaselineStageOutcome[] = []
  let observedFailure: ObservedFailure | null = null
  let terminal: BaselineStageOutcome | null = null
  for (const [index, value] of policy.stageOutcomes.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return unreadableStages
    const row = value as Record<string, unknown>
    const stage = gatewayStages[index]!
    const observed = observedStages.has(stage)
    const enforcement = observed ? 'OBSERVED' : 'ENFORCED'
    if (row.stage !== stage || row.enforcement !== enforcement) return unreadableStages
    const skipped = observed && observedFailure !== null
    if (skipped ? row.outcomeType !== 'SKIPPED' : typeof row.outcomeType !== 'string'
      || !['PASS', 'DENY', 'ERROR'].includes(row.outcomeType)) return unreadableStages
    const outcomeType = row.outcomeType as BaselineStageOutcome['outcomeType']
    if ((outcomeType === 'PASS' || outcomeType === 'SKIPPED')
      ? Object.hasOwn(row, 'reasonCode') : !reason(row.reasonCode)) return unreadableStages
    const outcome = Object.freeze({ stage, enforcement, outcomeType,
      reasonCode: outcomeType === 'PASS' || outcomeType === 'SKIPPED' ? null : row.reasonCode as string })
    outcomes.push(outcome)
    if (outcomeType === 'DENY' && observed) observedFailure = Object.freeze({ stage, reasonCode: outcome.reasonCode! })
    else if (outcomeType === 'DENY' || outcomeType === 'ERROR') {
      if (index !== policy.stageOutcomes.length - 1 || (stage === 'PREFLIGHT' && outcomeType === 'DENY')) return unreadableStages
      terminal = outcome
    }
  }
  if (observedFailure === null
    ? has('observedFailedStage') || has('observedReasonCode')
    : !has('observedFailedStage') || !has('observedReasonCode')
      || policy.observedFailedStage !== observedFailure.stage || policy.observedReasonCode !== observedFailure.reasonCode) return unreadableStages
  if (terminal === null) {
    if (decision !== 'ALLOW' || outcomes.length !== gatewayStages.length || has('failedStage')
      || policy.reasonCode !== 'BASELINE_ALLOW') return unreadableStages
  } else if (decision !== terminal.outcomeType || !has('failedStage') || policy.failedStage !== terminal.stage
    || policy.reasonCode !== terminal.reasonCode) return unreadableStages
  return Object.freeze({ status: 'valid', mode: 'BASELINE', stageOutcomes: Object.freeze(outcomes),
    failedStage: terminal?.stage ?? null, observedFailure })
}

type CallLink = { readonly status: 'absent' | 'unreadable' } | { readonly status: 'id'; readonly id: string }
type StoredEvent = Omit<GatewayPolicyEvent, 'callDetails'> & { readonly eventType: string; readonly callLink: CallLink }
function readCallLink(metadata: unknown): CallLink {
  if (metadata === undefined || metadata === null) return { status: 'absent' }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'unreadable' }
  if (!Object.hasOwn(metadata, 'toolCallId')) return { status: 'absent' }
  const value = (metadata as Record<string, unknown>).toolCallId
  return typeof value === 'string' && uuidPattern.test(value)
    ? { status: 'id', id: value.toLowerCase() } : { status: 'unreadable' }
}
function readEvent(value: unknown, runId: string): StoredEvent {
  const row = object(value)
  if (row.schemaVersion !== '1.0' || uuid(row.runId) !== runId) fail()
  const occurredAt = string(row.occurredAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) fail()
  const policy = row.policyDecision !== null && typeof row.policyDecision === 'object'
    && !Array.isArray(row.policyDecision) ? row.policyDecision as Record<string, unknown> : {}
  // Reason codes are recorded text, not a closed enum or an inferred security outcome.
  const nestedReason = typeof policy.reasonCode === 'string' && policy.reasonCode.length <= 100
    ? policy.reasonCode : null
  const decision = readDecision(policy)
  return Object.freeze({
    eventType: string(row.eventType), eventId: uuid(row.eventId), traceId: uuid(row.traceId), runId,
    testCaseRunId: row.testCaseRunId === null ? null : uuid(row.testCaseRunId),
    sequence: integer(row.sequence), occurredAt, toolName: nullableLabel(row.toolName),
    decision, stageDetails: readStages(policy, decision), callLink: readCallLink(row.metadata),
    reasonCode: nullableLabel(row.reasonCode), decisionReasonCode: nestedReason,
    payloadDigest: hash(row.payloadDigest), eventHash: hash(row.eventHash),
    prevEventHash: row.prevEventHash === null ? null : hash(row.prevEventHash),
  })
}

interface CallGroup {
  context: StoredEvent
  conflict: boolean
  firstSequence: number
  policies: number
  requests: number
  responses: number
  policy?: StoredEvent
  request?: StoredEvent
  response?: StoredEvent
}
function sameCallContext(left: StoredEvent, right: StoredEvent): boolean {
  return left.testCaseRunId !== null && left.toolName !== null && left.toolName.length > 0
    && left.runId === right.runId && left.testCaseRunId === right.testCaseRunId
    && left.traceId === right.traceId && left.toolName === right.toolName
}
function callRef(event: StoredEvent, eventType: CallEventRef['eventType']): CallEventRef {
  return Object.freeze({ eventId: event.eventId, eventType, sequence: event.sequence, occurredAt: event.occurredAt,
    payloadDigest: event.payloadDigest, eventHash: event.eventHash, prevEventHash: event.prevEventHash })
}
function resolveCall(id: string, group: CallGroup, proposal: StoredEvent | undefined): GatewayCallDetails {
  const unreadable = (): GatewayCallDetails => Object.freeze({ status: 'unreadable', toolCallId: id })
  if (!proposal || !sameCallContext(group.context, proposal) || group.conflict
    || proposal.sequence >= group.firstSequence || (group.responses > 0 && group.requests === 0)) return unreadable()
  const counts = Object.freeze({ policies: group.policies, requests: group.requests, responses: group.responses })
  const ambiguous = (): GatewayCallDetails => Object.freeze({ status: 'ambiguous', toolCallId: id, counts })
  if (group.policies > 1 || group.requests > 1 || group.responses > 1) return ambiguous()
  if (group.response && group.request && group.response.sequence <= group.request.sequence) return unreadable()
  if (!group.policy) return unreadable()
  if ((group.request && group.request.sequence < group.policy.sequence)
    || (group.response && group.response.sequence < group.policy.sequence)) return ambiguous()
  return Object.freeze({ status: 'valid', toolCallId: id, proposal: callRef(proposal, 'TOOL_PROPOSED'),
    request: group.request ? callRef(group.request, 'TOOL_REQUEST') : null,
    response: group.response ? callRef(group.response, 'TOOL_RESPONSE') : null })
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
    const policyEvents: StoredEvent[] = []
    const proposals = new Map<string, StoredEvent>()
    const groups = new Map<string, CallGroup>()
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
        if (event.eventType === 'TOOL_PROPOSED') proposals.set(event.eventId, event)
        if (event.eventType === 'POLICY_EVALUATED') policyEvents.push(event)
        if (event.callLink.status === 'id'
          && ['POLICY_EVALUATED', 'TOOL_REQUEST', 'TOOL_RESPONSE'].includes(event.eventType)) {
          const group: CallGroup = groups.get(event.callLink.id) ?? { context: event, conflict: false,
            firstSequence: event.sequence, policies: 0, requests: 0, responses: 0 }
          group.conflict ||= !sameCallContext(group.context, event)
          if (event.eventType === 'POLICY_EVALUATED') { group.policies++; group.policy ??= event }
          if (event.eventType === 'TOOL_REQUEST') { group.requests++; group.request ??= event }
          if (event.eventType === 'TOOL_RESPONSE') { group.responses++; group.response ??= event }
          groups.set(event.callLink.id, group)
        }
      }
      if (after < head && (cursor === null || cursor !== after)) fail('INCOMPLETE_HISTORY')
    } while (after < head)
    // Resolve each explicit call group once, after every captured page passed history checks.
    const calls = new Map<string, GatewayCallDetails>()
    for (const [callId, group] of groups) calls.set(callId, resolveCall(callId, group, proposals.get(callId)))
    const events = policyEvents.map(({ eventType: _, callLink, ...projection }): GatewayPolicyEvent => {
      const callDetails: GatewayCallDetails = callLink.status === 'id' ? calls.get(callLink.id)!
        : callLink.status === 'absent' ? Object.freeze({ status: 'absent' })
          : Object.freeze({ status: 'unreadable', toolCallId: null })
      return Object.freeze({ ...projection, callDetails })
    })
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
