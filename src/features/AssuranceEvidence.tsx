import type {
  AttackRateBreakdown, CaseTrialDistribution, CategoryTrialDistribution, CompletionRate,
  CriticalInvariantAnySuccess, CriticalTrialCoverage, JsonValue, MetricsView, PolicyLatency,
  TrialBit, TrialSuccessDistribution,
} from '../api/contracts'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableCount = (value: unknown) => value === null || count(value)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier)
const status = (value: unknown) => value === 'AVAILABLE' || value === 'N_A'
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const nullableNumber = (value: unknown) => value === null || number(value)
const nullableBoolean = (value: unknown) => value === null || typeof value === 'boolean'
const bits = (value: unknown) => Array.isArray(value) && value.every(bit => bit === null || bit === 0 || bit === 1)
const gcIdentities: Record<string, string> = { 'GC-01': 'INV-01', 'GC-02': 'INV-02', 'GC-03': 'INV-04', 'GC-04': 'INV-05' }

function fraction(value: Record<string, unknown>): boolean {
  return status(value.status) && nullableText(value.reason) && nullableCount(value.numerator)
    && nullableCount(value.denominator) && nullableNumber(value.value) && strings(value.sourceRunIds)
    && (value.status !== 'AVAILABLE' || (count(value.numerator) && count(value.denominator)
      && value.denominator > 0 && value.numerator <= value.denominator && number(value.value) && value.value <= 1
      // The current calculators return this IEEE-754 division; validate only, never replace the server value.
      && value.value === value.numerator / value.denominator))
}

function latency(value: unknown): PolicyLatency | null {
  const item = record(value)
  if (!item || !status(item.status) || !nullableText(item.reason) || !count(item.observedEventCount)
    || !count(item.invalidEventCount) || item.invalidEventCount > item.observedEventCount
    || !strings(item.sourceRunIds) || !strings(item.sourceEventIds)
    || !['averageMs', 'p50Ms', 'p95Ms', 'p99Ms'].every(key => nullableNumber(item[key]))
    || (item.status === 'AVAILABLE' && (item.observedEventCount === 0 || item.invalidEventCount !== 0
      || item.sourceRunIds.length === 0 || item.sourceEventIds.length === 0
      || !['averageMs', 'p50Ms', 'p95Ms', 'p99Ms'].every(key => number(item[key]))
      || (item.p50Ms as number) > (item.p95Ms as number) || (item.p95Ms as number) > (item.p99Ms as number)))) return null
  return item as unknown as PolicyLatency
}

function completion(value: unknown): CompletionRate | null {
  const item = record(value)
  return item && fraction(item) && nullableCount(item.cancelledTrials) && nullableCount(item.unmaterializedTrials)
    && (item.status !== 'AVAILABLE' || (count(item.cancelledTrials) && count(item.unmaterializedTrials)))
    && (item.status !== 'AVAILABLE' || (item.sourceRunIds as string[]).length > 0
      && (item.numerator as number) + (item.cancelledTrials as number) + (item.unmaterializedTrials as number) <= (item.denominator as number))
    ? item as unknown as CompletionRate : null
}

function trial(value: unknown): value is TrialBit {
  const item = record(value)
  return !!item && ['runId', 'testCaseId', 'caseRunId'].every(key => identifier(item[key]))
    && count(item.trialIndex) && (item.successBit === null || item.successBit === 0 || item.successBit === 1)
    && nullableText(item.exclusionReason) && typeof item.secondaryInconclusive === 'boolean'
}

