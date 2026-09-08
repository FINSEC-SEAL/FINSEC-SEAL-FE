import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Release } from '../../api/contracts'
import { ContractReviewClient } from './client'
import { StoredContractReviewPage } from './StoredContractReviewPage'
import type { StoredContractReview } from './wire'

const releaseId = '019903ac-abcd-7000-8000-000000000002'
const secondReleaseId = '019903ac-abcd-7000-8000-000000000012'
const versionId = '019903ac-abcd-7000-8000-000000000003'
const secondVersionId = '019903ac-abcd-7000-8000-000000000004'
const workspaceId = '019903ac-abcd-7000-8000-000000000001'
const traceId = '019903ac-abcd-7000-8000-000000000005'
const policyHash = `sha256:${'a'.repeat(64)}`
const resourceHash = `sha256:${'b'.repeat(64)}`
const changedHash = `sha256:${'c'.repeat(64)}`
const baseHash = `sha256:${'d'.repeat(64)}`
const key = 'SYNTHETIC_PAGE_REVIEWER_CANARY_0123456789'
const consent = '정책 변경 내용과 검토 의견을 확인했습니다.'
const retryConsent = '처리 여부가 미확정인 기존 요청을 같은 내용으로 다시 전송합니다.'
const client = new ContractReviewClient('https://api.test')

beforeEach(() => {
  let operationId = 10
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() =>
    `00000000-0000-4000-8000-${String(++operationId).padStart(12, '0')}`)
})

function release(id = releaseId): Release {
  return { id, agentId: workspaceId, version: id === releaseId ? 'release-1' : 'release-2',
    businessPurpose: '대출 서류 검토', manifestSchemaVersion: '1.0', agentArtifactFingerprint: policyHash,
    releaseFingerprint: baseHash, safetyContractHash: null, lifecycleState: 'REVIEW', effectiveStatus: 'REVIEW',
    revalidationReason: null, analyzedAt: '2026-09-07T00:00:00Z', lastTestedAt: null,
    createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }
}

function snapshot(overrides: Partial<StoredContractReview> = {}): StoredContractReview {
  const identity = overrides.identity ?? { versionId, workspaceId, releaseId, contractKey: 'loan-review', version: 7 }
  const policy = { schemaVersion: '1.0', contractId: identity.contractKey, version: identity.version,
    purpose: 'LOAN_DOCUMENT_COMPLETENESS_REVIEW',
    allowedTools: ['CASE_CONTEXT_READ', 'DOCUMENT_READER', 'CUSTOMER_DATA_READ', 'LOAN_POLICY_SEARCH', 'REVIEW_NOTE_WRITE'],
    resourcePolicies: { DOCUMENT_READER: { caseScope: 'CURRENT_CASE_ONLY', documentScope: 'ALLOWED_DOCUMENTS_ONLY' }, REVIEW_NOTE_WRITE: { caseScope: 'CURRENT_CASE_ONLY' } },
    customerScope: { type: 'CURRENT_APPLICANT_ONLY' }, fieldPolicy: { CUSTOMER_DATA_READ: { allowed: ['incomeBand', 'employmentStatus'], denyUnknown: true } },
    cardinality: { CUSTOMER_DATA_READ: { maxRequestedRecords: 1, maxReturnedRecords: 1 } },
    externalEgress: { allowed: false, allowedDestinations: [] }, workflow: { allowedStages: ['DOCUMENT_REVIEW'] },
    highImpactActions: { LOAN_DECISION_UPDATE: 'HUMAN_ONLY' }, toolTrust: { requireTrustedTool: true, allowedTrustLevels: ['TRUSTED_INTERNAL'] },
    outputPolicy: { reviewStatusAllowed: ['READY_FOR_HUMAN_REVIEW', 'NEEDS_MORE_DOCUMENTS'] }, metadata: { templateVersion: 'loan-review/1', validatorVersion: '1.0' } }
  return { identity, state: 'CANDIDATE', policyHash, resourceHash,
    storedPolicyJson: JSON.stringify(policy, null, 2), canonicalPolicyJson: JSON.stringify(policy),
    baseline: { identity: { ...identity, versionId: traceId, contractKey: 'earlier-policy', version: 1 }, policyHash: baseHash },
    validation: null, review: null,
    changes: [{ pointer: '/version', kind: 'MODIFIED', beforeJson: '1', afterJson: String(identity.version) }],
    ...overrides }
}

function validated(overrides: Partial<StoredContractReview> = {}): StoredContractReview {
  return snapshot({ state: 'VALIDATED', validation: { status: 'VALID', issues: [] }, ...overrides })
}

function platformVersion(view: StoredContractReview, overrides: Record<string, unknown> = {}) {
  return { id: view.identity.versionId, workspaceId: view.identity.workspaceId, releaseId: view.identity.releaseId,
    contractKey: view.identity.contractKey, version: view.identity.version, state: view.state,
    policyHash: view.policyHash, resourceHash: view.resourceHash, policy: { private: key },
    validation: {}, review: { sessionId: key }, ...overrides }
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, traceId, timestamp: '2026-09-07T06:00:00Z' }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, traceId, title: key, detail: key, retryable: status >= 500 }), {
    status, headers: { 'Content-Type': 'application/problem+json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Reply = Response | Promise<Response>

// Synthetic HTTP only: every response still crosses the production client, wire and display components.
function api(initial: StoredContractReview[] = [snapshot()]) {
  const views = new Map(initial.map(view => [view.identity.versionId, view]))
  const handlers: {
    list: (release: string) => Reply
    detail: (id: string) => Reply
    post: (path: string, init: RequestInit) => Reply
    operation: (id: string, init: RequestInit) => Reply
  } = {
    list: selected => response([...views.values()].filter(view => view.identity.releaseId === selected).map(view => platformVersion(view))),
    detail: id => response(views.get(id)),
    post: () => problem(409, 'INVALID_STATE_TRANSITION'),
    operation: () => problem(404, 'RESOURCE_NOT_FOUND'),
  }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input))
    if (init.method === 'POST') return handlers.post(url.pathname, init)
    if (url.pathname.startsWith('/api/v1/operations/')) return handlers.operation(url.pathname.split('/').at(-1)!, init)
    if (url.pathname.endsWith('/review')) return handlers.detail(url.pathname.split('/').at(-2)!)
    if (url.pathname === '/api/v1/platform/contracts') return handlers.list(url.searchParams.get('releaseId')!)
    throw new Error('Unexpected synthetic HTTP route')
  })
  return { views, handlers, fetchMock, posts: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST') }
}

function page(releases = [release(), release(secondReleaseId)], preferredReleaseId: string | undefined = releaseId) {
  return render(<StoredContractReviewPage releases={releases} preferredReleaseId={preferredReleaseId} client={client} />)
}

type User = ReturnType<typeof userEvent.setup>

async function loadList(user: User, reviewerKey = key) {
  const input = screen.getByLabelText('검토자 키') as HTMLInputElement
  if (input.value !== reviewerKey) { await user.clear(input); await user.type(input, reviewerKey) }
  await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
}

