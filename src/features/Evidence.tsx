import { useLayoutEffect, useRef, useState } from 'react'
import type { Attestation, JsonValue, Release } from '../api/contracts'
import { api, type PlatformClient } from '../api/client'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, StatusBadge, formatDate } from '../components/Primitives'

type AttestationDecision = 'PASS' | 'REVIEW' | 'BLOCKED'
type EffectName = 'UnauthorizedRecordExposureCount' | 'ExfiltrationSuccessCount'
type ObservedEffect = { metric: EffectName; status: 'AVAILABLE'; value: number }
  | { metric: EffectName; status: 'N_A'; reason: string }
type ObservedEffects = { kind: 'legacy' } | { kind: 'invalid' }
  | { kind: 'available'; entries: ObservedEffect[] }

const effectNames: EffectName[] = ['UnauthorizedRecordExposureCount', 'ExfiltrationSuccessCount']
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const effectLabels: Record<EffectName, string> = {
  UnauthorizedRecordExposureCount: '무단 고객 레코드 노출',
  ExfiltrationSuccessCount: '외부 반출 성공',
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, JsonValue>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function readObservedEffects(attestation: Attestation): ObservedEffects {
  if (!Object.hasOwn(attestation.document, 'observedEffectCounts')) return { kind: 'legacy' }
  const raw = attestation.document.observedEffectCounts
  if (!Array.isArray(raw) || raw.length !== effectNames.length) return { kind: 'invalid' }

  const entries: ObservedEffect[] = []
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item) || item.metric !== effectNames[index]
      || item.calculatorVersion !== 'mvp-metrics/1'
      || !Array.isArray(item.sourceTestRunIds)
      || !item.sourceTestRunIds.every(id => typeof id === 'string' && uuidPattern.test(id))
      || new Set(item.sourceTestRunIds.map(id => String(id).toLowerCase())).size !== item.sourceTestRunIds.length) {
      return { kind: 'invalid' }
    }
    const metric = effectNames[index]!
    if (item.status === 'AVAILABLE') {
      if (!hasOnlyKeys(item, ['metric', 'calculatorVersion', 'status', 'value', 'sourceTestRunIds', 'evidenceDigest'])
        || typeof item.value !== 'number' || !Number.isSafeInteger(item.value) || item.value < 0
        || item.sourceTestRunIds.length === 0
        || typeof item.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.evidenceDigest)) {
        return { kind: 'invalid' }
      }
      entries.push({ metric, status: 'AVAILABLE', value: item.value })
    } else if (item.status === 'N_A') {
      if (!hasOnlyKeys(item, ['metric', 'calculatorVersion', 'status', 'reason', 'sourceTestRunIds'])
        || typeof item.reason !== 'string' || item.reason.trim().length === 0) {
        return { kind: 'invalid' }
      }
      entries.push({ metric, status: 'N_A', reason: item.reason })
    } else {
      return { kind: 'invalid' }
    }
  }
  return { kind: 'available', entries }
}

function readDecision(attestation: Attestation): AttestationDecision | null {
  const decision = attestation.document.decision
  const value = decision && typeof decision === 'object' && !Array.isArray(decision)
    ? decision.value
    : null
  return value === 'PASS' || value === 'REVIEW' || value === 'BLOCKED' ? value : null
}

