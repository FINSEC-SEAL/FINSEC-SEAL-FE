import { fireEvent, render, screen, within } from '@testing-library/react'
import { PolicyReviewDetails } from './PolicyReviewDetails'
import type { StoredContractReview } from './wire'

const identity = {
  versionId: '019903ac-abcd-7000-8000-000000000003',
  workspaceId: '019903ac-abcd-7000-8000-000000000001',
  releaseId: '019903ac-abcd-7000-8000-000000000002',
  contractKey: 'loan-review-default', version: 7,
}
const otherId = '019903ac-abcd-7000-8000-000000000004'
const policyHash = `sha256:${'a'.repeat(64)}`
const resourceHash = `sha256:${'b'.repeat(64)}`
const baseHash = `sha256:${'c'.repeat(64)}`

// Field layout follows BE fixtures/loan-review-safety-contract.json; the selected version is historical.
const policy = {
  schemaVersion: '1.0', contractId: identity.contractKey, version: identity.version,
  purpose: 'LOAN_DOCUMENT_COMPLETENESS_REVIEW',
  allowedTools: ['CASE_CONTEXT_READ', 'DOCUMENT_READER', 'CUSTOMER_DATA_READ', 'LOAN_POLICY_SEARCH', 'REVIEW_NOTE_WRITE'],
  resourcePolicies: {
    DOCUMENT_READER: { caseScope: 'CURRENT_CASE_ONLY', documentScope: 'ALLOWED_DOCUMENTS_ONLY' },
    REVIEW_NOTE_WRITE: { caseScope: 'CURRENT_CASE_ONLY' },
  },
  customerScope: { type: 'CURRENT_APPLICANT_ONLY' },
  fieldPolicy: { CUSTOMER_DATA_READ: { allowed: ['incomeBand', 'employmentStatus'], denyUnknown: true } },
  cardinality: { CUSTOMER_DATA_READ: { maxRequestedRecords: 1, maxReturnedRecords: 1 } },
  externalEgress: { allowed: false, allowedDestinations: [] },
  workflow: { allowedStages: ['DOCUMENT_REVIEW'] },
  highImpactActions: { LOAN_DECISION_UPDATE: 'HUMAN_ONLY' },
  toolTrust: { requireTrustedTool: true, allowedTrustLevels: ['TRUSTED_INTERNAL'] },
  outputPolicy: { reviewStatusAllowed: ['READY_FOR_HUMAN_REVIEW', 'NEEDS_MORE_DOCUMENTS'] },
  metadata: { templateVersion: 'loan-review/1', validatorVersion: '1.0' },
}

function storedReview(overrides: Partial<StoredContractReview> = {}): StoredContractReview {
  return {
    identity, state: 'VALIDATED', policyHash, resourceHash,
    storedPolicyJson: JSON.stringify(policy, null, 2), canonicalPolicyJson: JSON.stringify(policy),
    baseline: { identity: { ...identity, versionId: otherId, contractKey: 'earlier-policy', version: 1 }, policyHash: baseHash },
    validation: { status: 'VALID', issues: [] }, review: null,
    changes: [{ pointer: '/version', kind: 'MODIFIED', beforeJson: '1', afterJson: '7' }],
    ...overrides,
  }
}