async function selectVersion(user: User, view = snapshot()) {
  await user.click(await screen.findByRole('button', { name: `계약 ${view.identity.contractKey} v${view.identity.version} 선택` }))
  await waitFor(() => expect(screen.getByLabelText('계약 JSON').textContent).toBe(view.storedPolicyJson))
}

async function load(user: User, view = snapshot()) { await loadList(user); await selectVersion(user, view) }

function unavailable(name: string) {
  const button = screen.queryByRole('button', { name })
  if (button) expect(button).toBeDisabled()
  else expect(button).not.toBeInTheDocument()
}

async function confirm(user: User, action: '승인' | '거절', comment = '변경 범위와 검증 결과 확인') {
  await user.click(screen.getByRole('button', { name: `${action} 검토` }))
  const dialog = await screen.findByRole('dialog', { name: `계약 ${action} 확인` })
  const input = within(dialog).getByLabelText('검토 의견')
  await user.clear(input); await user.type(input, comment)
  await user.click(within(dialog).getByRole('checkbox', { name: consent }))
  return dialog
}

describe('stored contract page selection and authority', () => {
  it('requires a real release and explicit credential apply without auto-selecting the first release', async () => {
    const backend = api()
    const user = userEvent.setup()
    render(<StoredContractReviewPage releases={[release()]} client={client} />)
    expect(screen.getByRole('heading', { name: '안전 정책 검토' })).toBeInTheDocument()
    expect(screen.getByLabelText('정책 Release')).toHaveValue('')
    expect(screen.getByLabelText('검토자 키')).toHaveAttribute('type', 'password')
    unavailable('계약 목록 조회')
    await user.type(screen.getByLabelText('검토자 키'), key)
    expect(backend.fetchMock).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByLabelText('정책 Release'), releaseId)
    expect(backend.fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
    expect(await screen.findByRole('button', { name: '계약 loan-review v7 선택' })).toBeInTheDocument()
    expect(backend.fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
  })

  it('uses detail state rather than a stale VALIDATED list badge and does not leak A private evidence', async () => {
    const backend = api()
    backend.handlers.list = () => response([platformVersion(snapshot(), { state: 'VALIDATED' })])
    const user = userEvent.setup(); page(); await load(user)
    expect(screen.getByRole('button', { name: '계약 검증' })).toBeEnabled()
    unavailable('승인 검토')
    expect(screen.getByRole('button', { name: '거절 검토' })).toBeEnabled()
    expect(document.body.textContent).not.toContain(key)
    expect(backend.posts()).toHaveLength(0)
  })

  it('distinguishes loading, an actual empty inventory and a safe credential rejection without demo fallback', async () => {
    const backend = api([])
    const pending = deferred<Response>()
    backend.handlers.list = () => pending.promise
    const user = userEvent.setup(); page(); await loadList(user)
    expect(screen.getByText('저장 계약 목록을 불러오는 중')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /계약 .* 선택/ })).not.toBeInTheDocument()
    await act(async () => pending.resolve(response([])))
    expect(await screen.findByRole('heading', { name: '저장된 계약이 없습니다' })).toBeInTheDocument()
    backend.handlers.list = () => problem(403, 'CONTRACT_AUTH_REQUIRED')
    await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
    expect(await screen.findByText('검토자 키를 확인해 주세요.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /계약 .* 선택/ })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(key)
    expect(backend.posts()).toHaveLength(0)
  })

  it('validates a candidate, reloads WARN evidence, and requires a separate explicit approval', async () => {
    const backend = api()
    const warn = validated({ resourceHash: changedHash, validation: { status: 'WARN', issues: [
      { jsonPointer: '/purpose', code: 'STORED_WARNING', severity: 'WARNING', message: '저장된 검토 경고' },
    ] } })
    backend.handlers.post = path => {
      expect(path.endsWith(':validate')).toBe(true)
      backend.views.set(versionId, warn)
      return response(platformVersion(warn))
    }
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('저장된 검토 경고')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled()
    unavailable('계약 검증')
    expect(backend.posts()).toHaveLength(1)
    expect(backend.posts()[0]![1]?.body).toBe('{}')
    expect(new Headers(backend.posts()[0]![1]?.headers).get('If-Match')).toBe(`"${resourceHash}"`)
    const approved = validated({ state: 'APPROVED', resourceHash: baseHash })
    backend.handlers.post = () => { backend.views.set(versionId, approved); return response(platformVersion(approved)) }
    const dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    await waitFor(() => expect(backend.posts()).toHaveLength(2))
    expect(new Headers(backend.posts()[1]![1]?.headers).get('If-Match')).toBe(`"${changedHash}"`)
  })

  it('shows actual INVALID evidence when validation leaves the version CANDIDATE', async () => {
    const backend = api()
    const invalid = snapshot({ resourceHash: changedHash, validation: { status: 'INVALID', issues: [
      { jsonPointer: '/allowedTools', code: 'MINIMUM_AVAILABILITY', severity: 'ERROR', message: '필수 업무 도구 누락' },
    ] } })
    backend.handlers.post = () => { backend.views.set(versionId, invalid); return response(platformVersion(invalid)) }
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('필수 업무 도구 누락')).toBeInTheDocument()
    expect(screen.getByText('MINIMUM_AVAILABILITY')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '계약 검증' })).toBeEnabled()
    unavailable('승인 검토')
    expect(backend.posts()).toHaveLength(1)
  })

  it.each(['APPROVED', 'REJECTED', 'SUPERSEDED'] as const)('keeps terminal %s details read-only', async state => {
    const view = validated({ state })
    const backend = api([view])
    const user = userEvent.setup(); page(); await load(user, view)
    for (const action of ['계약 검증', '승인 검토', '거절 검토']) unavailable(action)
    expect(screen.getByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(0)
  })

  it.each([null, { status: 'INVALID' as const, issues: [
    { jsonPointer: '/purpose', code: 'STORED_ERROR', severity: 'ERROR' as const, message: '저장된 오류' },
  ] }])('does not approve VALIDATED metadata without eligible stored validation evidence', async validation => {
    const view = validated({ validation })
    const backend = api([view])
    const user = userEvent.setup(); page(); await load(user, view)
    unavailable('계약 검증'); unavailable('승인 검토')
    expect(screen.getByRole('button', { name: '거절 검토' })).toBeEnabled()
    expect(backend.posts()).toHaveLength(0)
  })
})

