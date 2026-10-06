import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { Fingerprint, Release } from './api/contracts'
import { LiveReleaseOverviewPage } from './features/ReleaseOverview'
import type { StoredContractReview } from './features/policy/wire'
import { mainNavigation, pageLabels } from './product/model'

const envelope = (data: unknown) => new Response(JSON.stringify({ data, traceId: 'trace-test', timestamp: '2026-09-01T00:00:00Z' }), { status: 200 })
beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => window.history.replaceState(null, '', '/'))

describe('FINAgent SEAL product shell', () => {
  it('starts in clearly marked simulated mode without calling an API', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    expect(await screen.findByRole('heading', { name: /에이전트의 위험한 행동/ })).toBeInTheDocument()
    expect(screen.getByText('SIMULATED · 합성 체험')).toBeInTheDocument()
    expect(screen.getByText('Internal assessment. Not official certification.')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(mainNavigation)('opens the %s menu without a server dependency', async page => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    window.history.replaceState(null, '', '/#/demo/' + page)
    render(<App />)
    await waitFor(() => expect(screen.queryByText('워크스페이스 정보를 불러오는 중')).not.toBeInTheDocument())
    const nav = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(nav.getByRole('button', { name: new RegExp(pageLabels[page]) })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('filters agents and keeps navigation addressable in the URL', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: /에이전트의 위험한 행동/ })
    await user.click(screen.getByRole('button', { name: /^에이전트$/ }))
    expect(screen.getByRole('heading', { name: '에이전트 관리' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/demo/agents')
    await user.type(screen.getByLabelText('에이전트 검색'), 'no-match')
    expect(screen.getByRole('heading', { name: '검색 결과 없음' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '필터 초기화' }))
    expect(screen.getByRole('heading', { name: '대출서류 검토 Agent' })).toBeInTheDocument()
  })

  it('loads real inventory only in API mode and does not invent runtime metrics', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
      String(input).endsWith('/api/v1/agents') ? envelope([{ id:'agent-1', agentKey:'loan-agent', name:'Live Agent', purposeSummary:'Document review', status:'ACTIVE', createdAt:'2026-09-01T00:00:00Z', updatedAt:'2026-09-01T00:00:00Z' }]) : envelope([]))
    render(<App />)
    expect(await screen.findByRole('heading', { name: '검증 워크스페이스' })).toBeInTheDocument()
    expect(screen.getByText('실행 집계 미연결')).toBeInTheDocument()
    expect(screen.getAllByText('N/A', { selector: '.metric-card strong' })).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('SIMULATED · 합성 체험')).not.toBeInTheDocument()
  })

  it('never silently falls back to synthetic data when the API fails', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection refused')
    expect(screen.getByText('API 연결을 확인해 주세요.')).toBeInTheDocument()
    expect(screen.queryByText('대출서류 검토 Agent')).not.toBeInTheDocument()
  })

  it('marks unconnected runtime pages explicitly in LIVE_API', async () => {
    window.history.replaceState(null, '', '/#/live/states')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([]))
    render(<App />)
    expect(await screen.findByText('실제 데이터와 합성 결과를 섞지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name:'승인 범위 확인 · 재검증' })).not.toBeInTheDocument()
  })

  it('requires human approval, handles conflicts, then shows comparison and a blocked sample report', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    window.history.replaceState(null, '', '/#/demo/policy')
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: '승인 범위 확인 · 재검증' }))
    const dialog = screen.getByRole('dialog')
    const approve = within(dialog).getByRole('button', { name:'샘플 승인 후 재검증' })
    expect(approve).toBeDisabled()
    await user.type(within(dialog).getByLabelText('검토 의견'), '고객 범위와 정상업무 영향 확인')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name:'버전 충돌 상태 체험' }))
    expect(approve).toBeDisabled()
    expect(within(dialog).getByText('409 · STALE_BASE_HASH')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name:'최신 diff 다시 검토' }))
    expect(within(dialog).getByLabelText('검토 의견')).toHaveValue('고객 범위와 정상업무 영향 확인')
    expect(approve).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(approve)
    expect(await screen.findByText('동일 조건 비교 가능 · 정책 v1 → v2 변경', {}, { timeout:4000 })).toBeInTheDocument()
    expect(screen.getByText('ATTACK_BLOCKED')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name:'Held-out · 정상업무 검증 →' }))
    await user.click(screen.getByRole('button', { name:'합성 추가 검증 실행' }))
    await user.click(await screen.findByRole('button', { name:'판정 근거 검토 →' }, { timeout:4000 }))
    expect(screen.getByText('BLOCKED · 출시 보류 · 남은 위험을 먼저 해결하세요.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name:'DEMO_ONLY · HTML / JSON 비활성' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name:'최종 판정 확인창 보기' }))
    expect(screen.getByRole('button', { name:'SIMULATED · 실제 확정 비활성' })).toBeDisabled()
    expect(fetch).not.toHaveBeenCalled()
  }, 12000)

  it('blocks reset while running and preserves a cancelled state', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name:'샘플 검증 체험 →' }))
    await user.click(screen.getByRole('button', { name:'데모 초기화' }))
    expect(screen.getByRole('button', { name:'샘플 검증 초기화' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name:'돌아가기' }))
    await user.click(screen.getByRole('button', { name:'실행 취소 요청' }))
    expect(screen.getByText('실행 취소됨 · 부분 증거 보존')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name:'데모 초기화' }))
    await user.click(screen.getByRole('button', { name:'샘플 검증 초기화' }))
    expect(screen.getByText('아직 시험하지 않았습니다.')).toBeInTheDocument()
  })

  it('supports hash navigation and restores a known route', async () => {
    render(<App />)
    await screen.findByRole('heading', { name:/에이전트의 위험한 행동/ })
    act(() => { window.location.hash = '/demo/reports'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByRole('heading', { name:'검증 보고서' })).toBeInTheDocument()
  })
})

const liveAgentId = '019903ac-abcd-7000-8000-000000000001'
const liveReleaseId = '019903ac-abcd-7000-8000-000000000002'
const selectedReleaseId = '019903ac-abcd-7000-8000-000000000012'
const liveVersionId = '019903ac-abcd-7000-8000-000000000003'
const reviewerKey = 'SYNTHETIC_APP_REVIEWER_CANARY_0123456789'
const resourceHash = `sha256:${'b'.repeat(64)}`
const policyHash = `sha256:${'a'.repeat(64)}`
const consent = '정책 변경 내용과 검토 의견을 확인했습니다.'

function storedReview(): StoredContractReview {
  const policy = { schemaVersion: '1.0', contractId: 'live-loan-review', version: 7,
    purpose: 'LOAN_DOCUMENT_COMPLETENESS_REVIEW',
    allowedTools: ['CASE_CONTEXT_READ', 'DOCUMENT_READER', 'CUSTOMER_DATA_READ', 'LOAN_POLICY_SEARCH', 'REVIEW_NOTE_WRITE'],
    resourcePolicies: { DOCUMENT_READER: { caseScope: 'CURRENT_CASE_ONLY', documentScope: 'ALLOWED_DOCUMENTS_ONLY' }, REVIEW_NOTE_WRITE: { caseScope: 'CURRENT_CASE_ONLY' } },
    customerScope: { type: 'CURRENT_APPLICANT_ONLY' }, fieldPolicy: { CUSTOMER_DATA_READ: { allowed: ['incomeBand', 'employmentStatus'], denyUnknown: true } },
    cardinality: { CUSTOMER_DATA_READ: { maxRequestedRecords: 1, maxReturnedRecords: 1 } },
    externalEgress: { allowed: false, allowedDestinations: [] }, workflow: { allowedStages: ['DOCUMENT_REVIEW'] },
    highImpactActions: { LOAN_DECISION_UPDATE: 'HUMAN_ONLY' }, toolTrust: { requireTrustedTool: true, allowedTrustLevels: ['TRUSTED_INTERNAL'] },
    outputPolicy: { reviewStatusAllowed: ['READY_FOR_HUMAN_REVIEW', 'NEEDS_MORE_DOCUMENTS'] }, metadata: { templateVersion: 'loan-review/1', validatorVersion: '1.0' } }
  return { identity: { versionId: liveVersionId, workspaceId: liveAgentId, releaseId: selectedReleaseId, contractKey: 'live-loan-review', version: 7 },
    state: 'VALIDATED', policyHash, resourceHash, storedPolicyJson: JSON.stringify(policy, null, 2), canonicalPolicyJson: JSON.stringify(policy),
    baseline: null, validation: { status: 'VALID', issues: [] }, review: null,
    changes: [{ pointer: '', kind: 'ADDED', beforeJson: null, afterJson: JSON.stringify(policy, null, 2) }] }
}

function platformContract(review: StoredContractReview) {
  return { id: review.identity.versionId, workspaceId: review.identity.workspaceId, releaseId: review.identity.releaseId,
    contractKey: review.identity.contractKey, version: review.identity.version, state: review.state,
    policyHash: review.policyHash, resourceHash: review.resourceHash, policy: { private: reviewerKey }, review: { sessionId: reviewerKey } }
}

