import { useEffect, useRef, useState } from 'react'
import { api, type FinsecApiClient } from '../api/client'
import type { Fingerprint, Release } from '../api/contracts'
import { DataTable, Notice, Panel } from '../components/Product'
import { EmptyState, ErrorBanner, formatDate, LoadingBlock, PageHeader, ShortHash, StatusBadge } from '../components/Primitives'

type OverviewClient = Pick<FinsecApiClient, 'releaseDetail' | 'fingerprint'>
type StoredOverview = { key: string; detail: Release; fingerprint: Fingerprint }
type StoredError = { key: string; cause: unknown }
const digestPattern = /^sha256:[0-9a-f]{64}$/
const componentNamePattern = /^[A-Za-z][A-Za-z0-9]*Hash$/
const isDigest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value)
const isNullableDigest = (value: unknown): value is string | null => value === null || isDigest(value)

function matchesInventory(detail: Release, inventory: Release): boolean {
  return isDigest(inventory.agentArtifactFingerprint) && isDigest(inventory.releaseFingerprint)
    && isNullableDigest(inventory.safetyContractHash)
    && detail.id === inventory.id && detail.agentId === inventory.agentId
    && detail.version === inventory.version && detail.businessPurpose === inventory.businessPurpose
    && detail.manifestSchemaVersion === inventory.manifestSchemaVersion
    && detail.updatedAt === inventory.updatedAt && detail.analyzedAt === inventory.analyzedAt
    && detail.lastTestedAt === inventory.lastTestedAt
    && detail.lifecycleState === inventory.lifecycleState && detail.effectiveStatus === inventory.effectiveStatus
    && detail.agentArtifactFingerprint === inventory.agentArtifactFingerprint
    && detail.releaseFingerprint === inventory.releaseFingerprint
    && detail.safetyContractHash === inventory.safetyContractHash
}

function matchesFingerprint(fingerprint: Fingerprint, detail: Release): boolean {
  return isDigest(fingerprint.agentArtifactFingerprint) && isDigest(fingerprint.releaseFingerprint)
    && isNullableDigest(fingerprint.safetyContractHash)
    && fingerprint.agentArtifactFingerprint === detail.agentArtifactFingerprint
    && fingerprint.releaseFingerprint === detail.releaseFingerprint
    && fingerprint.safetyContractHash === detail.safetyContractHash
    && typeof fingerprint.canonicalizationVersion === 'string'
    && fingerprint.components !== null && typeof fingerprint.components === 'object'
    && !Array.isArray(fingerprint.components)
    && Object.entries(fingerprint.components).every(([name, digest]) => componentNamePattern.test(name) && isDigest(digest))
}

