import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { EventChainVerification, ExecutionEvent, Finding, OracleResult, Release, TestRun, TestRunSummary, TestSuiteSummary } from '../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, ShortHash, formatDate } from '../components/Primitives'

const attacks = [['FA-01','악성 문서 지시'],['FA-02','타 고객 데이터 조회'],['FA-03','민감정보 과다 조회'],['FA-04','외부 정보 유출'],['FA-05','고위험 상태 변경']]
const tone = (value:string) => ['COMPLETED','ATTACK_BLOCKED','NORMAL_SUCCESS'].includes(value) ? 'positive' : ['FAILED','ERROR','ATTACK_SUCCESS'].includes(value) ? 'critical' : 'warning'

export function ExecutionPage({ releases, actorId }: { releases:Release[]; actorId:string }) {
  const [releaseId,setReleaseId]=useState(releases[0]?.id??''); const [runId,setRunId]=useState('')
  const [suiteOptions,setSuiteOptions]=useState<TestSuiteSummary[]>([]); const [runOptions,setRunOptions]=useState<TestRunSummary[]>([])
  const [suiteId,setSuiteId]=useState(''); const [mode,setMode]=useState<TestRun['mode']>('BASELINE'); const [runModeFilter,setRunModeFilter]=useState<TestRun['mode'] | ''>(''); const [runStatusFilter,setRunStatusFilter]=useState(''); const [contractVersionId,setContractVersionId]=useState(''); const [caseIds,setCaseIds]=useState(''); const [randomSeed,setRandomSeed]=useState('42'); const [receipt,setReceipt]=useState('')
  const [run,setRun]=useState<TestRun|null>(null); const [events,setEvents]=useState<ExecutionEvent[]>([])
  const [chain,setChain]=useState<EventChainVerification|null>(null); const [oracles,setOracles]=useState<OracleResult[]>([]); const [findings,setFindings]=useState<Finding[]>([])
  const [busy,setBusy]=useState(false); const [error,setError]=useState<unknown>()
  const selectedSuite = suiteOptions.find((suite) => suite.id === suiteId)
  const canStartRun = !!releaseId && !!suiteId.trim() && selectedSuite?.status === 'READY' && !busy

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
      setSuiteId('')
      setRunId('')
      return
    }

    void Promise.all([
      api.listTestSuites(releaseId, actorId).then((items) => {
        setSuiteOptions(items)
        if (!items.some((item) => item.id === suiteId)) setSuiteId(items[0]?.id ?? '')
      }),
      refreshRunList(),
    ])
  }, [releaseId, actorId, runModeFilter, runStatusFilter])

  async function inspect(){ if(!runId.trim())return; setBusy(true);setError(undefined);try{const id=runId.trim();const [r,h,c,o,f]=await Promise.all([api.testRun(id,actorId),api.eventHistory(id,actorId),api.verifyEventChain(id,actorId),api.runOracleResults(id,actorId),api.runFindings(id,actorId)]);setRun(r);setEvents(h.items);setChain(c);setOracles(o);setFindings(f)}catch(e){setError(e)}finally{setBusy(false)} }
  async function start(){
    if (!releaseId || !suiteId.trim()) return
    if (selectedSuite?.status !== 'READY') {
      setError(new Error('READY 상태의 Suite만 실행할 수 있습니다.'))
      return
    }
    setBusy(true);setError(undefined);setReceipt('');
    try{const result=await api.startTestRun({releaseId,suiteId:suiteId.trim(),mode,contractVersionId:contractVersionId.trim()||null,caseIds:caseIds.split(/[\s,]+/).filter(Boolean),randomSeed:randomSeed?Number(randomSeed):null},actorId);setRunId(result.runId);setReceipt(`Run ${result.runId} · ${result.status}`)}catch(e){setError(e)}finally{setBusy(false)}}
  return <><PageHeader eyebrow="ATTACK EXECUTION" title="Runs & Trace" description="B Runtime이 수행한 공격·Replay 상태와 Policy, Tool, Oracle 이벤트 체인을 추적합니다." />
    {error?<ErrorBanner error={error} onDismiss={()=>setError(undefined)}/>:null}
    {receipt?<div className="success-banner" role="status">{receipt}</div>:null}
    <section className="panel execution-start"><div className="panel-heading"><div><p className="eyebrow">NEW TEST RUN</p><h2>공격 및 Replay 실행</h2></div><span className="status status--positive">API CONNECTED</span></div><div className="execution-form"><label>Release<select value={releaseId} onChange={e=>setReleaseId(e.target.value)}><option value="">Release 선택</option>{releases.map(r=><option key={r.id} value={r.id}>v{r.version} · {r.effectiveStatus}</option>)}</select></label><label>Suite<select aria-label="Suite" value={suiteId} onChange={e=>setSuiteId(e.target.value)}><option value="">Suite 선택</option>{suiteOptions.map(s=><option key={s.id} value={s.id}>{s.version} · {s.status} · {s.caseCount} cases</option>)}</select></label><label>Suite ID<input aria-label="Suite ID" value={suiteId} onChange={e=>setSuiteId(e.target.value)} placeholder="READY Test Suite UUID"/></label><label>Mode<select aria-label="Run mode" value={mode} onChange={e=>setMode(e.target.value as TestRun['mode'])}><option>BASELINE</option><option>SEAL_REPLAY</option><option>HELD_OUT</option><option>REGRESSION</option></select></label><label>Contract Version ID<input value={contractVersionId} onChange={e=>setContractVersionId(e.target.value)} placeholder="선택"/></label><label>Case IDs<input value={caseIds} onChange={e=>setCaseIds(e.target.value)} placeholder="비우면 Suite 전체"/></label><label>Random seed<input type="number" value={randomSeed} onChange={e=>setRandomSeed(e.target.value)}/></label><button className="primary-button" disabled={!canStartRun} onClick={()=>void start()}>실행 시작</button></div><p className="file-hint">READY 상태의 Suite만 실행할 수 있습니다. DRAFT/INVALID suite는 시작 전 검증이 필요합니다.</p></section>
    <section className="panel run-picker"><div className="execution-form"><label>Run mode filter<select aria-label="Run mode filter" value={runModeFilter} onChange={e=>setRunModeFilter(e.target.value as TestRun['mode'] | '')}><option value="">전체</option><option value="BASELINE">BASELINE</option><option value="SEAL_REPLAY">SEAL_REPLAY</option><option value="HELD_OUT">HELD_OUT</option><option value="REGRESSION">REGRESSION</option></select></label><label>Run status filter<select aria-label="Run status filter" value={runStatusFilter} onChange={e=>setRunStatusFilter(e.target.value)}><option value="">전체</option><option value="QUEUED">QUEUED</option><option value="RUNNING">RUNNING</option><option value="COMPLETED">COMPLETED</option><option value="FAILED">FAILED</option><option value="CANCELED">CANCELED</option></select></label><button className="secondary-button" type="button" onClick={()=>void refreshRunList()}>목록 새로고침</button></div><label>최근 Run<select aria-label="Run list" value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Run 선택</option>{runOptions.map(r=><option key={r.id} value={r.id}>{r.mode} · {r.status} · {r.completedCases}/{r.totalCases}</option>)}</select></label><label>생성된 Test Run ID<input aria-label="Test Run ID" value={runId} onChange={e=>setRunId(e.target.value)} placeholder="UUID를 입력하세요"/></label><button className="primary-button" disabled={!runId.trim()||busy} onClick={()=>void inspect()}>Run 조회</button></section>
    <div className="attack-grid">{attacks.map(([id,title])=><article className="panel" key={id}><span>{id}</span><h2>{title}</h2></article>)}</div>
    {busy&&!run?<LoadingBlock label="Run evidence를 불러오는 중"/>:!run?<EmptyState title="Test Run을 선택하세요">B 실행부가 생성한 Run ID로 상태, Trace, Oracle, Finding을 함께 조회합니다.</EmptyState>:<><section className="run-summary"><article className="panel"><span>Status</span><strong className={`status status--${tone(run.status)}`}>{run.status}</strong></article><article className="panel"><span>Progress</span><strong>{run.completedCases}/{run.totalCases}</strong></article><article className="panel"><span>Mode</span><strong>{run.mode}</strong></article><article className="panel"><span>Errors</span><strong>{run.operationalErrorCount}</strong></article><article className="panel"><span>Event chain</span><strong className={`status status--${chain?.valid?'positive':'critical'}`}>{chain?.valid?'VALID':'INVALID'}</strong></article></section>
      <div className="content-grid execution-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRACE TIMELINE</p><h2>{events.length} execution events</h2></div><ShortHash value={chain?.headHash??run.eventHeadHash}/></div><div className="event-list">{events.map(e=><details key={e.eventId}><summary><span>#{e.sequence}</span><strong>{e.eventType}</strong><em>{e.toolName??e.reasonCode??''}</em><time>{formatDate(e.occurredAt)}</time></summary><pre>{JSON.stringify({input:e.input,policyDecision:e.policyDecision,output:e.output,metadata:e.metadata,eventHash:e.eventHash},null,2)}</pre></details>)}</div></section>
      <aside className="execution-side"><ResultList title="ORACLE RESULTS" items={oracles.map(o=>({id:o.id,title:o.oracleType,status:o.outcome,note:o.reasonCode}))}/><ResultList title="FINDINGS" items={findings.map(f=>({id:f.id,title:`${f.category} · ${f.title}`,status:f.status,note:f.severity}))}/></aside></div></>}</>}

function ResultList({title,items}:{title:string;items:Array<{id:string;title:string;status:string;note:string}>}){return <section className="panel"><p className="eyebrow">{title}</p><h2>{items.length} results</h2>{items.length?items.map(i=><div className="compact-result" key={i.id}><strong>{i.title}</strong><span className={`status status--${tone(i.status)}`}>{i.status}</span><small>{i.note}</small></div>):<p className="muted">결과가 없습니다.</p>}</section>}
