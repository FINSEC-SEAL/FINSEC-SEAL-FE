import type {
  GovernanceSessionClient, GovernanceSessionErrorCode, GovernanceSessionHandle,
  GovernanceSessionIdentity, GovernanceSessionPhase, GovernanceSessionSnapshot,
} from './sessionTypes'

const defaultBase = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080'
const sessionPath = '/api/v1/governance-reviewer-session'
const scheme = 'GovernanceBootstrap '
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const csrf = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const codes = new Set<GovernanceSessionErrorCode>([
  'invalid_configuration', 'invalid_input', 'invalid_response', 'cookie_not_confirmed', 'busy',
  'unavailable', 'stale', 'expired', 'logout_unknown', 'invalid_handle', 'disposed',
])
const disconnected: GovernanceSessionSnapshot = Object.freeze({ phase: 'disconnected', identity: null, error: null, pending: false })
const expired: GovernanceSessionSnapshot = Object.freeze({ phase: 'disconnected', identity: null, error: 'expired', pending: false })
const disposed: GovernanceSessionSnapshot = Object.freeze({ phase: 'disconnected', identity: null, error: 'disposed', pending: false })
const disconnectedPending: GovernanceSessionSnapshot = Object.freeze({ ...disconnected, pending: true })
const expiredPending: GovernanceSessionSnapshot = Object.freeze({ ...expired, pending: true })
const disposedPending: GovernanceSessionSnapshot = Object.freeze({ ...disposed, pending: true })

export class GovernanceSessionError extends Error {
  readonly code: GovernanceSessionErrorCode
  constructor(code: GovernanceSessionErrorCode) {
    super('거버넌스 세션 요청을 완료하지 못했습니다.')
    this.name = 'GovernanceSessionError'
    this.code = codes.has(code) ? code : 'unavailable'
    Object.freeze(this)
  }
}

interface WireSession extends GovernanceSessionIdentity { readonly csrfToken: string }
interface Context { disposed: boolean }
interface Flight {
  readonly context: Context
  readonly generation: number
  readonly controller: AbortController
  abortCode: GovernanceSessionErrorCode
  timer: ReturnType<typeof setTimeout> | null
}
interface Channel {
  generation: number
  endpoint: string | null
  session: WireSession | null
  snapshot: GovernanceSessionSnapshot
  flight: Flight | null
  expiryTimer: ReturnType<typeof setTimeout> | null
  readonly members: Set<Context>
  readonly listeners: Set<() => void>
}
interface HandleRecord { readonly context: Context; readonly channel: Channel; readonly generation: number }
const channels = new Map<string, Channel>()
const handles = new WeakMap<object, HandleRecord>()