export function EvidencePage({ releases, actorId, preferredReleaseId, onReleaseChange, client = api, simulated = false }: {
  releases: Release[]; actorId: string; preferredReleaseId?: string; onReleaseChange?: (releaseId: string) => void
  client?: PlatformClient; simulated?: boolean
}) {
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? '')
  const selectedId = preferredReleaseId === undefined ? releaseId : preferredReleaseId
  const validReleaseId = releases.some(release => release.id === selectedId) ? selectedId : ''
  const selectionKey = JSON.stringify([actorId, validReleaseId])
  const selectionKeyRef = useRef(selectionKey)
  selectionKeyRef.current = selectionKey
  const requestVersion = useRef(0)
  const exportController = useRef<AbortController | null>(null)
  const [storedAttestation, setStoredAttestation] = useState<{ key: string; value: Attestation } | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [storedError, setStoredError] = useState<{ key: string; cause: unknown } | null>(null)
  const attestation = storedAttestation?.key === selectionKey ? storedAttestation.value : null
  const busy = busyKey === selectionKey
  const error = storedError?.key === selectionKey ? storedError.cause : undefined

  useLayoutEffect(() => {
    requestVersion.current++
    exportController.current?.abort()
    exportController.current = null
    setStoredAttestation(null)
    setStoredError(null)
    setBusyKey(null)
    return () => {
      requestVersion.current++
      exportController.current?.abort()
      exportController.current = null
    }
  }, [selectionKey])

  function chooseRelease(id: string) {
    requestVersion.current++
    exportController.current?.abort()
    exportController.current = null
    setReleaseId(id)
    setStoredAttestation(null)
    setStoredError(null)
    setBusyKey(null)
    onReleaseChange?.(id)
  }

  async function inspect() {
    if (!validReleaseId) return
    const request = ++requestVersion.current
    const current = () => request === requestVersion.current && selectionKey === selectionKeyRef.current
    setBusyKey(selectionKey); setStoredError(null); setStoredAttestation(null)
    try { const value = await client.attestation(validReleaseId, actorId); if (current()) setStoredAttestation({ key: selectionKey, value }) }
    catch (cause) { if (current()) setStoredError({ key: selectionKey, cause }) }
    finally { if (current()) setBusyKey(null) }
  }

  async function download(format: 'json' | 'html' | 'json-precise') {
    if (!validReleaseId) return
    const request = ++requestVersion.current
    const current = () => request === requestVersion.current && selectionKey === selectionKeyRef.current
    const controller = new AbortController()
    exportController.current = controller
    setBusyKey(selectionKey); setStoredError(null)
    try { await client.downloadAttestation(validReleaseId, format, actorId, controller.signal) }
    catch (cause) { if (current() && !(cause instanceof DOMException && cause.name === 'AbortError')) setStoredError({ key: selectionKey, cause }) }
    finally {
      if (exportController.current === controller) exportController.current = null
      if (current()) setBusyKey(null)
    }
  }

  return <>
    <PageHeader eyebrow="EVIDENCE PROJECTION" title="구성과 증거" description="확정된 판정의 입력과 증적을 확인합니다. 과거 보고서와 현재 구성의 상태를 구분합니다." />
    <ErrorBanner error={error} onDismiss={() => setStoredError(null)} />
    <section className="panel attestation-picker"><label>Release<select value={validReleaseId} onChange={(event) => chooseRelease(event.target.value)}>
      <option value="">선택하세요</option>{releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.businessPurpose} · {release.effectiveStatus}</option>)}</select></label>
      <button className="primary-button" disabled={!validReleaseId || busy} onClick={() => void inspect()}>{busy ? '검증 중…' : 'Attestation 검증'}</button>
    </section>
    {!attestation ? <EmptyState title="Attestation을 선택하세요">확정 Decision이 있는 Release만 증적을 생성할 수 있습니다. A는 Decision을 계산하지 않습니다.</EmptyState> : (() => {
      const decision = readDecision(attestation)
      const effects = readObservedEffects(attestation)
      return <section className="content-grid attestation-grid">
        <article className="panel attestation-summary"><div className="panel-heading"><div><p className="eyebrow">VERIFIED PROJECTION</p><h2>{attestation.stale ? 'Historical attestation' : 'Current attestation'}</h2></div><StatusBadge status={attestation.stale ? 'STALE' : decision ?? 'INVALID'} /></div>
          {attestation.stale ? <div className="stale-notice"><strong>STALE / NEEDS REVALIDATION</strong><p>기존 증적은 보존되지만 현재 Release의 상태를 인증하지 않습니다.</p></div> : null}
          <dl className="detail-grid"><div><dt>Document hash</dt><dd><ShortHash value={attestation.documentHash} /></dd></div><div><dt>Generated</dt><dd>{formatDate(attestation.generatedAt)}</dd></div>
            <div><dt>Decision</dt><dd>{decision ?? 'INVALID'}</dd></div><div><dt>Disclaimer</dt><dd>{attestation.disclaimerVersion}</dd></div></dl>
          <section aria-label="관측 효과 건수">
            <h3>관측 효과 건수</h3>
            {effects.kind === 'legacy' ? <p className="muted">이전 증명서에는 관측 효과 건수가 없습니다. 0건으로 간주하지 않습니다.</p>
              : effects.kind === 'invalid' ? <p role="alert">관측 효과 건수의 저장 형식을 확인할 수 없습니다.</p>
                : <dl className="detail-grid">{effects.entries.map(effect => <div key={effect.metric}>
                  <dt>{effectLabels[effect.metric]}</dt>
                  <dd>{effect.status === 'AVAILABLE' ? `${effect.value.toLocaleString('ko-KR')}건` : `N/A · ${effect.reason}`}</dd>
                </div>)}</dl>}
          </section>
          <div className="button-row"><button className="secondary-button" disabled={simulated || busy || !decision} onClick={() => void download('json')}>JSON 내려받기</button><button className="primary-button" disabled={simulated || busy || !decision} onClick={() => void download('html')}>HTML 내려받기</button><button className="secondary-button" disabled={simulated || busy || !decision} onClick={() => void download('json-precise')}>정밀 JSON 내려받기</button></div>
          <p className="muted">정밀 JSON은 현대 네 보고서의 저장 수치와 배열 순서를 보존합니다. Document hash는 canonical 문서 기준이며 정밀 파일의 바이트 해시가 아닙니다. 원래 숫자 표기나 소실된 과거 값은 복원하지 않습니다.</p>
          {simulated ? <p className="muted">DEMO_ONLY · 합성 예시의 실제 증적 내보내기는 비활성화됩니다.</p> : null}
        </article>
        <article className="panel document-preview"><div className="panel-heading"><div><p className="eyebrow">CANONICAL DOCUMENT</p><h2>Evidence snapshot</h2></div></div><pre>{JSON.stringify(attestation.document, null, 2)}</pre></article>
      </section>
    })()}
  </>
}
