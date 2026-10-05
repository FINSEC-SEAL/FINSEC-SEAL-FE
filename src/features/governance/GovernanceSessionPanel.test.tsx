import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GovernanceSessionPanel } from './GovernanceSessionPanel'

// Synthetic fetch/jsdom through the real client: not browser cookie/CORS or BE/D evidence.
const now = Date.parse('2026-10-04T22:00:00Z')
const bootstrap = 'SYNTHETIC_A_PANEL_BOOTSTRAP_PRIVATE_0123456789'
const csrf = '00000000-0000-4000-8000-000000000011:00000000-0000-4000-8000-000000000012'
const cookieCanary = 'SYNTHETIC_HTTPONLY_COOKIE_VALUE_NEVER_PUBLIC'
const workspaceId = '019903ac-abcd-7000-8000-000000000001'
const sessionId = '019903ac-abcd-7000-8000-000000000002'
const calls: { url: string; init: RequestInit; headers: Headers }[] = []
const remaining: (() => void)[] = []
let example = 0
let base = ''

function wire(actorId = '거버넌스 검토자', expiresAt = now / 1000 + 1800) {
  return { csrfToken: csrf, expiresAt, actorId, workspaceId,
    role: 'AI_GOVERNANCE_REVIEWER', sessionId, demoMode: true }
}
function envelope(data: unknown = wire()) {
  return { data, traceId: '019903ac-abcd-7000-8000-000000000003', timestamp: new Date(now).toISOString() }
}
function response(data: unknown = wire()) {
  return new Response(JSON.stringify(envelope(data)), { status: 200, headers: {
    'Content-Type': 'application/json', 'Set-Cookie': `__Host-FINSEC_GOVERNANCE=${cookieCanary}`,
  } })
}
function transport(handler: (index: number) => Response | Promise<Response>) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
  fetchMock.mockImplementation((input, init = {}) => {
    const index = calls.length
    calls.push({ url: String(input), init, headers: new Headers(init.headers) })
    return Promise.resolve(handler(index))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
function slowBody(data: unknown = wire()) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope(data))))
    controller.close()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value }, cancel() { finished = true },
  })
  remaining.push(finish)
  return { reply: new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }), finish }
}
function deferredDiscard(status: number, contentType = 'application/problem+json') {
  let resolve!: () => void
  let settled = false
  const wait = new Promise<void>(done => { resolve = done })
  const finish = (): void => { if (!settled) { settled = true; resolve() } }
  const cancel = vi.fn(() => wait)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`${bootstrap} ${csrf} ${cookieCanary}`)) },
    cancel,
  })
  remaining.push(finish)
  return { reply: new Response(stream, { status, headers: { 'Content-Type': contentType } }), cancel, finish }
}
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
}
function mount(apiBase = base) {
  const view = render(<GovernanceSessionPanel apiBase={apiBase} />)
  return { ...view, ui: within(view.container) }
}
type UI = ReturnType<typeof within>
function input(ui: UI): HTMLInputElement {
  return ui.getByLabelText('거버넌스 연결 키') as HTMLInputElement
}
function connect(ui: UI, key = bootstrap): void {
  fireEvent.change(input(ui), { target: { value: key } })
  fireEvent.submit(input(ui).closest('form')!)
}
function busyButtons(ui: UI): void {
  for (const name of ['연결', '상태 확인', '해제']) {
    expect(ui.getByRole('button', { name })).toBeDisabled()
  }
}
function publicSafe(): void {
  expect(document.body.textContent).not.toContain(bootstrap)
  expect(document.body.textContent).not.toContain(csrf)
  expect(document.body.textContent).not.toContain(cookieCanary)
  expect(document.body.innerHTML).not.toContain(bootstrap)
  expect(document.body.innerHTML).not.toContain(csrf)
  expect(document.body.innerHTML).not.toContain(cookieCanary)
  expect(document.body.textContent).not.toContain('Authorization')
  expect(document.body.textContent).not.toContain('csrfToken')
}