describe('stored policy review details', () => {
  it('displays actual identity, every rule section and the recorded historical baseline without network calls', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<PolicyReviewDetails review={storedReview()} />)
    const identityTable = within(screen.getByRole('table', { name: '저장 계약 식별자' }))
    for (const value of [identity.contractKey, identity.versionId, identity.workspaceId, identity.releaseId, policyHash, resourceHash]) {
      expect(identityTable.getByText(value)).toBeInTheDocument()
    }
    for (const title of ['기본 정보', '허용 도구', '객체·고객 범위', '허용 필드', '조회·반환 건수', '외부 반출', '업무 단계', '사람 전용 행동', '도구 신뢰', '검토 결과', '템플릿·검증기']) {
      expect(screen.getByRole('table', { name: title })).toBeInTheDocument()
    }
    const expectedRules = [
      ['허용 도구', 'CUSTOMER_DATA_READ'], ['객체·고객 범위', 'CURRENT_APPLICANT_ONLY'],
      ['객체·고객 범위', 'ALLOWED_DOCUMENTS_ONLY'], ['허용 필드', 'incomeBand'],
      ['허용 필드', 'employmentStatus'], ['조회·반환 건수', 'maxRequestedRecords'],
      ['조회·반환 건수', 'maxReturnedRecords'],
      ['업무 단계', 'DOCUMENT_REVIEW'], ['사람 전용 행동', 'HUMAN_ONLY'],
      ['도구 신뢰', 'TRUSTED_INTERNAL'], ['검토 결과', 'NEEDS_MORE_DOCUMENTS'],
      ['템플릿·검증기', 'loan-review/1'],
    ] as const
    for (const [title, value] of expectedRules) expect(screen.getByRole('table', { name: title }).textContent).toContain(value)
    expect(within(screen.getByRole('table', { name: '외부 반출' })).getByText('false')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: '외부 반출' })).getByText('빈 목록 []')).toBeInTheDocument()
    const baseline = within(screen.getByRole('table', { name: '승인 비교 기준 식별자' }))
    expect(baseline.getByText('earlier-policy')).toBeInTheDocument()
    expect(baseline.getByText(baseHash)).toBeInTheDocument()
    expect(baseline.getByText(otherId)).toBeInTheDocument()
    expect(screen.queryByText('승인 시각')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps raw and canonical JSON text exact across the accessible toggle', () => {
    const storedPolicyJson = '{\r\n "schemaVersion":"1.0", "contractId":"loan-review-default", "version":7, "purpose":"검토\\r\\n\\\"확인\\\""\r\n}'
    const canonicalPolicyJson = '{"contractId":"loan-review-default","purpose":"검토\\r\\n\\\"확인\\\"","schemaVersion":"1.0","version":7}'
    render(<PolicyReviewDetails review={storedReview({ storedPolicyJson, canonicalPolicyJson })} />)
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
    expect(screen.getByRole('button', { name: '저장 JSON', pressed: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Canonical JSON' }))
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(canonicalPolicyJson)
    expect(screen.getByRole('button', { name: 'Canonical JSON', pressed: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '저장 JSON' }))
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
  })

  it('shows exact numeric source tokens in rule cells without rounding them', () => {
    const storedPolicyJson = '{"schemaVersion":"1.0","contractId":"loan-review-default","version":7,"cardinality":{"CUSTOMER_DATA_READ":{"maxRequestedRecords":9007199254740993,"maxReturnedRecords":1.0000000000000001},"EXTRA_TOOL":{"maxRequestedRecords":1e-500,"maxReturnedRecords":-0}}}'
    render(<PolicyReviewDetails review={storedReview({ storedPolicyJson })} />)
    const counts = within(screen.getByRole('table', { name: '조회·반환 건수' }))
    for (const value of ['9007199254740993', '1.0000000000000001', '1e-500', '-0']) expect(counts.getByText(value)).toBeInTheDocument()
    expect(counts.queryByText('9007199254740992')).not.toBeInTheDocument()
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
  })

  it('falls back to the entire unchanged raw policy when native numeric context is unavailable', () => {
    const originalParse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => originalParse(text, (key, value: unknown) => reviver ? reviver(key, value) : value))
    const storedPolicyJson = '{"schemaVersion":"1.0","version":7,"cardinality":{"TOOL":{"maxRequestedRecords":9007199254740993}}}'
    render(<PolicyReviewDetails review={storedReview({ storedPolicyJson })} />)
    expect(screen.getByLabelText('규칙 원문 대체 표시').textContent).toBe(storedPolicyJson)
    expect(screen.queryByRole('table', { name: '조회·반환 건수' })).not.toBeInTheDocument()
    expect(screen.queryByText('9007199254740992')).not.toBeInTheDocument()
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
  })

  it.each(['{', '[]', 'null', '{"schemaVersion":"1.0","futureRule":{"value":1}}'])('uses safe raw fallback for unsupported content %s', storedPolicyJson => {
    render(<PolicyReviewDetails review={storedReview({ storedPolicyJson })} />)
    expect(screen.getByLabelText('규칙 원문 대체 표시').textContent).toBe(storedPolicyJson)
    expect(screen.queryByRole('table', { name: '허용 도구' })).not.toBeInTheDocument()
    expect(screen.queryByText(/SyntaxError/)).not.toBeInTheDocument()
  })

  it('shows missing rules and absent metadata even for a later candidate version', () => {
    render(<PolicyReviewDetails review={storedReview({
      state: 'CANDIDATE', baseline: null, validation: null, review: null,
      storedPolicyJson: '{"schemaVersion":"1.0","contractId":"loan-review-default","version":7}',
      changes: [{ pointer: '', kind: 'ADDED', beforeJson: null, afterJson: 'null' }],
    })} />)
    expect(within(screen.getByRole('table', { name: '허용 도구' })).getByText('저장된 규칙 없음')).toBeInTheDocument()
    expect(screen.getByText('기록된 승인 기준본이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('저장된 검증 결과가 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('저장된 검토 기록이 없습니다.')).toBeInTheDocument()
    const changes = within(screen.getByRole('table', { name: '계약 변경 내역' }))
    expect(changes.getByText('문서 전체')).toBeInTheDocument()
    expect(changes.getByText('값 없음')).toBeInTheDocument()
    expect(screen.getByLabelText('변경 이후 문서 전체').textContent).toBe('null')
    expect(screen.queryByRole('table', { name: '승인 비교 기준 식별자' })).not.toBeInTheDocument()
  })

  it('renders supplied changes exactly and never derives a replacement diff', () => {
    const beforeJson = '"검토\\r\\n이전"'
    const afterJson = '{\r\n"limit":9007199254740993, "text":"검토\\n이후"\r\n}'
    const { rerender } = render(<PolicyReviewDetails review={storedReview({ changes: [
      { pointer: '/a~1b/~0name', kind: 'MODIFIED', beforeJson, afterJson },
      { pointer: '/removed', kind: 'REMOVED', beforeJson: 'null', afterJson: null },
    ] })} />)
    expect(screen.getByLabelText('변경 이전 /a~1b/~0name').textContent).toBe(beforeJson)
    expect(screen.getByLabelText('변경 이후 /a~1b/~0name').textContent).toBe(afterJson)
    expect(screen.getByLabelText('변경 이전 /removed').textContent).toBe('null')
    expect(screen.getByText('REMOVED')).toBeInTheDocument()
    rerender(<PolicyReviewDetails review={storedReview({ changes: [] })} />)
    expect(screen.getByText('서버 비교 결과에 변경 항목이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '계약 변경 내역' })).not.toBeInTheDocument()
    expect(screen.queryByText(/보안.*동일/)).not.toBeInTheDocument()
  })

  it.each(['INVALID', 'WARN'] as const)('renders every supplied %s issue and public review field without invented results', status => {
    const issue = { jsonPointer: '/fieldPolicy/CUSTOMER_DATA_READ/allowed', code: 'EXCESSIVE_PRIVILEGE',
      severity: status === 'INVALID' ? 'ERROR' as const : 'WARNING' as const, message: '저장된 검증 내용\r\n검토' }
    const comment = '검토 의견\r\n정확한 변경 내용'
    render(<PolicyReviewDetails review={storedReview({
      validation: { status, issues: [issue] },
      review: { actorId: 'reviewer-c', role: 'AI_SECURITY_REVIEWER', comment, decision: 'REJECTED' },
    })} />)
    const issues = within(screen.getByRole('table', { name: '저장된 검증 오류와 경고' }))
    expect(issues.getByText(issue.severity)).toBeInTheDocument()
    expect(issues.getByText(issue.jsonPointer)).toBeInTheDocument()
    expect(issues.getByText(issue.code)).toBeInTheDocument()
    expect(issues.getByText(/저장된 검증 내용/).textContent).toBe(issue.message)
    const metadata = within(screen.getByRole('table', { name: '저장된 검토 기록' }))
    for (const value of ['reviewer-c', 'AI_SECURITY_REVIEWER', 'REJECTED']) expect(metadata.getByText(value)).toBeInTheDocument()
    expect(metadata.getByText(/검토 의견\s+정확한/).textContent).toBe(comment)
    expect(screen.getByText('정상업무 영향과 실제 공격 방어 결과는 이 조회에 포함되지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByText('승인 시각')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '승인' })).not.toBeInTheDocument()
  })

  it('renders hostile strings and destinations as text without active markup or links', () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(1)</script>'
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const storedPolicyJson = JSON.stringify({ ...policy, purpose: attack,
      externalEgress: { allowed: true, allowedDestinations: ['javascript:alert(1)'] } })
    const { container } = render(<PolicyReviewDetails review={storedReview({ storedPolicyJson,
      review: { actorId: attack, role: attack, comment: attack, decision: attack },
      changes: [{ pointer: '/purpose', kind: 'ADDED', beforeJson: null, afterJson: JSON.stringify(attack) }],
    })} />)
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
    expect(screen.getByRole('table', { name: '외부 반출' }).textContent).toContain('javascript:alert(1)')
    expect(container.querySelector('img, script, a')).toBeNull()
    expect(alert).not.toHaveBeenCalled()
  })

  it.each(['APPROVED', 'REJECTED', 'SUPERSEDED'] as const)('shows terminal %s read-only and replaces evidence on a different target', state => {
    const { rerender } = render(<PolicyReviewDetails review={storedReview({ state })} />)
    expect(screen.getByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /승인|거절|검증/ })).not.toBeInTheDocument()
    const storedPolicyJson = JSON.stringify({ ...policy, contractId: 'new-policy', version: 8 })
    rerender(<PolicyReviewDetails review={storedReview({
      identity: { ...identity, versionId: otherId, contractKey: 'new-policy', version: 8 },
      state: 'CANDIDATE', policyHash: baseHash, storedPolicyJson, baseline: null, changes: [], validation: null,
    })} />)
    const table = within(screen.getByRole('table', { name: '저장 계약 식별자' }))
    expect(table.getByText('new-policy')).toBeInTheDocument()
    expect(table.queryByText(identity.versionId)).not.toBeInTheDocument()
    expect(table.queryByText(policyHash)).not.toBeInTheDocument()
    expect(screen.queryByText('이 버전은 읽기 전용입니다.')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('변경 이후 /version')).not.toBeInTheDocument()
    expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedPolicyJson)
  })
})