function fail(code: GovernanceSessionErrorCode): never { throw new GovernanceSessionError(code) }
function safeError(error: unknown, fallback: GovernanceSessionErrorCode): GovernanceSessionError {
  // Do not trust a caught getter/message/cause or preserve a transport error object.
  try {
    if (error instanceof GovernanceSessionError) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown
      if (typeof code === 'string' && codes.has(code as GovernanceSessionErrorCode)) {
        return new GovernanceSessionError(code as GovernanceSessionErrorCode)
      }
    }
  } catch { /* An arbitrary transport error does not become a public diagnostic. */ }
  return new GovernanceSessionError(fallback)
}
function clock(): number {
  const value = Date.now()
  if (!Number.isFinite(value) || value < 0) fail('unavailable')
  return value
}
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_response')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) fail('invalid_response')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of names) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !Object.hasOwn(field, 'value')) fail('invalid_response')
    result[key] = field.value
  }
  return result
}
function readWire(value: unknown): WireSession {
  const envelope = record(value, ['data', 'traceId', 'timestamp'])
  if (typeof envelope.traceId !== 'string' || !uuid.test(envelope.traceId)
    || typeof envelope.timestamp !== 'string' || envelope.timestamp.length > 64
    || !Number.isFinite(Date.parse(envelope.timestamp))) fail('invalid_response')
  const serverTime = Date.parse(envelope.timestamp as string)
  const fields = ['csrfToken', 'expiresAt', 'actorId', 'workspaceId', 'role', 'sessionId', 'demoMode']
  const data = record(envelope.data, fields)
  if (typeof data.csrfToken !== 'string' || !csrf.test(data.csrfToken)
    || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt)
    || data.expiresAt <= 0 || data.expiresAt > Math.floor(serverTime / 1000) + 1800
    || data.expiresAt * 1000 <= clock()
    || typeof data.actorId !== 'string' || !data.actorId.trim() || data.actorId.length > 120
    || /[\u0000-\u001f\u007f-\u009f]/.test(data.actorId)
    || typeof data.workspaceId !== 'string' || !uuid.test(data.workspaceId)
    || typeof data.sessionId !== 'string' || !uuid.test(data.sessionId)
    || data.role !== 'AI_GOVERNANCE_REVIEWER' || data.demoMode !== true) fail('invalid_response')
  const session = Object.freeze({ csrfToken: data.csrfToken, expiresAt: data.expiresAt,
    actorId: data.actorId, workspaceId: data.workspaceId, role: data.role,
    sessionId: data.sessionId, demoMode: data.demoMode }) as WireSession
  if (privateInPublicProjection(session, session.csrfToken)) fail('invalid_response')
  return session
}
function publicStrings(session: WireSession): string[] {
  return [session.actorId, session.workspaceId, session.role, session.sessionId]
}
function privateInPublicProjection(session: WireSession, secret: string): boolean {
  // Check the actual stable public snapshot as well as values rendered as text.
  return publicStrings(session).some(value => value.includes(secret))
    || [false, true].some(pending => JSON.stringify({
      phase: 'connected', identity: identity(session), error: null, pending,
    }).includes(secret))
}
function identity(session: WireSession): GovernanceSessionIdentity {
  return Object.freeze({ expiresAt: session.expiresAt, actorId: session.actorId,
    workspaceId: session.workspaceId, role: session.role, sessionId: session.sessionId, demoMode: true })
}
function matches(first: WireSession, second: WireSession): boolean {
  return first.csrfToken === second.csrfToken && first.expiresAt === second.expiresAt
    && first.actorId === second.actorId && first.workspaceId === second.workspaceId
    && first.role === second.role && first.sessionId === second.sessionId && first.demoMode === second.demoMode
}
function notify(channel: Channel): void {
  for (const listener of channel.listeners) {
    try { listener() } catch { /* A view callback cannot interrupt authority invalidation. */ }
  }
}
function clearExpiry(channel: Channel): void {
  if (channel.expiryTimer !== null) clearTimeout(channel.expiryTimer)
  channel.expiryTimer = null
}
function refreshPending(channel: Channel): void {
  const pending = channel.flight !== null
  if (channel.snapshot.pending !== pending) {
    // Preserve session/expiry timer: this is only an observable flight transition.
    channel.snapshot = Object.freeze({ ...channel.snapshot, pending })
  }
}
function state(channel: Channel, phase: GovernanceSessionPhase, session: WireSession | null,
  error: GovernanceSessionErrorCode | null = null): void {
  clearExpiry(channel)
  channel.session = session
  channel.snapshot = phase === 'disconnected' && error === 'expired'
    ? (channel.flight !== null ? expiredPending : expired)
    : Object.freeze({ phase, identity: session ? identity(session) : null, error, pending: channel.flight !== null })
}
function invalidate(channel: Channel, phase: GovernanceSessionPhase, error: GovernanceSessionErrorCode | null = null): void {
  channel.generation++
  state(channel, phase, null, error)
}
function connected(channel: Channel, session: WireSession): void {
  state(channel, 'connected', session)
  const generation = channel.generation
  const tick = (): void => {
    if (channel.generation !== generation || channel.session !== session) return
    const remaining = session.expiresAt * 1000 - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      invalidate(channel, 'disconnected', 'expired'); notify(channel)
    } else channel.expiryTimer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
  }
  tick()
}
function active(channel: Channel, flight: Flight): void {
  if (flight.context.disposed || flight.controller.signal.aborted
    || channel.flight !== flight || channel.generation !== flight.generation) fail('stale')
}
async function discardBody(response: Response): Promise<void> {
  // Do not parse/echo rejected bodies. Cancellation must settle before release.
  if (response.body) await response.body.cancel()
}
async function currentResponse(response: Response, channel: Channel, flight: Flight): Promise<void> {
  try { active(channel, flight) }
  catch { await discardBody(response); fail('stale') }
}
async function body(response: Response, channel: Channel, flight: Flight): Promise<WireSession> {
  await currentResponse(response, channel, flight)
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
    await discardBody(response); fail('invalid_response')
  }
  const text = await response.text()
  active(channel, flight)
  if (text.length > 6000 || new TextEncoder().encode(text).length > 6000) fail('invalid_response')
  try { return readWire(JSON.parse(text) as unknown) } catch { fail('invalid_response') }
}
function endpoint(base: string): URL {
  try {
    const result = new URL(`${base.replace(/\/+$/, '')}${sessionPath}`, globalThis.location.href)
    if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.search || result.hash) fail('invalid_configuration')
    return result
  } catch { fail('invalid_configuration') }
}

