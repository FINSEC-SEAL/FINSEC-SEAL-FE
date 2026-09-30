export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ApiEnvelope<T> {
  data: T
  traceId: string
  timestamp: string
}

export interface ApiProblem {
  type?: string
  title?: string
  status?: number
  detail?: string
  code?: string
  traceId?: string
  retryable?: boolean
  errors?: Array<{ field?: string; message?: string }>
}

export type AgentStatus = 'ACTIVE' | 'ARCHIVED'

export interface Agent {
  id: string
  agentKey: string
  name: string
  purposeSummary: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
}

export interface AgentCreate {
  agentKey: string
  name: string
  purposeSummary: string
}

export type ReleaseLifecycle =
  | 'DRAFT'
  | 'ANALYZED'
  | 'TESTING'
  | 'REMEDIATION'
  | 'VERIFYING'
  | 'DECISION_PENDING'
  | 'PASS'
  | 'REVIEW'
  | 'BLOCKED'
  | 'NEEDS_REVALIDATION'

export interface Release {
  id: string
  agentId: string
  version: string
  businessPurpose: string
  manifestSchemaVersion: string
  agentArtifactFingerprint: string
  releaseFingerprint: string
  safetyContractHash: string | null
  lifecycleState: ReleaseLifecycle
  effectiveStatus: ReleaseLifecycle
  revalidationReason: JsonValue
  analyzedAt: string | null
  lastTestedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ReleaseDiffComponent {
  component: string
  jsonPointers: string[]
  oldDigest: string | null
  newDigest: string | null
  changed: boolean
  redactedSummary: string
}

export interface ReleaseDiff {
  against: string
  releaseId: string
  components: ReleaseDiffComponent[]
  meaningfulChange: boolean
}

export interface ManifestIssue {
  path: string
  code: string
  severity: 'ERROR' | 'WARNING'
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ManifestIssue[]
}

export interface Fingerprint {
  canonicalizationVersion: string
  agentArtifactFingerprint: string
  releaseFingerprint: string
  safetyContractHash: string | null
  components: Record<string, string>
}

export interface Attestation {
  id: string
  releaseDecisionId: string
  document: Record<string, JsonValue>
  documentHash: string
  generatedAt: string
  disclaimerVersion: string
  stale: boolean
  invalidation: JsonValue
}

export interface AuditRecord {
  id: string
  workspaceId: string
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  beforeDigest: string | null
  afterDigest: string | null
  metadata: JsonValue
  occurredAt: string
}

export interface PendingRecovery {
  idempotencyRecordId: string
  actorId: string
  httpMethod: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  requestPath: string
  idempotencyKey: string
  requestDigest: string
  expiresAt: string
  executionFinishedAt: string
  recoveryReason: string
  createdAt: string
}

export interface RecoveryRequest extends Omit<PendingRecovery, 'idempotencyRecordId' | 'expiresAt' | 'executionFinishedAt' | 'recoveryReason' | 'createdAt'> {
  resolution: 'RELEASE' | 'COMPLETE'
  verificationReference: string
  completedResponse?: {
    status: number
    contentType?: string
    location?: string
    traceId: string
    bodyBase64: string
  }
}

export interface RecoveryResult {
  id: string
  idempotencyRecordId: string
  resolution: 'RELEASE' | 'COMPLETE'
  stateAfterRecovery: 'RELEASED' | 'COMPLETED'
  responseDigest: string | null
  recoveredBy: string
  recoveredAt: string
}

export type OracleOutcome =
  | 'ATTACK_SUCCESS'
  | 'ATTACK_BLOCKED'
  | 'INCONCLUSIVE'
  | 'NORMAL_SUCCESS'
  | 'NORMAL_FAILURE'

export type OracleType =
  | 'CROSS_CUSTOMER'
  | 'SENSITIVE_FIELD'
  | 'EXFILTRATION'
  | 'HIGH_IMPACT_MUTATION'
  | 'NORMAL_TASK'

export interface OracleResult {
  id: string
  runId: string
  testCaseRunId: string
  sourceEventId: string | null
  oracleType: OracleType
  oracleVersion: string
  outcome: OracleOutcome
  reasonCode: string
  invariantId: string
  evidence: JsonValue
  evidenceDigest: string
  evaluatedAt: string
  createdAt: string
}

export interface Finding {
  id: string
  releaseId: string
  sourceOracleResultId: string
  category: string
  severity: string
  title: string
  status: string
  violatedInvariant: string
  rootCause: JsonValue
  findingGroupKey: string | null
  firstSeenRunId: string
  latestSeenRunId: string
  createdAt: string
  updatedAt: string
}

export interface FindingDetail {
  finding: Finding
  oracleResult: OracleResult
  relatedFindings: Finding[]
}

export interface MetricValue {
  name: string
  status: 'AVAILABLE' | 'N_A'
  numerator: number | null
  denominator: number | null
  value: number | null
  reason: string | null
  sourceRunIds: string[]
}

export interface TrialEvaluation {
  runId: string
  caseRunId: string
  mode: string
  caseType: string
  category: string
  severity: string
  status: string
  outcomes: OracleOutcome[]
  reasonCodes: string[]
  forbiddenAttempt: boolean
  policyDeniedBeforeSideEffect: boolean
  operationalError: boolean
}

export interface ReleaseMetrics {
  attackSuccessRate: MetricValue
  attackBlockRate: MetricValue
  heldOutAttackSuccessRate: MetricValue
  normalTaskSuccessRate: MetricValue
  falseBlockRate: MetricValue
  operationalErrorRate: MetricValue
  unauthorizedRecordExposureCount: number | null
  sensitiveFieldExposureCount: number | null
  exfiltrationSuccessCount: number | null
  highImpactMutationCount: number | null
  normalConclusiveTrials: number
  trials: TrialEvaluation[]
}

export interface MetricsView {
  releaseId: string
  metrics: ReleaseMetrics
  /** Forward-compatible B/C replay evidence. The current backend may omit this until orchestration is wired. */
  replaySummary?: ReplaySummary | null
  policyLatency?: PolicyLatency | null
  completionRate?: CompletionRate | null
  trialSuccessDistribution?: TrialSuccessDistribution | null
  attackRateBreakdown?: AttackRateBreakdown | null
  criticalInvariantAnySuccess?: CriticalInvariantAnySuccess | null
}

export type AssuranceStatus = 'AVAILABLE' | 'N_A'

export interface PolicyLatency {
  status: AssuranceStatus
  reason: string | null
  observedEventCount: number
  invalidEventCount: number
  averageMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  sourceEventIds: string[]
  sourceRunIds: string[]
}

export interface CompletionRate {
  status: AssuranceStatus
  reason: string | null
  numerator: number | null
  denominator: number | null
  value: number | null
  cancelledTrials: number | null
  unmaterializedTrials: number | null
  sourceRunIds: string[]
}

export interface TrialBit {
  runId: string
  testCaseId: string
  caseRunId: string
  trialIndex: number
  successBit: 0 | 1 | null
  exclusionReason: string | null
  secondaryInconclusive: boolean
}

export interface CaseTrialDistribution {
  status: AssuranceStatus
  reason: string | null
  runId: string
  mode: string
  testCaseId: string
  caseKey: string
  caseType: string
  category: string
  partition: string
  successBits: Array<0 | 1 | null>
  orderedTrials: TrialBit[]
  successCount: number | null
  trials: number | null
  excludedTrials: number
}

export interface CategoryTrialDistribution {
  status: AssuranceStatus
  reason: string | null
  mode: string
  caseType: string
  category: string
  successBits: Array<0 | 1 | null>
  orderedTrials: TrialBit[]
  successCount: number | null
  trials: number | null
  excludedTrials: number
  sourceRunIds: string[]
}

export interface TrialSuccessDistribution {
  status: AssuranceStatus
  reason: string | null
  cases: CaseTrialDistribution[]
  categories: CategoryTrialDistribution[]
  sourceRunIds: string[]
}

export interface AttackRateGroup {
  status: AssuranceStatus
  reason: string | null
  mode: string
  category: string
  partition: string
  numerator: number | null
  denominator: number | null
  value: number | null
  anySuccess: boolean | null
  excludedTrials: number
  sourceRunIds: string[]
}

export interface AttackRateBreakdown {
  status: AssuranceStatus
  reason: string | null
  groups: AttackRateGroup[]
  sourceRunIds: string[]
}

export interface CriticalInvariantEvidence {
  gcId: string
  invariantId: string
  status: AssuranceStatus
  reason: string | null
  anySuccess: boolean | null
  sourceRunIds: string[]
  sourceCaseRunIds: string[]
  sourceOracleResultIds: string[]
  sourceEventIds: string[]
}

export interface CriticalInvariantAnySuccess {
  invariants: CriticalInvariantEvidence[]
}

export interface CriticalTrialCoverage {
  complete: boolean
  observedRequirementMet: boolean
  status: AssuranceStatus
  reason: string | null
  requiredCategoriesPresent: boolean
  cases: Array<{
    testCaseId: string
    category: string
    partition: string
    mode: string | null
    requiredTrials: number | null
    conclusiveTrials: number
    complete: boolean
    reason: string | null
  }>
}

export interface ReplayComparison {
  baselineRunId: string | null
  replayRunId: string
  category?: string | null
  comparable: boolean
  mismatchReasons: string[]
}

export interface ReplaySummary {
  totalCount: number
  comparableCount: number
  nonComparableCount: number
  evidenceComplete: boolean
  items: ReplayComparison[]
}

export type DecisionValue = 'PASS' | 'REVIEW' | 'BLOCKED'

export interface DecisionProposal {
  releaseId: string
  proposedDecision: DecisionValue
  gatePolicyVersion: string
  inputDigest: string
  inputSnapshot: JsonValue
}

export interface DecisionView {
  id: string
  releaseId: string
  decision: DecisionValue
  gatePolicyVersion: string
  inputDigest: string
  proposedAt: string
  confirmedBy: string
  confirmedAt: string
}

export interface TestSuiteSummary { id:string; releaseId:string; version:string; status:string; suiteHash:string; caseCount:number }
export type TestRunStatus = 'QUEUED'|'PREPARING'|'RUNNING'|'CANCELLING'|'COMPLETED'|'FAILED'|'CANCELLED'
export interface TestRunSummary { id:string; releaseId:string; suiteId:string; mode:'BASELINE'|'SEAL_REPLAY'|'HELD_OUT'|'REGRESSION'; status:TestRunStatus; totalCases:number; completedCases:number; operationalErrorCount:number; latestSequence:number; startedAt:string|null; completedAt:string|null }
export interface TestRun { id:string; releaseId:string; suiteId:string; contractVersionId:string|null; mode:'BASELINE'|'SEAL_REPLAY'|'HELD_OUT'|'REGRESSION'; status:TestRunStatus; agentArtifactFingerprint:string; releaseFingerprint:string; fixtureVersion:string; fixtureDigest:string; totalCases:number; completedCases:number; operationalErrorCount:number; latestSequence:number; latestEventType:string|null; eventHeadHash:string|null; summary:JsonValue; startedAt:string|null; completedAt:string|null; createdAt:string }
export interface ExecutionEvent { schemaVersion:string; eventId:string; traceId:string; runId:string; testCaseRunId:string|null; sequence:number; occurredAt:string; eventType:string; toolName:string|null; input:JsonValue; output:JsonValue; payloadDigest:string; policyDecision:JsonValue; reasonCode:string|null; metadata:JsonValue; prevEventHash:string|null; eventHash:string }
export interface EventHistory { items:ExecutionEvent[]; headSequence:number; nextCursor:number|null }
export interface EventChainVerification { runId:string; valid:boolean; eventCount:number; firstInvalidSequence:number|null; headHash:string|null }
export interface TestRunStart { releaseId:string; suiteId:string; mode:TestRun['mode']; contractVersionId:string|null; caseIds:string[]; randomSeed:number|null }
export interface TestRunRegistered { runId:string; status:'QUEUED'; statusUrl:string; streamUrl:string }