function distributionItem(value: unknown, category: boolean): boolean {
  const item = record(value)
  if (!item || !status(item.status) || !nullableText(item.reason)
    || !['mode', 'caseType', 'category'].every(key => typeof item[key] === 'string')
    || !bits(item.successBits) || !Array.isArray(item.orderedTrials) || !item.orderedTrials.every(trial)
    || !nullableCount(item.successCount) || !nullableCount(item.trials) || !count(item.excludedTrials)) return false
  const ordered = item.orderedTrials as TrialBit[]
  const vector = item.successBits as Array<number | null>
  if (ordered.length === 0 || vector.length !== ordered.length || !ordered.every((bit, index) => bit.successBit === vector[index]
    && (bit.successBit === null ? typeof bit.exclusionReason === 'string' && bit.exclusionReason.length > 0 : bit.exclusionReason === null))
    || new Set(ordered.map(bit => bit.caseRunId)).size !== ordered.length) return false
  if (item.status === 'AVAILABLE') {
    if (!count(item.successCount) || !count(item.trials) || item.trials === 0
      || item.successCount > item.trials || item.trials + item.excludedTrials !== ordered.length
      || item.trials !== vector.filter(bit => bit !== null).length
      || item.successCount !== vector.filter(bit => bit === 1).length
      || item.excludedTrials !== vector.filter(bit => bit === null).length) return false
  } else if (item.successCount !== null || item.trials !== null || item.excludedTrials !== ordered.length
    || !vector.every(bit => bit === null)) return false
  return category ? strings(item.sourceRunIds) && ordered.every(bit => (item.sourceRunIds as string[]).includes(bit.runId))
    : identifier(item.runId) && identifier(item.testCaseId) && ['caseKey', 'partition'].every(key => typeof item[key] === 'string')
      && ordered.every(bit => bit.runId === item.runId && bit.testCaseId === item.testCaseId)
}

function sameRuns(reported: string[], referenced: string[]): boolean {
  const expected = new Set(referenced), actual = new Set(reported)
  return actual.size === expected.size && [...actual].every(id => expected.has(id))
}

function distributionGraph(cases: CaseTrialDistribution[], categories: CategoryTrialDistribution[], sourceRunIds: string[]): boolean {
  const caseHeaders = new Set<string>(), caseRuns = new Set<string>()
  const groups = new Map<string, TrialBit[]>()
  const groupKey = (item: CaseTrialDistribution | CategoryTrialDistribution) => JSON.stringify([item.mode, item.caseType, item.category])
  const trialKey = (bit: TrialBit) => JSON.stringify([bit.runId, bit.testCaseId, bit.caseRunId, bit.trialIndex,
    bit.successBit, bit.exclusionReason, bit.secondaryInconclusive])
  for (const item of cases) {
    const header = JSON.stringify([item.runId, item.testCaseId])
    if (caseHeaders.has(header)) return false
    caseHeaders.add(header)
    for (let index = 0; index < item.orderedTrials.length; index++) {
      const bit = item.orderedTrials[index]!
      if (caseRuns.has(bit.caseRunId) || (index > 0 && item.orderedTrials[index - 1]!.trialIndex >= bit.trialIndex)) return false
      caseRuns.add(bit.caseRunId)
    }
    const key = groupKey(item)
    groups.set(key, [...(groups.get(key) ?? []), ...item.orderedTrials])
  }
  if (groups.size !== categories.length) return false
  const seenGroups = new Set<string>(), categoryRuns = new Set<string>()
  for (const item of categories) {
    const key = groupKey(item), expected = groups.get(key)
    if (!expected || seenGroups.has(key) || expected.length !== item.orderedTrials.length
      || !item.orderedTrials.every((bit, index) => trialKey(bit) === trialKey(expected[index]!))
      || !sameRuns(item.sourceRunIds, expected.map(bit => bit.runId))) return false
    seenGroups.add(key)
    for (const bit of item.orderedTrials) {
      if (categoryRuns.has(bit.caseRunId)) return false
      categoryRuns.add(bit.caseRunId)
    }
  }
  // An invalid-metadata N_A report can retain observed Runs without publishing any trial rows.
  return cases.length === 0 || sameRuns(sourceRunIds, cases.flatMap(item => item.orderedTrials.map(bit => bit.runId)))
}

