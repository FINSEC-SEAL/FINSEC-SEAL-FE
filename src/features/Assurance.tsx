import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { DecisionProposal, DecisionValue, JsonValue, MetricValue, MetricsView, Release, ReplaySummary } from '../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, ShortHash } from '../components/Primitives'

function metricText(metric: MetricValue): string {
  if (metric.status === 'N_A' || metric.value === null) return 'N/A'
  return `${(metric.value * 100).toFixed(1)}%`
}

function MetricCard({ label, metric, accent }: { label: string; metric: MetricValue; accent: string }) {
  return <article className={`metric-card metric-card--${accent}`}><p>{label}</p><strong>{metricText(metric)}</strong><span>{metric.status === 'AVAILABLE' ? `${metric.numerator}/${metric.denominator} conclusive trials` : metric.reason ?? 'Evidence unavailable'}</span></article>
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function decisionRules(snapshot: JsonValue): Array<{ ruleId: string; triggered: boolean; detail: string }> {
  const decision = asRecord(asRecord(snapshot)?.decision)
  const rules = decision?.ruleTrace
  if (!Array.isArray(rules)) return []
  return rules.flatMap((value) => {
    const rule = asRecord(value)
    return rule && typeof rule.ruleId === 'string' && typeof rule.triggered === 'boolean'
      ? [{ ruleId: rule.ruleId, triggered: rule.triggered, detail: typeof rule.detail === 'string' ? rule.detail : '' }]
      : []
  })
}

function ReplayPanel({ summary }: { summary?: ReplaySummary | null }) {
  if (!summary) return <section className="panel replay-panel"><div className="panel-heading"><div><p className="eyebrow">REPLAY COMPARABILITY</p><h2>Replay 증거 연결 대기</h2></div><span className="status status--warning">PENDING CONTRACT</span></div><p className="muted">화면은 준비됐습니다. B/C 실행부가 comparable 및 mismatchReasons를 Metrics 응답에 제공하면 자동으로 비교 결과가 표시됩니다.</p></section>
  return <section className="panel replay-panel"><div className="panel-heading"><div><p className="eyebrow">REPLAY COMPARABILITY</p><h2>{summary.evidenceComplete ? 'Replay evidence complete' : 'Review required'}</h2></div><span className={`status status--${summary.evidenceComplete ? 'positive' : 'critical'}`}>{summary.evidenceComplete ? 'COMPLETE' : 'INCOMPLETE'}</span></div>
    <div className="replay-counts"><div><span>Total</span><strong>{summary.totalCount}</strong></div><div><span>Comparable</span><strong>{summary.comparableCount}</strong></div><div><span>Excluded</span><strong>{summary.nonComparableCount}</strong></div></div>
    {summary.items.length ? <div className="replay-list">{summary.items.map((item) => <article key={`${item.baselineRunId}:${item.replayRunId}`}><div><strong>{item.category ?? 'Replay trial'}</strong><span className={`status status--${item.comparable ? 'positive' : 'critical'}`}>{item.comparable ? 'COMPARABLE' : 'NON-COMPARABLE'}</span></div><code>{item.baselineRunId.slice(0, 12)} → {item.replayRunId.slice(0, 12)}</code>{item.mismatchReasons.length ? <ul>{item.mismatchReasons.map((reason) => <li key={reason}>{reason.replaceAll('_', ' ')}</li>)}</ul> : null}</article>)}</div> : <p className="muted">Replay trial이 없습니다.</p>}
  </section>
}

export function AssurancePage({ releases, actorId, preferredReleaseId, onReleaseChange }: { releases: Release[]; actorId: string; preferredReleaseId?: string; onReleaseChange?: (releaseId: string) => void }) {
  const [releaseId, setReleaseId] = useState(preferredReleaseId && releases.some((release) => release.id === preferredReleaseId) ? preferredReleaseId : releases[0]?.id ?? '')
  const [metrics, setMetrics] = useState<MetricsView | null>(null)
  const [proposal, setProposal] = useState<DecisionProposal | null>(null)
  const [decision, setDecision] = useState<DecisionValue>('REVIEW')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [receipt, setReceipt] = useState<string>()

  useEffect(() => {
    if (preferredReleaseId && releases.some((release) => release.id === preferredReleaseId) && preferredReleaseId !== releaseId) setReleaseId(preferredReleaseId)
    else if (!releaseId && releases[0]) setReleaseId(releases[0].id)
  }, [preferredReleaseId, releaseId, releases])

  function chooseRelease(nextReleaseId: string) {
    setReleaseId(nextReleaseId); onReleaseChange?.(nextReleaseId)
  }

  async function loadMetrics() {
    if (!releaseId) return
    setBusy(true); setError(undefined); setProposal(null); setReceipt(undefined)
    try { setMetrics(await api.metrics(releaseId, actorId)) }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }

  useEffect(() => { void loadMetrics() }, [releaseId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function evaluate() {
    setBusy(true); setError(undefined); setReceipt(undefined)
    try { const next = await api.evaluateDecision(releaseId, actorId); setProposal(next); setDecision(next.proposedDecision) }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }

  async function confirm() {
    if (!proposal || !comment.trim()) return
    setBusy(true); setError(undefined)
    try { const result = await api.confirmDecision(releaseId, proposal.inputDigest, decision, comment.trim(), actorId); setReceipt(`${result.decision} confirmed by ${result.confirmedBy}`); setProposal(null); setComment('') }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }

  const values = metrics?.metrics
  const rules = proposal ? decisionRules(proposal.inputSnapshot) : []
  return <>
    <PageHeader eyebrow="RELEASE ASSURANCE" title="Metrics & Decision" description="공격·정상업무의 정확한 분수와 증거 완전성을 바탕으로 배포 판단 근거를 검토합니다." />
    {error ? <ErrorBanner error={error} onDismiss={() => setError(undefined)} /> : null}
    {receipt ? <div className="success-banner" role="status">{receipt}</div> : null}
    <section className="panel assurance-picker"><label>검사할 Agent 버전<select aria-label="Assurance Release" value={releaseId} onChange={(event) => chooseRelease(event.target.value)}><option value="">Release 선택</option>{releases.map((release) => <option key={release.id} value={release.id}>Release v{release.version} · {release.effectiveStatus}</option>)}</select></label><button className="secondary-button" disabled={!releaseId || busy} onClick={() => void loadMetrics()}>Metrics 새로고침</button><button className="primary-button" disabled={!releaseId || busy} onClick={() => void evaluate()}>Decision 평가</button></section>
    {busy && !metrics ? <LoadingBlock label="Release evidence를 계산하는 중" /> : !values ? <EmptyState title="Metrics를 조회하세요">Release를 선택하면 현재까지의 Oracle 결과를 집계합니다.</EmptyState> : <>
      <div className="metric-grid assurance-metrics"><MetricCard label="Attack success rate" metric={values.attackSuccessRate} accent="amber" /><MetricCard label="Attack block rate" metric={values.attackBlockRate} accent="mint" /><MetricCard label="Normal task success" metric={values.normalTaskSuccessRate} accent="blue" /><MetricCard label="False block rate" metric={values.falseBlockRate} accent="violet" /><MetricCard label="Held-out ASR" metric={values.heldOutAttackSuccessRate} accent="amber" /><MetricCard label="Operational errors" metric={values.operationalErrorRate} accent="slate" /></div>
      <div className="content-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">ACTUAL IMPACT</p><h2>Observed security effects</h2></div></div><dl className="impact-grid"><div><dt>Unauthorized records</dt><dd>{values.unauthorizedRecordExposureCount}</dd></div><div><dt>Sensitive fields</dt><dd>{values.sensitiveFieldExposureCount}</dd></div><div><dt>Exfiltrations</dt><dd>{values.exfiltrationSuccessCount}</dd></div><div><dt>High-impact mutations</dt><dd>{values.highImpactMutationCount}</dd></div></dl><p className="file-hint">Synthetic Sandbox evidence only. N/A는 0이 아니라 결론 가능한 trial 부족을 의미합니다.</p></section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRIAL COVERAGE</p><h2>{values.trials.length} evaluated trials</h2></div></div><div className="trial-chips">{values.trials.length ? values.trials.map((trial) => <span key={trial.caseRunId}>{trial.mode} · {trial.category} · {trial.outcomes.join('/') || trial.status}</span>) : <p className="muted">아직 평가된 trial이 없습니다.</p>}</div></section></div>
      <ReplayPanel summary={metrics?.replaySummary} />
    </>}
    {proposal ? <section className="panel decision-panel"><div className="panel-heading"><div><p className="eyebrow">PROPOSED DECISION</p><h2>{proposal.proposedDecision}</h2></div><span className={`decision-mark decision-mark--${proposal.proposedDecision.toLowerCase()}`}>{proposal.proposedDecision}</span></div><dl className="detail-grid"><div><dt>Gate policy</dt><dd>{proposal.gatePolicyVersion}</dd></div><div><dt>Input digest</dt><dd><ShortHash value={proposal.inputDigest} /></dd></div></dl>
      <div className="gate-rules"><h3>Gate 판정 근거</h3>{rules.length ? rules.map((rule) => <div key={rule.ruleId} className={rule.triggered ? 'gate-rule gate-rule--triggered' : 'gate-rule'}><span>{rule.triggered ? '!' : '✓'}</span><div><strong>{rule.ruleId.replaceAll('_', ' ')}</strong><p>{rule.detail || (rule.triggered ? '검토 조건이 발생했습니다.' : '통과')}</p></div></div>) : <p className="muted">세부 Rule trace가 snapshot에 없습니다.</p>}</div>
      <details><summary>Decision input snapshot</summary><pre>{JSON.stringify(proposal.inputSnapshot, null, 2)}</pre></details><div className="decision-confirm"><label>Final decision<select aria-label="Final decision" value={decision} onChange={(event) => setDecision(event.target.value as DecisionValue)}><option>PASS</option><option>REVIEW</option><option>BLOCKED</option></select></label><label>Reviewer comment<textarea aria-label="Decision comment" rows={3} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="판정 근거를 기록하세요." /><small>{comment.length}/1000</small></label><button className="danger-button" disabled={busy || !comment.trim()} onClick={() => void confirm()}>Decision 확정</button></div></section> : null}
  </>
}
