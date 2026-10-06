import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createGovernanceSessionClient } from './sessionClient'
import type { GovernanceSessionClient, GovernanceSessionPhase } from './sessionTypes'

const phaseLabels: Record<GovernanceSessionPhase, string> = {
  disconnected: '연결되지 않음', connecting: '연결 확인 중', restoring: '상태 확인 중',
  connected: '연결됨', disconnecting: '해제 확인 중', unknown: '결과 미확정',
}

interface Binding {
  readonly base: string | undefined
  readonly generation: number
  readonly client: GovernanceSessionClient | null
}

/** Standalone lifecycle UI. Mounting this panel never exchanges or restores a session. */
export function GovernanceSessionPanel({ apiBase }: { apiBase?: string }) {
  const [binding, setBinding] = useState<Binding | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    // Create only in the committed effect; abandoned/StrictMode renders own no client.
    let client: GovernanceSessionClient | null = null
    try { client = createGovernanceSessionClient(apiBase) } catch { /* Fixed public configuration error. */ }
    setBinding({ base: apiBase, generation: ++generation.current, client })
    return () => { client?.dispose() }
  }, [apiBase])

  // An origin change removes the old view before the replacement effect creates its context.
  if (!binding || binding.base !== apiBase) {
    return <section aria-label="거버넌스 세션"><p role="status">세션 화면 준비 중</p></section>
  }
  if (!binding.client) {
    return <section aria-label="거버넌스 세션"><p role="alert">세션 연결 설정을 확인해 주세요.</p></section>
  }
  return <SessionControls key={binding.generation} client={binding.client} />
}

function SessionControls({ client }: { client: GovernanceSessionClient }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const bootstrapInput = useRef<HTMLInputElement>(null)
  const keyHelpId = useId()
  const lifecycle = useRef(0)
  const [failed, setFailed] = useState(false)

  function clearInput(): void {
    if (bootstrapInput.current) bootstrapInput.current.value = ''
  }
  useEffect(() => {
    lifecycle.current++
    const input = bootstrapInput.current
    return () => {
      lifecycle.current++
      if (input) input.value = ''
    }
  }, [client])
  useEffect(() => {
    if (snapshot.pending || snapshot.phase === 'connected' || snapshot.phase === 'unknown') clearInput()
  }, [snapshot.pending, snapshot.phase])

  function perform(action: () => Promise<void>): void {
    clearInput()
    if (client.getSnapshot().pending) return
    const context = lifecycle.current
    setFailed(false)
    // Caught transport objects/messages never enter React state, callbacks, or the DOM.
    void action().catch(() => {
      if (lifecycle.current === context) setFailed(true)
    })
  }
  function connect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    let key = bootstrapInput.current?.value ?? ''
    clearInput()
    const current = client.getSnapshot()
    if (current.pending || current.phase === 'unknown' || current.phase === 'connected') {
      key = ''; return
    }
    // The transient local variable is consumed synchronously while the client builds its header.
    perform(() => client.connect(key))
    key = ''
  }
  function logout(): void {
    clearInput()
    if (client.getSnapshot().pending) return
    const handle = client.getHandle()
    if (handle) perform(() => client.logout(handle))
  }

  const connectDisabled = snapshot.pending || snapshot.phase === 'unknown' || snapshot.phase === 'connected'
  const logoutDisabled = snapshot.pending || snapshot.phase !== 'connected' || snapshot.identity === null
  const alert = snapshot.error === 'logout_unknown'
    ? '해제 결과를 확인하지 못했습니다. 정리가 끝나면 상태 확인을 눌러 주세요.'
    : snapshot.error === 'expired'
      ? '세션이 만료되었습니다. 상태 확인으로 현재 쿠키 세션을 확인해 주세요.'
      : ((failed && snapshot.phase !== 'connected') || snapshot.error !== null)
        ? '세션 요청을 완료하지 못했습니다. 정리가 끝나면 상태 확인을 눌러 주세요.'
        : null

  return <section aria-label="거버넌스 세션" aria-busy={snapshot.pending}>
    <h2>거버넌스 세션</h2>
    <p role="status" aria-live="polite">{phaseLabels[snapshot.phase]}</p>
    {snapshot.pending && <p>요청 정리가 끝날 때까지 기다려 주세요.</p>}
    {snapshot.phase === 'unknown' && <p>
      요청이 서버에서 처리됐을 수 있습니다. 정리가 끝나면 상태 확인을 눌러 쿠키 세션을 확인하세요.
    </p>}
    {alert && <p role="alert">{alert}</p>}
    {snapshot.identity && <dl>
      <dt>검토자</dt><dd>{snapshot.identity.actorId}</dd>
      <dt>워크스페이스</dt><dd>{snapshot.identity.workspaceId}</dd>
      <dt>역할</dt><dd>{snapshot.identity.role}</dd>
      <dt>만료 시각</dt><dd>{new Date(snapshot.identity.expiresAt * 1000).toLocaleString('ko-KR')}</dd>
    </dl>}
    <form onSubmit={connect}>
      <label>거버넌스 연결 키
        <input ref={bootstrapInput} type="password" autoComplete="off" spellCheck={false}
          disabled={connectDisabled} aria-describedby={keyHelpId} />
      </label>
      <p id={keyHelpId}>명시적인 연결 요청에만 사용하며 전송 시 입력을 지웁니다.</p>
      <button type="submit" disabled={connectDisabled}>연결</button>
    </form>
    <button type="button" disabled={snapshot.pending} onClick={() => perform(() => client.current())}>상태 확인</button>
    <button type="button" disabled={logoutDisabled} onClick={logout}>해제</button>
  </section>
}