// Synthetic HTTP fixtures cross the real inventory client and the C client, wire and review page.
function livePolicyApi() {
  let current = storedReview()
  const releaseRows = (): Release[] => [liveReleaseId, selectedReleaseId].map((id, index) => ({
    id, agentId: liveAgentId, version: `${index + 1}.0.0`, businessPurpose: '대출 서류 검토', manifestSchemaVersion: '1.0',
    agentArtifactFingerprint: policyHash, releaseFingerprint: policyHash, safetyContractHash: policyHash,
    lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW', revalidationReason: null, analyzedAt: '2026-09-07T00:00:00Z',
    lastTestedAt: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
  }))
  const handlers = { review: () => envelope(current) }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/v1/agents') return envelope([{ id: liveAgentId, agentKey: 'live-loan-agent', name: 'Live Loan Agent', purposeSummary: 'Document review', status: 'ACTIVE', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }])
    if (url.pathname === `/api/v1/agents/${liveAgentId}/releases`) return envelope(releaseRows())
    const release = releaseRows().find(item => url.pathname === `/api/v1/releases/${item.id}` || url.pathname === `/api/v1/releases/${item.id}/fingerprint`)
    if (release && url.pathname.endsWith('/fingerprint')) return envelope({
      canonicalizationVersion: '1.0', agentArtifactFingerprint: release.agentArtifactFingerprint,
      releaseFingerprint: release.releaseFingerprint, safetyContractHash: release.safetyContractHash,
      components: { systemPromptHash: policyHash },
    })
    if (release) return envelope(release)
    if (url.pathname === '/api/v1/platform/contracts') return envelope(url.searchParams.get('releaseId') === selectedReleaseId ? [platformContract(current)] : [])
    if (url.pathname === `/api/v1/platform/contracts/${liveVersionId}/review`) return handlers.review()
    if (init.method === 'POST' && url.pathname === `/api/v1/contract-versions/${liveVersionId}:approve`) {
      current = { ...current, state: 'APPROVED', resourceHash: `sha256:${'c'.repeat(64)}` }
      return envelope(platformContract(current))
    }
    throw new Error('Unexpected synthetic app HTTP route')
  })
  const contracts = () => fetch.mock.calls.filter(([input]) => {
    const path = new URL(String(input), window.location.origin).pathname
    return path.startsWith('/api/v1/platform/contracts') || path.startsWith('/api/v1/contract-versions/')
  })
  return { fetch, handlers, contracts, posts: () => contracts().filter(([, init]) => init?.method === 'POST') }
}

const otherAgentId = '019903ac-abcd-7000-8000-000000000021'
const otherReleaseId = '019903ac-abcd-7000-8000-000000000022'
const diffData = {
  against: liveReleaseId, releaseId: selectedReleaseId, meaningfulChange: true,
  components: [{ component: 'serverToolCatalogHash', jsonPointers: ['/serverToolCatalog'],
    oldDigest: null, newDigest: `sha256:${'e'.repeat(64)}`, changed: true,
    redactedSummary: 'Canonical digest changed; raw sensitive values are redacted' }],
}

function liveReleaseDiffApi(reply: () => Response | Promise<Response> = () => envelope(diffData)) {
  let currentStatus = 'NEEDS_REVALIDATION'
  let currentContractHash = `sha256:${'d'.repeat(64)}`
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/v1/agents') return envelope([
      { id: liveAgentId, agentKey: 'loan-agent', name: 'Loan Agent', status: 'ACTIVE' },
      { id: otherAgentId, agentKey: 'other-agent', name: 'Other Agent', status: 'ACTIVE' },
    ])
    if (url.pathname === `/api/v1/agents/${liveAgentId}/releases`) return envelope([
      { id: liveReleaseId, agentId: liveAgentId, version: '1.0.0', businessPurpose: '서류 검토',
        lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW', agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
        safetyContractHash: `sha256:${'b'.repeat(64)}`, releaseFingerprint: `sha256:${'c'.repeat(64)}`,
        updatedAt: '2026-09-01T00:00:00Z' },
      { id: selectedReleaseId, agentId: liveAgentId, version: '2.0.0', businessPurpose: '서류 검토',
        lifecycleState: currentStatus, effectiveStatus: currentStatus, agentArtifactFingerprint: `sha256:${'e'.repeat(64)}`,
        safetyContractHash: currentContractHash, releaseFingerprint: `sha256:${'f'.repeat(64)}`,
        updatedAt: '2026-09-01T00:00:00Z' },
    ])
    if (url.pathname === `/api/v1/agents/${otherAgentId}/releases`) return envelope([
      { id: otherReleaseId, agentId: otherAgentId, version: '3.0.0', businessPurpose: '별도 업무',
        lifecycleState: 'ANALYZED', effectiveStatus: 'ANALYZED', agentArtifactFingerprint: `sha256:${'1'.repeat(64)}`,
        safetyContractHash: null, releaseFingerprint: `sha256:${'2'.repeat(64)}`,
        updatedAt: '2026-09-01T00:00:00Z' },
    ])
    if (url.pathname === `/api/v1/releases/${selectedReleaseId}/diff`
      || url.pathname === `/api/v1/releases/${liveReleaseId}/diff`) return reply()
    throw new Error(`Unexpected synthetic diff HTTP route: ${url.pathname}`)
  })
  const diffCalls = () => fetch.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.endsWith('/diff'))
  return {
    fetch, diffCalls,
    updateCurrent: () => { currentStatus = 'PASS'; currentContractHash = `sha256:${'9'.repeat(64)}` },
  }
}

const overviewRelease: Release = {
  id: selectedReleaseId, agentId: liveAgentId, version: '2.0.0', businessPurpose: '실제 대출서류 검토',
  manifestSchemaVersion: '1.1', agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
  releaseFingerprint: `sha256:${'b'.repeat(64)}`, safetyContractHash: null,
  lifecycleState: 'ANALYZED', effectiveStatus: 'NEEDS_REVALIDATION',
  revalidationReason: { privatePrompt: 'PRIVATE_REASON_CANARY' },
  analyzedAt: '2026-09-07T00:00:00Z', lastTestedAt: null,
  createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
}
const olderOverviewRelease: Release = {
  ...overviewRelease, id: liveReleaseId, version: '1.0.0', businessPurpose: '과거 대출서류 검토',
  releaseFingerprint: `sha256:${'c'.repeat(64)}`, effectiveStatus: 'REVIEW',
}
function overviewFingerprint(release: Release): Fingerprint {
  return {
    canonicalizationVersion: '1.0', agentArtifactFingerprint: release.agentArtifactFingerprint,
    releaseFingerprint: release.releaseFingerprint, safetyContractHash: release.safetyContractHash,
    components: { systemPromptHash: `sha256:${'d'.repeat(64)}`, toolCatalogHash: `sha256:${'e'.repeat(64)}` },
  }
}
function liveReleaseOverviewApi() {
  let selected = overviewRelease
  const handlers = {
    detail: (release: Release): Response | Promise<Response> => envelope(release),
    fingerprint: (release: Release): Response | Promise<Response> => envelope(overviewFingerprint(release)),
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/v1/agents') return envelope([{ id: liveAgentId, name: 'Live Agent', status: 'ACTIVE' }])
    if (url.pathname === `/api/v1/agents/${liveAgentId}/releases`) return envelope([olderOverviewRelease, selected])
    const release = [olderOverviewRelease, selected].find(item => url.pathname === `/api/v1/releases/${item.id}`
      || url.pathname === `/api/v1/releases/${item.id}/fingerprint`)
    if (release && url.pathname.endsWith('/fingerprint')) return handlers.fingerprint(release)
    if (release) return handlers.detail(release)
    throw new Error(`Unexpected Release overview HTTP route: ${url.pathname}`)
  })
  const detailCalls = () => fetch.mock.calls.filter(([input]) => /^\/api\/v1\/releases\/[^/]+$/.test(new URL(String(input), window.location.origin).pathname))
  const fingerprintCalls = () => fetch.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.endsWith('/fingerprint'))
  return { fetch, handlers, detailCalls, fingerprintCalls, updateSelected: (patch: Partial<Release>) => { selected = { ...selected, ...patch } } }
}

