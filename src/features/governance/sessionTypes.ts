/** Nonsecret browser projection. A local lifecycle handle is never BE mutation authority. */
export interface GovernanceSessionIdentity {
  readonly expiresAt: number // integral epoch seconds, not milliseconds
  readonly actorId: string
  readonly workspaceId: string
  readonly role: 'AI_GOVERNANCE_REVIEWER'
  readonly sessionId: string
  readonly demoMode: true
}

declare const governanceSessionHandle: unique symbol
export interface GovernanceSessionHandle {
  readonly [governanceSessionHandle]: true
}

export type GovernanceSessionErrorCode =
  | 'invalid_configuration' | 'invalid_input' | 'invalid_response' | 'cookie_not_confirmed'
  | 'busy' | 'unavailable' | 'stale' | 'expired' | 'logout_unknown' | 'invalid_handle' | 'disposed'

export type GovernanceSessionPhase =
  | 'disconnected' | 'connecting' | 'restoring' | 'connected' | 'disconnecting' | 'unknown'

export interface GovernanceSessionSnapshot {
  readonly phase: GovernanceSessionPhase
  readonly pending: boolean // shared origin flight, including body cleanup; never authority
  readonly identity: GovernanceSessionIdentity | null
  readonly error: GovernanceSessionErrorCode | null
}

/** Only lifecycle operations; there is no arbitrary URL/body/D mutation dispatch. */
export interface GovernanceSessionClient {
  getSnapshot(): GovernanceSessionSnapshot
  subscribe(listener: () => void): () => void
  connect(bootstrapKey: string): Promise<void>
  current(): Promise<void>
  logout(handle: GovernanceSessionHandle): Promise<void>
  getHandle(): GovernanceSessionHandle | null
  isCurrent(handle: unknown): handle is GovernanceSessionHandle
  dispose(): void
}
