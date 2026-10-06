import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGovernanceSessionClient, GovernanceSessionError } from './sessionClient'
import type { GovernanceSessionClient, GovernanceSessionHandle, GovernanceSessionSnapshot } from './sessionTypes'

const now = Date.parse('2026-10-04T22:00:00Z')
const bootstrap = 'SYNTHETIC_A_BOOTSTRAP_PRIVATE_CANARY_0123456789'
const privateCsrf = '00000000-0000-4000-8000-000000000011:00000000-0000-4000-8000-000000000012'
const sessionId = '019903ac-abcd-7000-8000-000000000002'
const workspaceId = '019903ac-abcd-7000-8000-000000000001'
const endpoint = 'https://governance.test/api/v1/governance-reviewer-session'
const clients: GovernanceSessionClient[] = []
interface Call { readonly url: string; readonly init: RequestInit; readonly headers: Record<string, string> }
const calls: Call[] = []
function wire(overrides: Record<string, unknown> = {}) {
  return { csrfToken: privateCsrf, expiresAt: now / 1000 + 1800, actorId: '거버넌스 검토자',
    workspaceId, role: 'AI_GOVERNANCE_REVIEWER', sessionId, demoMode: true, ...overrides }
}
function envelope(value: unknown = wire()) {
  return { data: value, traceId: '019903ac-abcd-7000-8000-000000000003', timestamp: new Date(now).toISOString() }
}
function response(value: unknown = wire()) {
  return new Response(JSON.stringify(envelope(value)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function make(base = 'https://governance.test/'): GovernanceSessionClient {
  const client = createGovernanceSessionClient(base); clients.push(client); return client
}
function transport(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
  mock.mockImplementation((input, init = {}) => {
    const call = { url: String(input), init, headers: Object.fromEntries(new Headers(init.headers)) }
    calls.push(call)
    return Promise.resolve(handler(call, calls.length - 1))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function delayedDiscardResponse(status: number, contentType = 'application/json') {
  const cleanup = deferred<void>()
  const cancel = vi.fn(() => cleanup.promise)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`${bootstrap} ${privateCsrf}`)) },
    cancel,
  })
  const reply = new Response(stream, { status, headers: { 'Content-Type': contentType } })
  const text = vi.spyOn(reply, 'text'), json = vi.spyOn(reply, 'json')
  return { cleanup, cancel, reply, text, json }
}
function safePublic(client: GovernanceSessionClient) {
  for (const value of [JSON.stringify(client), JSON.stringify(client.getSnapshot()), JSON.stringify(client.getHandle())]) {
    expect(value).not.toContain(bootstrap)
    expect(value).not.toContain(privateCsrf)
    expect(value).not.toContain('csrfToken')
    expect(value).not.toContain('Authorization')
  }
}
async function rejected(promise: Promise<void>, code: string) {
  try { await promise; throw new Error('Expected lifecycle rejection') }
  catch (error) {
    expect(error).toBeInstanceOf(GovernanceSessionError)
    expect(error).toMatchObject({ code })
    expect(error).not.toHaveProperty('cause')
    expect(String(error)).not.toContain(bootstrap)
    expect(String(error)).not.toContain(privateCsrf)
    expect(JSON.stringify(error)).not.toContain(bootstrap)
    expect(JSON.stringify(error)).not.toContain(privateCsrf)
  }
}

beforeEach(() => { calls.length = 0; vi.spyOn(Date, 'now').mockReturnValue(now) })
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('separate governance session lifecycle', () => {
  it('exchanges once then confirms only the cookie, exposing no CSRF/key/token capability fields', async () => {
    transport(() => response())
    const client = make()
    const pending = client.connect(bootstrap)
    expect(client.getSnapshot()).toMatchObject({ phase: 'connecting', identity: null })
    await pending
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.url)).toEqual([endpoint, endpoint])
    expect(calls[0]!.headers).toEqual({ accept: 'application/json', authorization: `GovernanceBootstrap ${bootstrap}` })
    expect(calls[1]!.headers).toEqual({ accept: 'application/json' })
    for (const call of calls) expect(call.init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error' })
    expect(client.getSnapshot()).toEqual({ phase: 'connected', error: null, pending: false, identity: {
      expiresAt: now / 1000 + 1800, actorId: '거버넌스 검토자', workspaceId,
      role: 'AI_GOVERNANCE_REVIEWER', sessionId, demoMode: true,
    } })
    const handle = client.getHandle()!
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Reflect.ownKeys(handle)).toEqual([])
    expect(client.isCurrent(handle)).toBe(true)
    expect(client.getHandle()).toBe(handle)
    safePublic(client)
  })

  it.each([
    ['csrfToken', '00000000-0000-4000-8000-000000000013:00000000-0000-4000-8000-000000000014'],
    ['actorId', '다른 검토자'], ['workspaceId', '019903ac-abcd-7000-8000-000000000005'],
    ['sessionId', '019903ac-abcd-7000-8000-000000000006'], ['expiresAt', now / 1000 + 1700],
    ['role', 'AI_SECURITY_REVIEWER'], ['demoMode', false],
  ])('refuses cookie confirmation with a different %s rather than registering a local handle', async (field, value) => {
    transport((_, index) => response(index === 0 ? wire() : wire({ [field]: value })))
    const client = make()
    await rejected(client.connect(bootstrap), 'cookie_not_confirmed')
    expect(client.getHandle()).toBeNull()
    expect(client.getSnapshot()).toMatchObject({ phase: 'unknown', identity: null })
    expect(calls).toHaveLength(2)
    safePublic(client)
  })

  it('treats a blocked cookie/empty403 as unknown and allows only explicit cookie-current recovery', async () => {
    transport((_, index) => index === 1 ? new Response(null, { status: 403 }) : response())
    const client = make()
    await rejected(client.connect(bootstrap), 'cookie_not_confirmed')
    expect(calls).toHaveLength(2)
    expect(client.getHandle()).toBeNull()
    await client.current()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.headers).toEqual({ accept: 'application/json' })
    expect(client.getSnapshot().phase).toBe('connected')
  })

  it('restores directly with a cookie-only current request and never automatically renews', async () => {
    transport(() => response())
    const client = make()
    await client.current()
    const previous = client.getHandle()!
    await client.current()
    expect(calls).toHaveLength(2)
    expect(calls.every(call => !Object.hasOwn(call.headers, 'authorization'))).toBe(true)
    expect(client.isCurrent(previous)).toBe(false)
    expect(client.isCurrent(client.getHandle())).toBe(true)
  })

  it.each([
    { role: 'AI_SECURITY_REVIEWER' }, { demoMode: false }, { token: bootstrap }, { csrfToken: bootstrap },
    { expiresAt: now }, { expiresAt: now / 1000 }, { expiresAt: now / 1000 + 1.5 },
    { expiresAt: String(now / 1000 + 1800) }, { sessionId: sessionId.toUpperCase() }, { workspaceId: 'invalid' },
  ])('rejects a malformed/foreign/extra-field response %j without echoing it', async value => {
    transport(() => response(wire(value)))
    const client = make()
    await rejected(client.current(), 'invalid_response')
    expect(client.getHandle()).toBeNull()
    safePublic(client)
  })

  it.each(['csrfToken', 'expiresAt', 'actorId', 'workspaceId', 'role', 'sessionId', 'demoMode'])(
    'rejects missing/null/inherited/accessor %s without evaluating a getter', async field => {
      transport(() => response())
      for (const kind of ['missing', 'null', 'inherited', 'accessor']) {
        const value: Record<string, unknown> = wire()
        const getter = vi.fn(() => value[field])
        if (kind === 'null') value[field] = null
        else {
          const previous = value[field]
          delete value[field]
          if (kind === 'inherited') Object.setPrototypeOf(value, { [field]: previous })
          if (kind === 'accessor') Object.defineProperty(value, field, { enumerable: true, get: getter })
        }
        // Native JSON cannot encode descriptors. A parsed-value boundary double
        // exercises the private validator via the real public lifecycle method.
        const parsed = vi.spyOn(JSON, 'parse').mockReturnValueOnce(envelope(value))
        const client = make(`https://${kind}-${field.toLowerCase()}.test`)
        try { await rejected(client.current(), 'invalid_response') }
        finally { parsed.mockRestore() }
        expect(getter).not.toHaveBeenCalled()
        expect(client.getHandle()).toBeNull()
        safePublic(client)
      }
    },
  )

  it('rejects untrusted envelope descriptors and nonfinite/unsafe expiry without public hydration', async () => {
    transport(() => response())
    const getter = vi.fn(() => wire())
    const withGetter = Object.defineProperty(envelope(), 'data', { get: getter })
    const inherited = Object.assign(Object.create({ data: wire() }), { traceId: envelope().traceId, timestamp: envelope().timestamp })
    const invalid = [null, { ...envelope(), extra: bootstrap }, inherited, withGetter,
      ...[NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map(expiresAt => envelope(wire({ expiresAt })))]
    for (const [index, value] of invalid.entries()) {
      const parsed = vi.spyOn(JSON, 'parse').mockReturnValueOnce(value)
      const client = make(`https://invalid-envelope-${index}.test`)
      try { await rejected(client.current(), 'invalid_response') }
      finally { parsed.mockRestore() }
      expect(client.getHandle()).toBeNull()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects a public actor that echoes the currently supplied bootstrap or private CSRF', async () => {
    for (const actorId of [bootstrap, privateCsrf]) {
      transport(() => response(wire({ actorId })))
      const client = make(`https://${actorId === bootstrap ? 'key' : 'csrf'}.test`)
      await rejected(client.connect(bootstrap), 'invalid_response')
      expect(client.getSnapshot().identity).toBeNull()
      safePublic(client)
    }
  })

  it('refuses a malicious success whose serialized public field boundary contains the supplied key', async () => {
    const key = '"role":"AI_GOVERNANCE_REVIEWER","sessionId":"'
    transport(() => response())
    const client = make()
    await rejected(client.connect(key), 'invalid_response')
    expect(calls).toHaveLength(1)
    expect(client.getHandle()).toBeNull()
    expect(JSON.stringify(client.getSnapshot())).not.toContain(key)
  })

  it.each([false, true])('rejects supplied-private canaries across the actual pending%s snapshot boundary', async pending => {
    const key = `"demoMode":true},"error":null,"pending":${pending}`
    transport(() => response())
    const client = make()
    await rejected(client.connect(key), 'invalid_response')
    expect(client.getHandle()).toBeNull()
    expect(client.getSnapshot().pending).toBe(false)
    expect(JSON.stringify(client.getSnapshot())).not.toContain(key)
    expect(calls).toHaveLength(1)
  })

  it('returns only fixed errors for malicious transport errors and refused response bodies', async () => {
    transport(() => Promise.reject(new Error(`${bootstrap} ${privateCsrf}`)))
    const first = make()
    await rejected(first.connect(bootstrap), 'unavailable')
    expect(calls).toHaveLength(1)
    safePublic(first)
    transport(() => new Response(`${bootstrap} ${privateCsrf}`, { status: 500 }))
    const second = make('https://second.test')
    await rejected(second.current(), 'invalid_response')
    safePublic(second)
  })

  it('keeps one origin flight across clients without queuing another bootstrap secret', async () => {
    const waiting = deferred<Response>()
    transport((_, index) => index === 0 ? waiting.promise : response())
    const first = make(), second = make('https://governance.test')
    const connect = first.connect(bootstrap)
    await rejected(second.connect(bootstrap), 'busy')
    await rejected(second.current(), 'busy')
    expect(calls).toHaveLength(1)
    waiting.resolve(response()); await connect
    expect(calls).toHaveLength(2)
    expect(second.getSnapshot().phase).toBe('connected')
    const firstHandle = first.getHandle()!
    expect(second.isCurrent(firstHandle)).toBe(false)
    expect(second.isCurrent(second.getHandle())).toBe(true)
  })

  it('keeps the origin busy through response-body settlement before cookie confirmation', async () => {
    const waiting = deferred<string>(); const firstBody = response()
    const text = vi.spyOn(firstBody, 'text').mockReturnValue(waiting.promise)
    transport((_, index) => index === 0 ? firstBody : response())
    const first = make(), peer = make(); const pending = first.connect(bootstrap)
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(1))
    await rejected(peer.current(), 'busy')
    await rejected(peer.connect(bootstrap), 'busy')
    expect(calls).toHaveLength(1)
    expect(first.getHandle()).toBeNull()
    expect(peer.getSnapshot().pending).toBe(true)
    waiting.resolve(JSON.stringify(envelope())); await pending
    expect(peer.getSnapshot().pending).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers).not.toHaveProperty('authorization')
    expect(peer.isCurrent(peer.getHandle())).toBe(true)
  })

  it('does not let a busy nonowner unsubscribe/dispose cancel its owner request or callbacks', async () => {
    const waiting = deferred<Response>()
    transport((_, index) => index === 0 ? waiting.promise : response())
    const owner = make(), nonowner = make(); const ownerListener = vi.fn(), nonownerListener = vi.fn()
    owner.subscribe(ownerListener); const off = nonowner.subscribe(nonownerListener)
    const pending = owner.connect(bootstrap)
    await rejected(nonowner.current(), 'busy')
    off(); nonowner.dispose(); const staleCalls = nonownerListener.mock.calls.length
    expect(calls[0]!.init.signal?.aborted).toBe(false)
    waiting.resolve(response()); await pending
    expect(calls).toHaveLength(2)
    expect(owner.isCurrent(owner.getHandle())).toBe(true)
    expect(ownerListener).toHaveBeenCalled()
    expect(nonownerListener).toHaveBeenCalledTimes(staleCalls)
    expect(nonowner.getSnapshot().error).toBe('disposed')
  })

  it('does not hydrate a recreated A context from an abandoned first A response across A-B-A', async () => {
    const waiting = deferred<Response>()
    transport((_, index) => index === 0 ? waiting.promise : response())
    const firstA = make(); const pending = firstA.current()
    const b = make('https://b-origin.test'); await b.current(); const bHandle = b.getHandle()!
    const cancelled = rejected(pending, 'stale'); firstA.dispose(); await cancelled
    const newA = make()
    await rejected(newA.current(), 'busy')
    expect(newA.getHandle()).toBeNull()
    waiting.resolve(response(wire({ actorId: 'abandoned first A' })))
    await new Promise<void>(done => setTimeout(done, 0))
    expect(newA.getHandle()).toBeNull()
    expect(newA.getSnapshot().identity).toBeNull()
    await newA.current()
    expect(newA.getSnapshot().identity?.actorId).toBe('거버넌스 검토자')
    expect(newA.isCurrent(newA.getHandle())).toBe(true)
    expect(b.isCurrent(bHandle)).toBe(true)
    expect(calls.map(call => new URL(call.url).origin)).toEqual([
      'https://governance.test', 'https://b-origin.test', 'https://governance.test',
    ])
  })

  it('keeps a successor origin channel during old completion-callback cleanup', async () => {
    const slow = deferred<string>(), nextResponse = response()
    const text = vi.spyOn(nextResponse, 'text').mockReturnValue(slow.promise)
    transport((_, index) => index === 1 ? nextResponse : response())
    const owner = make()
    let successor!: GovernanceSessionClient
    let successorWork!: Promise<void>
    let replaced = false
    owner.subscribe(() => {
      if (replaced || owner.getSnapshot().phase !== 'connected') return
      replaced = true
      owner.dispose()
      successor = make()
      successorWork = successor.current()
    })
    await owner.current()
    expect(replaced).toBe(true)
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(1))
    const third = make()
    try {
      await rejected(third.current(), 'busy')
      await rejected(third.connect(bootstrap), 'busy')
      expect(calls).toHaveLength(2)
      expect(successor.getHandle()).toBeNull()
      expect(calls[1]!.init.signal?.aborted).toBe(false)
    } finally {
      slow.resolve(JSON.stringify(envelope()))
      await successorWork
    }
    expect(successor.isCurrent(successor.getHandle())).toBe(true)
    expect(third.isCurrent(third.getHandle())).toBe(true)
    await third.current()
    expect(calls).toHaveLength(3)
    expect(third.isCurrent(third.getHandle())).toBe(true)
    expect(owner.getSnapshot().error).toBe('disposed')
  })

  it.each([{ status: 403, type: 'application/json' }, { status: 200, type: 'text/plain' }])(
    'holds a refused GET $status/$type until body cancellation settles', async ({ status, type }) => {
      const failure = delayedDiscardResponse(status, type)
      transport((_, index) => index === 1 ? failure.reply : response())
      const owner = make(), peer = make()
      await owner.current(); const previous = owner.getHandle()!
      const pending = rejected(owner.current(), 'invalid_response')
      await vi.waitFor(() => expect(failure.cancel).toHaveBeenCalledTimes(1))
      expect(owner.isCurrent(previous)).toBe(false)
      expect(owner.getHandle()).toBeNull()
      try {
        await rejected(peer.current(), 'busy')
        await rejected(peer.connect(bootstrap), 'busy')
        expect(calls).toHaveLength(2)
        expect(failure.text).not.toHaveBeenCalled()
        expect(failure.json).not.toHaveBeenCalled()
        expect(peer.getSnapshot().pending).toBe(true)
        safePublic(owner); safePublic(peer)
      } finally { failure.cleanup.resolve(undefined); await pending }
      expect(owner.getSnapshot()).toMatchObject({ phase: 'unknown', pending: false })
      await peer.current()
      expect(calls).toHaveLength(3)
      expect(calls[2]!.headers).not.toHaveProperty('authorization')
      expect(peer.isCurrent(peer.getHandle())).toBe(true)
    },
  )

  it('holds a non204 DELETE until cancellation settles with no public failure-body canary', async () => {
    const failure = delayedDiscardResponse(500)
    transport(call => call.init.method === 'DELETE' ? failure.reply : response())
    const owner = make(), peer = make(); await owner.current(); const previous = owner.getHandle()!
    const pending = rejected(owner.logout(previous), 'logout_unknown')
    await vi.waitFor(() => expect(failure.cancel).toHaveBeenCalledTimes(1))
    expect(owner.isCurrent(previous)).toBe(false)
    expect(peer.getHandle()).toBeNull()
    try {
      await rejected(peer.current(), 'busy')
      expect(calls).toHaveLength(2)
      expect(failure.text).not.toHaveBeenCalled()
      expect(failure.json).not.toHaveBeenCalled()
      expect(peer.getSnapshot().pending).toBe(true)
      safePublic(owner); safePublic(peer)
    } finally { failure.cleanup.resolve(undefined); await pending }
    expect(owner.getSnapshot()).toMatchObject({ phase: 'unknown', identity: null, error: 'logout_unknown', pending: false })
    await peer.current()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.headers).not.toHaveProperty('authorization')
    expect(peer.isCurrent(peer.getHandle())).toBe(true)
  })

  it('cancels a stale arriving response before releasing its origin or parsing its private body', async () => {
    const waiting = deferred<Response>(), late = delayedDiscardResponse(200)
    transport((_, index) => index === 0 ? waiting.promise : response())
    const owner = make(), peer = make(); const notifications: GovernanceSessionSnapshot[] = []
    peer.subscribe(() => { notifications.push(peer.getSnapshot()) })
    const pending = owner.current()
    const cancelled = rejected(pending, 'stale'); owner.dispose(); await cancelled
    waiting.resolve(late.reply)
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledTimes(1))
    const held = peer.getSnapshot(), notificationCount = notifications.length
    expect(held).toMatchObject({ phase: 'unknown', pending: true, identity: null })
    expect(peer.getSnapshot()).toBe(held)
    expect(owner.getSnapshot()).toMatchObject({ error: 'disposed', pending: true, identity: null })
    try {
      await rejected(peer.current(), 'busy')
      expect(calls).toHaveLength(1)
      expect(peer.getHandle()).toBeNull()
      expect(late.text).not.toHaveBeenCalled()
      expect(late.json).not.toHaveBeenCalled()
      safePublic(owner); safePublic(peer)
    } finally {
      late.cleanup.resolve(undefined)
      await new Promise<void>(done => setTimeout(done, 0))
    }
    const released = peer.getSnapshot()
    expect(released).toMatchObject({ phase: 'unknown', pending: false, identity: null })
    expect(released).not.toBe(held)
    expect(peer.getSnapshot()).toBe(released)
    expect(held.pending).toBe(true)
    expect(Object.isFrozen(held)).toBe(true)
    expect(Object.isFrozen(released)).toBe(true)
    expect(notifications.length).toBeGreaterThan(notificationCount)
    expect(notifications.at(-1)).toBe(released)
    expect(owner.getSnapshot()).toMatchObject({ error: 'disposed', pending: false, identity: null })
    expect(peer.getHandle()).toBeNull()
    await peer.current()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers).not.toHaveProperty('authorization')
    expect(peer.isCurrent(peer.getHandle())).toBe(true)
  })


  it.each(['fetch', 'body'] as const)
  ('keeps a retained %s flight unknown through repeated last-member disposal and reopening', async kind => {
    const firstClient = clients.length, safeError = 'unavailable' as const
    const waiting = deferred<Response>(), body = deferred<string>(), first = response()
    const bodyRead = kind === 'body' ? vi.spyOn(first, 'text').mockImplementation(() => body.promise) : null
    transport((_, index) => index === 0 ? (kind === 'fetch' ? waiting.promise : first)
      : response(wire({ actorId: 'Explicitly recovered reviewer' })))
    const owner = make(), pending = owner.connect(bootstrap)
    const cancelled = rejected(pending, 'stale')
    const finish = (): void => { waiting.resolve(first); body.resolve(JSON.stringify(envelope())) }
    try {
      if (bodyRead) await vi.waitFor(() => expect(bodyRead).toHaveBeenCalledTimes(1))
      expect(calls).toHaveLength(1)
      owner.dispose(); await cancelled
      expect(calls[0]!.init.signal?.aborted).toBe(true)
      for (let cycle = 0; cycle < 3; cycle++) {
        const reopened = make()
        expect(reopened.getSnapshot()).toMatchObject({ phase: 'unknown', identity: null, error: safeError, pending: true })
        expect(reopened.getHandle()).toBeNull()
        await rejected(reopened.connect(bootstrap), 'busy')
        await rejected(reopened.current(), 'busy')
        expect(reopened.getSnapshot().error).toBe(safeError)
        expect(calls).toHaveLength(1)
        safePublic(reopened)
        reopened.dispose()
      }
      const retained = make(), held = retained.getSnapshot()
      expect(held).toMatchObject({ phase: 'unknown', identity: null, error: safeError, pending: true })
      expect(retained.getHandle()).toBeNull()
      finish()
      await vi.waitFor(() => expect(retained.getSnapshot())
        .toMatchObject({ phase: 'unknown', identity: null, error: safeError, pending: false }))
      expect(held).toMatchObject({ pending: true, error: safeError })
      expect(retained.getHandle()).toBeNull()
      expect(calls).toHaveLength(1)
      safePublic(retained)
      await retained.current()
      expect(calls).toHaveLength(2)
      expect(calls[1]!.headers).toEqual({ accept: 'application/json' })
      expect(calls[1]!.init).toMatchObject({ method: 'GET', credentials: 'include' })
      expect(retained.getSnapshot()).toMatchObject({ phase: 'connected', pending: false,
        identity: { actorId: 'Explicitly recovered reviewer' } })
      expect(retained.isCurrent(retained.getHandle())).toBe(true)
      retained.dispose()
      const clean = make()
      expect(clean.getSnapshot()).toEqual({ phase: 'disconnected', identity: null, error: null, pending: false })
      expect(clean.getHandle()).toBeNull()
      expect(calls).toHaveLength(2)
      clean.dispose()
    } finally {
      for (const client of clients.slice(firstClient)) client.dispose()
      finish(); await cancelled
      await new Promise<void>(done => setTimeout(done, 0))
    }
  })

  it('rejects forged/copied/C-shaped handles before invoking getters or sending DELETE', async () => {
    transport(() => response())
    const client = make(); await client.current()
    const getter = vi.fn(() => privateCsrf)
    const forged = Object.defineProperty({}, 'csrfToken', { get: getter }) as GovernanceSessionHandle
    const issued = client.getHandle()!
    for (const value of [forged, Object.freeze({}) as GovernanceSessionHandle,
      { ...issued } as GovernanceSessionHandle, JSON.parse(JSON.stringify(issued)) as GovernanceSessionHandle,
      { kind: 'session', role: 'AI_SECURITY_REVIEWER', csrfToken: privateCsrf } as unknown as GovernanceSessionHandle]) {
      expect(client.isCurrent(value)).toBe(false)
      await rejected(client.logout(value), 'invalid_handle')
    }
    expect(getter).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it.each([403, 500])('invalidates locally before logout and keeps status %s unknown, separate from durable revoke', async status => {
    const deleted = deferred<Response>()
    transport(call => call.init.method === 'DELETE' ? deleted.promise : response())
    const client = make(); await client.current()
    const handle = client.getHandle()!
    const pending = client.logout(handle)
    expect(client.isCurrent(handle)).toBe(false)
    expect(client.getHandle()).toBeNull()
    expect(client.getSnapshot()).toMatchObject({ phase: 'disconnecting', identity: null })
    const call = calls[1]!
    expect(call.url).toBe(`${endpoint}/${sessionId}`)
    expect(call.headers['x-csrf-token']).toBe(privateCsrf)
    expect(call.headers['idempotency-key']).toMatch(/^gov-logout-[0-9a-f-]{36}$/)
    expect(call.headers).not.toHaveProperty('authorization')
    expect(call.init).toMatchObject({ method: 'DELETE', credentials: 'include', redirect: 'error', cache: 'no-store' })
    deleted.resolve(new Response(null, { status }))
    await rejected(pending, 'logout_unknown')
    expect(client.getSnapshot()).toMatchObject({ phase: 'unknown', identity: null, error: 'logout_unknown' })
    expect(calls).toHaveLength(2)
    safePublic(client)
  })

  it('keeps disposed/aborted logout unknown and ignores a later204 without restoring a local handle', async () => {
    const waiting = deferred<Response>()
    transport(call => call.init.method === 'DELETE' ? waiting.promise : response())
    const client = make(); await client.current(); const handle = client.getHandle()!
    const pending = client.logout(handle); const cancelled = rejected(pending, 'logout_unknown')
    client.dispose(); await cancelled
    expect(client.isCurrent(handle)).toBe(false)
    expect(client.getHandle()).toBeNull()
    expect(calls[1]!.init.signal?.aborted).toBe(true)
    expect(new Headers(calls[1]!.init.headers).has('X-CSRF-Token')).toBe(false)
    waiting.resolve(new Response(null, { status: 204 }))
    await new Promise<void>(done => setTimeout(done, 0))
    expect(client.getSnapshot()).toEqual({ phase: 'disconnected', identity: null, error: 'disposed', pending: false })
    expect(calls).toHaveLength(2)
  })

  it('finishes a204 logout without reading/echoing a body or reusing its handle', async () => {
    transport(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : response())
    const client = make(); await client.current(); const handle = client.getHandle()!
    await client.logout(handle)
    expect(client.getSnapshot()).toEqual({ phase: 'disconnected', identity: null, error: null, pending: false })
    await rejected(client.logout(handle), 'invalid_handle')
    expect(calls).toHaveLength(2)
  })

  it('never lets an abandoned slow body restore authority or overwrite a newer cookie-current', async () => {
    const slow = deferred<string>(); const firstResponse = response()
    const text = vi.spyOn(firstResponse, 'text').mockReturnValue(slow.promise)
    transport((_, index) => index === 0 ? firstResponse : response())
    const first = make(), second = make()
    const pending = first.connect(bootstrap)
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(1))
    const cancelled = rejected(pending, 'stale')
    first.dispose(); await cancelled
    expect(first.getSnapshot()).toMatchObject({ phase: 'disconnected', error: 'disposed' })
    await rejected(second.current(), 'busy')
    slow.resolve(JSON.stringify(envelope(wire({ actorId: 'late old actor' }))))
    await new Promise<void>(done => setTimeout(done, 0))
    await second.current(); const currentHandle = second.getHandle()!
    expect(second.isCurrent(currentHandle)).toBe(true)
    expect(second.getSnapshot().identity?.actorId).toBe('거버넌스 검토자')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers).not.toHaveProperty('authorization')
  })

  it('isolates configured origins and API-prefix contexts, including disposal', async () => {
    const waiting = deferred<Response>()
    transport(call => call.url.startsWith('https://governance.test/') ? waiting.promise : response())
    const first = make(); const other = make('https://other.test/gateway/')
    const pending = first.current(); await other.current()
    expect(other.getSnapshot().phase).toBe('connected')
    expect(calls[1]!.url).toBe('https://other.test/gateway/api/v1/governance-reviewer-session')
    const otherHandle = other.getHandle()!
    expect(first.isCurrent(otherHandle)).toBe(false)
    const cancelled = rejected(pending, 'stale'); first.dispose(); await cancelled
    waiting.resolve(response())
    expect(other.isCurrent(otherHandle)).toBe(true)
    const prefixed = make('https://other.test/another')
    expect(prefixed.getHandle()).toBeNull()
    expect(prefixed.getSnapshot()).toEqual({ phase: 'disconnected', identity: null, error: null, pending: false })
    other.dispose(); expect(other.isCurrent(otherHandle)).toBe(false)
  })

  it('rechecks expiry before sending logout even if the UI timer has not run', async () => {
    transport(() => response())
    const client = make(); await client.current(); const handle = client.getHandle()!
    vi.spyOn(Date, 'now').mockReturnValue((now / 1000 + 1800) * 1000)
    expect(client.getSnapshot()).toMatchObject({ phase: 'disconnected', identity: null, error: 'expired' })
    expect(client.isCurrent(handle)).toBe(false)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(client.isCurrent(handle)).toBe(false)
    await rejected(client.logout(handle), 'invalid_handle')
    expect(calls).toHaveLength(1)
  })

  it('expires the local handle at its timer boundary without making any renewal request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    transport(() => response(wire({ expiresAt: now / 1000 + 1 })))
    const client = make(); await client.current(); const handle = client.getHandle()!
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.isCurrent(handle)).toBe(false)
    expect(client.getSnapshot().error).toBe('expired')
    expect(calls).toHaveLength(1)
  })

  it('bounds an ignored abort and leaves unknown issuance recoverable by an explicit current only', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const waiting = deferred<Response>()
    transport((_, index) => index === 0 ? waiting.promise : response())
    const client = make(), peer = make(); const notifications: GovernanceSessionSnapshot[] = []
    peer.subscribe(() => { notifications.push(peer.getSnapshot()) })
    const pending = client.connect(bootstrap)
    const timedOut = rejected(pending, 'unavailable')
    await vi.advanceTimersByTimeAsync(30000); await timedOut
    expect(client.getHandle()).toBeNull()
    const held = peer.getSnapshot(), notificationCount = notifications.length
    expect(held).toMatchObject({ phase: 'unknown', pending: true, identity: null })
    expect(peer.getSnapshot()).toBe(held)
    expect(calls).toHaveLength(1)
    await rejected(client.current(), 'busy')
    await rejected(peer.current(), 'busy')
    waiting.resolve(response()); await vi.advanceTimersByTimeAsync(0)
    const released = peer.getSnapshot()
    expect(released).toMatchObject({ phase: 'unknown', pending: false, identity: null })
    expect(released).not.toBe(held)
    expect(peer.getSnapshot()).toBe(released)
    expect(held.pending).toBe(true)
    expect(notifications.length).toBeGreaterThan(notificationCount)
    expect(notifications.at(-1)).toBe(released)
    expect(peer.getHandle()).toBeNull()
    expect(calls).toHaveLength(1)
    await client.current(); const handle = client.getHandle()!
    expect(client.isCurrent(handle)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('supports the selected localhost cross-origin base and rejects credentials/query/nonHTTP configuration', async () => {
    transport(() => response())
    const client = make('http://localhost:8080'); await client.current()
    expect(calls[0]!.url).toBe('http://localhost:8080/api/v1/governance-reviewer-session')
    for (const base of ['file:///private', 'https://user:password@api.test', 'https://api.test?key=value', 'https://api.test/#fragment']) {
      expect(() => make(base)).toThrow(GovernanceSessionError)
    }
    expect(calls).toHaveLength(1)
  })

  it('uses matching safeASCII/UTF8 key values without normalization and refuses short inputs before transport', async () => {
    transport(() => response())
    for (const [index, key] of ['S'.repeat(32), 'é'.repeat(16)].entries()) {
      const client = make(`https://control-${index}.test`)
      await client.connect(key)
      expect(calls[index * 2]!.headers.authorization).toBe(`GovernanceBootstrap ${key}`)
      expect(client.getSnapshot().phase).toBe('connected')
      expect(JSON.stringify(client.getSnapshot())).not.toContain(key)
    }
    const client = make('https://invalid-input.test')
    for (const key of ['x'.repeat(31), 'é'.repeat(15), `${bootstrap}\r\nHeader:value`]) {
      await rejected(client.connect(key), 'invalid_input')
    }
    expect(calls).toHaveLength(4)
  })

  it('fails native header construction without fetch, fallback codec, or public key echo', async () => {
    const fetch = transport(() => response()); const client = make()
    const key = '한'.repeat(32)
    await rejected(client.connect(key), 'invalid_input')
    expect(fetch).not.toHaveBeenCalled()
    expect(client.getSnapshot().identity).toBeNull()
    expect(JSON.stringify(client.getSnapshot())).not.toContain(key)
  })

  it('keeps separately subscribed identical callbacks alive when another client unsubscribes', async () => {
    transport(() => response())
    const first = make(), second = make(); const listener = vi.fn()
    const offFirst = first.subscribe(listener); second.subscribe(listener); offFirst()
    await first.current()
    expect(listener).toHaveBeenCalled()
    second.dispose(); const count = listener.mock.calls.length
    await first.current(); expect(listener).toHaveBeenCalledTimes(count)
  })
})
