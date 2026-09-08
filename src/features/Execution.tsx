import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { EventChainVerification, ExecutionEvent, Finding, OracleResult, Release, ReplayComparison, TestRun, TestRunSummary, TestSuiteSummary } from '../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, ShortHash, formatDate } from '../components/Primitives'

const attacks = [['FA-01','악성 문서 지시'],['FA-02','타 고객 데이터 조회'],['FA-03','민감정보 과다 조회'],['FA-04','외부 정보 유출'],['FA-05','고위험 상태 변경']]
const tone = (value:string) => ['COMPLETED','ATTACK_BLOCKED','NORMAL_SUCCESS','OPEN'].includes(value) ? 'positive' : ['FAILED','ERROR','ATTACK_SUCCESS','BLOCKED'].includes(value) ? 'critical' : 'warning'
const activeRunStatuses = new Set(['QUEUED', 'PREPARING', 'RUNNING', 'CANCELLING'])
const streamBaseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080'

export function ExecutionPage({ releases, actorId }: { releases:Release[]; actorId:string }) {
  const [releaseId,setReleaseId]=useState(releases[0]?.id??''); const [runId,setRunId]=useState('')
  const [suiteOptions,setSuiteOptions]=useState<TestSuiteSummary[]>([]); const [runOptions,setRunOptions]=useState<TestRunSummary[]>([]); const [replayComparisons,setReplayComparisons]=useState<ReplayComparison[]>([])
  const [suiteId,setSuiteId]=useState(''); const [mode,setMode]=useState<TestRun['mode']>('BASELINE'); const [runModeFilter,setRunModeFilter]=useState<TestRun['mode'] | ''>(''); const [runStatusFilter,setRunStatusFilter]=useState(''); const [contractVersionId,setContractVersionId]=useState(''); const [caseIds,setCaseIds]=useState(''); const [randomSeed,setRandomSeed]=useState('42'); const [receipt,setReceipt]=useState('')
  const [run,setRun]=useState<TestRun|null>(null); const [events,setEvents]=useState<ExecutionEvent[]>([])
  const [chain,setChain]=useState<EventChainVerification|null>(null); const [oracles,setOracles]=useState<OracleResult[]>([]); const [findings,setFindings]=useState<Finding[]>([])
  const [oracleOutcomeFilter,setOracleOutcomeFilter]=useState(''); const [findingCategoryFilter,setFindingCategoryFilter]=useState(''); const [findingSeverityFilter,setFindingSeverityFilter]=useState(''); const [findingStatusFilter,setFindingStatusFilter]=useState('')
  const [streamState, setStreamState] = useState<'IDLE' | 'CONNECTING' | 'LIVE' | 'ERROR'>('IDLE')
  const [busy,setBusy]=useState(false); const [error,setError]=useState<unknown>()
  const streamRef = useRef<EventSource | null>(null)
  const selectedSuite = suiteOptions.find((suite) => suite.id === suiteId)
  const canStartRun = !!releaseId && !!suiteId.trim() && selectedSuite?.status === 'READY' && !busy
  const filteredOracles = oracles.filter((oracle) => !oracleOutcomeFilter || oracle.outcome === oracleOutcomeFilter)
  const filteredFindings = findings.filter((finding) => (!findingCategoryFilter || finding.category === findingCategoryFilter) && (!findingSeverityFilter || finding.severity === findingSeverityFilter) && (!findingStatusFilter || finding.status === findingStatusFilter))
  const findingCategories = Array.from(new Set(findings.map((finding) => finding.category)))
  const findingSeverities = Array.from(new Set(findings.map((finding) => finding.severity)))
  const findingStatuses = Array.from(new Set(findings.map((finding) => finding.status)))

  function closeStream() {
    if (streamRef.current) {
      streamRef.current.close()
      streamRef.current = null
    }
    setStreamState('IDLE')
  }

  function upsertEvent(next: ExecutionEvent) {
    setEvents((current) => {
      if (current.some((item) => item.eventId === next.eventId)) return current
      return [...current, next].sort((a, b) => a.sequence - b.sequence)
    })
  }

  async function refreshRunSnapshot(targetRunId: string) {
    try {
      const [nextRun, nextChain] = await Promise.all([
        api.testRun(targetRunId, actorId),
        api.verifyEventChain(targetRunId, actorId),
      ])
      setRun(nextRun)
      setChain(nextChain)
      if (!activeRunStatuses.has(nextRun.status)) {
        closeStream()
      }
    } catch {
      setStreamState('ERROR')
    }
  }

  function openStream(targetRunId: string) {
    closeStream()
    setStreamState('CONNECTING')
    const stream = new EventSource(`${streamBaseUrl}/api/v1/test-runs/${encodeURIComponent(targetRunId)}/events`)
    streamRef.current = stream
    const onEvent = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ExecutionEvent
        upsertEvent(parsed)
        if (parsed.eventType === 'RUN_COMPLETED' || parsed.eventType === 'RUN_FAILED') {
          void refreshRunSnapshot(targetRunId)
        }
      } catch {
        // Ignore malformed SSE payloads and keep the stream alive.
      }
    }
    stream.onopen = () => {
      setStreamState('LIVE')
    }
    stream.onerror = () => {
      setStreamState('ERROR')
    }
    stream.addEventListener('trace.event', onEvent as EventListener)
    stream.addEventListener('run.status', onEvent as EventListener)
    stream.addEventListener('run.completed', onEvent as EventListener)
    stream.addEventListener('finding.created', onEvent as EventListener)
  }

  async function inspectRun(nextRunId: string) {
    if (!nextRunId.trim()) return
    closeStream()
    setBusy(true)
    setError(undefined)
    try {
      const id = nextRunId.trim()
      const [r, h, c, o, f] = await Promise.all([
        api.testRun(id, actorId),
        api.eventHistory(id, actorId),
        api.verifyEventChain(id, actorId),
        api.runOracleResults(id, actorId),
        api.runFindings(id, actorId),
      ])
      setRunId(id)
      setRun(r)
      setEvents(h.items)
      setChain(c)
      setOracles(o)
      setFindings(f)
      setStreamState('IDLE')
      if (activeRunStatuses.has(r.status)) {
        openStream(id)
      }
      if (!runOptions.some((item) => item.id === id)) {
        setRunOptions((current) => current)
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  async function openReplayRun(item: ReplayComparison) {
    setRunId(item.replayRunId)
    await inspectRun(item.replayRunId)
  }

  const refreshRunList = async () => {
    if (!releaseId) {
      setRunOptions([])
      setRunId('')
      return
    }

    const items = await api.listTestRuns(releaseId, actorId, {
      mode: runModeFilter || undefined,
      status: runStatusFilter || undefined,
      limit: 10,
    })
    setRunOptions(items)
    if (!items.some((item) => item.id === runId)) setRunId(items[0]?.id ?? '')
  }

  useEffect(() => {
    if (!releaseId) {
      setSuiteOptions([])
      setRunOptions([])
      setReplayComparisons([])
      setSuiteId('')
      setRunId('')
      closeStream()
      return
    }

    void Promise.all([
      api.listTestSuites(releaseId, actorId, { status: 'READY', limit: 20 }).then((items) => {
        setSuiteOptions(items)
        if (!items.some((item) => item.id === suiteId)) setSuiteId(items[0]?.id ?? '')
      }),
      refreshRunList(),
      api.listReplayComparisons(releaseId, actorId).then(setReplayComparisons),
    ]).catch(setError)
  }, [releaseId, actorId, runModeFilter, runStatusFilter])

  useEffect(() => () => closeStream(), [])

  async function inspect(){ await inspectRun(runId) }
  async function start(){
    if (!releaseId || !suiteId.trim()) return
    if (selectedSuite?.status !== 'READY') {
      setError(new Error('READY 상태의 Suite만 실행할 수 있습니다.'))
      return
    }
    setBusy(true);setError(undefined);setReceipt('');
    try{const result=await api.startTestRun({releaseId,suiteId:suiteId.trim(),mode,contractVersionId:contractVersionId.trim()||null,caseIds:caseIds.split(/[\s,]+/).filter(Boolean),randomSeed:randomSeed?Number(randomSeed):null},actorId);setReceipt(`Run ${result.runId} · ${result.status}`);await inspectRun(result.runId)}catch(e){setError(e)}finally{setBusy(false)}}
  return <><PageHeader eyebrow="ATTACK EXECUTION" title="Runs & Trace" description="B Runtime이 수행한 공격·Replay 상태와 Policy, Tool, Oracle 이벤트 체인을 추적합니다." />
    {error?<ErrorBanner error={error} onDismiss={()=>setError(undefined)}/>:null}
    {receipt?<div className="success-banner" role="status">{receipt}</div>:null}
    <section className="panel execution-start"><div className="panel-heading"><div><p className="eyebrow">NEW TEST RUN</p><h2>공격 및 Replay 실행</h2></div><span className="status status--positive">API CONNECTED</span></div><div className="execution-form"><label>Release<select value={releaseId} onChange={e=>setReleaseId(e.target.value)}><option value="">Release 선택</option>{releases.map(r=><option key={r.id} value={r.id}>v{r.version} · {r.effectiveStatus}</option>)}</select></label><label>Suite<select aria-label="Suite" value={suiteId} onChange={e=>setSuiteId(e.target.value)}><option value="">Suite 선택</option>{suiteOptions.map(s=><option key={s.id} value={s.id}>{s.version} · {s.status} · {s.caseCount} cases</option>)}</select></label><label>Suite ID<input aria-label="Suite ID" value={suiteId} onChange={e=>setSuiteId(e.target.value)} placeholder="READY Test Suite UUID"/></label><label>Mode<select aria-label="Run mode" value={mode} onChange={e=>setMode(e.target.value as TestRun['mode'])}><option>BASELINE</option><option>SEAL_REPLAY</option><option>HELD_OUT</option><option>REGRESSION</option></select></label><label>Contract Version ID<input value={contractVersionId} onChange={e=>setContractVersionId(e.target.value)} placeholder="선택"/></label><label>Case IDs<input value={caseIds} onChange={e=>setCaseIds(e.target.value)} placeholder="비우면 Suite 전체"/></label><label>Random seed<input type="number" value={randomSeed} onChange={e=>setRandomSeed(e.target.value)}/></label><button className="primary-button" disabled={!canStartRun} onClick={()=>void start()}>실행 시작</button></div><p className="file-hint">READY 상태의 Suite만 실행할 수 있습니다. DRAFT/INVALID suite는 시작 전 검증이 필요합니다.</p></section>
    <section className="panel run-picker"><div className="execution-form"><label>Run mode filter<select aria-label="Run mode filter" value={runModeFilter} onChange={e=>setRunModeFilter(e.target.value as TestRun['mode'] | '')}><option value="">전체</option><option value="BASELINE">BASELINE</option><option value="SEAL_REPLAY">SEAL_REPLAY</option><option value="HELD_OUT">HELD_OUT</option><option value="REGRESSION">REGRESSION</option></select></label><label>Run status filter<select aria-label="Run status filter" value={runStatusFilter} onChange={e=>setRunStatusFilter(e.target.value)}><option value="">전체</option><option value="QUEUED">QUEUED</option><option value="RUNNING">RUNNING</option><option value="COMPLETED">COMPLETED</option><option value="FAILED">FAILED</option><option value="CANCELED">CANCELED</option></select></label><button className="secondary-button" type="button" onClick={()=>void refreshRunList()}>목록 새로고침</button></div><label>최근 Run<select aria-label="Run list" value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Run 선택</option>{runOptions.map(r=><option key={r.id} value={r.id}>{r.mode} · {r.status} · {r.completedCases}/{r.totalCases}</option>)}</select></label><label>생성된 Test Run ID<input aria-label="Test Run ID" value={runId} onChange={e=>setRunId(e.target.value)} placeholder="UUID를 입력하세요"/></label><button className="primary-button" disabled={!runId.trim()||busy} onClick={()=>void inspect()}>Run 조회</button><p className="file-hint">Live stream: {streamState}</p></section>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">REPLAY COMPARABILITY</p><h2>{replayComparisons.length} replay comparisons</h2></div><span className={`status status--${replayComparisons.some((item) => !item.comparable) ? 'warning' : 'positive'}`}>{replayComparisons.some((item) => !item.comparable) ? 'MISMATCHES PRESENT' : 'COMPARABLE'}</span></div>{replayComparisons.length ? <div className="event-list">{replayComparisons.map((item)=><details key={`${item.baselineRunId ?? 'missing'}-${item.replayRunId}`}><summary><strong>{item.category ?? 'UNSPECIFIED'}</strong><em>{item.comparable ? 'Comparable replay' : 'Non-comparable replay'}</em><span className={`status status--${item.comparable ? 'positive' : 'warning'}`}>{item.comparable ? 'COMPARABLE' : 'MISMATCH'}</span></summary><div className="execution-form"><label>Baseline run<input readOnly value={item.baselineRunId ?? 'NO BASELINE'} /></label><label>Replay run<input readOnly value={item.replayRunId} /></label><button className="secondary-button" type="button" onClick={()=>void openReplayRun(item)}>Replay run 열기</button></div><pre>{JSON.stringify({baselineRunId:item.baselineRunId,replayRunId:item.replayRunId,mismatchReasons:item.mismatchReasons},null,2)}</pre></details>)}</div> : <p className="muted">Replay comparison evidence가 아직 없습니다.</p>}</section>
    <div className="attack-grid">{attacks.map(([id,title])=><article className="panel" key={id}><span>{id}</span><h2>{title}</h2></article>)}</div>
    {busy&&!run?<LoadingBlock label="Run evidence를 불러오는 중"/>:!run?<EmptyState title="Test Run을 선택하세요">B 실행부가 생성한 Run ID로 상태, Trace, Oracle, Finding을 함께 조회합니다.</EmptyState>:<><section className="run-summary"><article className="panel"><span>Status</span><strong className={`status status--${tone(run.status)}`}>{run.status}</strong></article><article className="panel"><span>Progress</span><strong>{run.completedCases}/{run.totalCases}</strong></article><article className="panel"><span>Mode</span><strong>{run.mode}</strong></article><article className="panel"><span>Errors</span><strong>{run.operationalErrorCount}</strong></article><article className="panel"><span>Event chain</span><strong className={`status status--${chain?.valid?'positive':'critical'}`}>{chain?.valid?'VALID':'INVALID'}</strong></article></section>
      <div className="content-grid execution-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRACE TIMELINE</p><h2>{events.length} execution events</h2></div><ShortHash value={chain?.headHash??run.eventHeadHash}/></div><div className="event-list">{events.map(e=><details key={e.eventId}><summary><span>#{e.sequence}</span><strong>{e.eventType}</strong><em>{e.toolName??e.reasonCode??''}</em><time>{formatDate(e.occurredAt)}</time></summary><pre>{JSON.stringify({input:e.input,policyDecision:e.policyDecision,output:e.output,metadata:e.metadata,eventHash:e.eventHash},null,2)}</pre></details>)}</div></section>
      <aside className="execution-side"><ResultList title="ORACLE RESULTS" filters={<label>Outcome<select aria-label="Oracle outcome filter" value={oracleOutcomeFilter} onChange={e=>setOracleOutcomeFilter(e.target.value)}><option value="">전체 outcome</option><option value="ATTACK_SUCCESS">ATTACK_SUCCESS</option><option value="ATTACK_BLOCKED">ATTACK_BLOCKED</option><option value="INCONCLUSIVE">INCONCLUSIVE</option><option value="NORMAL_SUCCESS">NORMAL_SUCCESS</option><option value="NORMAL_FAILURE">NORMAL_FAILURE</option></select></label>} items={filteredOracles.map(o=>({id:o.id,title:o.oracleType,status:o.outcome,note:o.reasonCode}))}/><ResultList title="FINDINGS" filters={<><label>Category<select aria-label="Finding category filter" value={findingCategoryFilter} onChange={e=>setFindingCategoryFilter(e.target.value)}><option value="">전체 category</option>{findingCategories.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>Severity<select aria-label="Finding severity filter" value={findingSeverityFilter} onChange={e=>setFindingSeverityFilter(e.target.value)}><option value="">전체 severity</option>{findingSeverities.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>Status<select aria-label="Finding status filter" value={findingStatusFilter} onChange={e=>setFindingStatusFilter(e.target.value)}><option value="">전체 status</option>{findingStatuses.map(value=><option key={value} value={value}>{value}</option>)}</select></label></>} items={filteredFindings.map(f=>({id:f.id,title:`${f.category} · ${f.title}`,status:f.status,note:f.severity}))}/></aside></div></>}</>}

function ResultList({title,items,filters}:{title:string;items:Array<{id:string;title:string;status:string;note:string}>;filters?:ReactNode}){return <section className="panel"><p className="eyebrow">{title}</p><h2>{items.length} results</h2>{filters?<div className="execution-form execution-result-filters">{filters}</div>:null}{items.length?items.map(i=><div className="compact-result" key={i.id}><strong>{i.title}</strong><span className={`status status--${tone(i.status)}`}>{i.status}</span><small>{i.note}</small></div>):<p className="muted">결과가 없습니다.</p>}</section>}