export function LiveReleaseOverviewPage({ releases, actorId, preferredReleaseId, onReleaseChange, onOpenManifest, onOpenDiff, client = api }: {
  releases: Release[]
  actorId: string
  preferredReleaseId: string
  onReleaseChange: (releaseId: string) => void
  onOpenManifest: () => void
  onOpenDiff: () => void
  client?: OverviewClient
}) {
  const current = releases.find((release) => release.id === preferredReleaseId)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const key = JSON.stringify([
    actorId, current?.id, current?.agentId, current?.version, current?.businessPurpose,
    current?.manifestSchemaVersion, current?.updatedAt, current?.analyzedAt, current?.lastTestedAt,
    current?.lifecycleState, current?.effectiveStatus, current?.agentArtifactFingerprint,
    current?.releaseFingerprint, current?.safetyContractHash, refreshVersion,
  ])
  const keyRef = useRef(key)
  keyRef.current = key
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [storedOverview, setStoredOverview] = useState<StoredOverview | null>(null)
  const [storedError, setStoredError] = useState<StoredError | null>(null)
  const overview = storedOverview?.key === key ? storedOverview : null
  const error = storedError?.key === key ? storedError.cause : undefined

  useEffect(() => {
    if (!current) return
    let active = true
    setBusyKey(key)
    setStoredError(null)
    setStoredOverview(null)
    void Promise.all([
      client.releaseDetail(current.id, actorId),
      client.fingerprint(current.id, actorId),
    ]).then(([detail, fingerprint]) => {
      if (!active || keyRef.current !== key) return
      if (!detail || !matchesInventory(detail, current) || !fingerprint || !matchesFingerprint(fingerprint, detail)) {
        throw new Error('서버 Release 상세·fingerprint와 현재 목록이 일치하지 않습니다. 목록을 새로고침한 뒤 다시 조회하세요.')
      }
      setStoredOverview({ key, detail, fingerprint })
    }).catch((cause: unknown) => {
      if (active && keyRef.current === key) setStoredError({ key, cause })
    }).finally(() => {
      if (active && keyRef.current === key) setBusyKey(null)
    })
    return () => { active = false }
  }, [actorId, client, current, key])

  const reload = () => setRefreshVersion((version) => version + 1)
  const components = overview ? Object.entries(overview.fingerprint.components).sort(([left], [right]) => left.localeCompare(right)) : []

  return <>
    <PageHeader eyebrow="RELEASE CONFIGURATION" title="Release 구성과 검증 상태" description="선택한 Release의 서버 상세와 무결성 검사된 fingerprint를 확인합니다." />
    <Notice title="구성 상태와 출시 판정은 별개입니다." tone="amber">Lifecycle과 현재 유효 상태는 서버 값입니다. 이 화면은 Run 결과, 정책 승인 또는 출시 판정을 추정하지 않습니다. 평가 지표는 이 화면에 연결되지 않아 N/A입니다.</Notice>
    <section className="panel section-gap"><div className="button-row">
      <label>검토할 Release<select value={current?.id ?? ''} onChange={(event) => onReleaseChange(event.target.value)}>
        <option value="">선택하세요</option>
        {releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.businessPurpose} · {release.effectiveStatus}</option>)}
      </select></label>
      <button className="secondary-button" onClick={reload} disabled={!current || busyKey === key}>상세 다시 조회</button>
      <button className="secondary-button" onClick={onOpenManifest} disabled={!current}>Manifest 관리 →</button>
      <button className="secondary-button" onClick={onOpenDiff} disabled={!current}>구성 변경 비교 →</button>
    </div></section>
    {!current ? <EmptyState title="Release를 선택하세요">실제 목록에서 검토할 버전을 선택해야 서버 상세를 읽습니다.</EmptyState> : <>
      <ErrorBanner error={error} onDismiss={() => setStoredError(null)} />
      {busyKey === key && <LoadingBlock label="Release 상세와 fingerprint를 조회하는 중" />}
      {overview && <>
        {overview.detail.effectiveStatus === 'NEEDS_REVALIDATION' && <Notice title="재검증이 필요한 Release입니다." tone="amber">서버의 현재 유효 상태입니다. 구성 변경 비교에서 다른 버전과의 Manifest digest 차이를 확인할 수 있습니다.</Notice>}
        <Panel title="Release 상세" description="서버가 반환한 식별자, 업무 목적과 상태입니다." className="section-gap">
          <DataTable caption="Release 상세와 서버 상태" headings={['항목', '서버 값']} rows={[
            ['Release ID', <code>{overview.detail.id}</code>],
            ['Agent ID', <code>{overview.detail.agentId}</code>],
            ['버전', `v${overview.detail.version}`],
            ['업무 목적', overview.detail.businessPurpose],
            ['Manifest schema', overview.detail.manifestSchemaVersion],
            ['Lifecycle', <StatusBadge status={overview.detail.lifecycleState} />],
            ['현재 유효 상태', <StatusBadge status={overview.detail.effectiveStatus} />],
            ['분석 시각', formatDate(overview.detail.analyzedAt)],
            ['마지막 시험 시각', formatDate(overview.detail.lastTestedAt)],
          ]} />
        </Panel>
        <Panel title="서버 fingerprint" description="Manifest 원문이나 Prompt 대신 정규화 버전과 digest만 표시합니다." className="section-gap">
          <DataTable caption="Release fingerprint 식별자" headings={['항목', '서버 hash']} rows={[
            ['정규화 버전', overview.fingerprint.canonicalizationVersion],
            ['Agent artifact', <ShortHash value={overview.fingerprint.agentArtifactFingerprint} />],
            ['Safety Contract hash', <ShortHash value={overview.fingerprint.safetyContractHash} />],
            ['Release fingerprint', <ShortHash value={overview.fingerprint.releaseFingerprint} />],
          ]} />
          {components.length === 0 ? <EmptyState title="구성 요소 digest가 없습니다">서버가 구성 요소 digest를 반환하지 않았습니다.</EmptyState>
            : <DataTable caption="Manifest 구성 요소 digest" headings={['구성 요소', 'Digest']} rows={components.map(([name, digest]) => [name, <ShortHash value={digest} />])} />}
        </Panel>
      </>}
    </>}
  </>
}