function distribution(value: unknown): TrialSuccessDistribution | null {
  const item = record(value)
  return item && status(item.status) && nullableText(item.reason) && strings(item.sourceRunIds)
    && Array.isArray(item.cases) && item.cases.every(value => distributionItem(value, false))
    && Array.isArray(item.categories) && item.categories.every(value => distributionItem(value, true))
    && item.cases.every(value => (item.sourceRunIds as string[]).includes((value as CaseTrialDistribution).runId))
    && item.categories.every(value => (value as CategoryTrialDistribution).sourceRunIds.every(id => (item.sourceRunIds as string[]).includes(id)))
    && (item.status === 'N_A' ? [...item.cases, ...item.categories].every(value => record(value)?.status === 'N_A')
      : item.cases.some(value => record(value)?.status === 'AVAILABLE') && item.categories.some(value => record(value)?.status === 'AVAILABLE'))
    && distributionGraph(item.cases as CaseTrialDistribution[], item.categories as CategoryTrialDistribution[], item.sourceRunIds)
    ? item as unknown as TrialSuccessDistribution : null
}

function breakdown(value: unknown): AttackRateBreakdown | null {
  const item = record(value)
  return item && status(item.status) && nullableText(item.reason) && strings(item.sourceRunIds)
    && Array.isArray(item.groups) && item.groups.every(value => {
      const group = record(value)
      return group && fraction(group) && ['mode', 'category', 'partition'].every(key => typeof group[key] === 'string')
        && nullableBoolean(group.anySuccess) && count(group.excludedTrials)
        && (group.status !== 'AVAILABLE' || (group.sourceRunIds as string[]).length > 0
          && group.anySuccess === ((group.numerator as number) > 0))
        && (group.sourceRunIds as string[]).every(id => (item.sourceRunIds as string[]).includes(id))
    }) && new Set(item.groups.map(value => {
      const group = record(value)!
      return JSON.stringify([group.mode, group.category, group.partition])
    })).size === item.groups.length
    && (item.status === 'AVAILABLE' ? item.groups.some(value => record(value)?.status === 'AVAILABLE')
      : item.groups.every(value => record(value)?.status === 'N_A'))
    ? item as unknown as AttackRateBreakdown : null
}

function critical(value: unknown): CriticalInvariantAnySuccess | null {
  const item = record(value)
  return item && Array.isArray(item.invariants) && item.invariants.every(value => {
    const row = record(value)
    return row && typeof row.gcId === 'string' && typeof row.invariantId === 'string' && gcIdentities[row.gcId] === row.invariantId
      && status(row.status) && nullableText(row.reason) && nullableBoolean(row.anySuccess)
      && ['sourceRunIds', 'sourceCaseRunIds', 'sourceOracleResultIds', 'sourceEventIds'].every(key => strings(row[key]))
      && (row.status === 'AVAILABLE' ? row.anySuccess === true
        && ['sourceRunIds', 'sourceCaseRunIds', 'sourceOracleResultIds', 'sourceEventIds'].every(key => (row[key] as string[]).length > 0)
        : row.anySuccess === null)
  }) && new Set(item.invariants.map(value => record(value)?.gcId)).size === item.invariants.length
    ? item as unknown as CriticalInvariantAnySuccess : null
}

export function readCriticalTrialCoverage(snapshot: JsonValue | undefined): CriticalTrialCoverage | null {
  const item = record(record(snapshot)?.criticalTrialCoverage)
  if (!item || !status(item.status) || !nullableText(item.reason)
    || !['complete', 'observedRequirementMet', 'requiredCategoriesPresent'].every(key => typeof item[key] === 'boolean')
    || !Array.isArray(item.cases) || !item.cases.every(value => {
      const row = record(value)
      return row && ['testCaseId', 'category', 'partition'].every(key => typeof row[key] === 'string')
        && nullableText(row.mode) && nullableCount(row.requiredTrials) && count(row.conclusiveTrials)
        && typeof row.complete === 'boolean' && nullableText(row.reason)
    })) return null
  return item as unknown as CriticalTrialCoverage
}

function unavailable(reason?: string | null) { return `N/A — ${reason || '보고서가 없거나 저장 형식을 확인할 수 없습니다.'}` }
function exact(value: number | null) { return value === null ? '미확정' : String(value) }
function fractionText(item: { status: string; reason: string | null; numerator: number | null; denominator: number | null }) {
  return item.status === 'AVAILABLE' ? `${item.numerator}/${item.denominator}` : unavailable(item.reason)
}

