import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
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
    window.history.replaceState(null, '', '/#/live/replay')
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
  const handlers = { review: () => envelope(current) }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/v1/agents') return envelope([{ id: liveAgentId, agentKey: 'live-loan-agent', name: 'Live Loan Agent', purposeSummary: 'Document review', status: 'ACTIVE', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }])
    if (url.pathname === `/api/v1/agents/${liveAgentId}/releases`) return envelope([liveReleaseId, selectedReleaseId].map((id, index) => ({
      id, agentId: liveAgentId, version: `${index + 1}.0.0`, businessPurpose: '대출 서류 검토', manifestSchemaVersion: '1.0',
      agentArtifactFingerprint: policyHash, releaseFingerprint: policyHash, safetyContractHash: policyHash,
      lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW', revalidationReason: null, analyzedAt: '2026-09-07T00:00:00Z',
      lastTestedAt: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
    })))
    if (url.pathname === '/api/v1/platform/contracts') return envelope(url.searchParams.get('releaseId') === selectedReleaseId ? [platformContract(current)] : [])
    if (url.pathname === `/api/v1/platform/contracts/${liveVersionId}/review`) return handlers.review()
    if (init.method === 'POST' && url.pathname === `/api/v1/platform/contracts/${liveVersionId}:approve`) {
      current = { ...current, state: 'APPROVED', resourceHash: `sha256:${'c'.repeat(64)}` }
      return envelope(platformContract(current))
    }
    throw new Error('Unexpected synthetic app HTTP route')
  })
  const contracts = () => fetch.mock.calls.filter(([input]) => new URL(String(input), window.location.origin).pathname.startsWith('/api/v1/platform/contracts'))
  return { fetch, handlers, contracts, posts: () => contracts().filter(([, init]) => init?.method === 'POST') }
}

async function applyLiveReviewer(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: '안전 정책 검토' })
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
    expect(new URL(String(postUrl)).pathname).toBe(`/api/v1/platform/contracts/${liveVersionId}:approve`)
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
    act(() => { window.location.hash = '/live/policy'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
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