describe('live Release overview and fingerprint', () => {
  it('restores an explicit URL Release and shows matching server status and digest only', async () => {
    window.history.replaceState(null, '', `/#/live/release?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseOverviewApi()
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Release 구성과 검증 상태' })).toBeInTheDocument()
    const detail = await screen.findByRole('table', { name: 'Release 상세와 서버 상태' })
    expect(screen.getByLabelText('검토할 Release')).toHaveValue(selectedReleaseId)
    expect(within(detail).getByText('실제 대출서류 검토')).toBeInTheDocument()
    expect(within(detail).getByText('ANALYZED')).toBeInTheDocument()
    expect(within(detail).getByText('NEEDS REVALIDATION')).toBeInTheDocument()
    expect(screen.getByText('재검증이 필요한 Release입니다.')).toBeInTheDocument()
    const hashes = screen.getByRole('table', { name: 'Release fingerprint 식별자' })
    expect(within(hashes).getByText('N/A')).toBeInTheDocument()
    const components = screen.getByRole('table', { name: 'Manifest 구성 요소 digest' })
    expect(within(components).getByText('systemPromptHash')).toBeInTheDocument()
    expect(screen.queryByText('PRIVATE_REASON_CANARY')).not.toBeInTheDocument()
    expect(backend.detailCalls()).toHaveLength(1)
    expect(backend.fingerprintCalls()).toHaveLength(1)
    expect(new Headers(backend.detailCalls()[0]![1]?.headers).get('X-Actor-Id')).toBe('role-a-console')
    await user.click(screen.getByRole('button', { name: '구성 변경 비교 →' }))
    expect(window.location.hash).toBe(`#/live/changed?releaseId=${selectedReleaseId}`)
  })

  it('makes no detail read without selection and rejects an unknown direct link', async () => {
    window.history.replaceState(null, '', '/#/live/release')
    const backend = liveReleaseOverviewApi()
    const view = render(<App />)
    expect(await screen.findByText('Release를 선택하세요')).toBeInTheDocument()
    expect(backend.detailCalls()).toHaveLength(0)
    expect(backend.fingerprintCalls()).toHaveLength(0)

    view.unmount()
    window.history.replaceState(null, '', '/#/live/release?releaseId=missing-release')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '선택한 Release를 찾을 수 없습니다.' })).toBeInTheDocument()
    expect(backend.detailCalls()).toHaveLength(0)
  })

  it.each(['detail ID', 'detail revision', 'fingerprint hash', 'raw component'])('suppresses a %s mismatch instead of mixing responses', async mismatch => {
    window.history.replaceState(null, '', `/#/live/release?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseOverviewApi()
    if (mismatch === 'detail ID') backend.handlers.detail = (release) => envelope({ ...release, id: otherReleaseId })
    if (mismatch === 'detail revision') backend.handlers.detail = (release) => envelope({ ...release, effectiveStatus: 'PASS' })
    if (mismatch === 'fingerprint hash') backend.handlers.fingerprint = (release) => envelope({ ...overviewFingerprint(release), releaseFingerprint: `sha256:${'f'.repeat(64)}` })
    if (mismatch === 'raw component') backend.handlers.fingerprint = (release) => envelope({ ...overviewFingerprint(release), components: { systemPromptHash: 'RAW_PROMPT_CANARY' } })
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('서버 Release 상세·fingerprint와 현재 목록이 일치하지 않습니다.')
    expect(screen.queryByRole('table', { name: 'Release 상세와 서버 상태' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Manifest 구성 요소 digest' })).not.toBeInTheDocument()
    expect(screen.queryByText('RAW_PROMPT_CANARY')).not.toBeInTheDocument()
  })

  it.each(['agentArtifactFingerprint', 'releaseFingerprint', 'safetyContractHash'] as const)('rejects a malformed %s even when all three reads agree', async field => {
    window.history.replaceState(null, '', `/#/live/release?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseOverviewApi()
    backend.updateSelected({ [field]: 'RAW_HASH_CANARY' })
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('서버 Release 상세·fingerprint와 현재 목록이 일치하지 않습니다.')
    expect(screen.queryByRole('table', { name: 'Release fingerprint 식별자' })).not.toBeInTheDocument()
    expect(screen.queryByText('RAW_HASH_CANARY')).not.toBeInTheDocument()
  })

  it.each(['detail 404', 'fingerprint 409', 'offline'])('keeps a %s as a LIVE error without demo fallback', async failed => {
    window.history.replaceState(null, '', `/#/live/release?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseOverviewApi()
    const status = failed === 'detail 404' ? 404 : 409
    const reply = () => new Response(JSON.stringify({
      status, code: failed === 'detail 404' ? 'RELEASE_NOT_FOUND' : 'RELEASE_CHANGED',
      detail: failed, traceId: 'trace-overview-error', retryable: false,
    }), { status })
    if (failed === 'detail 404') backend.handlers.detail = reply
    else if (failed === 'fingerprint 409') backend.handlers.fingerprint = reply
    else backend.handlers.detail = () => Promise.reject(new Error('Offline'))
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(failed === 'offline' ? 'Offline' : failed)
    expect(screen.queryByRole('table', { name: 'Release 상세와 서버 상태' })).not.toBeInTheDocument()
    expect(screen.queryByText('System prompt')).not.toBeInTheDocument()
  })

  it.each(['actor', 'Release', 'inventory'])('ignores late dual-GET data after %s changes', async changed => {
    let resolveOld!: (detail: Release) => void
    const oldDetail = new Promise<Release>(resolve => { resolveOld = resolve })
    const nextRelease = changed === 'Release' ? olderOverviewRelease
      : changed === 'inventory' ? { ...overviewRelease, effectiveStatus: 'PASS' as const } : overviewRelease
    const oldDigest = `sha256:${'1'.repeat(64)}`
    const newDigest = `sha256:${'2'.repeat(64)}`
    const client = {
      releaseDetail: vi.fn().mockReturnValueOnce(oldDetail).mockResolvedValue(nextRelease),
      fingerprint: vi.fn().mockResolvedValueOnce({ ...overviewFingerprint(overviewRelease), components: { systemPromptHash: oldDigest } })
        .mockResolvedValue({ ...overviewFingerprint(nextRelease), components: { systemPromptHash: newDigest } }),
    }
    const baseProps = {
      releases: [overviewRelease], actorId: 'role-a-console', preferredReleaseId: selectedReleaseId,
      onReleaseChange: vi.fn(), onOpenManifest: vi.fn(), onOpenDiff: vi.fn(), client,
    }
    const view = render(<LiveReleaseOverviewPage {...baseProps} />)
    await waitFor(() => expect(client.releaseDetail).toHaveBeenCalledTimes(1))
    const nextProps = {
      ...baseProps,
      releases: [nextRelease],
      actorId: changed === 'actor' ? 'other-reviewer' : baseProps.actorId,
      preferredReleaseId: nextRelease.id,
    }
    view.rerender(<LiveReleaseOverviewPage {...nextProps} />)
    expect(await screen.findByTitle(newDigest)).toBeInTheDocument()
    await act(async () => resolveOld(overviewRelease))
    expect(screen.getByTitle(newDigest)).toBeInTheDocument()
    expect(screen.queryByTitle(oldDigest)).not.toBeInTheDocument()
    expect(client.releaseDetail).toHaveBeenCalledTimes(2)
  })

  it('keeps the simulated Release summary isolated from API reads', async () => {
    window.history.replaceState(null, '', `/#/demo/release?releaseId=${selectedReleaseId}`)
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '이 에이전트는 어디까지 허용되나요?' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Release 구성과 검증 상태' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('live Release configuration diff', () => {
  it('uses an explicit same-Agent pair and renders nullable, redacted server diff separately from Release state', async () => {
    window.history.replaceState(null, '', `/#/live/changed?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseDiffApi()
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Release 구성 변경 비교' })
    expect(screen.getByLabelText('현재 Release')).toHaveValue(selectedReleaseId)
    const against = screen.getByLabelText('비교할 Release')
    expect(within(against).queryByRole('option', { name: /v3\.0\.0/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '서버 구성 비교' })).toBeDisabled()
    expect(backend.diffCalls()).toHaveLength(0)

    await user.selectOptions(against, liveReleaseId)
    await user.click(screen.getByRole('button', { name: '서버 구성 비교' }))
    const components = await screen.findByRole('table', { name: 'Release Manifest 구성 요소 변경' })
    expect(within(components).getByText('serverToolCatalogHash')).toBeInTheDocument()
    expect(within(components).getByText('/serverToolCatalog')).toBeInTheDocument()
    expect(within(components).getByText('N/A')).toBeInTheDocument()
    expect(screen.getByText('Manifest 구성 요소 변경 있음')).toBeInTheDocument()
    expect(screen.getByText(/Safety Contract 연결 해시도 다릅니다/)).toBeInTheDocument()
    const identity = screen.getByRole('table', { name: 'Release 식별자와 상태' })
    expect(within(identity).getAllByText('NEEDS REVALIDATION')).toHaveLength(2)
    expect(backend.diffCalls()).toHaveLength(1)
    const [url, init] = backend.diffCalls()[0]!
    expect(url).toBe(`http://localhost:8080/api/v1/releases/${selectedReleaseId}/diff?against=${liveReleaseId}`)
    expect(new Headers(init?.headers).get('X-Actor-Id')).toBe('role-a-console')
  })

  it('preserves the selected Release URL through the live Evidence link', async () => {
    window.history.replaceState(null, '', `/#/live/evidence?releaseId=${selectedReleaseId}`)
    liveReleaseDiffApi()
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Release 구성 변경 비교 →' }))
    expect(window.location.hash).toBe(`#/live/changed?releaseId=${selectedReleaseId}`)
    expect(screen.getByLabelText('현재 Release')).toHaveValue(selectedReleaseId)
  })

  it('hides an older diff when inventory status or contract hash changes without a new URL or timestamp', async () => {
    window.history.replaceState(null, '', `/#/live/changed?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseDiffApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Release 구성 변경 비교' })
    await user.selectOptions(screen.getByLabelText('비교할 Release'), liveReleaseId)
    await user.click(screen.getByRole('button', { name: '서버 구성 비교' }))
    await screen.findByRole('table', { name: 'Release Manifest 구성 요소 변경' })

    backend.updateCurrent()
    await user.click(screen.getByRole('button', { name: '데이터 새로고침' }))
    await waitFor(() => expect(screen.getByRole('option', { name: /v2\.0\.0.*PASS/ })).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Release Manifest 구성 요소 변경' })).not.toBeInTheDocument()
  })

  it.each(['target', 'actor'])('ignores a late Release diff after the %s changes', async changed => {
    window.history.replaceState(null, '', `/#/live/changed?releaseId=${selectedReleaseId}`)
    let finish!: (response: Response) => void
    const backend = liveReleaseDiffApi(() => new Promise(resolve => { finish = resolve }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Release 구성 변경 비교' })
    await user.selectOptions(screen.getByLabelText('비교할 Release'), liveReleaseId)
    await user.click(screen.getByRole('button', { name: '서버 구성 비교' }))
    await waitFor(() => expect(backend.diffCalls()).toHaveLength(1))

    if (changed === 'target') {
      await user.selectOptions(screen.getByLabelText('현재 Release'), liveReleaseId)
      expect(window.location.hash).toBe(`#/live/changed?releaseId=${liveReleaseId}`)
    } else {
      await user.click(screen.getByRole('button', { name: '환경 설정' }))
      const dialog = screen.getByRole('dialog', { name: '워크스페이스 환경 설정' })
      await user.clear(within(dialog).getByLabelText('API actor ID'))
      await user.type(within(dialog).getByLabelText('API actor ID'), 'other-reviewer')
      await user.click(within(dialog).getByRole('button', { name: 'Actor 적용' }))
    }
    await act(async () => finish(envelope(diffData)))
    expect(screen.queryByRole('table', { name: 'Release Manifest 구성 요소 변경' })).not.toBeInTheDocument()
  })

  it('rejects a mismatched server pair and preserves a live HTTP error without demo fallback', async () => {
    window.history.replaceState(null, '', `/#/live/changed?releaseId=${selectedReleaseId}`)
    const backend = liveReleaseDiffApi(() => envelope({ ...diffData, against: otherReleaseId }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Release 구성 변경 비교' })
    await user.selectOptions(screen.getByLabelText('비교할 Release'), liveReleaseId)
    await user.click(screen.getByRole('button', { name: '서버 구성 비교' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('요청한 Release 쌍과 서버 비교 응답이 일치하지 않습니다.')
    expect(screen.queryByText('NEEDS_REVALIDATION · v1.1.0의 변경 상태 예시')).not.toBeInTheDocument()
    expect(backend.diffCalls()).toHaveLength(1)
  })

  it('shows a server validation error instead of synthetic success', async () => {
    window.history.replaceState(null, '', `/#/live/changed?releaseId=${selectedReleaseId}`)
    liveReleaseDiffApi(() => new Response(JSON.stringify({
      status: 422, code: 'VALIDATION_ERROR', detail: 'Release diff requires the same Agent', retryable: false,
    }), { status: 422 }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Release 구성 변경 비교' })
    await user.selectOptions(screen.getByLabelText('비교할 Release'), liveReleaseId)
    await user.click(screen.getByRole('button', { name: '서버 구성 비교' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Release diff requires the same Agent')
    expect(screen.queryByRole('table', { name: 'Release Manifest 구성 요소 변경' })).not.toBeInTheDocument()
  })

  it('keeps the sample Changed page isolated from all API reads', async () => {
    window.history.replaceState(null, '', `/#/demo/changed?releaseId=${selectedReleaseId}`)
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    expect(await screen.findByText('NEEDS_REVALIDATION · v1.1.0의 변경 상태 예시')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('live Release identity navigation', () => {
  it('opens the exact inventory Release in overview, Manifest and Evidence, then restores it on reload', async () => {
    window.history.replaceState(null, '', '/#/live/releases')
    livePolicyApi()
    const user = userEvent.setup()
    const view = render(<App />)
    await screen.findByRole('heading', { name: '릴리스 버전 관리' })

    await user.click(within(screen.getByText('v2.0.0').closest('tr')!).getByRole('button', { name: '릴리스 열기 →' }))
    expect(await screen.findByRole('heading', { name: 'Release 구성과 검증 상태' })).toBeInTheDocument()
    expect(window.location.hash).toBe(`#/live/release?releaseId=${selectedReleaseId}`)
    await screen.findByRole('table', { name: 'Release 상세와 서버 상태' })
    await user.click(screen.getByRole('button', { name: 'Manifest 관리 →' }))
    expect(await screen.findByRole('heading', { name: 'v2.0.0' })).toBeInTheDocument()
    expect(window.location.hash).toBe(`#/live/manifest?releaseId=${selectedReleaseId}`)
    await user.click(within(screen.getByRole('navigation', { name: '주요 메뉴' })).getByRole('button', { name: '구성·증거' }))
    expect(screen.getByLabelText('Release')).toHaveValue(selectedReleaseId)
    expect(window.location.hash).toBe(`#/live/evidence?releaseId=${selectedReleaseId}`)

    view.unmount()
    render(<App />)
    await screen.findByRole('heading', { name: '구성과 증거' })
    expect(screen.getByLabelText('Release')).toHaveValue(selectedReleaseId)
  })

  it('updates the URL from Evidence selection and restores the chosen ID on hash history changes', async () => {
    window.history.replaceState(null, '', `/#/live/evidence?releaseId=${liveReleaseId}`)
    livePolicyApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '구성과 증거' })
    expect(screen.getByLabelText('Release')).toHaveValue(liveReleaseId)

    await user.selectOptions(screen.getByLabelText('Release'), selectedReleaseId)
    expect(window.location.hash).toBe(`#/live/evidence?releaseId=${selectedReleaseId}`)
    act(() => { window.location.hash = `/live/evidence?releaseId=${liveReleaseId}`; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(screen.getByLabelText('Release')).toHaveValue(liveReleaseId)
    act(() => { window.location.hash = `/live/evidence?releaseId=${selectedReleaseId}`; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(screen.getByLabelText('Release')).toHaveValue(selectedReleaseId)
  })

  it('never falls back to another Release for an unknown direct-link ID', async () => {
    window.history.replaceState(null, '', '/#/live/evidence?releaseId=missing-release')
    livePolicyApi()
    render(<App />)

    expect(await screen.findByRole('heading', { name: '선택한 Release를 찾을 수 없습니다.' })).toBeInTheDocument()
    expect(screen.getByText('다른 Release로 자동 전환하지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Attestation 검증' })).not.toBeInTheDocument()
  })

  it('ignores a live Release query when opening the isolated demo Evidence page', async () => {
    window.history.replaceState(null, '', `/#/demo/evidence?releaseId=${selectedReleaseId}`)
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)

    await screen.findByRole('heading', { name: '구성과 증거' })
    expect(screen.getByLabelText('Release')).not.toHaveValue(selectedReleaseId)
    expect(screen.getByText('SIMULATED · 합성 체험')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})

async function applyLiveReviewer(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: '안전 정책 검토' })
  await user.selectOptions(screen.getByLabelText('인증 방식'), 'local')
  await user.selectOptions(screen.getByLabelText('정책 Release'), selectedReleaseId)
  await user.type(screen.getByLabelText('검토자 키'), reviewerKey)
  await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
  await user.click(await screen.findByRole('button', { name: '계약 live-loan-review v7 선택' }))
}

describe('live stored contract review routing', () => {
  it.each(['policies', 'policy'])('connects LIVE %s to explicit review and approval while preserving release selection', async route => {
    window.history.replaceState(null, '', `/#/live/${route}`)
    const backend = livePolicyApi()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '안전 정책 검토' })
    expect(screen.getByLabelText('정책 Release')).toHaveValue('')
    expect(backend.contracts()).toHaveLength(0)
    await user.selectOptions(screen.getByLabelText('인증 방식'), 'local')
    await user.selectOptions(screen.getByLabelText('정책 Release'), selectedReleaseId)
    await user.type(screen.getByLabelText('검토자 키'), reviewerKey)
    expect(backend.contracts()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
    await user.click(await screen.findByRole('button', { name: '계약 live-loan-review v7 선택' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON').textContent).toBe(storedReview().storedPolicyJson))
    expect(screen.getByRole('table', { name: '저장 계약 식별자' }).textContent).toContain(selectedReleaseId)
    expect(new URL(String(backend.contracts()[0]![0])).searchParams.get('releaseId')).toBe(selectedReleaseId)
    expect(backend.posts()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    const dialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    const submit = within(dialog).getByRole('button', { name: '승인 요청 전송' })
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText('검토 의견'), '저장된 변경 내역과 검증 결과를 검토했습니다.')
    await user.click(within(dialog).getByRole('checkbox', { name: consent }))
    expect(backend.posts()).toHaveLength(0)
    await user.click(submit)
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(await screen.findByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
    const [postUrl, post] = backend.posts()[0]!
    expect(new URL(String(postUrl)).pathname).toBe(`/api/v1/contract-versions/${liveVersionId}:approve`)
    expect(post?.body).toBe(JSON.stringify({ comment: '저장된 변경 내역과 검증 결과를 검토했습니다.' }))
    expect(new Headers(post?.headers).get('If-Match')).toBe(`"${resourceHash}"`)
    expect(new Headers(post?.headers).get('Idempotency-Key')).toMatch(/^contract-approve-[0-9a-f-]{36}$/)
    for (const [, init] of backend.contracts()) {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Contract-Reviewer-Key')).toBe(reviewerKey)
      expect(headers.has('X-Actor-Id')).toBe(false)
      expect(headers.has('Cookie')).toBe(false)
      expect(init?.credentials).toBe('omit')
      expect(init?.cache).toBe('no-store')
    }
    expect(document.body.textContent).not.toContain(reviewerKey)
    expect(screen.queryByRole('button', { name: '승인 범위 확인 · 재검증' })).not.toBeInTheDocument()
    const count = backend.contracts().length
    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    await user.click(navigation.getByRole('button', { name: '워크스페이스' }))
    await screen.findByRole('heading', { name: '검증 워크스페이스' })
    await user.click(navigation.getByRole('button', { name: '안전 정책' }))
    await screen.findByRole('heading', { name: '안전 정책 검토' })
    expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
    expect(screen.getByLabelText('검토자 키')).toHaveValue('')
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(backend.contracts()).toHaveLength(count)
  })

  it('shows a safe C API failure without displaying a synthetic policy or server detail', async () => {
    window.history.replaceState(null, '', '/#/live/policy')
    const backend = livePolicyApi()
    backend.handlers.review = () => new Response(JSON.stringify({ status: 503, code: 'CONTRACT_REVIEW_UNAVAILABLE', title: reviewerKey, detail: reviewerKey, instance: `/${reviewerKey}`, retryable: true }), { status: 503 })
    const user = userEvent.setup()
    render(<App />)
    await applyLiveReviewer(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('요청을 완료하지 못했습니다. 서버 상태를 확인해 주세요.')
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '승인 검토' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '승인 범위 확인 · 재검증' })).not.toBeInTheDocument()
    expect(screen.queryByText('SIMULATED · 합성 체험')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(reviewerKey)
    expect(backend.posts()).toHaveLength(0)
  })

  it('clears a consented live dialog on hash mode change and adds no requests in demo mode', async () => {
    window.history.replaceState(null, '', '/#/live/policy')
    const backend = livePolicyApi()
    const user = userEvent.setup()
    render(<App />)
    await applyLiveReviewer(user)
    await user.click(await screen.findByRole('button', { name: '승인 검토' }))
    const dialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    await user.type(within(dialog).getByLabelText('검토 의견'), '이전 모드의 승인 의견')
    await user.click(within(dialog).getByRole('checkbox', { name: consent }))
    expect(within(dialog).getByRole('button', { name: '승인 요청 전송' })).toBeEnabled()
    const fetchCount = backend.fetch.mock.calls.length
    const contractCount = backend.contracts().length
    act(() => { window.location.hash = '/demo/policy'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByText('SIMULATED · 합성 체험')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '승인 범위 확인 · 재검증' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('검토자 키')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('이전 모드의 승인 의견')
    expect(backend.fetch).toHaveBeenCalledTimes(fetchCount)
    act(() => { window.location.hash = '/live/policy'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await screen.findByRole('heading', { name: '안전 정책 검토' })
    expect(screen.getByLabelText('검토자 키')).toHaveValue('')
    expect(screen.getByLabelText('정책 Release')).toHaveValue('')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(backend.contracts()).toHaveLength(contractCount)
    expect(backend.posts()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('이전 모드의 승인 의견')
  })
})


describe('merged live console navigation', () => {
  it.each([
    ['테스트 실행', 'Runs & Trace'],
    ['발견된 위험', 'Findings'],
    ['검증 보고서', 'Metrics & Decision'],
  ])('opens the live %s feature from the product menu', async (menu, heading) => {
    window.history.replaceState(null, '', '/#/live/overview')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([]))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '검증 워크스페이스' })
    await user.click(within(screen.getByRole('navigation', { name: '주요 메뉴' })).getByRole('button', { name: menu }))
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(screen.getByText('LIVE_API · API 모드')).toBeInTheDocument()
    expect(screen.queryByText('SIMULATED · 합성 체험')).not.toBeInTheDocument()
  })
})

const gatewayRunId = '019903ac-abcd-7000-8000-000000000091'
const gatewayEventId = '019903ac-abcd-7000-8000-000000000092'
function liveGatewayApi() {
  const backend = livePolicyApi()
  const inventory = backend.fetch.getMockImplementation()!
  let releaseId = selectedReleaseId
  const history = () => envelope({ headSequence: 1, nextCursor: null, items: [{
    schemaVersion: '1.0', eventId: gatewayEventId, traceId: liveAgentId, runId: gatewayRunId,
    testCaseRunId: liveVersionId, sequence: 1, occurredAt: '2026-09-08T00:00:00Z',
    eventType: 'POLICY_EVALUATED', toolName: 'CUSTOMER_DATA_READ',
    policyDecision: { allowed: false, reasonCode: 'POLICY_EVALUATION_TIMEOUT' }, reasonCode: 'POLICY_EVALUATION_TIMEOUT',
    payloadDigest: policyHash, eventHash: resourceHash, prevEventHash: null,
    input: { private: reviewerKey }, output: reviewerKey, metadata: { private: reviewerKey, gateway: 'c' },
  }] })
  const handlers = { history: async () => history() }
  backend.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    const match = url.pathname.match(/^\/api\/v1\/releases\/([^/]+)\/test-runs$/)
    if (match) {
      releaseId = match[1]!
      return envelope({ items: [{ id: gatewayRunId, releaseId, mode: 'SEAL_REPLAY', status: 'FAILED' }], nextCursor: null })
    }
    if (url.pathname === `/api/v1/test-runs/${gatewayRunId}`) return envelope({
      id: gatewayRunId, releaseId, mode: 'SEAL_REPLAY', status: 'FAILED', contractVersionId: liveVersionId,
    })
    if (url.pathname === `/api/v1/test-runs/${gatewayRunId}/event-history`) return handlers.history()
    return inventory(input, init)
  })
  const reads = () => backend.fetch.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.includes('/test-runs'))
  return { ...backend, handlers, history, reads }
}

async function selectGatewayRun(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Gateway 정책 판단 이력' })
  await user.selectOptions(screen.getByLabelText('Gateway Release'), selectedReleaseId)
  await user.selectOptions(await screen.findByLabelText('Gateway Run'), gatewayRunId)
}

describe('LIVE Gateway stored evidence routing', () => {
  it('keeps an HTTP policy ERROR distinct from DENY through the real shell and C client', async () => {
    window.history.replaceState(null, '', '/#/live/gateway')
    const backend = liveGatewayApi()
    const errorEventId = '019903ac-abcd-7000-8000-000000000093'
    const errorPayloadDigest = `sha256:${'c'.repeat(64)}`
    const errorEventHash = `sha256:${'d'.repeat(64)}`
    // Synthetic HTTP evidence retains the original legacy DENY and adds the actual ERROR/false wire shape.
    backend.handlers.history = async () => {
      const original = await backend.history().json() as { data: { items: Record<string, unknown>[] } }
      const first = original.data.items[0]!
      return envelope({ headSequence: 2, nextCursor: null, items: [first, {
        ...first, eventId: errorEventId, sequence: 2,
        policyDecision: { allowed: false, decisionType: 'ERROR', reasonCode: 'INVALID_REQUEST_SCHEMA', successfulSecurityBlock: false },
        reasonCode: 'INVALID_REQUEST_SCHEMA', payloadDigest: errorPayloadDigest,
        eventHash: errorEventHash, prevEventHash: first.eventHash,
      }] })
    }
    const user = userEvent.setup()
    render(<App />)
    await selectGatewayRun(user)
    expect(await screen.findByText('정책 판단 2건 중 2건 표시')).toBeInTheDocument()
    expect(screen.getByText('기록된 DENY')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('판단 필터'), 'ERROR')
    expect(screen.getByLabelText('판단 필터')).toHaveValue('ERROR')
    expect(screen.getByText('정책 판단 2건 중 1건 표시')).toBeInTheDocument()
    expect(screen.queryByText('#1 · CUSTOMER_DATA_READ')).not.toBeInTheDocument()
    expect(screen.queryByText('기록된 DENY')).not.toBeInTheDocument()
    const errorSummary = screen.getByText('#2 · CUSTOMER_DATA_READ')
    expect(within(errorSummary.closest('details')!).getByText('ERROR · 운영 오류')).toBeInTheDocument()
    await user.click(errorSummary)
    const source = screen.getByRole('table', { name: '정책 이벤트 2 기록' })
    for (const value of [errorEventId, gatewayRunId, liveAgentId, liveVersionId, errorPayloadDigest, errorEventHash, resourceHash]) {
      expect(source).toHaveTextContent(value)
    }
    expect(within(source).getAllByText('INVALID_REQUEST_SCHEMA')).toHaveLength(2)
    expect(screen.getByRole('table', { name: '조회한 Run 기록' })).toHaveTextContent(selectedReleaseId)
    expect(screen.getByText('캡처한 이력 범위 · head 2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(new RegExp(`${reviewerKey}|ATTACK_BLOCKED|successfulSecurityBlock|공격 차단 성공|SIMULATED · 합성 체험`))
    expect(screen.getByText('정의된 합성 시험 범위의 내부 평가입니다. 공식 인증 또는 모든 취약점의 부재를 보장하지 않습니다.')).toBeInTheDocument()
    expect(screen.getByText('Internal assessment. Not official certification.')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('판단 필터'), 'DENY')
    expect(screen.getByText('정책 판단 2건 중 1건 표시')).toBeInTheDocument()
    expect(screen.getByText('#1 · CUSTOMER_DATA_READ')).toBeInTheDocument()
    expect(screen.getByText('기록된 DENY')).toBeInTheDocument()
    expect(screen.queryByText('#2 · CUSTOMER_DATA_READ')).not.toBeInTheDocument()
    expect(backend.reads()).toHaveLength(3)
    for (const [, init] of backend.fetch.mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body).toBeUndefined()
    }
    for (const [, init] of backend.reads()) {
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe('role-a-console')
    }
  })

  it('uses the real shell and C client with selected Release and actor, preserving recorded meaning', async () => {
    window.history.replaceState(null, '', '/#/live/gateway')
    const backend = liveGatewayApi()
    const user = userEvent.setup()
    render(<App />)
    await selectGatewayRun(user)
    await user.click(await screen.findByText('#1 · CUSTOMER_DATA_READ'))
    expect(screen.getByRole('table', { name: '정책 이벤트 1 기록' })).toHaveTextContent(gatewayEventId)
    expect(screen.getByRole('table', { name: '조회한 Run 기록' })).toHaveTextContent(selectedReleaseId)
    expect(screen.getByText('캡처한 이력 범위 · head 1')).toBeInTheDocument()
    expect(screen.getByText('기록된 DENY')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(new RegExp(`${reviewerKey}|ATTACK_BLOCKED|SIMULATED · 합성 체험`))
    expect(screen.getByText('Internal assessment. Not official certification.')).toBeInTheDocument()
    expect(backend.reads()).toHaveLength(3)
    for (const [, init] of backend.reads()) {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('X-Actor-Id')).toBe('role-a-console')
    }
    await user.click(screen.getByRole('button', { name: '환경 설정' }))
    const dialog = screen.getByRole('dialog')
    await user.clear(within(dialog).getByLabelText('API actor ID'))
    await user.type(within(dialog).getByLabelText('API actor ID'), 'gateway-reader-2')
    await user.click(within(dialog).getByRole('button', { name: 'Actor 적용' }))
    await waitFor(() => expect(new Headers(backend.reads().at(-1)?.[1]?.headers).get('X-Actor-Id')).toBe('gateway-reader-2'))
    expect(screen.getByLabelText('Gateway Release')).toHaveValue(selectedReleaseId)
    expect(screen.queryByText('기록된 DENY')).not.toBeInTheDocument()
    act(() => { window.location.hash = `/live/policy?releaseId=${encodeURIComponent(selectedReleaseId)}`; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await screen.findByRole('heading', { name: '안전 정책 검토' })
    expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
  })

  it('aborts a pending Gateway read when leaving the page and ignores its late response', async () => {
    window.history.replaceState(null, '', '/#/live/gateway')
    const backend = liveGatewayApi()
    let resolve!: (response: Response) => void
    backend.handlers.history = () => new Promise(done => { resolve = done })
    const user = userEvent.setup()
    render(<App />)
    await selectGatewayRun(user)
    await screen.findByText('정책 판단 이력을 불러오는 중')
    await waitFor(() => expect(backend.reads()).toHaveLength(3))
    const signal = backend.reads().at(-1)?.[1]?.signal
    act(() => { window.location.hash = '/live/overview'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await screen.findByRole('heading', { name: '검증 워크스페이스' })
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolve(backend.history()) })
    expect(screen.queryByText('기록된 DENY')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps demo Gateway independent of every API request', async () => {
    window.history.replaceState(null, '', '/#/demo/gateway')
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    await screen.findByRole('heading', { name: '어떤 요청이 차단되고 허용됐나요?' })
    expect(screen.getByText('SIMULATED · 합성 체험')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Gateway 정책 판단 이력' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['runs', 'trace'])('keeps LIVE %s on the existing B Execution page', async route => {
    window.history.replaceState(null, '', `/#/live/${route}`)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([]))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Runs & Trace' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Gateway 정책 판단 이력' })).not.toBeInTheDocument()
  })
})

// Actual C transport + ProductApp routing, served by synthetic D61 HTTP fixtures.
function liveStoredReplayApi() {
  const backend = livePolicyApi(), inventory = backend.fetch.getMockImplementation()!
  const event = (value: unknown, id = gatewayEventId) => ({ eventId: id, eventType: 'POLICY_EVALUATED', toolName: 'CUSTOMER_DATA_READ',
    value, payloadDigest: policyHash, reasonCode: 'RECORDED_EVENT_REASON', occurredAt: '2026-09-17T00:00:00Z' })
  const side = (runId: string, mode: string) => ({ runId, caseRunId: liveVersionId, mode, runStatus: 'COMPLETED', caseStatus: 'PASSED',
    policyDecisions: [event({ allowed: true, reasonCode: 'BASELINE_ALLOW', private: reviewerKey })],
    securityOutcome: reviewerKey, functionalOutcome: reviewerKey, apiResponses: [{ value: reviewerKey }], stateChanges: [{ value: reviewerKey }], oracleResults: [{ outcome: reviewerKey }] })
  const comparison = () => envelope({ releaseId: selectedReleaseId, replayRunId: gatewayRunId, replayLinkId: liveAgentId, findingId: liveVersionId,
    category: reviewerKey, severity: reviewerKey, comparable: false, mismatchReasons: ['MODEL_CONFIG_MISMATCH'],
    baseline: side(liveVersionId, 'BASELINE'), replay: { ...side(gatewayRunId, 'SEAL_REPLAY'), policyDecisions: [
      event({ decisionType: 'ERROR', allowed: false, reasonCode: 'POLICY_EVALUATION_TIMEOUT', evaluationMode: 'ENFORCE', private: reviewerKey }),
      event({ decisionType: 'ERROR', allowed: true, reasonCode: 'CONFLICT', private: reviewerKey }, liveAgentId),
    ] }, difference: { attackMitigated: true, private: reviewerKey } })
  const handlers = { comparison: async () => comparison() }
  backend.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === `/api/v1/releases/${selectedReleaseId}/test-runs`) return envelope({ items: [
      { id: liveVersionId, releaseId: selectedReleaseId, mode: 'BASELINE', status: 'COMPLETED' },
      { id: gatewayRunId, releaseId: selectedReleaseId, mode: 'SEAL_REPLAY', status: 'COMPLETED' },
    ], nextCursor: null })
    if (url.pathname === `/api/v1/replays/${gatewayRunId}/comparison`) return handlers.comparison()
    return inventory(input, init)
  })
  return { ...backend, handlers, comparison, comparisons: () => backend.fetch.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.includes('/comparison')) }
}

async function selectStoredReplay(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: '저장된 Replay 정책 비교' })
  await user.selectOptions(screen.getByLabelText('Replay Release'), selectedReleaseId)
  await user.selectOptions(await screen.findByLabelText('Replay Run'), gatewayRunId)
}

describe('LIVE stored Replay policy routing', () => {
  it('uses the real read-only C client and exact D61 projection after explicit selection', async () => {
    window.history.replaceState(null, '', '/#/live/replay')
    const backend = liveStoredReplayApi(), user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '저장된 Replay 정책 비교' })
    expect(screen.getByLabelText('Replay Release')).toHaveValue(''); expect(backend.comparisons()).toHaveLength(0)
    await user.selectOptions(screen.getByLabelText('Replay Release'), selectedReleaseId)
    const run = await screen.findByLabelText('Replay Run')
    expect(run).toHaveValue(''); expect(within(run).getAllByRole('option')).toHaveLength(2); expect(backend.comparisons()).toHaveLength(0)
    await user.selectOptions(run, gatewayRunId)
    expect(await screen.findByText('서버 기록: 비교 불가')).toBeVisible()
    expect(screen.getByText('MODEL_CONFIG_MISMATCH')).toBeVisible()
    expect(screen.getByText('기록된 ALLOW')).toBeVisible()
    expect(screen.getByText('ERROR · 운영 오류')).toBeVisible(); expect(screen.getByText('UNKNOWN · 판독 불가')).toBeVisible()
    const replay = within(screen.getByRole('region', { name: 'Replay 정책 기록' }))
    await user.click(replay.getByText('표시 1 · CUSTOMER_DATA_READ'))
    expect(replay.getByText('POLICY_EVALUATION_TIMEOUT')).toBeVisible()
    expect(replay.getByText(gatewayEventId)).toBeVisible()
    expect(replay.getAllByText('RECORDED_EVENT_REASON')[0]).toBeVisible()
    expect(document.body.textContent).not.toContain(reviewerKey)
    expect(screen.queryByText('ATTACK_BLOCKED')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '승인 범위 확인 · 재검증' })).not.toBeInTheDocument()
    for (const [, init] of backend.fetch.mock.calls) { expect(init?.method ?? 'GET').toBe('GET'); expect(init?.body).toBeUndefined() }
    const [, init] = backend.comparisons()[0]!
    expect(new Headers(init?.headers).get('X-Actor-Id')).toBeNull()
    expect(new Headers(init?.headers).get('X-Contract-Reviewer-Key')).toBeNull()
    expect(init?.credentials).toBe('omit'); expect(init?.cache).toBe('no-store')
  })
  it('opens C Replay through the existing Safety Policy menu and keeps C Release selection across navigation', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    const backend = liveStoredReplayApi(), user = userEvent.setup()
    render(<App />); await screen.findByRole('heading', { name: '검증 워크스페이스' })
    expect(screen.queryByRole('navigation', { name: '정책 화면 이동' })).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('navigation', { name: '주요 메뉴' })).getByRole('button', { name: '안전 정책' }))
    await screen.findByRole('heading', { name: '안전 정책 검토' })
    await user.selectOptions(screen.getByLabelText('정책 Release'), selectedReleaseId)
    const nav = () => within(screen.getByRole('navigation', { name: '정책 화면 이동' }))
    await user.click(nav().getByRole('button', { name: 'Gateway 판단 이력' }))
    await screen.findByRole('heading', { name: 'Gateway 정책 판단 이력' })
    expect(screen.getByLabelText('Gateway Release')).toHaveValue(selectedReleaseId)
    await user.click(nav().getByRole('button', { name: 'Replay 정책 비교' }))
    expect(window.location.hash).toBe(`#/live/replay?releaseId=${encodeURIComponent(selectedReleaseId)}`)
    expect(screen.getByLabelText('Replay Release')).toHaveValue(selectedReleaseId)
    expect(await screen.findByLabelText('Replay Run')).toHaveValue(''); expect(backend.comparisons()).toHaveLength(0)
    expect(nav().getByRole('button', { name: 'Replay 정책 비교' })).toHaveAttribute('aria-current', 'page')
    await user.selectOptions(screen.getByLabelText('Replay Run'), gatewayRunId)
    await screen.findByText('서버 기록: 비교 불가')
    await user.click(nav().getByRole('button', { name: '정책 검토' }))
    expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
    expect(screen.queryByText('서버 기록: 비교 불가')).not.toBeInTheDocument()
    expect(backend.posts()).toHaveLength(0)
  })
  it('keeps D comparison errors safe without rendering a sample or stale result', async () => {
    window.history.replaceState(null, '', '/#/live/replay')
    const backend = liveStoredReplayApi(), user = userEvent.setup()
    backend.handlers.comparison = async () => new Response(JSON.stringify({ detail: reviewerKey }), { status: 409 })
    render(<App />); await selectStoredReplay(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('저장된 비교를 조회하지 못했습니다.')
    expect(screen.queryByText('서버 기록: 비교 가능')).not.toBeInTheDocument()
    expect(screen.queryByText('서버 기록: 비교 불가')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(reviewerKey)
    expect(screen.queryByText('ATTACK_BLOCKED')).not.toBeInTheDocument()
    backend.handlers.comparison = async () => backend.comparison()
    await user.click(screen.getByRole('button', { name: '비교 기록 새로고침' }))
    expect(await screen.findByText('서버 기록: 비교 불가')).toBeVisible()
  })
  it('aborts a pending actual comparison read when navigating to another owner page', async () => {
    window.history.replaceState(null, '', '/#/live/replay')
    const backend = liveStoredReplayApi(), user = userEvent.setup()
    let resolve!: (response: Response) => void
    backend.handlers.comparison = () => new Promise<Response>(yes => { resolve = yes })
    render(<App />); await selectStoredReplay(user)
    const signal = backend.comparisons()[0]![1]!.signal!
    await user.click(within(screen.getByRole('navigation', { name: '주요 메뉴' })).getByRole('button', { name: '워크스페이스' }))
    expect(await screen.findByRole('heading', { name: '검증 워크스페이스' })).toBeVisible()
    expect(screen.queryByRole('navigation', { name: '정책 화면 이동' })).not.toBeInTheDocument()
    expect(signal.aborted).toBe(true)
    await act(async () => { resolve(backend.comparison()) })
    expect(screen.queryByText('서버 기록: 비교 불가')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('keeps demo Replay independent with no C live navigation or fetch', async () => {
    window.history.replaceState(null, '', '/#/demo/replay')
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '정책 적용 전후, 무엇이 달라졌나요?' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '저장된 Replay 정책 비교' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '정책 화면 이동' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})


// Shell integration through frozen published A/C modules and synthetic HTTP only.
// Native dialog cancel is exercised in jsdom; this is not browser Escape/CORS/cookie proof.
describe('LIVE settings governance session integration', () => {
  const bootstrap = 'SYNTHETIC_SETTINGS_GOV_BOOTSTRAP_PRIVATE_0123456789'
  const csrf = '00000000-0000-4000-8000-000000000051:00000000-0000-4000-8000-000000000052'
  const cookieCanary = 'SYNTHETIC_SETTINGS_HTTPONLY_COOKIE_NEVER_PUBLIC'
  const actor = 'settings-governance-reviewer'
  const workspace = '019903ac-abcd-7000-8000-000000000051'
  const session = '019903ac-abcd-7000-8000-000000000052'
  const path = '/api/v1/governance-reviewer-session'
  type User = ReturnType<typeof userEvent.setup>
  type View = ReturnType<typeof render>
  type Call = { pathname: string; method: string; headers: Headers; credentials: RequestCredentials | undefined;
    cache: RequestCache | undefined; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined }
  type Exit = 'Close' | 'X' | 'native cancel' | 'Actor apply' | 'mode button' | 'hash MODE' | 'App unmount'

  function wireText(): string {
    const now = Date.now()
    return JSON.stringify({ data: { csrfToken: csrf, expiresAt: Math.floor(now / 1000) + 1800,
      actorId: actor, workspaceId: workspace, role: 'AI_GOVERNANCE_REVIEWER', sessionId: session, demoMode: true },
    traceId: '019903ac-abcd-7000-8000-000000000053', timestamp: new Date(now).toISOString() })
  }
  function reply(text: string): Response {
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json',
      'Set-Cookie': `__Host-FINSEC_GOVERNANCE=${cookieCanary}` } })
  }
  function transport(backend: ReturnType<typeof livePolicyApi>, custom?: (call: Call, index: number) => Response | Promise<Response>) {
    const original = backend.fetch.getMockImplementation()!
    const text = wireText()
    const calls: Call[] = []
    backend.fetch.mockImplementation(async (input, init = {}) => {
      const url = new URL(String(input), window.location.origin)
      if (url.pathname !== path && url.pathname !== `${path}/${session}`) return original(input, init)
      // The client erases credential Headers later; snapshot only at actual dispatch.
      const call: Call = { pathname: url.pathname, method: init.method ?? 'GET', headers: new Headers(init.headers),
        credentials: init.credentials, cache: init.cache, redirect: init.redirect, signal: init.signal }
      calls.push(call)
      if (custom) return custom(call, calls.length - 1)
      if (call.method === 'GET' && call.pathname === path) return reply(text)
      if (call.method === 'DELETE' && call.pathname === `${path}/${session}`) return new Response(null, { status: 204 })
      throw new Error('Unexpected synthetic governance lifecycle request')
    })
    return { calls, text }
  }
  function publicSafe(): void {
    for (const value of [bootstrap, csrf, cookieCanary]) {
      expect(document.body.textContent?.includes(value)).toBe(false)
      expect(document.body.innerHTML.includes(value)).toBe(false)
      expect(window.location.href.includes(value)).toBe(false)
      for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)!
          expect(key.includes(value)).toBe(false)
          expect((storage.getItem(key) ?? '').includes(value)).toBe(false)
        }
      }
    }
  }
  function governanceHeadersSafe(calls: readonly Call[]): void {
    for (const [index, call] of calls.entries()) {
      expect(call.headers.has('X-Contract-Reviewer-Key')).toBe(false)
      expect(call.headers.has('X-Actor-Id')).toBe(false)
      expect(call.headers.has('Cookie')).toBe(false)
      expect(call.credentials).toBe('include'); expect(call.cache).toBe('no-store'); expect(call.redirect).toBe('error')
      if (call.method === 'DELETE') {
        expect(call.pathname).toBe(`${path}/${session}`)
        expect(call.headers.has('Authorization')).toBe(false)
        expect(call.headers.get('X-CSRF-Token') === csrf).toBe(true)
        expect(call.headers.get('Idempotency-Key')).toMatch(/^gov-logout-[0-9a-f-]{36}$/)
      } else {
        expect(call.method).toBe('GET'); expect(call.pathname).toBe(path)
        expect(call.headers.get('Authorization') === (index === 0 ? `GovernanceBootstrap ${bootstrap}` : null)).toBe(true)
        expect(call.headers.has('X-CSRF-Token')).toBe(false)
        expect(call.headers.has('Idempotency-Key')).toBe(false)
      }
    }
  }
  async function open(user: User) {
    await user.click(screen.getByRole('button', { name: '환경 설정' }))
    const dialog = screen.getByRole('dialog', { name: '워크스페이스 환경 설정' })
    const panel = await within(dialog).findByRole('region', { name: '거버넌스 세션' })
    await within(panel).findByRole('button', { name: '연결' })
    return { dialog, panel, ui: within(panel) }
  }
  async function connect(user: User, ui: ReturnType<typeof within>): Promise<void> {
    await user.type(ui.getByLabelText('거버넌스 연결 키'), bootstrap)
    await user.click(ui.getByRole('button', { name: '연결' }))
    expect(ui.getByLabelText('거버넌스 연결 키')).toHaveValue('')
  }
  function changeHash(hash: string): void {
    act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')) })
  }
  async function exit(kind: Exit, user: User, view: View, dialog: HTMLElement): Promise<void> {
    if (kind === 'Close') await user.click(within(dialog).getByRole('button', { name: '닫기' }))
    else if (kind === 'X') await user.click(within(dialog).getByRole('button', { name: '확인창 닫기' }))
    else if (kind === 'native cancel') fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    else if (kind === 'Actor apply') {
      await user.clear(within(dialog).getByLabelText('API actor ID'))
      await user.type(within(dialog).getByLabelText('API actor ID'), 'settings-api-actor')
      await user.click(within(dialog).getByRole('button', { name: 'Actor 적용' }))
    } else if (kind === 'mode button') await user.click(within(dialog).getByRole('button', { name: '샘플 체험 모드로' }))
    else if (kind === 'hash MODE') changeHash('/demo/overview')
    else view.unmount()
  }
  function deferred(kind: 'fetch' | 'body') {
    const text = wireText()
    let finished = false
    let bodyRead = false
    let resolve!: (value: Response) => void
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const pending = kind === 'fetch' ? new Promise<Response>(done => { resolve = done }) : null
    const body = kind === 'body' ? new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      pull() { bodyRead = true },
      cancel() { finished = true },
    }, { highWaterMark: 0 }) : null
    const response = body ? new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }) : null
    return {
      response: () => pending ?? response!,
      bodyRead: () => bodyRead,
      finish: () => {
        if (finished) return
        finished = true
        if (kind === 'fetch') resolve(reply(text))
        else { controller.enqueue(new TextEncoder().encode(text)); controller.close() }
      },
    }
  }
  async function settle(view: View, pending?: ReturnType<typeof deferred>): Promise<void> {
    view.unmount()
    await act(async () => { pending?.finish(); for (let i = 0; i < 20; i++) await Promise.resolve() })
  }

  it('keeps initial LIVE inventory separate from governance0 and never mounts or fetches governance in SIMULATED settings', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    const backend = livePolicyApi(), gov = transport(backend), user = userEvent.setup()
    const view = render(<App />)
    try {
      await screen.findByRole('heading', { name: '검증 워크스페이스' })
      expect(backend.fetch).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('region', { name: '거버넌스 세션' })).not.toBeInTheDocument()
      expect(gov.calls).toHaveLength(0)
      const { dialog, panel } = await open(user)
      expect(within(dialog).getAllByRole('region', { name: '거버넌스 세션' })).toHaveLength(1)
      expect(gov.calls).toHaveLength(0)
      const actorForm = within(dialog).getByLabelText('API actor ID').closest('form')!
      const governanceForm = within(panel).getByLabelText('거버넌스 연결 키').closest('form')!
      expect(actorForm).not.toBe(governanceForm)
      expect(actorForm.contains(governanceForm)).toBe(false)
      expect(governanceForm.contains(actorForm)).toBe(false)
      await user.click(within(dialog).getByRole('button', { name: '샘플 체험 모드로' }))
      await screen.findByText('SIMULATED · 합성 체험')
      backend.fetch.mockClear()
      await user.click(screen.getByRole('button', { name: '환경 설정' }))
      expect(screen.queryByRole('region', { name: '거버넌스 세션' })).not.toBeInTheDocument()
      expect(backend.fetch).not.toHaveBeenCalled()
      expect(gov.calls).toHaveLength(0)
    } finally { await settle(view) }
  })

  it('uses only explicit connect/current/own logout and keeps server identity separate from API Actor and selected Release', async () => {
    window.history.replaceState(null, '', `/#/live/policy?releaseId=${selectedReleaseId}`)
    const backend = livePolicyApi(), gov = transport(backend), user = userEvent.setup()
    const view = render(<App />)
    try {
      await screen.findByRole('heading', { name: '안전 정책 검토' })
      const { dialog, ui } = await open(user)
      const actorBefore = (within(dialog).getByLabelText('API actor ID') as HTMLInputElement).value
      await connect(user, ui)
      await waitFor(() => expect(ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(gov.calls).toHaveLength(2)
      expect(gov.calls[0]!.headers.get('Authorization') === `GovernanceBootstrap ${bootstrap}`).toBe(true)
      expect(gov.calls[1]!.headers.has('Authorization')).toBe(false)
      expect(ui.getByText(actor)).toBeInTheDocument()
      expect(ui.getByText(workspace)).toBeInTheDocument()
      expect(ui.getByText('AI_GOVERNANCE_REVIEWER')).toBeInTheDocument()
      expect(within(dialog).getByLabelText('API actor ID')).toHaveValue(actorBefore)
      expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
      for (const call of gov.calls) {
        expect(call.method).toBe('GET')
        expect(call.credentials).toBe('include'); expect(call.cache).toBe('no-store'); expect(call.redirect).toBe('error')
        expect(call.headers.has('X-Actor-Id')).toBe(false)
        expect(call.headers.has('X-Contract-Reviewer-Key')).toBe(false)
      }
      await user.click(ui.getByRole('button', { name: '상태 확인' }))
      await waitFor(() => expect(ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(gov.calls).toHaveLength(3)
      expect(gov.calls[2]!.headers.has('Authorization')).toBe(false)
      await user.click(ui.getByRole('button', { name: '해제' }))
      await waitFor(() => expect(ui.getByRole('status')).toHaveTextContent('연결되지 않음'))
      expect(gov.calls).toHaveLength(4)
      const logout = gov.calls[3]!
      expect(logout.method).toBe('DELETE'); expect(logout.pathname).toBe(`${path}/${session}`)
      expect(logout.headers.get('X-CSRF-Token') === csrf).toBe(true)
      expect(logout.headers.get('Idempotency-Key')).toMatch(/^gov-logout-[0-9a-f-]{36}$/)
      expect(logout.headers.has('Authorization')).toBe(false)
      governanceHeadersSafe(gov.calls)
      publicSafe()
    } finally { await settle(view) }
  })

  const pendingExits = (['fetch', 'body'] as const).flatMap(kind =>
    (['Close', 'X', 'native cancel', 'Actor apply', 'mode button', 'hash MODE', 'App unmount'] as const).map(kindOfExit => ({ kind, kindOfExit })))
  it.each(pendingExits)('disposes $kind pending work through $kindOfExit without auto restore or false disconnected claims', async ({ kind, kindOfExit }) => {
    window.history.replaceState(null, '', `/#/live/overview?releaseId=${selectedReleaseId}`)
    const backend = livePolicyApi(), pending = deferred(kind)
    const gov = transport(backend, (call, index) => index === 0 ? pending.response() : reply(wireText()))
    const user = userEvent.setup()
    let view = render(<App />)
    try {
      await screen.findByRole('heading', { name: '검증 워크스페이스' })
      const original = await open(user)
      const oldInput = original.ui.getByLabelText('거버넌스 연결 키')
      await connect(user, original.ui)
      await waitFor(() => expect(gov.calls).toHaveLength(1))
      if (kind === 'body') await waitFor(() => expect(pending.bodyRead()).toBe(true))
      expect(original.panel).toHaveAttribute('aria-busy', 'true')
      expect(original.ui.queryByText(actor)).not.toBeInTheDocument()
      await exit(kindOfExit, user, view, original.dialog)
      expect(screen.queryByRole('region', { name: '거버넌스 세션' })).not.toBeInTheDocument()
      expect(oldInput).toHaveValue('')
      expect(gov.calls[0]!.signal?.aborted).toBe(true)
      expect(gov.calls).toHaveLength(1)
      if (kindOfExit === 'mode button' || kindOfExit === 'hash MODE') {
        const total = backend.fetch.mock.calls.length
        await user.click(screen.getByRole('button', { name: '환경 설정' }))
        expect(screen.queryByRole('region', { name: '거버넌스 세션' })).not.toBeInTheDocument()
        expect(backend.fetch).toHaveBeenCalledTimes(total)
        changeHash(`/live/overview?releaseId=${selectedReleaseId}`)
        await screen.findByRole('heading', { name: '검증 워크스페이스' })
      } else if (kindOfExit === 'App unmount') view = render(<App />)
      const reopened = await open(user)
      expect(reopened.ui.getByLabelText('거버넌스 연결 키')).toHaveValue('')
      expect(reopened.ui.getByRole('status')).toHaveTextContent('결과 미확정')
      expect(reopened.panel).toHaveAttribute('aria-busy', 'true')
      expect(reopened.ui.getByRole('button', { name: '상태 확인' })).toBeDisabled()
      expect(reopened.ui.getByRole('button', { name: '연결' })).toBeDisabled()
      expect(reopened.ui.getByRole('button', { name: '해제' })).toBeDisabled()
      expect(reopened.ui.queryByText(actor)).not.toBeInTheDocument()
      expect(gov.calls).toHaveLength(1)
      await act(async () => { pending.finish(); for (let i = 0; i < 20; i++) await Promise.resolve() })
      await waitFor(() => expect(reopened.panel).toHaveAttribute('aria-busy', 'false'))
      expect(reopened.ui.getByRole('status')).toHaveTextContent('결과 미확정')
      expect(reopened.ui.queryByText(actor)).not.toBeInTheDocument()
      expect(reopened.ui.getByRole('button', { name: '연결' })).toBeDisabled()
      expect(reopened.ui.getByRole('button', { name: '해제' })).toBeDisabled()
      expect(reopened.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
      expect(gov.calls).toHaveLength(1)
      await user.click(reopened.ui.getByRole('button', { name: '상태 확인' }))
      await waitFor(() => expect(reopened.ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(gov.calls).toHaveLength(2)
      expect(gov.calls[1]!.headers.has('Authorization')).toBe(false)
      expect(gov.calls[1]!.headers.has('X-CSRF-Token')).toBe(false)
      expect(reopened.ui.getByText(actor)).toBeInTheDocument()
      publicSafe()
    } finally { await settle(view, pending) }
  })

  it('clears a typed key and reopens disconnected only after the old flight-free origin channel was removed', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    const backend = livePolicyApi(), gov = transport(backend), user = userEvent.setup()
    const view = render(<App />)
    try {
      await screen.findByRole('heading', { name: '검증 워크스페이스' })
      const initial = await open(user)
      const input = initial.ui.getByLabelText('거버넌스 연결 키')
      await user.type(input, bootstrap)
      expect(input).toHaveValue(bootstrap)
      await user.click(within(initial.dialog).getByRole('button', { name: '닫기' }))
      expect(input).toHaveValue('')
      const reopened = await open(user)
      expect(reopened.ui.getByRole('status')).toHaveTextContent('연결되지 않음')
      expect(reopened.panel).toHaveAttribute('aria-busy', 'false')
      expect(reopened.ui.getByLabelText('거버넌스 연결 키')).toHaveValue('')
      expect(gov.calls).toHaveLength(0)
      await user.click(reopened.ui.getByRole('button', { name: '상태 확인' }))
      await waitFor(() => expect(reopened.ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(gov.calls).toHaveLength(1)
      expect(gov.calls[0]!.headers.has('Authorization')).toBe(false)
      publicSafe()
    } finally { await settle(view) }
  })

  it('preserves the same connected panel across SAME-LIVE page and Release hash changes', async () => {
    window.history.replaceState(null, '', `/#/live/overview?releaseId=${selectedReleaseId}`)
    const backend = livePolicyApi(), gov = transport(backend), user = userEvent.setup()
    const view = render(<App />)
    try {
      await screen.findByRole('heading', { name: '검증 워크스페이스' })
      const initial = await open(user)
      const input = initial.ui.getByLabelText('거버넌스 연결 키')
      await connect(user, initial.ui)
      await waitFor(() => expect(initial.ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(gov.calls).toHaveLength(2)
      changeHash(`/live/policy?releaseId=${selectedReleaseId}`)
      await screen.findByRole('heading', { name: '안전 정책 검토' })
      expect(screen.getByRole('region', { name: '거버넌스 세션' })).toBe(initial.panel)
      expect(within(initial.panel).getByLabelText('거버넌스 연결 키')).toBe(input)
      changeHash(`/live/policy?releaseId=${liveReleaseId}`)
      await waitFor(() => expect(screen.getByLabelText('정책 Release')).toHaveValue(liveReleaseId))
      expect(screen.getByRole('dialog', { name: '워크스페이스 환경 설정' })).toBe(initial.dialog)
      expect(screen.getByRole('region', { name: '거버넌스 세션' })).toBe(initial.panel)
      expect(initial.ui.getByRole('status')).toHaveTextContent('연결됨')
      expect(initial.ui.getByText(actor)).toBeInTheDocument()
      expect(gov.calls).toHaveLength(2)
      await user.click(within(initial.dialog).getByRole('button', { name: '닫기' }))
      const reopened = await open(user)
      expect(reopened.ui.getByRole('status')).toHaveTextContent('연결되지 않음')
      expect(gov.calls).toHaveLength(2)
      publicSafe()
    } finally { await settle(view) }
  })

  it('keeps the actual C local-reviewer workflow and selected Release separate while governance settings connect', async () => {
    window.history.replaceState(null, '', `/#/live/policy?releaseId=${selectedReleaseId}`)
    const backend = livePolicyApi(), gov = transport(backend), user = userEvent.setup()
    const view = render(<App />)
    try {
      await applyLiveReviewer(user)
      const cCount = backend.contracts().length
      const { dialog, ui } = await open(user)
      const apiActor = (within(dialog).getByLabelText('API actor ID') as HTMLInputElement).value
      await connect(user, ui)
      await waitFor(() => expect(ui.getByRole('status')).toHaveTextContent('연결됨'))
      expect(backend.contracts()).toHaveLength(cCount)
      expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
      expect(screen.getByLabelText('검토자 키')).toHaveValue(reviewerKey)
      expect(within(dialog).getByLabelText('API actor ID')).toHaveValue(apiActor)
      expect(gov.calls).toHaveLength(2)
      governanceHeadersSafe(gov.calls)
      publicSafe()
      await user.click(within(dialog).getByRole('button', { name: '닫기' }))
      await user.click(screen.getByRole('button', { name: '승인 검토' }))
      const cDialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
      await user.type(within(cDialog).getByLabelText('검토 의견'), '독립된 C 정책 검토 의견')
      await user.click(within(cDialog).getByRole('checkbox', { name: consent }))
      await user.click(within(cDialog).getByRole('button', { name: '승인 요청 전송' }))
      await screen.findByText('계약 승인 요청이 처리되었습니다.')
      expect(backend.posts()).toHaveLength(1)
      expect(gov.calls).toHaveLength(2)
      expect(screen.getByLabelText('정책 Release')).toHaveValue(selectedReleaseId)
      for (const [, init] of backend.contracts()) {
        const headers = new Headers(init?.headers)
        expect(headers.get('X-Contract-Reviewer-Key') === reviewerKey).toBe(true)
        expect(headers.has('Authorization')).toBe(false); expect(headers.has('X-CSRF-Token')).toBe(false)
        expect(headers.has('X-Actor-Id')).toBe(false); expect(headers.has('Cookie')).toBe(false)
        expect(init?.credentials).toBe('omit')
      }
      publicSafe()
    } finally { await settle(view) }
  })
})