function Sources({ entries }: { entries: Array<[string, string[]]> }) {
  return <details><summary>전체 근거 ID</summary><dl className="detail-grid">{entries.map(([label, ids]) => <div key={label}>
    <dt>{label}</dt><dd>{ids.length ? ids.map((id, index) => <div key={`${index}:${id}`}><code>{id}</code></div>) : '출처 ID 없음'}</dd>
  </div>)}</dl></details>
}

function TrialRows({ item }: { item: CaseTrialDistribution | CategoryTrialDistribution }) {
  return <><p>Ordered bits: [{item.successBits.map(bit => bit === null ? '?' : String(bit)).join(', ')}]</p>
    <ol>{item.orderedTrials.map((bit, index) => <li key={`${index}:${bit.caseRunId}`}>
      Trial {bit.trialIndex}: {bit.successBit === null ? '미확정' : String(bit.successBit)}
      {bit.exclusionReason ? ` · ${bit.exclusionReason}` : ''}{bit.secondaryInconclusive ? ' · SECONDARY_INCONCLUSIVE' : ''}
      <Sources entries={[["Run", [bit.runId]], ['TestCase', [bit.testCaseId]], ['CaseRun', [bit.caseRunId]]]} />
    </li>)}</ol></>
}

export function AssuranceEvidence({ reports }: { reports: MetricsView }) {
  const policy = latency(reports.policyLatency)
  const completed = completion(reports.completionRate)
  const trials = distribution(reports.trialSuccessDistribution)
  const attacks = breakdown(reports.attackRateBreakdown)
  const gc = critical(reports.criticalInvariantAnySuccess)
  const gcOrder = [...(gc?.invariants.map(item => item.gcId) ?? []), ...Object.keys(gcIdentities).filter(id => !gc?.invariants.some(item => item.gcId === id))]
  return <section aria-label="LIVE Metrics evidence">
    <div className="panel-heading"><div><p className="eyebrow">LIVE STORED METRICS</p><h2>현재 저장된 평가 근거</h2></div></div>
    <p className="file-hint">현재 Metrics 조회 결과입니다. Decision 후보 snapshot과 집계 범위가 다를 수 있습니다. 내부 평가이며 공식 인증이 아닙니다.</p>
    <div className="content-grid"><article className="panel" aria-label="Policy latency"><h3>Policy latency</h3>
      {!policy ? <p>{unavailable()}</p> : <><p>{policy.status === 'N_A' ? unavailable(policy.reason) : 'AVAILABLE · POLICY_EVALUATED only'}</p>
        <dl className="detail-grid">{(['averageMs', 'p50Ms', 'p95Ms', 'p99Ms'] as const).map(key => <div key={key}><dt>{key}</dt><dd>{policy.status === 'AVAILABLE' ? `${policy[key]} ms` : '미확정'}</dd></div>)}
          <div><dt>Observed events</dt><dd>{policy.observedEventCount}</dd></div><div><dt>Invalid events</dt><dd>{policy.invalidEventCount}</dd></div></dl>
        <Sources entries={[["Run", policy.sourceRunIds], ['Event', policy.sourceEventIds]]} /></>}
    </article><article className="panel" aria-label="Completion rate"><h3>Completion rate</h3>
      {!completed ? <p>{unavailable()}</p> : <><p>{fractionText(completed)} terminal non-cancelled / scheduled trials</p>
        <dl className="detail-grid"><div><dt>Server value</dt><dd>{completed.status === 'AVAILABLE' ? String(completed.value) : '미확정'}</dd></div>
          <div><dt>Cancelled trials</dt><dd>{completed.status === 'AVAILABLE' ? exact(completed.cancelledTrials) : '미확정'}</dd></div>
          <div><dt>Unmaterialized trials</dt><dd>{completed.status === 'AVAILABLE' ? exact(completed.unmaterializedTrials) : '미확정'}</dd></div></dl>
        <Sources entries={[["Run", completed.sourceRunIds]]} /></>}
    </article></div>
    <article className="panel replay-panel" aria-label="Trial success distribution"><h3>Trial success distribution</h3>
      {!trials ? <p>{unavailable()}</p> : <><p>{trials.status === 'N_A' ? unavailable(trials.reason) : 'AVAILABLE'}</p>
        <p className="file-hint">공격: 1은 공격 성공, 0은 해당 trial의 미성공입니다. 정상업무: 1은 정상 성공, 0은 실패입니다. ?는 결론이 없어 분모에서 제외된 trial이며 음성 증거가 아닙니다.</p>
        <div className="table-wrap"><table><caption>Case별 관측 분포</caption><thead><tr><th>Case / Run</th><th>Mode / partition</th><th>Success / conclusive</th><th>Ordered trials</th></tr></thead><tbody>
          {trials.cases.map((item, index) => <tr key={`${index}:${item.runId}:${item.testCaseId}`}><td>{item.caseKey}<small>{item.category} · {item.caseType}</small><code>{item.testCaseId}</code><small>{item.runId}</small></td>
            <td>{item.mode} · {item.partition}</td><td>{item.status === 'AVAILABLE' ? `${item.successCount}/${item.trials}` : unavailable(item.reason)}<small>Excluded: {item.excludedTrials}</small></td><td><TrialRows item={item} /></td></tr>)}
        </tbody></table></div>
        <div className="table-wrap"><table><caption>Category별 관측 분포</caption><thead><tr><th>Mode / category</th><th>Success / conclusive</th><th>Ordered trials / source</th></tr></thead><tbody>
          {trials.categories.map((item, index) => <tr key={index}><td>{item.mode} · {item.category}<small>{item.caseType}</small></td><td>{item.status === 'AVAILABLE' ? `${item.successCount}/${item.trials}` : unavailable(item.reason)}<small>Excluded: {item.excludedTrials}</small></td>
            <td><TrialRows item={item} /><Sources entries={[["Run", item.sourceRunIds]]} /></td></tr>)}
        </tbody></table></div><Sources entries={[["Run", trials.sourceRunIds]]} /></>}
    </article>
    <article className="panel replay-panel" aria-label="Attack rate breakdown"><h3>Attack rate breakdown</h3>
      {!attacks ? <p>{unavailable()}</p> : <><p>{attacks.status === 'N_A' ? unavailable(attacks.reason) : 'AVAILABLE'}</p><div className="table-wrap"><table><caption>Mode / category / partition별 공격 성공률</caption><thead><tr><th>Mode / category / partition</th><th>Fraction / server value</th><th>Any success / exclusions</th><th>Source</th></tr></thead><tbody>
        {attacks.groups.map((item, index) => <tr key={index}><td>{item.mode} · {item.category} · {item.partition}</td><td>{fractionText(item)}<small>Server value: {item.status === 'AVAILABLE' ? String(item.value) : '미확정'}</small></td>
          <td>{item.status === 'AVAILABLE' && item.anySuccess !== null ? String(item.anySuccess) : '미확정'}<small>Excluded: {item.excludedTrials}</small></td><td><Sources entries={[["Run", item.sourceRunIds]]} /></td></tr>)}
      </tbody></table></div><Sources entries={[["Run", attacks.sourceRunIds]]} /></>}
    </article>
    <article className="panel replay-panel" aria-label="Critical invariant evidence"><h3>Critical invariant anySuccess</h3><p className="file-hint">성공이 관측되지 않았다는 사실만으로 GC 음성 증거나 배포 PASS를 만들지 않습니다.</p>
      <div className="table-wrap"><table><caption>GC-01 ~ GC-04 원본 판정</caption><thead><tr><th>GC / invariant</th><th>Server anySuccess</th><th>Reason / source</th></tr></thead><tbody>
        {gcOrder.map(id => {
          const matches = gc?.invariants.filter(item => item.gcId === id) ?? []
          const item = matches.length === 1 ? matches[0] : undefined
          return <tr key={id}><td>{id}<small>{item?.invariantId ?? '미확정'}</small></td><td>{item?.status === 'AVAILABLE' && item.anySuccess !== null ? String(item.anySuccess) : '미확정'}</td>
            <td>{item ? item.status === 'N_A' ? unavailable(item.reason) : 'AVAILABLE · 관측 범위' : unavailable()}
              {item ? <Sources entries={[["Run", item.sourceRunIds], ['CaseRun', item.sourceCaseRunIds], ['Oracle', item.sourceOracleResultIds], ['Event', item.sourceEventIds]]} /> : null}</td></tr>
        })}
      </tbody></table></div>
    </article>
  </section>
}

