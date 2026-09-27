import { useEffect, useRef, useState } from 'react'
import { api, type FinsecApiClient } from '../api/client'
import type { Release, ReleaseDiff } from '../api/contracts'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, StatusBadge } from '../components/Primitives'
import { DataTable, Notice, Panel } from '../components/Product'

type DiffClient = Pick<FinsecApiClient, 'releaseDiff'>
type ComparisonSelection = { actorId: string; releaseId: string; againstId: string }
type StoredResult = { key: string; value: ReleaseDiff }
type StoredError = { key: string; cause: unknown }

export function ReleaseDiffPage({ releases, actorId, preferredReleaseId, onReleaseChange, client = api }: {
  releases: Release[]
  actorId: string
  preferredReleaseId: string
  onReleaseChange: (releaseId: string) => void
  client?: DiffClient
}) {
  const current = releases.find((release) => release.id === preferredReleaseId)
  const candidates = current
    ? releases.filter((release) => release.agentId === current.agentId && release.id !== current.id)
    : []
  const [selection, setSelection] = useState<ComparisonSelection>({ actorId: '', releaseId: '', againstId: '' })
  const against = selection.actorId === actorId && selection.releaseId === current?.id
    ? candidates.find((release) => release.id === selection.againstId)
    : undefined
  const pairKey = JSON.stringify([
    actorId,
    current?.id, current?.updatedAt, current?.lifecycleState, current?.effectiveStatus,
    current?.agentArtifactFingerprint, current?.safetyContractHash, current?.releaseFingerprint,
    against?.id, against?.updatedAt, against?.lifecycleState, against?.effectiveStatus,
    against?.agentArtifactFingerprint, against?.safetyContractHash, against?.releaseFingerprint,
  ])
  const pairKeyRef = useRef(pairKey)
  pairKeyRef.current = pairKey
  const requestVersion = useRef(0)
  const [storedResult, setStoredResult] = useState<StoredResult | null>(null)
  const [storedError, setStoredError] = useState<StoredError | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const result = storedResult?.key === pairKey ? storedResult.value : null
  const error = storedError?.key === pairKey ? storedError.cause : undefined
  const busy = busyKey === pairKey

  useEffect(() => () => { requestVersion.current++ }, [])

  function clearResult() {
    requestVersion.current++
    setStoredResult(null)
    setStoredError(null)
    setBusyKey(null)
  }

  function chooseRelease(id: string) {
    clearResult()
    setSelection({ actorId: '', releaseId: '', againstId: '' })
    onReleaseChange(id)
  }

  function chooseAgainst(id: string) {
    clearResult()
    setSelection({ actorId, releaseId: current?.id ?? '', againstId: id })
  }

  async function inspect() {
    if (!current || !against) return
    const request = ++requestVersion.current
    const key = pairKey
    const isCurrent = () => requestVersion.current === request && pairKeyRef.current === key
    setBusyKey(key)
    setStoredResult(null)
    setStoredError(null)
    try {
      const value = await client.releaseDiff(current.id, against.id, actorId)
      if (!isCurrent()) return
      if (value.releaseId !== current.id || value.against !== against.id
        || typeof value.meaningfulChange !== 'boolean' || !Array.isArray(value.components)) {
        throw new Error('요청한 Release 쌍과 서버 비교 응답이 일치하지 않습니다.')
      }
      setStoredResult({ key, value })
    } catch (cause) {
      if (isCurrent()) setStoredError({ key, cause })
    } finally {
      if (isCurrent()) setBusyKey(null)
    }
  }

  return <>
    <PageHeader eyebrow="CONFIGURATION INTEGRITY" title="Release 구성 변경 비교" description="서버가 검증한 두 Release의 구성 요소 digest와 현재 유효 상태를 확인합니다." />
    <Notice title="Manifest 비교와 Release 유효 상태는 별개입니다." tone="amber">구성 요소 diff는 Manifest의 canonical digest를 비교합니다. Safety Contract 연결, Release fingerprint, 재검증 상태는 각각 서버 값으로 확인합니다. 이 화면은 정책의 개선 효과나 Replay 동일 조건을 판정하지 않습니다.</Notice>
    <ErrorBanner error={error} onDismiss={() => setStoredError(null)} />
    <section className="panel section-gap">
      <div className="button-row">
        <label>현재 Release<select value={current?.id ?? ''} onChange={(event) => chooseRelease(event.target.value)}>
          <option value="">선택하세요</option>
          {releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.businessPurpose} · {release.effectiveStatus}</option>)}
        </select></label>
        <label>비교할 Release<select value={against?.id ?? ''} onChange={(event) => chooseAgainst(event.target.value)} disabled={!current || candidates.length === 0}>
          <option value="">선택하세요</option>
          {candidates.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.effectiveStatus}</option>)}
        </select></label>
        <button className="primary-button" disabled={!current || !against || busy} onClick={() => void inspect()}>{busy ? '비교 중…' : '서버 구성 비교'}</button>
      </div>
    </section>
    {!current ? <EmptyState title="현재 Release를 선택하세요">선택한 실제 Release를 기준으로 같은 Agent의 다른 버전을 비교합니다.</EmptyState>
      : candidates.length === 0 ? <EmptyState title="비교 가능한 Release가 없습니다">같은 Agent의 다른 Release가 있어야 구성 요소 diff를 조회할 수 있습니다.</EmptyState>
        : !against ? <EmptyState title="비교할 Release를 선택하세요">비교 요청 전에는 서버 구성 변경을 추정하지 않습니다.</EmptyState>
          : !result ? null : <>
            <div className="content-grid section-gap"><Panel title="비교 대상" description="과거 또는 비교 기준 → 현재 선택한 Release">
              <DataTable caption="Release 식별자와 상태" headings={['항목', '비교 기준', '현재 선택']} rows={[
                ['버전', `v${against.version}`, `v${current.version}`],
                ['Lifecycle', <StatusBadge status={against.lifecycleState} />, <StatusBadge status={current.lifecycleState} />],
                ['현재 유효 상태', <StatusBadge status={against.effectiveStatus} />, <StatusBadge status={current.effectiveStatus} />],
                ['Agent artifact', <ShortHash value={against.agentArtifactFingerprint} />, <ShortHash value={current.agentArtifactFingerprint} />],
                ['Safety Contract hash', <ShortHash value={against.safetyContractHash} />, <ShortHash value={current.safetyContractHash} />],
                ['Release fingerprint', <ShortHash value={against.releaseFingerprint} />, <ShortHash value={current.releaseFingerprint} />],
              ]} />
            </Panel><Notice title={result.meaningfulChange ? 'Manifest 구성 요소 변경 있음' : 'Manifest 구성 요소 변경 없음'} tone={result.meaningfulChange ? 'amber' : 'green'}>
              {against.safetyContractHash !== current.safetyContractHash
                ? 'Safety Contract 연결 해시도 다릅니다. 아래 Manifest 구성 요소 결과와 구분해 확인하세요.'
                : 'Safety Contract 연결 해시는 같습니다. Release 전체 유효 상태는 각 Release의 서버 상태를 확인하세요.'}
            </Notice></div>
            <Panel title="서버 구성 요소 diff" description="원문 Prompt나 정책 본문 대신 서버의 redacted summary와 digest를 표시합니다.">
              {result.components.length === 0 ? <EmptyState title="비교할 구성 요소가 없습니다">서버가 구성 요소 목록을 반환하지 않았습니다.</EmptyState>
                : <DataTable caption="Release Manifest 구성 요소 변경" headings={['구성 요소', '경로', '이전 digest', '현재 digest', '변경', '서버 요약']} rows={result.components.map((item) => [
                  item.component, item.jsonPointers.join(', ') || '—', <ShortHash value={item.oldDigest} />, <ShortHash value={item.newDigest} />,
                  item.changed ? '변경' : '동일', item.redactedSummary,
                ])} />}
            </Panel>
          </>}
  </>
}