describe('explicit review consent and conflicts', () => {
  it('binds full hashes and exact comment, clears edited consent, cancels without POST, and dispatches a double click once', async () => {
    const backend = api([validated()])
    const pending = deferred<Response>()
    backend.handlers.post = () => pending.promise
    const user = userEvent.setup(); page(); await load(user, validated())
    let dialog = await confirm(user, '승인', '첫 검토 의견')
    for (const hash of [baseHash, policyHash, resourceHash]) expect(dialog.textContent).toContain(hash)
    await user.type(within(dialog).getByLabelText('검토 의견'), ' 수정')
    expect(within(dialog).getByRole('checkbox', { name: consent })).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: '승인 요청 전송' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(backend.posts()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    dialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    expect(within(dialog).getByLabelText('검토 의견')).toHaveValue('첫 검토 의견 수정')
    expect(within(dialog).getByRole('checkbox', { name: consent })).not.toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: consent }))
    const send = within(dialog).getByRole('button', { name: '승인 요청 전송' })
    act(() => { fireEvent.click(send); fireEvent.click(send) })
    await waitFor(() => expect(backend.posts()).toHaveLength(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(backend.posts()[0]![1]?.body).toBe(JSON.stringify({ comment: '첫 검토 의견 수정' }))
    expect(new Headers(backend.posts()[0]![1]?.headers).get('If-Match')).toBe(`"${resourceHash}"`)
    await act(async () => pending.resolve(problem(403, 'CONTRACT_AUTH_REQUIRED')))
  })

  it('allows a separately consented rejection of a CANDIDATE', async () => {
    const backend = api()
    const rejected = snapshot({ state: 'REJECTED', resourceHash: changedHash })
    backend.handlers.post = () => { backend.views.set(versionId, rejected); return response(platformVersion(rejected)) }
    const user = userEvent.setup(); page(); await load(user)
    const dialog = await confirm(user, '거절', '검토\n"범위" 거절')
    await user.click(within(dialog).getByRole('button', { name: '거절 요청 전송' }))
    await waitFor(() => expect(screen.getByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument())
    expect(backend.posts()).toHaveLength(1)
    expect(backend.posts()[0]![0]).toBe(`https://api.test/api/v1/platform/contracts/${versionId}:reject`)
    expect(backend.posts()[0]![1]?.body).toBe(JSON.stringify({ comment: '검토\n"범위" 거절' }))
  })

  it('invalidates consent on manual refresh and on 409 while preserving the review comment for reinspection', async () => {
    const backend = api([validated()])
    const user = userEvent.setup(); page(); await load(user, validated())
    await confirm(user, '승인', '충돌 전 검토 의견')
    fireEvent.click(screen.getByRole('button', { name: '최신 계약 다시 조회' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    let dialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    expect(within(dialog).getByLabelText('검토 의견')).toHaveValue('충돌 전 검토 의견')
    expect(within(dialog).getByRole('checkbox', { name: consent })).not.toBeChecked()
    backend.handlers.post = () => {
      backend.views.set(versionId, validated({ resourceHash: changedHash }))
      return problem(409, 'RESOURCE_CONFLICT')
    }
    await user.click(within(dialog).getByRole('checkbox', { name: consent }))
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('table', { name: '저장 계약 식별자' }).textContent).toContain(changedHash))
    expect(backend.posts()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    dialog = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    expect(within(dialog).getByLabelText('검토 의견')).toHaveValue('충돌 전 검토 의견')
    expect(within(dialog).getByRole('checkbox', { name: consent })).not.toBeChecked()
    expect(dialog.textContent).toContain(changedHash)
    expect(within(dialog).getByRole('button', { name: '승인 요청 전송' })).toBeDisabled()
    expect(document.body.textContent).not.toContain(key)
  })

  it('keeps a confirmed mutation success separate from a failed subsequent GET and offers only reinspection', async () => {
    const backend = api([validated()])
    backend.handlers.post = () => {
      backend.handlers.detail = () => problem(503, 'CONTRACT_REVIEW_UNAVAILABLE')
      return response(platformVersion(validated({ state: 'APPROVED', resourceHash: changedHash })))
    }
    const user = userEvent.setup(); page(); await load(user, validated())
    const dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(await screen.findByText('변경 요청은 처리됐지만 최신 검토 내용을 불러오지 못했습니다.')).toBeInTheDocument()
    expect(screen.queryByText('요청 처리 여부가 미확정입니다.')).not.toBeInTheDocument()
    unavailable('동일 요청 재전송 검토'); unavailable('승인 검토')
    expect(screen.getByRole('button', { name: '최신 계약 다시 조회' })).toBeEnabled()
    expect(backend.posts()).toHaveLength(1)
    backend.handlers.detail = () => response(validated({ state: 'APPROVED', resourceHash: changedHash }))
    await user.click(screen.getByRole('button', { name: '최신 계약 다시 조회' }))
    expect(await screen.findByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
  })
})

describe('selection races and uncertain operations', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late detail %s and its finally after selecting another version', async outcome => {
    const first = snapshot()
    const second = snapshot({ identity: { ...first.identity, versionId: secondVersionId, version: 8 } })
    const backend = api([first, second])
    const old = deferred<Response>()
    const current = deferred<Response>()
    backend.handlers.detail = id => id === versionId ? old.promise : current.promise
    const user = userEvent.setup(); page(); await loadList(user)
    await user.click(await screen.findByRole('button', { name: '계약 loan-review v7 선택' }))
    await user.click(screen.getByRole('button', { name: '계약 loan-review v8 선택' }))
    await act(async () => outcome === 'resolve' ? old.resolve(response(first)) : old.reject(new Error(key)))
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(screen.getByText('저장 계약을 불러오는 중')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    unavailable('계약 검증')
    expect(document.body.textContent).not.toContain(key)
    await act(async () => current.resolve(response(second)))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON').textContent).toBe(second.storedPolicyJson))
    expect(screen.getByRole('button', { name: '계약 검증' })).toBeEnabled()
    expect(backend.posts()).toHaveLength(0)
  })

  it('ignores a late list after changing release and clears invalid preferred/inventory scope', async () => {
    const first = snapshot()
    const second = snapshot({ identity: { ...first.identity, releaseId: secondReleaseId, versionId: secondVersionId, version: 8 } })
    const backend = api([first, second])
    const old = deferred<Response>()
    backend.handlers.list = id => id === releaseId ? old.promise : response([platformVersion(second)])
    const user = userEvent.setup(); const rendered = page(); await loadList(user)
    await user.selectOptions(screen.getByLabelText('정책 Release'), secondReleaseId)
    await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
    expect(await screen.findByRole('button', { name: '계약 loan-review v8 선택' })).toBeInTheDocument()
    await act(async () => old.resolve(response([platformVersion(first)])))
    expect(screen.queryByRole('button', { name: '계약 loan-review v7 선택' })).not.toBeInTheDocument()
    await selectVersion(user, second)
    rendered.rerender(<StoredContractReviewPage releases={[release()]} preferredReleaseId={secondReleaseId} client={client} />)
    await waitFor(() => expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument())
    expect(screen.getByLabelText('정책 Release')).toHaveValue('')
    expect(backend.posts()).toHaveLength(0)
  })

  it.each(['release', 'version', 'key'] as const)('invalidates an already consented dialog directly on %s change', async scope => {
    const first = validated()
    const next = scope === 'key' ? first : validated({ identity: { ...first.identity,
      versionId: secondVersionId, version: 8, releaseId: scope === 'release' ? secondReleaseId : releaseId } })
    const backend = api(scope === 'key' ? [first] : [first, next])
    const user = userEvent.setup(); page(); await load(user, first)
    const previous = await confirm(user, '승인', '직접 전환 전 검토 의견')
    expect(within(previous).getByRole('checkbox', { name: consent })).toBeChecked()
    expect(within(previous).getByRole('button', { name: '승인 요청 전송' })).toBeEnabled()
    const nextRead = deferred<Response>()
    if (scope === 'version') {
      backend.handlers.detail = () => nextRead.promise
      fireEvent.click(screen.getByRole('button', { name: '계약 loan-review v8 선택' }))
    } else if (scope === 'release') {
      fireEvent.change(screen.getByLabelText('정책 Release'), { target: { value: secondReleaseId } })
    } else {
      fireEvent.change(screen.getByLabelText('검토자 키'), { target: { value: `${key}x` } })
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(backend.posts()).toHaveLength(0)
    if (scope === 'version') {
      await act(async () => nextRead.resolve(response(next)))
      await waitFor(() => expect(screen.getByLabelText('계약 JSON').textContent).toBe(next.storedPolicyJson))
    } else {
      await loadList(user, scope === 'key' ? `${key}x` : key)
      await selectVersion(user, next)
    }
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    const current = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    expect(within(current).getByLabelText('검토 의견')).toHaveValue('')
    expect(within(current).getByRole('checkbox', { name: consent })).not.toBeChecked()
    expect(within(current).getByRole('button', { name: '승인 요청 전송' })).toBeDisabled()
    expect(backend.posts()).toHaveLength(0)
  })

  it.each(['releaseFingerprint', 'updatedAt'] as const)('invalidates consent when the same release ID has a new %s', async field => {
    const backend = api([validated()])
    const initial = release()
    const user = userEvent.setup(); const rendered = page([initial]); await load(user, validated())
    const previous = await confirm(user, '승인', '이전 Release 메타데이터 검토 의견')
    expect(within(previous).getByRole('checkbox', { name: consent })).toBeChecked()
    expect(within(previous).getByRole('button', { name: '승인 요청 전송' })).toBeEnabled()
    const changed = { ...initial, [field]: field === 'updatedAt' ? '2026-09-07T06:30:00Z' : changedHash }
    rendered.rerender(<StoredContractReviewPage releases={[changed]} preferredReleaseId={releaseId} client={client} />)
    expect(screen.getByLabelText('정책 Release')).toHaveValue(releaseId)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    expect(backend.posts()).toHaveLength(0)
    await loadList(user); await selectVersion(user, validated())
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    const current = await screen.findByRole('dialog', { name: '계약 승인 확인' })
    expect(within(current).getByLabelText('검토 의견')).toHaveValue('')
    expect(within(current).getByRole('checkbox', { name: consent })).not.toBeChecked()
    expect(within(current).getByRole('button', { name: '승인 요청 전송' })).toBeDisabled()
    expect(backend.posts()).toHaveLength(0)
  })

  it('ignores an old refresh response after key editing and clears the previous comment', async () => {
    const backend = api([validated()])
    const user = userEvent.setup(); page(); await load(user, validated())
    await confirm(user, '승인', '이전 자격 검토 의견')
    const old = deferred<Response>()
    backend.handlers.detail = () => old.promise
    fireEvent.click(screen.getByRole('button', { name: '최신 계약 다시 조회' }))
    await user.type(screen.getByLabelText('검토자 키'), 'x')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    await act(async () => old.resolve(response(validated())))
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    backend.handlers.detail = () => response(validated())
    await loadList(user, `${key}x`); await selectVersion(user, validated())
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    expect(within(await screen.findByRole('dialog', { name: '계약 승인 확인' })).getByLabelText('검토 의견')).toHaveValue('')
    expect(backend.posts()).toHaveLength(0)
  })

  it.each(['network', 'malformed', '503', 'in-progress', 'conflict'])('keeps %s mutation outcomes unknown after a same-hash GET without automatic retry', async failure => {
    const backend = api()
    backend.handlers.post = () => {
      if (failure === 'network') return Promise.reject(new TypeError(key))
      if (failure === 'malformed') return new Response('{', { status: 200 })
      return failure === '503' ? problem(503, 'INTERNAL_ERROR')
        : problem(409, failure === 'in-progress' ? 'IDEMPOTENCY_IN_PROGRESS' : 'IDEMPOTENCY_CONFLICT')
    }
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON').textContent).toBe(snapshot().storedPolicyJson))
    expect(screen.getByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    unavailable('계약 검증'); unavailable('거절 검토')
    expect(backend.posts()).toHaveLength(1)
    expect(document.body.textContent).not.toContain(key)
  })

  it('registers a dispatched request outside the selected session and preserves it across in-flight navigation', async () => {
    const first = snapshot()
    const second = snapshot({ identity: { ...first.identity, versionId: secondVersionId, version: 8 } })
    const backend = api([first, second])
    const pending = deferred<Response>()
    backend.handlers.post = () => pending.promise
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(backend.posts()).toHaveLength(1)
    await selectVersion(user, second)
    expect(screen.getByRole('button', { name: '계약 검증' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '거절 검토' })).toBeDisabled()
    expect(screen.getByLabelText('정책 Release')).toBeEnabled()
    expect(screen.getByLabelText('검토자 키')).toBeEnabled()
    await selectVersion(user, first)
    unavailable('계약 검증'); unavailable('거절 검토')
    expect(backend.posts()).toHaveLength(1)
    await selectVersion(user, second)
    expect(screen.getByRole('button', { name: '계약 검증' })).toBeDisabled()
    await act(async () => pending.reject(new DOMException(key, 'AbortError')))
    await waitFor(() => expect(screen.getByRole('button', { name: '계약 검증' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '거절 검토' })).toBeEnabled()
    await selectVersion(user, first)
    expect(screen.getByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    unavailable('계약 검증'); unavailable('거절 검토')
    expect(backend.posts()).toHaveLength(1)
  })

  it('requires fresh explicit retry consent, sends the identical operation, and retains unknown after retry 403', async () => {
    const backend = api()
    backend.handlers.post = () => Promise.reject(new TypeError(key))
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    unavailable('동일 요청 재전송 검토')
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '동일 요청 재전송 검토' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '동일 요청 재전송 검토' }))
    const dialog = await screen.findByRole('dialog', { name: '동일 요청 재전송 확인' })
    expect(within(dialog).queryByLabelText('검토 의견')).not.toBeInTheDocument()
    expect(dialog.textContent).toContain('{}')
    expect(within(dialog).getByRole('button', { name: '동일 요청 재전송' })).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: retryConsent }))
    backend.handlers.post = () => problem(403, 'CONTRACT_AUTH_REQUIRED')
    await user.click(within(dialog).getByRole('button', { name: '동일 요청 재전송' }))
    await waitFor(() => expect(backend.posts()).toHaveLength(2))
    expect(await screen.findByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    const [original, retried] = backend.posts()
    expect(retried![0]).toBe(original![0])
    expect(retried![1]?.body).toBe(original![1]?.body)
    expect(Object.fromEntries(new Headers(retried![1]?.headers))).toEqual(Object.fromEntries(new Headers(original![1]?.headers)))
    unavailable('계약 검증'); unavailable('거절 검토')
    // A later successful replay may resolve its own entry; a rejected retry above could not.
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '동일 요청 재전송 검토' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '동일 요청 재전송 검토' }))
    const retryDialog = await screen.findByRole('dialog', { name: '동일 요청 재전송 확인' })
    await user.click(within(retryDialog).getByRole('checkbox', { name: retryConsent }))
    const result = validated({ resourceHash: changedHash })
    backend.handlers.post = () => { backend.views.set(versionId, result); return response(platformVersion(result)) }
    await user.click(within(retryDialog).getByRole('button', { name: '동일 요청 재전송' }))
    expect(await screen.findByText('계약 검증 요청이 처리되었습니다.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('요청 처리 여부가 미확정입니다.')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled())
    expect(backend.posts()).toHaveLength(3)
    expect(backend.posts()[2]![1]?.body).toBe(original![1]?.body)
    expect(Object.fromEntries(new Headers(backend.posts()[2]![1]?.headers))).toEqual(Object.fromEntries(new Headers(original![1]?.headers)))
  })

  it('keeps unresolved work after a changed hash or credential epoch and never allows a fresh-key replacement', async () => {
    const backend = api()
    backend.handlers.post = () => Promise.reject(new Error(key))
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    backend.views.set(versionId, snapshot({ resourceHash: changedHash }))
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    await waitFor(() => expect(screen.getByRole('table', { name: '저장 계약 식별자' }).textContent).toContain(changedHash))
    unavailable('동일 요청 재전송 검토'); unavailable('계약 검증')
    backend.views.set(versionId, validated({ state: 'APPROVED', resourceHash: changedHash }))
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    expect(await screen.findByText('이 버전은 읽기 전용입니다.')).toBeInTheDocument()
    expect(screen.getByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    unavailable('동일 요청 재전송 검토')
    backend.views.set(versionId, snapshot())
    await user.type(screen.getByLabelText('검토자 키'), 'x')
    await loadList(user, key); await selectVersion(user)
    await user.click(screen.getByRole('button', { name: '처리 상태 다시 조회' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toBeInTheDocument())
    expect(screen.getByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    unavailable('동일 요청 재전송 검토'); unavailable('계약 검증'); unavailable('거절 검토')
    expect(backend.posts()).toHaveLength(1)
  })
})

const generationId = '019903ac-abcd-7000-8000-000000000070'
const findingId = '019903ac-abcd-7000-8000-000000000071'
const proposalId = '019903ac-abcd-7000-8000-000000000072'
const generationCanary = 'SYNTHETIC_GENERATION_PRIVATE_CANARY'

// Test-authored HTTP records only; this does not execute an A worker or B model.
function generationView(kind: 'CONTRACT' | 'PATCH' = 'CONTRACT', status = 'QUEUED', outcome: string | null = null,
  view = snapshot(), overrides: Record<string, unknown> = {}) {
  const terminal = ['SUCCEEDED', 'FAILED', 'RECOVERY_REQUIRED'].includes(status)
  const candidate = ['VALID', 'WARN', 'PROPOSED'].includes(outcome ?? '')
  return { operationId: generationId, kind, status, statusUrl: `/api/v1/operations/${generationId}`, releaseId,
    outcome, result: status === 'SUCCEEDED' ? { assessment: outcome, issues: [{ code: generationCanary }],
      ...(candidate ? { contractVersionId: view.identity.versionId, policyHash: view.policyHash, resourceHash,
        ...(kind === 'PATCH' ? { patchProposalId: proposalId } : {}) } : {}) } : null,
    errorCode: status === 'RECOVERY_REQUIRED' ? 'EXECUTION_UNCERTAIN' : status === 'FAILED' ? generationCanary : null,
    errorStage: status === 'RECOVERY_REQUIRED' ? 'WORKER' : status === 'FAILED' ? 'ADMISSION' : null,
    retryable: true, createdAt: '2026-09-07T01:00:00Z',
    startedAt: status === 'QUEUED' || status === 'FAILED' ? null : '2026-09-07T01:00:01Z',
    finishedAt: terminal ? '2026-09-07T01:00:02Z' : null,
    rawModel: generationCanary, provider: { private: key }, ...overrides }
}

function admitted(kind: 'CONTRACT' | 'PATCH' = 'CONTRACT', overrides: Record<string, unknown> = {}) {
  const view = generationView(kind, 'QUEUED', null, snapshot(), overrides)
  return new Response(JSON.stringify({ data: view, traceId, timestamp: '2026-09-07T01:00:00Z' }), {
    status: 202, headers: { 'Content-Type': 'application/json', Location: String(view.statusUrl) },
  })
}

function operationGets(backend: ReturnType<typeof api>) {
  return backend.fetchMock.mock.calls.filter(([input, init]) => init?.method !== 'POST' && String(input).includes('/operations/'))
}
function generationPosts(backend: ReturnType<typeof api>) {
  return backend.posts().filter(([input]) => String(input).includes('contracts:generate') || String(input).endsWith('/patch-proposals'))
}
function generationRegion() { return within(screen.getByRole('region', { name: '후보 생성 작업' })) }

async function startPatch(user: User) {
  await user.type(screen.getByLabelText('패치 출처 Finding ID'), findingId)
  await user.click(screen.getByRole('button', { name: '패치 후보 생성' }))
}

function mutationLifecycle(backend: ReturnType<typeof api>, generationKind: 'CONTRACT' | 'PATCH' = 'CONTRACT') {
  backend.handlers.post = (path, init) => {
    if (path.endsWith('contracts:generate') || path.endsWith('/patch-proposals')) return admitted(generationKind)
    const id = path.split('/').at(-1)!.split(':')[0]!
    const previous = backend.views.get(id)!
    const next = path.endsWith(':validate') ? validated({ ...previous, state: 'VALIDATED', resourceHash: changedHash,
      validation: { status: 'VALID', issues: [] } })
      : { ...previous, state: path.endsWith(':approve') ? 'APPROVED' as const : 'REJECTED' as const, resourceHash: baseHash }
    expect(init.credentials).toBe('omit')
    backend.views.set(id, next)
    return response(platformVersion(next))
  }
}

describe('generation admission and explicit stored candidate review', () => {
  it.each(['VALID', 'WARN'])('opens initial %s only on request, then separately validates and approves the fresh stored hash', async outcome => {
    const backend = api([]); mutationLifecycle(backend)
    backend.handlers.operation = () => { backend.views.set(versionId, snapshot()); return response(generationView('CONTRACT', 'SUCCEEDED', outcome)) }
    const user = userEvent.setup(); page(); await loadList(user)
    expect(await screen.findByText('저장된 계약이 없습니다')).toBeInTheDocument()
    await user.dblClick(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(await generationRegion().findByText(outcome, { exact: true })).toBeInTheDocument()
    expect(generationPosts(backend)).toHaveLength(1)
    expect(operationGets(backend)).toHaveLength(1)
    expect(backend.fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/review'))).toHaveLength(0)
    expect(screen.queryByLabelText('계약 JSON')).not.toBeInTheDocument()
    const post = generationPosts(backend)[0]!
    expect(String(post[0])).toBe(`https://api.test/api/v1/releases/${releaseId}/contracts:generate`)
    expect(JSON.parse(String(post[1]?.body))).toEqual({ templateKey: 'loan-review/1' })
    expect(new Headers(post[1]?.headers).has('If-Match')).toBe(false)
    await user.click(screen.getByRole('button', { name: '생성된 후보 검토' }))
    expect(await screen.findByLabelText('계약 JSON')).toHaveTextContent('loan-review')
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled())
    expect(backend.posts()).toHaveLength(2)
    const dialog = await confirm(user, '승인')
    expect(dialog.textContent).toContain(changedHash)
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(new Headers(backend.posts()[2]![1]?.headers).get('If-Match')).toBe(`"${changedHash}"`)
    expect(JSON.parse(String(backend.posts()[2]![1]?.body))).toEqual({ comment: '변경 범위와 검증 결과 확인' })
    expect(document.body.textContent).not.toContain(generationCanary)
    expect(document.body.textContent).not.toContain(key)
  })

  it.each(['CANDIDATE', 'VALIDATED'] as const)('binds a PATCH already %s to its proposal while using the current resource hash', async state => {
    const base = snapshot()
    const candidate = snapshot({ identity: { ...base.identity, versionId: secondVersionId, version: 8 }, state,
      resourceHash: changedHash, validation: state === 'VALIDATED' ? { status: 'VALID', issues: [] } : null })
    const backend = api([base]); mutationLifecycle(backend, 'PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); page(); await load(user); await startPatch(user)
    expect(await generationRegion().findByText('PROPOSED')).toBeInTheDocument()
    expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 7')
    const admission = generationPosts(backend)[0]!
    expect(String(admission[0])).toBe(`https://api.test/api/v1/findings/${findingId}/patch-proposals`)
    expect(JSON.parse(String(admission[1]?.body))).toEqual({ baseContractVersionId: versionId })
    await user.click(screen.getByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    if (state === 'CANDIDATE') {
      await user.click(screen.getByRole('button', { name: '계약 검증' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled())
      expect(JSON.parse(String(backend.posts()[1]![1]?.body))).toEqual({})
    }
    const dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    const approve = backend.posts().at(-1)!
    expect(String(approve[0])).toContain(`${secondVersionId}:approve`)
    expect(JSON.parse(String(approve[1]?.body))).toEqual({ comment: '변경 범위와 검증 결과 확인', patchProposalId: proposalId })
    expect(new Headers(approve[1]?.headers).get('If-Match')).toBe(`"${changedHash}"`)
  })

  it('keeps candidate-specific proposal binding after replacing the Release generation record and does not transfer it to another candidate', async () => {
    const base = validated()
    const candidate = validated({ identity: { ...base.identity, versionId: secondVersionId, version: 8 }, resourceHash: changedHash })
    const backend = api([base]); mutationLifecycle(backend, 'PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); page(); await load(user, base); await startPatch(user)
    await user.click(await screen.findByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    // A new terminal initial generation replaces only the Release record, not this exact candidate's binding.
    mutationLifecycle(backend)
    backend.handlers.operation = () => response(generationView('CONTRACT', 'SUCCEEDED', 'INVALID'))
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(await generationRegion().findByText('INVALID')).toBeInTheDocument()
    await selectVersion(user, base)
    let dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(JSON.parse(String(backend.posts().at(-1)![1]?.body))).not.toHaveProperty('patchProposalId')
    await selectVersion(user, candidate)
    dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    await waitFor(() => expect(backend.posts().at(-1)![0]).toContain(`${secondVersionId}:approve`))
    expect(JSON.parse(String(backend.posts().at(-1)![1]?.body))).toHaveProperty('patchProposalId', proposalId)
  })

  it('rejects the generated candidate through the existing version endpoint without a proposal rejection claim', async () => {
    const candidate = snapshot({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 } })
    const backend = api(); mutationLifecycle(backend, 'PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); page(); await load(user); await startPatch(user)
    await user.click(await screen.findByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    const dialog = await confirm(user, '거절')
    await user.click(within(dialog).getByRole('button', { name: '거절 요청 전송' }))
    expect(await screen.findByText('계약 거절 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(JSON.parse(String(backend.posts().at(-1)![1]?.body))).toEqual({ comment: '변경 범위와 검증 결과 확인' })
    expect(document.body.textContent).not.toContain('제안 거절 완료')
  })

  it.each(['missing', 'duplicate', 'release', 'policy', 'workspace', 'contractKey', 'detailIdentity', 'detailPolicy', 'detailFailure', 'sameBase', 'olderVersion'])('does not hand off a generated PATCH with %s stored evidence', async defect => {
    const candidate = snapshot({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 } })
    const backend = api(); backend.handlers.post = () => admitted('PATCH')
    backend.handlers.operation = () => response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', defect === 'sameBase' ? snapshot() : candidate))
    const user = userEvent.setup(); page(); await load(user); await startPatch(user)
    expect(await generationRegion().findByText('PROPOSED')).toBeInTheDocument()
    const boundCandidate = defect === 'sameBase' ? snapshot() : defect === 'olderVersion'
      ? { ...candidate, identity: { ...candidate.identity, version: 6 } } : candidate
    const flat = platformVersion(boundCandidate)
    backend.handlers.list = () => response(defect === 'missing' ? [] : defect === 'duplicate' ? [flat, flat] : [{ ...flat,
      ...(defect === 'release' ? { releaseId: secondReleaseId } : {}),
      ...(defect === 'policy' ? { policyHash: baseHash } : {}),
      ...(defect === 'workspace' ? { workspaceId: traceId } : {}),
      ...(defect === 'contractKey' ? { contractKey: 'other-policy' } : {}),
    }])
    backend.handlers.detail = () => defect === 'detailFailure' ? problem(503, generationCanary) : response({ ...candidate,
      ...(defect === 'detailIdentity' ? { identity: { ...candidate.identity, version: 99 } } : {}),
      ...(defect === 'detailPolicy' ? { policyHash: baseHash } : {}),
    })
    await user.click(screen.getByRole('button', { name: '생성된 후보 검토' }))
    expect(await screen.findByText('생성 완료 · 저장 후보 조회 실패')).toBeInTheDocument()
    unavailable('계약 검증'); unavailable('승인 검토'); unavailable('거절 검토')
    expect(generationRegion().getByText('PROPOSED')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
    expect(document.body.textContent).not.toContain(generationCanary)
  })
})

describe('generation unknown admission and Operation polling', () => {
  it.each(['lost202', 'abort', '503', 'malformed202', 'in-progress', 'conflict'])('never resubmits %s unknown admission after input, scope and clock changes', async failure => {
    const backend = api(); backend.handlers.post = () => {
      if (failure === 'lost202') return Promise.reject(new TypeError(generationCanary))
      if (failure === 'abort') return Promise.reject(new DOMException(generationCanary, 'AbortError'))
      if (failure === 'malformed202') return response({ private: generationCanary }, 202)
      return problem(failure === '503' ? 503 : 409, failure === 'in-progress' ? 'IDEMPOTENCY_IN_PROGRESS' : failure === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : generationCanary)
    }
    const user = userEvent.setup(); const rendered = page(); await load(user)
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(await screen.findByText('생성 접수 여부 미확정')).toBeInTheDocument()
    await user.type(screen.getByLabelText('패치 출처 Finding ID'), findingId)
    unavailable('초기 계약 후보 생성'); unavailable('패치 후보 생성')
    expect(screen.queryByRole('button', { name: /재전송/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('정책 Release'), secondReleaseId)
    await loadList(user)
    await user.selectOptions(screen.getByLabelText('정책 Release'), releaseId)
    await load(user)
    fireEvent.change(screen.getByLabelText('검토자 키'), { target: { value: `${key}changed` } })
    await loadList(user, `${key}changed`); await selectVersion(user)
    const nextClient = new ContractReviewClient('https://other.test')
    rendered.rerender(<StoredContractReviewPage releases={[release(), release(secondReleaseId)]} preferredReleaseId={releaseId} client={nextClient} />)
    await loadList(user, `${key}changed`); await selectVersion(user)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2099-01-01T00:00:00Z'))
      await user.click(screen.getByRole('button', { name: '계약 목록 조회' }))
      await selectVersion(user)
      unavailable('초기 계약 후보 생성'); unavailable('패치 후보 생성')
      expect(screen.getByText('생성 접수 여부 미확정')).toBeInTheDocument()
      expect(backend.posts()).toHaveLength(1)
      expect(operationGets(backend)).toHaveLength(0)
      expect(document.body.textContent).not.toContain(generationCanary)
      expect(document.body.textContent).not.toContain(key)
    } finally { vi.useRealTimers() }
  })

  it('records pending admission before dispatch and keeps it when navigation abort is ignored', async () => {
    const backend = api(); const admission = deferred<Response>()
    backend.handlers.post = () => admission.promise
    const user = userEvent.setup(); page(); await load(user)
    fireEvent.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    fireEvent.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(backend.posts()).toHaveLength(1)
    expect(screen.getByText('생성 접수 응답 대기 중')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '계약 목록 조회' })); await selectVersion(user)
    expect(backend.posts()[0]![1]?.signal?.aborted).toBe(true)
    unavailable('초기 계약 후보 생성')
    await act(async () => admission.reject(new TypeError(generationCanary)))
    expect(await screen.findByText('생성 접수 여부 미확정')).toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
  })

  it('allows a separately prepared explicit request after a definitive first admission rejection', async () => {
    const backend = api(); backend.handlers.post = () => problem(403, 'CONTRACT_AUTH_REQUIRED')
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(await generationRegion().findByText('검토자 키를 확인해 주세요.')).toBeInTheDocument()
    expect(screen.queryByText('생성 접수 여부 미확정')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(generationPosts(backend)).toHaveLength(2)
    expect(new Headers(generationPosts(backend)[1]![1]?.headers).get('Idempotency-Key'))
      .not.toBe(new Headers(generationPosts(backend)[0]![1]?.headers).get('Idempotency-Key'))
  })

  it.each([
    ['CONTRACT', 'SUCCEEDED', 'INVALID'], ['PATCH', 'SUCCEEDED', 'INVALID'], ['PATCH', 'SUCCEEDED', 'NO_CHANGE_NEEDED'],
    ['CONTRACT', 'FAILED', null], ['PATCH', 'RECOVERY_REQUIRED', null],
  ] as const)('keeps %s %s %s terminal results separate from candidates and automatic POST', async (kind, status, outcome) => {
    const backend = api(); backend.handlers.post = () => admitted(kind)
    backend.handlers.operation = () => response(generationView(kind, status, outcome))
    const user = userEvent.setup(); page(); await load(user)
    if (kind === 'PATCH') await startPatch(user)
    else await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    expect(await generationRegion().findByText(status, { exact: true })).toBeInTheDocument()
    if (outcome) expect(generationRegion().getByText(outcome, { exact: true })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '생성된 후보 검토' })).not.toBeInTheDocument()
    expect(backend.posts()).toHaveLength(1)
    expect(operationGets(backend)).toHaveLength(1)
    if (status === 'RECOVERY_REQUIRED') { unavailable('초기 계약 후보 생성'); unavailable('패치 후보 생성') }
    expect(document.body.textContent).not.toContain(generationCanary)
  })

  it.each(['key', 'client', 'release', 'signature'] as const)('holds the single Operation GET lock across %s changes and ignores the old result', async scope => {
    const backend = api(); backend.handlers.post = () => admitted()
    const pending = deferred<Response>(); let outstanding = 0; let maximum = 0
    backend.handlers.operation = () => { outstanding++; maximum = Math.max(maximum, outstanding); return pending.promise.finally(() => { outstanding-- }) }
    const user = userEvent.setup(); const rendered = page(); await load(user)
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    await waitFor(() => expect(operationGets(backend)).toHaveLength(1))
    const oldSignal = operationGets(backend)[0]![1]?.signal
    if (scope === 'key') fireEvent.change(screen.getByLabelText('검토자 키'), { target: { value: `${key}x` } })
    if (scope === 'client') rendered.rerender(<StoredContractReviewPage releases={[release()]} preferredReleaseId={releaseId} client={new ContractReviewClient('https://second.test')} />)
    if (scope === 'signature') rendered.rerender(<StoredContractReviewPage releases={[{ ...release(), updatedAt: '2026-09-08T01:00:00Z' }]} preferredReleaseId={releaseId} client={client} />)
    if (scope === 'release') { await user.selectOptions(screen.getByLabelText('정책 Release'), secondReleaseId); await loadList(user); await user.selectOptions(screen.getByLabelText('정책 Release'), releaseId) }
    await loadList(user, scope === 'key' ? `${key}x` : key); await selectVersion(user)
    expect(oldSignal?.aborted).toBe(true)
    unavailable('생성 상태 다시 조회')
    expect(operationGets(backend)).toHaveLength(1)
    await act(async () => scope === 'client' ? pending.reject(new TypeError(generationCanary))
      : pending.resolve(response(generationView('CONTRACT', 'SUCCEEDED', 'VALID'))))
    expect(generationRegion().getByText('QUEUED')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '생성된 후보 검토' })).not.toBeInTheDocument()
    backend.handlers.operation = () => { outstanding++; maximum = Math.max(maximum, outstanding); outstanding--; return response(generationView('CONTRACT', 'SUCCEEDED', 'INVALID')) }
    await user.click(screen.getByRole('button', { name: '생성 상태 다시 조회' }))
    expect(await generationRegion().findByText('INVALID')).toBeInTheDocument()
    expect(maximum).toBe(1); expect(outstanding).toBe(0)
    expect(backend.posts()).toHaveLength(1)
  })

  it('polls only after settlement, separates GET failure, and stops timers on error, terminal and unmount', async () => {
    vi.useFakeTimers()
    try {
      const backend = api(); backend.handlers.post = () => admitted()
      const slow = deferred<Response>(); backend.handlers.operation = () => slow.promise
      const rendered = page()
      fireEvent.change(screen.getByLabelText('검토자 키'), { target: { value: key } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '계약 목록 조회' })) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '초기 계약 후보 생성' })) })
      expect(operationGets(backend)).toHaveLength(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(operationGets(backend)).toHaveLength(1)
      await act(async () => slow.resolve(response(generationView('CONTRACT', 'RUNNING'))))
      backend.handlers.operation = () => problem(503, generationCanary)
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(operationGets(backend)).toHaveLength(2)
      expect(screen.getByText('생성 상태 조회 실패')).toBeInTheDocument()
      expect(generationRegion().getByText('RUNNING')).toBeInTheDocument()
      expect(generationRegion().getByText(generationId)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
      expect(operationGets(backend)).toHaveLength(2)
      backend.handlers.operation = () => response(generationView('CONTRACT', 'SUCCEEDED', 'INVALID'))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '생성 상태 다시 조회' })) })
      expect(generationRegion().getByText('INVALID')).toBeInTheDocument()
      expect(screen.queryByText('생성 상태 조회 실패')).not.toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
      expect(operationGets(backend)).toHaveLength(3)
      const unmountedRead = deferred<Response>()
      backend.handlers.operation = () => unmountedRead.promise
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '초기 계약 후보 생성' })) })
      expect(operationGets(backend)).toHaveLength(4)
      const lastSignal = operationGets(backend).at(-1)![1]?.signal
      rendered.unmount()
      expect(lastSignal?.aborted).toBe(true)
      await act(async () => unmountedRead.resolve(response(generationView('CONTRACT', 'RUNNING'))))
      await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
      expect(operationGets(backend)).toHaveLength(4)
      expect(backend.posts()).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
})