export function RequiredCohortEvidence({ snapshot }: { snapshot?: JsonValue }) {
  const coverage = readCriticalTrialCoverage(snapshot)
  return <article className="panel replay-panel" aria-label="Required cohort evidence"><h3>Required cohort certification</h3>
    <p className="file-hint">Decision 후보 snapshot의 보고서입니다. 관측 threshold와 인증된 필수 trial 집합은 별개이며 LIVE Metrics로 빈 값을 채우지 않습니다.</p>
    <p>{coverage ? unavailable(coverage.reason) : unavailable(snapshot ? '후보의 cohort 보고서가 없거나 형식이 올바르지 않습니다.' : 'Metrics 응답에는 required cohort 인증 보고서가 없습니다.')}</p>
    {coverage ? <><dl className="detail-grid"><div><dt>Server status</dt><dd>{coverage.status}</dd></div><div><dt>Observed requirement met</dt><dd>{String(coverage.observedRequirementMet)}</dd></div><div><dt>Server complete</dt><dd>{String(coverage.complete)}</dd></div><div><dt>Required categories present</dt><dd>{String(coverage.requiredCategoriesPresent)}</dd></div></dl>
      <div className="table-wrap"><table><caption>후보 snapshot의 관측 critical trial threshold</caption><thead><tr><th>TestCase</th><th>Category / partition / mode</th><th>Required / conclusive</th><th>Observed complete / reason</th></tr></thead><tbody>
        {coverage.cases.map((item, index) => <tr key={`${index}:${item.testCaseId}`}><td><code>{item.testCaseId}</code></td><td>{item.category} · {item.partition} · {item.mode ?? '미확정'}</td><td>{exact(item.requiredTrials)} / {item.conclusiveTrials}</td><td>{String(item.complete)}<small>{item.reason}</small></td></tr>)}
      </tbody></table></div></> : null}
  </article>
}

