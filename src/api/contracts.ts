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
  | 'VERIFYING'
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