export function createGovernanceSessionClient(base = defaultBase): GovernanceSessionClient {
  const url = endpoint(base)
  const origin = url.origin
  const target = url.href
  let channel = channels.get(origin)
  if (!channel) {
    channel = { generation: 0, endpoint: null, session: null, snapshot: disconnected,
      flight: null, expiryTimer: null, members: new Set(), listeners: new Set() }
    channels.set(origin, channel)
  }
  const shared = channel
  const context: Context = { disposed: false }
  shared.members.add(context)
  const listeners = new Set<() => void>()
  let handle: GovernanceSessionHandle | null = null
  function live(): void { if (context.disposed) fail('disposed') }
  function currentSession(): WireSession | null {
    if (context.disposed || shared.endpoint !== target || shared.snapshot.phase !== 'connected') return null
    const now = Date.now()
    if (shared.session && Number.isFinite(now) && now >= 0 && shared.session.expiresAt * 1000 > now) return shared.session
    // Once this context observes expiry, a later clock adjustment cannot resurrect its old handle.
    invalidate(shared, 'disconnected', 'expired')
    const generation = shared.generation
    queueMicrotask(() => { if (shared.generation === generation) notify(shared) })
    return null
  }
  function isCurrent(value: unknown): value is GovernanceSessionHandle {
    if (value === null || typeof value !== 'object') return false
    const issued = handles.get(value)
    return Boolean(issued && issued.context === context && issued.channel === shared
      && issued.generation === shared.generation && currentSession())
  }
  function cleanChannel(): void {
    if (channels.get(origin) === shared && shared.members.size === 0 && shared.flight === null) {
      clearExpiry(shared); channels.delete(origin)
    }
  }
  async function run(kind: 'connecting' | 'restoring' | 'disconnecting',
    action: (flight: Flight) => Promise<WireSession | null>): Promise<void> {
    live()
    if (shared.flight) fail('busy')
    invalidate(shared, kind)
    shared.endpoint = target
    const flight: Flight = { context, generation: shared.generation,
      controller: new AbortController(), abortCode: 'unavailable', timer: null }
    shared.flight = flight
    refreshPending(shared)
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new GovernanceSessionError(flight.abortCode))
      flight.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    flight.timer = setTimeout(() => {
      if (shared.flight !== flight || shared.generation !== flight.generation) return
      invalidate(shared, 'unknown', kind === 'disconnecting' ? 'logout_unknown' : 'unavailable')
      flight.controller.abort(); notify(shared)
    }, 30000)
    notify(shared)
    let actionSettled = false
    const work = (async () => action(flight))()
    void work.then(() => { actionSettled = true }, () => { actionSettled = true })
    const release = (): void => {
      if (shared.flight === flight) {
        shared.flight = null
        refreshPending(shared)
        notify(shared)
      }
      cleanChannel()
    }
    try {
      const result = await Promise.race([work, aborted])
      active(shared, flight)
      if (result) connected(shared, result)
      else state(shared, 'disconnected', null)
    } catch (error) {
      const safe = safeError(error, kind === 'disconnecting' ? 'logout_unknown' : 'unavailable')
      if (!context.disposed && shared.flight === flight && shared.generation === flight.generation) {
        state(shared, 'unknown', null, kind === 'disconnecting' ? 'logout_unknown' : safe.code)
      }
      throw kind === 'disconnecting' ? new GovernanceSessionError('logout_unknown') : safe
    } finally {
      if (flight.timer !== null) clearTimeout(flight.timer)
      if (onAbort) flight.controller.signal.removeEventListener('abort', onAbort)
      // An ignored abort does not prove fetch/body settlement or cookie rollback.
      // Return the fixed outcome, but do not overlap another origin flight.
      if (actionSettled) release()
      else { notify(shared); void work.then(release, release) }
    }
  }
  async function get(flight: Flight, headers: Headers): Promise<WireSession> {
    const response = await fetch(target, { method: 'GET', headers, credentials: 'include',
      redirect: 'error', cache: 'no-store', signal: flight.controller.signal })
    return body(response, shared, flight)
  }
  return Object.freeze({
    getSnapshot(): GovernanceSessionSnapshot {
      if (context.disposed) return shared.flight !== null ? disposedPending : disposed
      if (shared.snapshot.phase === 'connected') {
        if (shared.endpoint !== target) return shared.flight !== null ? disconnectedPending : disconnected
        if (!currentSession()) return shared.snapshot
      }
      return shared.snapshot
    },
    subscribe(listener: () => void): () => void {
      live()
      const bound = (): void => { if (!context.disposed) listener() }
      listeners.add(bound); shared.listeners.add(bound)
      return () => { listeners.delete(bound); shared.listeners.delete(bound) }
    },
    async connect(bootstrapKey: string): Promise<void> {
      live()
      if (typeof bootstrapKey !== 'string' || !bootstrapKey || new TextEncoder().encode(bootstrapKey).length < 32
        || bootstrapKey.length + scheme.length > 4096
        || /[\u0000-\u0020\u007f-\u009f]/.test(bootstrapKey)) fail('invalid_input')
      let headers: Headers
      try { headers = new Headers({ Accept: 'application/json', Authorization: scheme + bootstrapKey }) }
      catch { bootstrapKey = ''; fail('invalid_input') }
      bootstrapKey = ''
      try {
        await run('connecting', async flight => {
          const first = await get(flight, headers)
          const supplied = headers.get('Authorization')!.substring(scheme.length)
          if (privateInPublicProjection(first, supplied)) fail('invalid_response')
          headers.delete('Authorization')
          let confirmed: WireSession
          try { confirmed = await get(flight, new Headers({ Accept: 'application/json' })) }
          catch { fail('cookie_not_confirmed') }
          active(shared, flight)
          if (!matches(first, confirmed)) fail('cookie_not_confirmed')
          return confirmed
        })
      } finally { headers.delete('Authorization') }
    },
    async current(): Promise<void> {
      await run('restoring', flight => get(flight, new Headers({ Accept: 'application/json' })))
    },
    async logout(value: GovernanceSessionHandle): Promise<void> {
      live()
      if (!isCurrent(value)) fail('invalid_handle')
      const session = currentSession()!
      let headers: Headers
      try { headers = new Headers({ Accept: 'application/json', 'X-CSRF-Token': session.csrfToken,
        'Idempotency-Key': `gov-logout-${crypto.randomUUID()}` }) }
      catch { invalidate(shared, 'unknown', 'logout_unknown'); notify(shared); fail('logout_unknown') }
      try {
        await run('disconnecting', async flight => {
          const response = await fetch(`${target}/${session.sessionId}`, { method: 'DELETE', headers,
            credentials: 'include', redirect: 'error', cache: 'no-store', signal: flight.controller.signal })
          await currentResponse(response, shared, flight)
          await discardBody(response)
          if (response.status !== 204) fail('logout_unknown')
          return null
        })
      } finally { headers.delete('X-CSRF-Token'); headers.delete('Idempotency-Key') }
    },
    getHandle(): GovernanceSessionHandle | null {
      if (!currentSession()) return null
      if (!handle || !isCurrent(handle)) {
        handle = Object.freeze(Object.create(null)) as GovernanceSessionHandle
        handles.set(handle, { context, channel: shared, generation: shared.generation })
      }
      return handle
    },
    isCurrent,
    dispose(): void {
      if (context.disposed) return
      context.disposed = true; handle = null
      for (const listener of listeners) shared.listeners.delete(listener)
      listeners.clear(); shared.members.delete(context)
      if (shared.flight?.context === context) {
        shared.flight.abortCode = 'stale'
        invalidate(shared, 'unknown', 'unavailable'); shared.flight.controller.abort(); notify(shared)
      } else if (shared.members.size === 0) {
        invalidate(shared, shared.flight ? 'unknown' : 'disconnected', shared.flight ? shared.snapshot.error : null)
      }
      cleanChannel()
    },
  })
}