// This is a filtered UI projection, not a new canonical snapshot or digest.
function known(value: unknown, keys: string[]): Record<string, JsonValue> {
  const source = record(value)
  const result: Record<string, JsonValue> = {}
  if (!source) return result
  for (const key of keys) {
    const value = source[key]
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value
    else if (Array.isArray(value) && value.every(item => item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) result[key] = value as JsonValue[]
  }
  return result
}
function knownList(value: unknown, keys: string[]): JsonValue[] { return Array.isArray(value) ? value.map(item => known(item, keys)) : [] }
const reportKeys = ['status', 'reason', 'sourceRunIds']
const metricKeys = ['metric', 'name', 'status', 'reason', 'numerator', 'denominator', 'value', 'calculatorVersion', 'sourceRunIds', 'sourceTestRunIds', 'evidenceDigest']
const trialKeys = ['runId', 'testCaseId', 'caseRunId', 'trialIndex', 'successBit', 'exclusionReason', 'secondaryInconclusive']
const caseKeys = ['status', 'reason', 'runId', 'mode', 'testCaseId', 'caseKey', 'caseType', 'category', 'partition', 'successBits', 'successCount', 'trials', 'excludedTrials', 'sourceRunIds']

export function filteredProposalSnapshot(snapshot: JsonValue): JsonValue {
  const source = record(snapshot)
  if (!source) return null
  const result = known(source, ['schemaVersion', 'systemPromptFingerprint', 'toolSetFingerprint', 'ragConfigurationFingerprint', 'testedAt'])
  const groups: Array<[string, string[]]> = [
    ['agent', ['id', 'name']], ['release', ['id', 'version', 'fingerprint', 'agentArtifactFingerprint']],
    ['model', ['provider', 'name', 'resolvedName', 'parametersHash']], ['safetyContract', ['status', 'versionId', 'version', 'hash']],
    ['testSuite', ['id', 'version', 'hash']], ['sandbox', ['fixtureVersion', 'fixtureDigest']],
    ['approvedPatch', ['proposalId', 'approvalId', 'baseHash', 'resultHash']],
    ['policyLatency', [...reportKeys, 'observedEventCount', 'invalidEventCount', 'averageMs', 'p50Ms', 'p95Ms', 'p99Ms', 'sourceEventIds']],
    ['completionRate', [...reportKeys, 'numerator', 'denominator', 'value', 'cancelledTrials', 'unmaterializedTrials']],
  ]
  const lists: Array<[string, string[]]> = [
    ['toolSchemaFingerprints', ['toolName', 'schemaHash', 'descriptionHash']], ['metrics', metricKeys],
    ['remainingFindings', ['id', 'severity', 'status', 'evidenceDigest']], ['observedEffectCounts', metricKeys],
    ['criticalSuccessEvidence', ['runId', 'caseRunId', 'mode', 'reasonCodes']],
  ]
  for (const key of [...groups.map(([key]) => key), ...lists.map(([key]) => key), 'results', 'decision',
    'replayComparability', 'criticalTrialCoverage', 'criticalInvariantAnySuccess', 'attackRateBreakdown', 'trialSuccessDistribution']) {
    if (source[key] === null) result[key] = null
  }
  for (const [key, fields] of groups) if (record(source[key])) result[key] = known(source[key], fields)
  for (const [key, fields] of lists) if (Array.isArray(source[key])) result[key] = knownList(source[key], fields)
  const results = record(source.results)
  if (results) {
    const values: Record<string, JsonValue> = {}
    for (const key of ['baseline', 'sealReplay', 'heldOut', 'normalRegression']) if (record(results[key])) values[key] = known(results[key], metricKeys)
    result.results = values
  }
  const decision = record(source.decision)
  if (decision) {
    const value = known(decision, ['value', 'gatePolicyVersion'])
    if (Array.isArray(decision.ruleTrace)) value.ruleTrace = knownList(decision.ruleTrace, ['ruleId', 'triggered', 'detail'])
    result.decision = value
  }
  const replay = record(source.replayComparability)
  if (replay) {
    const value = known(replay, ['totalCount', 'comparableCount', 'nonComparableCount', 'evidenceComplete'])
    if (Array.isArray(replay.items)) value.items = knownList(replay.items, ['baselineRunId', 'replayRunId', 'category', 'comparable', 'mismatchReasons'])
    result.replayComparability = value
  }
  const coverage = record(source.criticalTrialCoverage)
  if (coverage) {
    const value = known(coverage, [...reportKeys, 'complete', 'observedRequirementMet', 'requiredCategoriesPresent'])
    if (Array.isArray(coverage.cases)) value.cases = knownList(coverage.cases, ['testCaseId', 'category', 'partition', 'mode', 'requiredTrials', 'conclusiveTrials', 'complete', 'reason'])
    result.criticalTrialCoverage = value
  }
  const gc = record(source.criticalInvariantAnySuccess)
  if (gc && Array.isArray(gc.invariants)) result.criticalInvariantAnySuccess = { invariants: knownList(gc.invariants, ['gcId', 'invariantId', 'status', 'reason', 'anySuccess', 'sourceRunIds', 'sourceCaseRunIds', 'sourceOracleResultIds', 'sourceEventIds']) }
  const rates = record(source.attackRateBreakdown)
  if (rates) {
    const value = known(rates, reportKeys)
    if (Array.isArray(rates.groups)) value.groups = knownList(rates.groups, [...reportKeys, 'mode', 'category', 'partition', 'numerator', 'denominator', 'value', 'anySuccess', 'excludedTrials'])
    result.attackRateBreakdown = value
  }
  const distribution = record(source.trialSuccessDistribution)
  if (distribution) {
    const value = known(distribution, reportKeys)
    for (const key of ['cases', 'categories']) {
      const rows = distribution[key]
      if (Array.isArray(rows)) value[key] = rows.map(row => {
        const value = known(row, caseKeys)
        const trials = record(row)?.orderedTrials
        if (Array.isArray(trials)) value.orderedTrials = knownList(trials, trialKeys)
        return value
      })
    }
    result.trialSuccessDistribution = value
  }
  return result
}