beforeEach(() => {
  base = `https://panel-${++example}.test`
  calls.length = 0
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const finish of remaining.splice(0)) finish()
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('standalone governance session panel', () => {
  it('mounts without HTTP, uses an accessible password input, and erases the DOM value on context change/unmount', async () => {
    transport(() => response())
    const view = mount()
    expect(calls).toHaveLength(0)
    const oldInput = input(view.ui)
    expect(oldInput).toHaveAttribute('type', 'password')
    expect(oldInput).toHaveAttribute('autocomplete', 'off')
    expect(oldInput.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.change(oldInput, { target: { value: bootstrap } })
    expect(oldInput).toHaveValue(bootstrap)
    view.rerender(<GovernanceSessionPanel apiBase={`${base}/another-prefix`} />)
    expect(oldInput).toHaveValue('')
    const replacement = input(view.ui)
    expect(replacement).toHaveValue('')
    fireEvent.change(replacement, { target: { value: bootstrap } })
    view.unmount()
    expect(replacement).toHaveValue('')
    expect(calls).toHaveLength(0)
  })

  it('exchanges only after submit, clears the key immediately, confirms the cookie and renders only public identity', async () => {
    transport(() => response())
    const view = mount()
    connect(view.ui)
    expect(input(view.ui)).toHaveValue('')
    busyButtons(view.ui)
    await settle()
    expect(view.ui.getByRole('status')).toHaveTextContent('연결됨')
    expect(view.ui.getByText('거버넌스 검토자')).toBeInTheDocument()
    expect(view.ui.getByText(workspaceId)).toBeInTheDocument()
    expect(view.ui.getByText('AI_GOVERNANCE_REVIEWER')).toBeInTheDocument()
    expect(view.ui.getByRole('button', { name: '해제' })).toBeEnabled()
    expect(view.ui.getByRole('button', { name: '연결' })).toBeDisabled()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers.get('Authorization')).toBe(`GovernanceBootstrap ${bootstrap}`)
    expect(calls[1]!.headers.has('Authorization')).toBe(false)
    for (const call of calls) {
      expect(call.url).toBe(`${base}/api/v1/governance-reviewer-session`)
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store' })
    }
    publicSafe()
  })

  it('blocks duplicate submit and every lifecycle button until the confirmation response body settles', async () => {
    const body = slowBody()
    transport(index => index === 0 ? response() : body.reply)
    const view = mount()
    connect(view.ui)
    await settle()
    expect(calls).toHaveLength(2)
    busyButtons(view.ui)
    expect(view.ui.getByRole('region')).toHaveAttribute('aria-busy', 'true')
    fireEvent.submit(input(view.ui).closest('form')!)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    fireEvent.click(view.ui.getByRole('button', { name: '해제' }))
    expect(calls).toHaveLength(2)
    await act(async () => body.finish())
    await settle()
    expect(view.ui.getByRole('region')).toHaveAttribute('aria-busy', 'false')
    expect(view.ui.getByRole('status')).toHaveTextContent('연결됨')
    publicSafe()
  })

  it('keeps a blocked confirmation unknown and requires an explicit cookie-only status read instead of another exchange', async () => {
    transport(index => index === 1 ? new Response(null, { status: 403 }) : response())
    const view = mount()
    connect(view.ui)
    await settle()
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(view.ui.getByRole('button', { name: '연결' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(calls).toHaveLength(2)
    fireEvent.submit(input(view.ui).closest('form')!)
    expect(calls).toHaveLength(2)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.headers.has('Authorization')).toBe(false)
    expect(view.ui.getByRole('status')).toHaveTextContent('연결됨')
    publicSafe()
  })

  it('restores only on click, rereads without a new exchange, and logs out once using private CSRF', async () => {
    transport(index => index === 2 ? new Response(null, { status: 204 }) : response())
    const view = mount()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls.every(call => !call.headers.has('Authorization'))).toBe(true)
    fireEvent.click(view.ui.getByRole('button', { name: '해제' }))
    await settle()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.url).toBe(`${base}/api/v1/governance-reviewer-session/${sessionId}`)
    expect(calls[2]!.init.method).toBe('DELETE')
    expect(calls[2]!.headers.get('X-CSRF-Token')).toBe(csrf)
    expect(calls[2]!.headers.get('Idempotency-Key')).toMatch(/^gov-logout-/)
    expect(calls[2]!.headers.has('Authorization')).toBe(false)
    expect(view.ui.getByRole('status')).toHaveTextContent('연결되지 않음')
    expect(view.ui.queryByText('거버넌스 검토자')).not.toBeInTheDocument()
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    expect(calls).toHaveLength(3)
    publicSafe()
  })

  it('keeps unknown timeout locked through an ignored-abort body, then enables only explicit status recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const body = slowBody()
    transport(index => index === 0 ? body.reply : response(wire('회복된 검토자')))
    const view = mount()
    connect(view.ui)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(calls[0]!.init.signal?.aborted).toBe(true)
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    busyButtons(view.ui)
    expect(input(view.ui)).toHaveValue('')
    expect(calls).toHaveLength(1)
    await act(async () => body.finish())
    await settle()
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(view.ui.getByRole('button', { name: '연결' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    expect(view.ui.queryByText('거버넌스 검토자')).not.toBeInTheDocument()
    expect(calls).toHaveLength(1)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers.has('Authorization')).toBe(false)
    expect(view.ui.getByText('회복된 검토자')).toBeInTheDocument()
    publicSafe()
  })

  it.each([['non200', 403, 'application/problem+json'], ['badContentType', 200, 'text/plain']] as const)
  ('holds buttons through %s body cancellation and recovers only after cancellation settles', async (_, status, contentType) => {
    const body = deferredDiscard(status, contentType)
    transport(index => index === 0 ? body.reply : response())
    const view = mount()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(body.cancel).toHaveBeenCalledTimes(1)
    busyButtons(view.ui)
    expect(calls).toHaveLength(1)
    await act(async () => body.finish())
    await settle()
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(view.ui.getByRole('button', { name: '연결' })).toBeDisabled()
    expect(calls).toHaveLength(1)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers.has('Authorization')).toBe(false)
    publicSafe()
  })

  it('keeps logout failure locally invalid and busy through cancellation, without claiming revocation or auto retry', async () => {
    const body = deferredDiscard(500)
    transport(index => index === 1 ? body.reply : response())
    const view = mount()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    fireEvent.click(view.ui.getByRole('button', { name: '해제' }))
    await settle()
    expect(view.ui.queryByText('거버넌스 검토자')).not.toBeInTheDocument()
    busyButtons(view.ui)
    expect(body.cancel).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    await act(async () => body.finish())
    await settle()
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(view.ui.getByRole('alert')).toHaveTextContent('해제 결과를 확인하지 못했습니다.')
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '연결' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(calls).toHaveLength(2)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls.filter(call => call.init.method === 'DELETE')).toHaveLength(1)
    expect(calls[2]!.headers.has('Authorization')).toBe(false)
    publicSafe()
  })

  it('coordinates same-origin panels and does not cancel the owner when a nonowner panel unmounts', async () => {
    const body = slowBody()
    transport(index => index === 0 ? body.reply : response())
    const owner = mount(), peer = mount()
    connect(owner.ui)
    await settle()
    busyButtons(owner.ui); busyButtons(peer.ui)
    expect(input(peer.ui)).toHaveValue('')
    peer.unmount()
    expect(calls[0]!.init.signal?.aborted).toBe(false)
    expect(calls).toHaveLength(1)
    await act(async () => body.finish())
    await settle()
    expect(owner.ui.getByRole('status')).toHaveTextContent('연결됨')
    expect(calls).toHaveLength(2)
    publicSafe()
  })

  it('keeps a surviving peer busy after owner unmount, ignores the old body and waits for explicit recovery', async () => {
    const body = slowBody()
    transport(index => index === 0 ? body.reply : response(wire('새 검토자')))
    const owner = mount(), peer = mount()
    connect(owner.ui)
    await settle()
    owner.unmount()
    expect(calls[0]!.init.signal?.aborted).toBe(true)
    expect(peer.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    busyButtons(peer.ui)
    await act(async () => body.finish())
    await settle()
    expect(peer.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(peer.ui.queryByText('거버넌스 검토자')).not.toBeInTheDocument()
    expect(peer.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(calls).toHaveLength(1)
    fireEvent.click(peer.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(peer.ui.getByText('새 검토자')).toBeInTheDocument()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers.has('Authorization')).toBe(false)
    publicSafe()
  })

  it('does not restore the first A response during an A-to-B-to-A origin change', async () => {
    const body = slowBody(wire('오래된 A 검토자'))
    transport(index => index === 0 ? body.reply : response(wire(index === 1 ? 'B 검토자' : '새 A 검토자')))
    const view = mount()
    connect(view.ui)
    await settle()
    view.rerender(<GovernanceSessionPanel apiBase={`${base}-other`} />)
    expect(calls[0]!.init.signal?.aborted).toBe(true)
    expect(calls).toHaveLength(1)
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(view.ui.getByText('B 검토자')).toBeInTheDocument()
    view.rerender(<GovernanceSessionPanel apiBase={base} />)
    busyButtons(view.ui)
    expect(view.ui.queryByText('B 검토자')).not.toBeInTheDocument()
    await act(async () => body.finish())
    await settle()
    expect(view.ui.queryByText('오래된 A 검토자')).not.toBeInTheDocument()
    expect(calls).toHaveLength(2)
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(view.ui.getByText('새 A 검토자')).toBeInTheDocument()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.headers.has('Authorization')).toBe(false)
    publicSafe()
  })

  it.each(['network', 'bootstrap-in-success', 'csrf-in-success'] as const)
  ('keeps the %s private canary out of the public view and fixed error', async kind => {
    const fetchMock = transport(() => {
      if (kind === 'network') return Promise.reject(new Error(`${bootstrap} ${csrf} ${cookieCanary}`))
      return response(wire(kind === 'bootstrap-in-success' ? bootstrap : csrf))
    })
    const view = mount()
    connect(view.ui)
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(view.ui.getByRole('status')).toHaveTextContent('결과 미확정')
    expect(view.ui.getByRole('alert')).toHaveTextContent('세션 요청을 완료하지 못했습니다.')
    expect(input(view.ui)).toHaveValue('')
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    publicSafe()
  })

  it('hides expired identity and disables logout without a background renewal request', async () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockRestore()
    vi.setSystemTime(now)
    transport(() => response(wire('만료될 검토자', now / 1000 + 1)))
    const view = mount()
    fireEvent.click(view.ui.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(view.ui.getByText('만료될 검토자')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(view.ui.queryByText('만료될 검토자')).not.toBeInTheDocument()
    expect(view.ui.getByRole('button', { name: '해제' })).toBeDisabled()
    expect(view.ui.getByRole('button', { name: '상태 확인' })).toBeEnabled()
    expect(view.ui.getByRole('alert')).toHaveTextContent('세션이 만료되었습니다.')
    expect(calls).toHaveLength(1)
    publicSafe()
  })

  it('does not leak a malformed base or fetch automatically under StrictMode', async () => {
    transport(() => response())
    const view = render(<StrictMode><GovernanceSessionPanel apiBase={base} /></StrictMode>)
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '상태 확인' }))
    await settle()
    expect(calls).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('연결됨')
    view.rerender(<StrictMode><GovernanceSessionPanel apiBase={`https://${bootstrap}@bad.test`} /></StrictMode>)
    expect(screen.getByRole('alert')).toHaveTextContent('세션 연결 설정을 확인해 주세요.')
    expect(screen.queryByLabelText('거버넌스 연결 키')).not.toBeInTheDocument()
    expect(calls).toHaveLength(1)
    publicSafe()
  })
})
