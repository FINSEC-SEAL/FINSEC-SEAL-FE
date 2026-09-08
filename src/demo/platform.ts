import type { PlatformClient } from '../api/client'
import type { Agent, AuditRecord, JsonValue, PendingRecovery, Release } from '../api/contracts'

export const DEMO_AGENT_ID = '0198f200-0000-7000-8000-000000000001'
export const DEMO_RELEASE_ID = '0198f200-0000-7000-8000-000000000002'
const date = '2026-09-06T05:28:00Z'
const digest = (letter: string) => `sha256:${letter.repeat(64)}`
export const demoManifest = JSON.stringify({ schemaVersion: '1.0', version: '1.3.0', businessPurpose: '서류 완전성 검토, 대출 결정 아님', dataMode: 'SYNTHETIC_ONLY' }, null, 2)

// Deliberately separate from the HTTP client. This adapter never calls fetch or
// persists user input. It is an interactive UI fixture, not a security validator.
export function createDemoPlatform(): PlatformClient & { setReportReady: (ready: boolean) => void } {
  let sequence = 20
  const id = () => `0198f200-0000-7000-8000-${String(++sequence).padStart(12, '0')}`
  let reportReady = false
  let agents: Agent[] = [{ id: DEMO_AGENT_ID, agentKey: 'loan-document-review-agent', name: '대출서류 검토 Agent', purposeSummary: '서류 누락과 추가 확인 항목을 구조화합니다. 대출 승인·거절·실거래는 수행하지 않습니다.', status: 'ACTIVE', createdAt: date, updatedAt: date }]
  let releases: Release[] = ['1.2.0', '1.1.0', '1.0.0'].map((version, i) => ({
    id: i === 0 ? DEMO_RELEASE_ID : `0198f200-0000-7000-8000-00000000000${i + 2}`,
    agentId: DEMO_AGENT_ID, version, businessPurpose: '대출서류 완전성 검토', manifestSchemaVersion: '1.0',
    agentArtifactFingerprint: digest('a'), releaseFingerprint: digest('b'), safetyContractHash: null,
    lifecycleState: i === 2 ? 'DRAFT' : 'ANALYZED', effectiveStatus: i === 1 ? 'NEEDS_REVALIDATION' : i === 2 ? 'DRAFT' : 'ANALYZED',
    revalidationReason: i === 1 ? { reason: 'PROMPT_CHANGE' } : null, analyzedAt: i === 2 ? null : date, lastTestedAt: null, createdAt: date, updatedAt: date,
  }))
  const manifests = new Map<string, JsonValue>()
  const audits: AuditRecord[] = [{ id: id(), workspaceId: DEMO_AGENT_ID, actorId: 'reviewer-demo', action: 'RELEASE_ANALYZED', resourceType: 'AGENT_RELEASE', resourceId: DEMO_RELEASE_ID, beforeDigest: null, afterDigest: digest('b'), metadata: { simulated: true, scope: 'SYNTHETIC_ONLY' }, occurredAt: date }]
  let pending: PendingRecovery[] = [{ idempotencyRecordId: id(), actorId: 'role-a-console', httpMethod: 'POST', requestPath: '/api/v1/test-runs', idempotencyKey: 'demo-key-1', requestDigest: digest('d'), expiresAt: date, executionFinishedAt: date, recoveryReason: 'HTTP_5XX_RESPONSE', createdAt: date }]
  const get = (releaseId: string) => { const r = releases.find(r => r.id === releaseId); if (!r) throw new Error('합성 Release를 찾을 수 없습니다.'); return r }
  return {
    setReportReady(ready) { reportReady = ready },
    async listAgents() { return [...agents] },
    async listReleases(agentId) { return releases.filter(r => r.agentId === agentId) },
    async createAgent(input) {
      if (agents.some(a => a.agentKey === input.agentKey)) throw new Error('이미 등록된 Agent key입니다.')
      const agent: Agent = { ...input, id: id(), status: 'ACTIVE', createdAt: date, updatedAt: date }
      agents = [...agents, agent]; return agent
    },
    async archiveAgent(agentId) {
      const agent = agents.find(a => a.id === agentId)
      if (!agent) throw new Error('에이전트를 찾을 수 없습니다.')
      const archived: Agent = { ...agent, status: 'ARCHIVED' }
      agents = agents.map(a => a.id === agentId ? archived : a); return archived
    },
    async createRelease(agentId, manifest) {
      if (!agents.some(a => a.id === agentId && a.status === 'ACTIVE')) throw new Error('활성 에이전트를 선택하세요.')
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.version !== 'string' || typeof manifest.businessPurpose !== 'string') throw new Error('체험용 기본 검사: version과 businessPurpose 문자열이 필요합니다. 실제 strict schema 검사는 API 연결 모드에서 수행합니다.')
      if (releases.some(r => r.agentId === agentId && r.version === manifest.version)) throw new Error('이미 등록된 버전입니다.')
      const r: Release = { ...get(DEMO_RELEASE_ID), id: id(), agentId, version: manifest.version, businessPurpose: manifest.businessPurpose, lifecycleState: 'DRAFT', effectiveStatus: 'DRAFT', agentArtifactFingerprint: '', releaseFingerprint: '', analyzedAt: null }
      manifests.set(r.id, manifest); releases = [r, ...releases]; return r
    },
    async validateRelease(releaseId) { get(releaseId); return { valid: true, issues: [{ path: '/', code: 'DEMO_ONLY', severity: 'WARNING', message: '체험용 기본 구조 검사입니다. 실제 strict schema·해시·보안 검증이 아닙니다.' }] } },
    async analyzeRelease(releaseId) {
      const r = get(releaseId)
      const next: Release = { ...r, lifecycleState: 'ANALYZED', effectiveStatus: 'ANALYZED', analyzedAt: date, agentArtifactFingerprint: digest('a'), releaseFingerprint: digest('b') }
      releases = releases.map(item => item.id === releaseId ? next : item)
      audits.unshift({ ...audits[0]!, id: id(), resourceId: releaseId, metadata: { simulated: true, structuralPreviewOnly: true } }); return next
    },
    async fingerprint(releaseId) {
      const r = get(releaseId); if (r.lifecycleState === 'DRAFT') throw new Error('먼저 구성을 분석하세요.')
      return { canonicalizationVersion: 'DEMO_ONLY', agentArtifactFingerprint: r.agentArtifactFingerprint, releaseFingerprint: r.releaseFingerprint, safetyContractHash: null, components: { 'System prompt · 합성 hash': digest('a'), 'Tools · 합성 hash': digest('c'), 'Fixture · 합성 hash': digest('f') } }
    },
    async attestation(releaseId) {
      const r = get(releaseId)
      const historicalFixture = releaseId === '0198f200-0000-7000-8000-000000000003'
      if (!historicalFixture && (releaseId !== DEMO_RELEASE_ID || !reportReady)) throw new Error('아직 완료된 보고서가 없습니다. 사전 구성된 샘플에서 재검증과 추가 검증을 완료하세요. 직접 등록한 대상의 실제 검증은 API 연동이 필요합니다.')
      return { id: 'demo-attestation', releaseDecisionId: 'demo-decision', document: { simulated: true, reportType: 'DEMO_ONLY', decision: { value: releaseId === DEMO_RELEASE_ID ? 'BLOCKED' : 'REVIEW' }, source: '합성 UI fixture · 서버 판정 아님', metrics: { heldout: '1/40', normalSuccess: '29/30' }, disclaimer: 'Internal assessment. Not official certification.' }, documentHash: digest('e'), generatedAt: date, disclaimerVersion: 'finsec-internal/v1', stale: r.effectiveStatus === 'NEEDS_REVALIDATION', invalidation: r.revalidationReason }
    },
    async downloadAttestation() { throw new Error('DEMO_ONLY 보고서는 실제 증적으로 내보낼 수 없습니다.') },
    async audit(resourceType, resourceId) { return audits.filter(r => r.resourceType === resourceType && r.resourceId === resourceId) },
    async pendingRecoveries(key, actor) { if (key.length < 32 || !actor.startsWith('operator:')) throw new Error('샘플 운영자를 먼저 설정하세요.'); return [...pending] },
    async recover(input, key, actor) {
      if (key.length < 32 || !actor.startsWith('operator:')) throw new Error('운영자 설정이 필요합니다.')
      const request = pending.find(p => p.idempotencyKey === input.idempotencyKey && p.requestDigest === input.requestDigest)
      if (!request) throw new Error('현재 대기열과 요청 digest가 다릅니다.')
      if (!input.verificationReference || (input.resolution === 'COMPLETE' && !input.completedResponse?.traceId)) throw new Error('검증 근거와 원본 응답 정보를 확인하세요.')
      pending = pending.filter(p => p.idempotencyRecordId !== request.idempotencyRecordId)
      const recoveryId = id()
      audits.unshift({ ...audits[0]!, id: id(), actorId: actor, action: `DEMO_RECOVERY_${input.resolution}`, resourceType: 'IDEMPOTENCY_RECOVERY', resourceId: recoveryId, metadata: { simulated: true } })
      return { id: recoveryId, idempotencyRecordId: request.idempotencyRecordId, resolution: input.resolution, stateAfterRecovery: input.resolution === 'RELEASE' ? 'RELEASED' : 'COMPLETED', responseDigest: null, recoveredBy: actor, recoveredAt: date }
    },
    async listTestSuites() { return [] },
    async listTestRuns() { return [] },
    async listReplayComparisons() { return [] },
    async startTestRun() { throw new Error('체험 모드에서는 실제 Test Run을 시작할 수 없습니다.') },
    async testRun() { throw new Error('체험 모드에는 조회할 실제 Test Run이 없습니다.') },
  }
}
