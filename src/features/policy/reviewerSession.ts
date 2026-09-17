import { ContractWireError, readContractUuid } from './wire'

/** A projected server session, not client-issued reviewer authority. Kept in page memory only. */
export interface ReviewerSession {
  readonly kind: 'session'
  readonly csrfToken: string
  readonly expiresAt: number
  readonly actorId: string
  readonly workspaceId: string
  readonly role: 'AI_SECURITY_REVIEWER'
}

export type ContractReviewCredential = string | ReviewerSession

function invalid(): never { throw new ContractWireError() }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function own(source: Record<string, unknown>, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(source, name)
  if (!field || !Object.hasOwn(field, 'value')) invalid()
  return field.value
}

function nonblank(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid()
  return value
}

function project(value: unknown, now: number): ReviewerSession {
  const source = record(value)
  const actorId = nonblank(own(source, 'actorId'))
  const csrfToken = own(source, 'csrfToken')
  const expiresAt = own(source, 'expiresAt')
  const role = own(source, 'role')
  if (actorId.length > 120 || actorId !== actorId.trim() || /[\u0000-\u001f\u007f]/.test(actorId)
    || typeof csrfToken !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(csrfToken)
    || role !== 'AI_SECURITY_REVIEWER'
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
    || expiresAt > 8_640_000_000_000 || !Number.isFinite(now) || now < 0
    || expiresAt * 1000 <= now) invalid()
  return Object.freeze({ kind: 'session', csrfToken, expiresAt, actorId,
    workspaceId: readContractUuid(own(source, 'workspaceId')), role })
}

export function readReviewerSessionResponse(value: unknown, now = Date.now()): ReviewerSession {
  const envelope = record(value)
  nonblank(own(envelope, 'traceId'))
  nonblank(own(envelope, 'timestamp'))
  return project(own(envelope, 'data'), now)
}

/** Recheck a credential at dispatch; a delayed UI expiry timer must not authorize another request. */
export function readReviewerSessionCredential(value: unknown, now = Date.now()): ReviewerSession {
  const credential = record(value)
  if (own(credential, 'kind') !== 'session') invalid()
  return project(credential, now)
}