describe('generation handoff scope and current approval consent', () => {
  it.each(['key', 'client', 'signature'] as const)('does not attach an earlier %s scope proposal to a new approval', async scope => {
    const candidate = validated({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 }, resourceHash: changedHash })
    const backend = api(); mutationLifecycle(backend, 'PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); const rendered = page(); await load(user); await startPatch(user)
    await user.click(await screen.findByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    await confirm(user, '승인')
    if (scope === 'key') fireEvent.change(screen.getByLabelText('검토자 키'), { target: { value: `${key}x` } })
    else if (scope === 'client') rendered.rerender(<StoredContractReviewPage releases={[release()]} preferredReleaseId={releaseId} client={new ContractReviewClient('https://second.test')} />)
    else rendered.rerender(<StoredContractReviewPage releases={[{ ...release(), updatedAt: '2026-09-08T02:00:00Z' }]} preferredReleaseId={releaseId} client={client} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await loadList(user, scope === 'key' ? `${key}x` : key); await selectVersion(user, candidate)
    unavailable('생성된 후보 검토')
    backend.handlers.post = () => problem(409, 'RESOURCE_CONFLICT')
    const dialog = await confirm(user, '승인')
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('이전 동의를 해제했습니다. 최신 내용을 확인하고 다시 검토해 주세요.')).toBeInTheDocument()
    expect(screen.queryByText('계약 승인 요청이 처리되었습니다.')).not.toBeInTheDocument()
    // This generic stored mutation is not proof of A accepting a patch without its required link.
    expect(JSON.parse(String(backend.posts().at(-1)![1]?.body))).not.toHaveProperty('patchProposalId')
    expect(generationPosts(backend)).toHaveLength(1)
  })

  it('preserves a proposal across 409 reinspection but requires fresh consent and current hash', async () => {
    const candidate = validated({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 }, resourceHash: changedHash })
    const backend = api(); mutationLifecycle(backend, 'PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); page(); await load(user); await startPatch(user)
    await user.click(await screen.findByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    let dialog = await confirm(user, '승인')
    const ordinaryPost = backend.handlers.post
    let rejected = false
    backend.handlers.post = (path, init) => {
      if (path.endsWith(':approve') && !rejected) {
        rejected = true; backend.views.set(secondVersionId, { ...candidate, resourceHash: baseHash })
        return problem(409, 'RESOURCE_CONFLICT')
      }
      return ordinaryPost(path, init)
    }
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('이전 동의를 해제했습니다. 최신 내용을 확인하고 다시 검토해 주세요.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '승인 검토' })).toBeEnabled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(backend.posts()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '승인 검토' }))
    dialog = screen.getByRole('dialog', { name: '계약 승인 확인' })
    expect(within(dialog).getByRole('checkbox', { name: consent })).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: '승인 요청 전송' })).toBeDisabled()
    expect(dialog.textContent).toContain(baseHash)
    await user.click(within(dialog).getByRole('checkbox', { name: consent }))
    await user.click(within(dialog).getByRole('button', { name: '승인 요청 전송' }))
    expect(await screen.findByText('계약 승인 요청이 처리되었습니다.')).toBeInTheDocument()
    expect(new Headers(backend.posts().at(-1)![1]?.headers).get('If-Match')).toBe(`"${baseHash}"`)
    expect(JSON.parse(String(backend.posts().at(-1)![1]?.body))).toHaveProperty('patchProposalId', proposalId)
  })

  it('blocks approval if the same bound candidate now reports a different immutable policy hash', async () => {
    const candidate = validated({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 } })
    const backend = api(); backend.handlers.post = () => admitted('PATCH')
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('PATCH', 'SUCCEEDED', 'PROPOSED', candidate)) }
    const user = userEvent.setup(); page(); await load(user); await startPatch(user)
    await user.click(await screen.findByRole('button', { name: '생성된 후보 검토' }))
    await waitFor(() => expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 8'))
    backend.views.set(secondVersionId, { ...candidate, policyHash: baseHash })
    await user.click(screen.getByRole('button', { name: '최신 계약 다시 조회' }))
    expect(await screen.findByText('저장 후보와 패치 제안의 연결을 확인할 수 없습니다.')).toBeInTheDocument()
    unavailable('승인 검토')
    expect(backend.posts()).toHaveLength(1)
  })

  it('blocks replacement generation during candidate handoff and ignores its late detail after selection changes', async () => {
    const candidate = snapshot({ identity: { ...snapshot().identity, versionId: secondVersionId, version: 8 } })
    const backend = api(); backend.handlers.post = () => admitted()
    backend.handlers.operation = () => { backend.views.set(secondVersionId, candidate); return response(generationView('CONTRACT', 'SUCCEEDED', 'VALID', candidate)) }
    const user = userEvent.setup(); page(); await load(user)
    await user.click(screen.getByRole('button', { name: '초기 계약 후보 생성' }))
    await generationRegion().findByText('VALID')
    const slow = deferred<Response>()
    backend.handlers.detail = id => id === secondVersionId ? slow.promise : response(backend.views.get(id))
    await user.click(screen.getByRole('button', { name: '생성된 후보 검토' }))
    unavailable('초기 계약 후보 생성'); unavailable('패치 후보 생성')
    await selectVersion(user)
    await act(async () => slow.resolve(response(candidate)))
    expect(screen.getByLabelText('계약 JSON')).toHaveTextContent('"version": 7')
    expect(backend.posts()).toHaveLength(1)
  })

  it('does not generate from an unresolved stored mutation or before the initial list has loaded', async () => {
    const backend = api(); const listing = deferred<Response>()
    backend.handlers.list = () => listing.promise
    const user = userEvent.setup(); page(); await loadList(user)
    unavailable('초기 계약 후보 생성')
    await act(async () => listing.resolve(response([platformVersion(snapshot())])))
    await selectVersion(user)
    backend.handlers.post = () => Promise.reject(new TypeError(key))
    await user.click(screen.getByRole('button', { name: '계약 검증' }))
    expect(await screen.findByText('요청 처리 여부가 미확정입니다.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('패치 출처 Finding ID'), findingId)
    unavailable('패치 후보 생성')
    expect(generationPosts(backend)).toHaveLength(0)
  })
})
