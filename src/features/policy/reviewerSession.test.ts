import { ContractWireError } from './wire'
import { readReviewerSessionCredential, readReviewerSessionResponse } from './reviewerSession'

const now = Date.parse('2026-09-17T12:00:00Z')
const expiresAt = now / 1000 + 1800
const workspaceId = '019903ac-abcd-7000-8000-000000000001'
const csrfToken = '00000000-0000-4000-8000-000000000011:00000000-0000-4000-8000-000000000012'
const privateCanary = 'SYNTHETIC_SESSION_PRIVATE_CANARY'
const fields = ['csrfToken', 'expiresAt', 'actorId', 'workspaceId', 'role'] as const

function data(overrides: Record<string, unknown> = {}) {
  return { csrfToken, expiresAt, actorId: '검토자-1', workspaceId, role: 'AI_SECURITY_REVIEWER', ...overrides }
}
function envelope(value: unknown = data()) {
  return { data: value, traceId: '019903ac-abcd-7000-8000-000000000003', timestamp: '2026-09-17T12:00:00Z' }
}
function rejected(value: unknown) {
  expect(() => readReviewerSessionResponse(value, now)).toThrow(ContractWireError)
}

describe('reviewer session response boundary', () => {
  it('projects the actual five-field SessionView, copies it, and discards private evidence', () => {
    const source = data({ workspaceId: workspaceId.toUpperCase(), token: privateCanary, key: privateCanary,
      reviewer: { authenticated: true, role: 'ADMIN', raw: privateCanary } })
    const response = { ...envelope(source), private: privateCanary }
    const result = readReviewerSessionResponse(response, now)
    expect(result).toEqual({ kind: 'session', csrfToken, expiresAt, actorId: '검토자-1', workspaceId, role: 'AI_SECURITY_REVIEWER' })
    expect(Object.isFrozen(result)).toBe(true)
    source.actorId = 'changed'; source.csrfToken = 'changed'
    expect(result.actorId).toBe('검토자-1')
    expect(result.csrfToken).toBe(csrfToken)
    expect(JSON.stringify(result)).not.toContain(privateCanary)
    expect(() => Object.assign(result, { role: 'ADMIN' })).toThrow(TypeError)
  })

  it('accepts bounded opaque tokens without inventing a UUID-only token contract', () => {
    for (const value of ['opaque_token:v2+/=', 'x'.repeat(512)]) {
      expect(readReviewerSessionResponse(envelope(data({ csrfToken: value })), now).csrfToken).toBe(value)
    }
    expect(readReviewerSessionResponse(envelope(data({ actorId: 'a'.repeat(120) })), now).actorId).toHaveLength(120)
  })

  it('uses epoch seconds and rejects the exact expiry instant, including at later dispatch', () => {
    const session = readReviewerSessionResponse(envelope(), expiresAt * 1000 - 1)
    expect(session.expiresAt).toBe(expiresAt)
    expect(readReviewerSessionCredential(session, expiresAt * 1000 - 1)).toEqual(session)
    expect(() => readReviewerSessionResponse(envelope(), expiresAt * 1000)).toThrow(ContractWireError)
    expect(() => readReviewerSessionCredential(session, expiresAt * 1000)).toThrow(ContractWireError)
    expect(() => readReviewerSessionCredential(session, expiresAt * 1000 + 1)).toThrow(ContractWireError)
  })

  it('requires an explicit local discriminator when rechecking credentials', () => {
    for (const value of [data(), { ...data(), kind: 'key' }, null, [], csrfToken]) {
      expect(() => readReviewerSessionCredential(value, now)).toThrow(ContractWireError)
    }
    const original = readReviewerSessionResponse(envelope(), now)
    const checked = readReviewerSessionCredential(original, now)
    expect(checked).toEqual(original)
    expect(checked).not.toBe(original)
    expect(Object.isFrozen(checked)).toBe(true)
  })

  it.each(fields)('rejects missing, null, inherited, getter, and wrong-type %s fields without evaluating getters', name => {
    const missing: Record<string, unknown> = data(); delete missing[name]
    const getter = vi.fn(() => privateCanary)
    const accessed = Object.defineProperty(data(), name, { get: getter })
    const inherited = Object.assign(Object.create({ [name]: data()[name] }), missing)
    for (const value of [missing, data({ [name]: null }), data({ [name]: {} }), accessed, inherited]) rejected(envelope(value))
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    ['actorId', ''], ['actorId', '   '], ['actorId', ' leading'], ['actorId', 'trailing '],
    ['actorId', 'a'.repeat(121)], ['actorId', 'reviewer\nname'], ['actorId', 'reviewer\u007fname'],
    ['workspaceId', 'not-a-uuid'], ['workspaceId', `${workspaceId}x`], ['workspaceId', ` ${workspaceId}`],
    ['role', 'ADMIN'], ['role', 'ai_security_reviewer'], ['role', 'AI_SECURITY_REVIEWER '],
    ['csrfToken', ''], ['csrfToken', ' '], ['csrfToken', 'token with space'], ['csrfToken', 'token\r\nHeader:value'],
    ['csrfToken', 'token\u0000'], ['csrfToken', 'token\u007f'], ['csrfToken', 'x'.repeat(513)],
    ['expiresAt', String(expiresAt)], ['expiresAt', NaN], ['expiresAt', Infinity], ['expiresAt', -1],
    ['expiresAt', 0], ['expiresAt', expiresAt + 0.5], ['expiresAt', Number.MAX_SAFE_INTEGER + 1],
    ['expiresAt', 8_640_000_000_001], ['expiresAt', now / 1000], ['expiresAt', now / 1000 - 1],
  ])('rejects invalid %s value %j', (name, value) => { rejected(envelope(data({ [name]: value }))) })

  it.each([null, undefined, [], 'raw', 1, {}, { data: data() }, envelope(null), envelope([])])(
    'rejects malformed envelopes and session values %j', value => { rejected(value) },
  )

  it.each(['data', 'traceId', 'timestamp'])('requires own envelope field %s', name => {
    const missing: Record<string, unknown> = envelope(); delete missing[name]
    const getter = vi.fn(() => privateCanary)
    rejected(missing)
    rejected(Object.defineProperty(envelope(), name, { get: getter }))
    rejected({ ...envelope(), [name]: null })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -1])('rejects an unusable local clock %j', clock => {
    expect(() => readReviewerSessionResponse(envelope(), clock)).toThrow(ContractWireError)
  })

  it('uses the current clock by default and never places response or credential values in errors', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(readReviewerSessionResponse(envelope()).expiresAt).toBe(expiresAt)
    try {
      readReviewerSessionResponse(envelope(data({ role: privateCanary, csrfToken: privateCanary })))
      throw new Error('Expected malformed session to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractWireError)
      expect(String(error)).not.toContain(privateCanary)
      expect(JSON.stringify(error)).not.toContain(privateCanary)
      expect(error).not.toHaveProperty('cause')
    }
  })
})
