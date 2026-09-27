import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { api, FinsecApiError, RunStartError } from '../api/client'
import type { EventChainVerification, ExecutionEvent, Finding, OracleResult, Release, ReplayComparison, TestRun, TestRunStart, TestRunSummary, TestSuiteSummary } from '../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, ShortHash, formatDate } from '../components/Primitives'
import { readReviewerSessionCredential, type ReviewerSession } from './policy/reviewerSession'

const attacks = [['FA-01','악성 문서 지시'],['FA-02','타 고객 데이터 조회'],['FA-03','민감정보 과다 조회'],['FA-04','외부 정보 유출'],['FA-05','고위험 상태 변경']]
const tone = (value:string) => ['COMPLETED','ATTACK_BLOCKED','NORMAL_SUCCESS','OPEN'].includes(value) ? 'positive' : ['FAILED','ERROR','ATTACK_SUCCESS','BLOCKED'].includes(value) ? 'critical' : 'warning'
const activeRunStatuses = new Set(['QUEUED', 'PREPARING', 'RUNNING', 'CANCELLING'])
const streamBaseUrl = import.meta.env.VITE_FINSEC_API_BASE_URL ?? 'http://localhost:8080'
const secureRunSessionApi = (() => {
  try { return new URL(streamBaseUrl, globalThis.location?.origin).protocol === 'https:' }
  catch { return false }
})()

type RunStartAttempt = { readonly input: TestRunStart; readonly key: string; readonly actorId: string; readonly workspaceId: string }

function currentRunReviewer(session: ReviewerSession | null): ReviewerSession | null {
  if (!session) return null
  try { readReviewerSessionCredential(session); return session }
  catch { return null }
}

export function ExecutionPage({ releases, actorId }: { releases:Release[]; actorId:string }) {
  const [releaseId,setReleaseId]=useState(releases[0]?.id??''); const [runId,setRunId]=useState('')
  const [suiteOptions,setSuiteOptions]=useState<TestSuiteSummary[]>([]); const [runOptions,setRunOptions]=useState<TestRunSummary[]>([]); const [replayComparisons,setReplayComparisons]=useState<ReplayComparison[]>([])
  const [suiteId,setSuiteId]=useState(''); const [mode,setMode]=useState<TestRun['mode']>('BASELINE'); const [runModeFilter,setRunModeFilter]=useState<TestRun['mode'] | ''>(''); const [runStatusFilter,setRunStatusFilter]=useState(''); const [contractVersionId,setContractVersionId]=useState(''); const [caseIds,setCaseIds]=useState(''); const [randomSeed,setRandomSeed]=useState('42'); const [receipt,setReceipt]=useState('')
  const [run,setRun]=useState<TestRun|null>(null); const [events,setEvents]=useState<ExecutionEvent[]>([])
  const [chain,setChain]=useState<EventChainVerification|null>(null); const [oracles,setOracles]=useState<OracleResult[]>([]); const [findings,setFindings]=useState<Finding[]>([])
  const [oracleOutcomeFilter,setOracleOutcomeFilter]=useState(''); const [findingCategoryFilter,setFindingCategoryFilter]=useState(''); const [findingSeverityFilter,setFindingSeverityFilter]=useState(''); const [findingStatusFilter,setFindingStatusFilter]=useState('')
  const [streamState, setStreamState] = useState<'IDLE' | 'CONNECTING' | 'LIVE' | 'POLLING'>('IDLE')
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const [busy,setBusy]=useState(false); const [error,setError]=useState<unknown>()
  const [reviewerKey,setReviewerKey]=useState('')
  const [reviewerSession,setReviewerSession]=useState<ReviewerSession|null>(null)
  const [reviewerError,setReviewerError]=useState<unknown>()
  const [connectingReviewer,setConnectingReviewer]=useState(false)
  const [unknownStart,setUnknownStart]=useState<RunStartAttempt|null>(null)
  const reviewerConnectionRef=useRef(0)
  const reviewerConnectingRef=useRef(false)
  const aliveRef=useRef(true)
  const startFlightRef=useRef(false)
  const streamRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const generationRef = useRef(0)
  const feedRunRef = useRef('')
  const cursorRef = useRef(0)
  const eventIdsRef = useRef(new Map<number, string>())
  const pendingRef = useRef(new Map<number, ExecutionEvent>())
  const recoveryRef = useRef<Promise<void> | null>(null)
  const selectedSuite = suiteOptions.find((suite) => suite.id === suiteId)
  const currentReviewer = currentRunReviewer(reviewerSession)
  const canStartRun = !!releaseId && !!suiteId.trim() && selectedSuite?.status === 'READY'
    && !!currentReviewer && !busy && !connectingReviewer && !unknownStart
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
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  function isCurrent(id: string, generation: number) {
    return feedRunRef.current === id && generationRef.current === generation
  }

  function appendContiguous(id: string, generation: number, incoming: ExecutionEvent[]) {
    if (!isCurrent(id, generation)) return
    const accepted: ExecutionEvent[] = []
    const nextIds = new Map(eventIdsRef.current)
    const nextPending = new Map(pendingRef.current)
    const knownIds = new Set(nextIds.values())
    let nextCursor = cursorRef.current
    const accept = (event: ExecutionEvent) => {
      if (event.runId !== id || !Number.isSafeInteger(event.sequence) || event.sequence < 1
        || !event.eventId || typeof event.eventId !== 'string') {
        throw new Error('Run event is invalid')
      }
      if (event.sequence <= nextCursor) {
        const existing = nextIds.get(event.sequence)
        if (existing && existing !== event.eventId) throw new Error('Run event identity changed')
        return
      }
      if (event.sequence !== nextCursor + 1 || knownIds.has(event.eventId)) {
        throw new Error('Run event sequence is incomplete')
      }
      nextCursor = event.sequence
      nextIds.set(event.sequence, event.eventId)
      knownIds.add(event.eventId)
      nextPending.delete(event.sequence)
      accepted.push(event)
    }
    incoming.forEach(accept)
    while (nextPending.has(nextCursor + 1)) {
      accept(nextPending.get(nextCursor + 1)!)
    }
    cursorRef.current = nextCursor
    eventIdsRef.current = nextIds
    pendingRef.current = nextPending
    if (accepted.length) setEvents((current) => [...current, ...accepted])
  }

  async function refreshRunSnapshot(targetRunId: string, generation: number) {
    try {
      const [nextRun, nextChain] = await Promise.all([
        api.testRun(targetRunId, actorId),
        api.verifyEventChain(targetRunId, actorId),
      ])
      if (!isCurrent(targetRunId, generation)) return
      setRun(nextRun)
      setChain(nextChain)
      if (!activeRunStatuses.has(nextRun.status)) {
        closeStream()
        setStreamState('IDLE')
      }
    } catch {
      if (isCurrent(targetRunId, generation)) startPolling(targetRunId, generation)
    }
  }

  function startPolling(targetRunId: string, generation: number) {
    if (!isCurrent(targetRunId, generation)) return
    setStreamState('POLLING')
    if (pollRef.current) return
    pollRef.current = setInterval(() => {
      void synchronize(targetRunId, generation, true)
    }, 2000)
  }

  function synchronize(targetRunId: string, generation: number, refreshSnapshot: boolean) {
    if (!isCurrent(targetRunId, generation) || recoveryRef.current) return recoveryRef.current
    const recovery = (async () => {
      let snapshot: TestRun | null = null
      try {
        if (refreshSnapshot) {
          snapshot = await api.testRun(targetRunId, actorId)
          if (!isCurrent(targetRunId, generation)) return
          setRun(snapshot)
        }
        const history = await api.eventHistory(targetRunId, actorId, cursorRef.current)
        if (!isCurrent(targetRunId, generation)) return
        appendContiguous(targetRunId, generation, history.items)
        if (history.headSequence > cursorRef.current) {
          throw new Error('Run event history did not reach its head')
        }
        if (snapshot && !activeRunStatuses.has(snapshot.status)) {
          closeStream()
          setStreamState('IDLE')
        } else if (streamRef.current === null) {
          openStream(targetRunId, generation)
        }
      } catch (cause) {
        if (!isCurrent(targetRunId, generation)) return
        if (cause instanceof FinsecApiError && cause.status === 410 && cause.code === 'STREAM_CURSOR_EXPIRED') {
          try {
            snapshot ??= await api.testRun(targetRunId, actorId)
            if (!isCurrent(targetRunId, generation)) return
            if (!Number.isSafeInteger(snapshot.latestSequence) || snapshot.latestSequence < 0) {
              throw new Error('Run snapshot cursor is invalid')
            }
            setRun(snapshot)
            setEvents([])
            setHistoryUnavailable(true)
            cursorRef.current = snapshot.latestSequence
            eventIdsRef.current.clear()
            pendingRef.current.clear()
            if (streamRef.current) {
              streamRef.current.close()
              streamRef.current = null
            }
            if (activeRunStatuses.has(snapshot.status)) openStream(targetRunId, generation)
            else { closeStream(); setStreamState('IDLE') }
            return
          } catch {
            // The polling fallback will retry a failed snapshot read.
          }
        }
        if (streamRef.current) {
          streamRef.current.close()
          streamRef.current = null
        }
        startPolling(targetRunId, generation)
      }
    })()
    recoveryRef.current = recovery
    void recovery.finally(() => {
      if (recoveryRef.current === recovery) recoveryRef.current = null
    })
    return recovery
  }

  function openStream(targetRunId: string, generation: number) {
    if (!isCurrent(targetRunId, generation)) return
    if (streamRef.current) streamRef.current.close()
    setStreamState('CONNECTING')
    const stream = new EventSource(`${streamBaseUrl}/api/v1/test-runs/${encodeURIComponent(targetRunId)}/events?after=${cursorRef.current}`)
    streamRef.current = stream
    const onEvent = (event: MessageEvent) => {
      if (!isCurrent(targetRunId, generation) || streamRef.current !== stream) return
      try {
        const parsed = JSON.parse(event.data) as ExecutionEvent
        if (parsed.runId !== targetRunId || !Number.isSafeInteger(parsed.sequence)
          || parsed.sequence < 1 || event.lastEventId !== String(parsed.sequence)
          || typeof parsed.eventId !== 'string' || !parsed.eventId) {
          throw new Error('Run stream event is invalid')
        }
        if (parsed.sequence <= cursorRef.current) {
          appendContiguous(targetRunId, generation, [parsed])
          return
        }
        const pending = pendingRef.current.get(parsed.sequence)
        if (pending && pending.eventId !== parsed.eventId) throw new Error('Run event identity changed')
        if (!pending) pendingRef.current.set(parsed.sequence, parsed)
        let repair: Promise<void> | null = null
        if (recoveryRef.current === null) {
          if (parsed.sequence === cursorRef.current + 1) appendContiguous(targetRunId, generation, [])
          else repair = synchronize(targetRunId, generation, false)
        }
        if (parsed.eventType === 'RUN_COMPLETED' || parsed.eventType === 'RUN_FAILED') {
          const pendingRepair = repair ?? recoveryRef.current
          if (pendingRepair) {
            void pendingRepair.then(() => {
              if (isCurrent(targetRunId, generation) && pendingRef.current.size === 0) {
                void refreshRunSnapshot(targetRunId, generation)
              }
            })
          } else {
            void refreshRunSnapshot(targetRunId, generation)
          }
        }
      } catch {
        stream.close()
        if (streamRef.current === stream) streamRef.current = null
        startPolling(targetRunId, generation)
      }
    }
    stream.onopen = () => {
      if (!isCurrent(targetRunId, generation) || streamRef.current !== stream) return
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      setStreamState('LIVE')
    }
    stream.onerror = () => {
      if (!isCurrent(targetRunId, generation) || streamRef.current !== stream) return
      stream.close()
      streamRef.current = null
      startPolling(targetRunId, generation)
    }
    stream.addEventListener('trace.event', onEvent as EventListener)
    stream.addEventListener('run.status', onEvent as EventListener)
    stream.addEventListener('run.completed', onEvent as EventListener)
    stream.addEventListener('finding.created', onEvent as EventListener)
  }

  async function inspectRun(nextRunId: string) {
    if (!nextRunId.trim()) return
    const id = nextRunId.trim()
    const generation = ++generationRef.current
    closeStream()
    feedRunRef.current = id
    recoveryRef.current = null
    cursorRef.current = 0
    eventIdsRef.current.clear()
    pendingRef.current.clear()
    setRunId(id)
    setRun(null)
    setEvents([])
    setHistoryUnavailable(false)
    setStreamState('IDLE')
    setBusy(true)
    setError(undefined)
    try {
      const r = await api.testRun(id, actorId)
      if (!isCurrent(id, generation)) return
      setRun(r)
      const [h, c, o, f] = await Promise.all([
        api.eventHistory(id, actorId).catch((cause: unknown) => {
          if (cause instanceof FinsecApiError && cause.status === 410 && cause.code === 'STREAM_CURSOR_EXPIRED') return null
          throw cause
        }),
        api.verifyEventChain(id, actorId),
        api.runOracleResults(id, actorId),
        api.runFindings(id, actorId),
      ])
      if (!isCurrent(id, generation)) return
      if (h === null) {
        if (!Number.isSafeInteger(r.latestSequence) || r.latestSequence < 0) throw new Error('Run snapshot cursor is invalid')
        cursorRef.current = r.latestSequence
        setHistoryUnavailable(true)
      } else {
        cursorRef.current = h.headSequence
        eventIdsRef.current = new Map(h.items.map((item) => [item.sequence, item.eventId]))
        setEvents(h.items)
      }
      setChain(c)
      setOracles(o)
      setFindings(f)
      if (activeRunStatuses.has(r.status)) {
        openStream(id, generation)
      }
      if (!runOptions.some((item) => item.id === id)) {
        setRunOptions((current) => current)
      }
    } catch (e) {
      if (isCurrent(id, generation)) setError(e)
    } finally {
      if (isCurrent(id, generation)) setBusy(false)
    }
  }

  async function openReplayRun(item: ReplayComparison) {
    setRunId(item.replayRunId)
    await inspectRun(item.replayRunId)
  }

  function selectRelease(nextReleaseId: string) {
    if (nextReleaseId === releaseId) return
    generationRef.current += 1
    feedRunRef.current = ''
    closeStream()
    setStreamState('IDLE')
    setRun(null)
    setRunId('')
    setEvents([])
    setChain(null)
    setOracles([])
    setFindings([])
    setHistoryUnavailable(false)
    setBusy(false)
    setReleaseId(nextReleaseId)
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
      generationRef.current += 1
      feedRunRef.current = ''
      closeStream()
      setStreamState('IDLE')
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

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      reviewerConnectionRef.current += 1
      generationRef.current += 1
      closeStream()
    }
  }, [])

  useEffect(() => {
    if (!reviewerSession) return
    const remaining = reviewerSession.expiresAt * 1000 - Date.now()
    if (remaining <= 0) {
      setReviewerSession(null)
      setReviewerError(new RunStartError('session'))
      return
    }
    const timer = setTimeout(() => {
      setReviewerSession(null)
      setReviewerError(new RunStartError('session'))
    }, Math.min(remaining, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [reviewerSession])

  async function connectReviewer(withKey: boolean) {
    if (reviewerConnectingRef.current || startFlightRef.current) return
    const key = withKey ? reviewerKey : undefined
    if (withKey && !key) return
    reviewerConnectingRef.current = true
    setReviewerKey('')
    setReviewerError(undefined)
    setConnectingReviewer(true)
    const generation = ++reviewerConnectionRef.current
    try {
      const session = await api.connectRunReviewerSession(key)
      if (!aliveRef.current || generation !== reviewerConnectionRef.current) return
      setReviewerSession(session)
    } catch (cause) {
      if (!aliveRef.current || generation !== reviewerConnectionRef.current) return
      setReviewerSession(null)
      setReviewerError(cause)
    } finally {
      reviewerConnectingRef.current = false
      if (aliveRef.current && generation === reviewerConnectionRef.current) setConnectingReviewer(false)
    }
  }

  async function inspect(){ await inspectRun(runId) }
  async function sendStart(attempt: RunStartAttempt, session: ReviewerSession) {
    if (startFlightRef.current || !aliveRef.current) return
    if (attempt.actorId !== session.actorId || attempt.workspaceId !== session.workspaceId) {
      setReviewerError(new RunStartError('session'))
      return
    }
    startFlightRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.startTestRun(attempt.input, session, attempt.key)
      if (!aliveRef.current) return
      setUnknownStart(null)
      setReceipt(`Run ${result.runId} · ${result.status}`)
      await inspectRun(result.runId)
    } catch (cause) {
      if (!aliveRef.current) return
      if (cause instanceof RunStartError) {
        if (cause.kind === 'unknown') {
          setUnknownStart(attempt)
          setError(undefined)
        }
        else if (cause.kind === 'rejected' || cause.kind === 'invalid') setUnknownStart(null)
        if (cause.kind === 'session') {
          setReviewerSession(null)
          setReviewerError(cause)
          setError(undefined)
        } else if (cause.kind !== 'unknown') {
          setError(cause)
        }
      } else setError(cause)
    } finally {
      startFlightRef.current = false
      if (aliveRef.current) setBusy(false)
    }
  }

  async function start(){
    if (unknownStart || startFlightRef.current || !releaseId || !suiteId.trim()) return
    if (selectedSuite?.status !== 'READY') {
      setError(new Error('READY 상태의 Suite만 실행할 수 있습니다.'))
      return
    }
    const session = currentRunReviewer(reviewerSession)
    if (!session) {
      setReviewerSession(null)
      setReviewerError(new RunStartError('session'))
      return
    }
    const input: TestRunStart = {
      releaseId, suiteId: suiteId.trim(), mode, contractVersionId: contractVersionId.trim() || null,
      caseIds: caseIds.split(/[\s,]+/).filter(Boolean), randomSeed: randomSeed ? Number(randomSeed) : null,
    }
    const attempt: RunStartAttempt = { input, key: `test-run-start-${crypto.randomUUID()}`,
      actorId: session.actorId, workspaceId: session.workspaceId }
    setReceipt('')
    await sendStart(attempt, session)
  }

  async function retryUnknownStart() {
    if (!unknownStart) return
    const session = currentRunReviewer(reviewerSession)
    if (!session) {
      setReviewerSession(null)
      setReviewerError(new RunStartError('session'))
      return
    }
    await sendStart(unknownStart, session)
  }
  return <><PageHeader eyebrow="ATTACK EXECUTION" title="Runs & Trace" description="B Runtime이 수행한 공격·Replay 상태와 Policy, Tool, Oracle 이벤트 체인을 추적합니다." />
    {error?<ErrorBanner error={error} onDismiss={()=>setError(undefined)}/>:null}
    {receipt?<div className="success-banner" role="status">{receipt}</div>:null}
    <section className="panel execution-start">
      <div className="panel-heading"><div><p className="eyebrow">NEW TEST RUN</p><h2>공격 및 Replay 실행</h2></div><span className="status status--positive">API CONNECTED</span></div>
      <div className="execution-form">
        <label>Run 검토자 키<input aria-label="Run 검토자 키" type="password" autoComplete="off" value={reviewerKey}
          disabled={connectingReviewer || busy}
          onChange={event => setReviewerKey(event.target.value)} /></label>
        <button className="secondary-button" type="button" disabled={!reviewerKey || connectingReviewer || busy}
          onClick={() => void connectReviewer(true)}>검토자 세션 연결</button>
        <button className="secondary-button" type="button" disabled={connectingReviewer || busy}
          onClick={() => void connectReviewer(false)}>기존 세션 확인</button>
      </div>
      {!secureRunSessionApi ? <p className="file-hint">Run 시작에는 HTTPS API 연결이 필요합니다. 현재 HTTP 설정에서는 검토자 세션을 연결할 수 없습니다.</p> : null}
      {currentReviewer ? <p className="file-hint">확인된 실행 검토자: <strong>{currentReviewer.actorId}</strong></p> : <p className="file-hint">Run을 시작하려면 검토자 세션을 연결해 주세요.</p>}
      <ErrorBanner error={reviewerError} onDismiss={() => setReviewerError(undefined)} />
      {unknownStart ? <div className="error-banner" role="alert"><span aria-hidden="true">!</span><div>
        <strong>이전 실행 요청의 처리 여부가 불명확합니다.</strong>
        <p>Run 기록을 확인하세요. 목록에 보이지 않는 것만으로 미실행을 단정할 수 없습니다. 같은 검토자 세션에서 동일 요청과 idempotency key로만 다시 확인합니다.</p>
        <button className="secondary-button" type="button" disabled={!currentReviewer || busy || connectingReviewer
          || currentReviewer?.actorId !== unknownStart.actorId || currentReviewer?.workspaceId !== unknownStart.workspaceId}
          onClick={() => void retryUnknownStart()}>같은 요청 다시 확인</button>
      </div></div> : null}
      <div className="execution-form">
        <label>Release<select value={releaseId} onChange={e=>selectRelease(e.target.value)}><option value="">Release 선택</option>{releases.map(r=><option key={r.id} value={r.id}>v{r.version} · {r.effectiveStatus}</option>)}</select></label>
        <label>Suite<select aria-label="Suite" value={suiteId} onChange={e=>setSuiteId(e.target.value)}><option value="">Suite 선택</option>{suiteOptions.map(s=><option key={s.id} value={s.id}>{s.version} · {s.status} · {s.caseCount} cases</option>)}</select></label>
        <label>Suite ID<input aria-label="Suite ID" value={suiteId} onChange={e=>setSuiteId(e.target.value)} placeholder="READY Test Suite UUID"/></label>
        <label>Mode<select aria-label="Run mode" value={mode} onChange={e=>setMode(e.target.value as TestRun['mode'])}><option>BASELINE</option><option>SEAL_REPLAY</option><option>HELD_OUT</option><option>REGRESSION</option></select></label>
        <label>Contract Version ID<input value={contractVersionId} onChange={e=>setContractVersionId(e.target.value)} placeholder="선택"/></label>
        <label>Case IDs<input value={caseIds} onChange={e=>setCaseIds(e.target.value)} placeholder="비우면 Suite 전체"/></label>
        <label>Random seed<input type="number" value={randomSeed} onChange={e=>setRandomSeed(e.target.value)}/></label>
        <button className="primary-button" disabled={!canStartRun} onClick={()=>void start()}>실행 시작</button>
      </div>
      <p className="file-hint">READY 상태의 Suite와 검토자 세션이 필요합니다. DRAFT/INVALID suite는 시작 전 검증이 필요합니다.</p>
    </section>
    <section className="panel run-picker"><div className="execution-form"><label>Run mode filter<select aria-label="Run mode filter" value={runModeFilter} onChange={e=>setRunModeFilter(e.target.value as TestRun['mode'] | '')}><option value="">전체</option><option value="BASELINE">BASELINE</option><option value="SEAL_REPLAY">SEAL_REPLAY</option><option value="HELD_OUT">HELD_OUT</option><option value="REGRESSION">REGRESSION</option></select></label><label>Run status filter<select aria-label="Run status filter" value={runStatusFilter} onChange={e=>setRunStatusFilter(e.target.value)}><option value="">전체</option><option value="QUEUED">QUEUED</option><option value="RUNNING">RUNNING</option><option value="COMPLETED">COMPLETED</option><option value="FAILED">FAILED</option><option value="CANCELED">CANCELED</option></select></label><button className="secondary-button" type="button" onClick={()=>void refreshRunList()}>목록 새로고침</button></div><label>최근 Run<select aria-label="Run list" value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Run 선택</option>{runOptions.map(r=><option key={r.id} value={r.id}>{r.mode} · {r.status} · {r.completedCases}/{r.totalCases}</option>)}</select></label><label>생성된 Test Run ID<input aria-label="Test Run ID" value={runId} onChange={e=>setRunId(e.target.value)} placeholder="UUID를 입력하세요"/></label><button className="primary-button" disabled={!runId.trim()||busy} onClick={()=>void inspect()}>Run 조회</button><p className="file-hint">Live stream: {streamState}</p></section>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">REPLAY COMPARABILITY</p><h2>{replayComparisons.length} replay comparisons</h2></div><span className={`status status--${replayComparisons.some((item) => !item.comparable) ? 'warning' : 'positive'}`}>{replayComparisons.some((item) => !item.comparable) ? 'MISMATCHES PRESENT' : 'COMPARABLE'}</span></div>{replayComparisons.length ? <div className="event-list">{replayComparisons.map((item)=><details key={`${item.baselineRunId ?? 'missing'}-${item.replayRunId}`}><summary><strong>{item.category ?? 'UNSPECIFIED'}</strong><em>{item.comparable ? 'Comparable replay' : 'Non-comparable replay'}</em><span className={`status status--${item.comparable ? 'positive' : 'warning'}`}>{item.comparable ? 'COMPARABLE' : 'MISMATCH'}</span></summary><div className="execution-form"><label>Baseline run<input readOnly value={item.baselineRunId ?? 'NO BASELINE'} /></label><label>Replay run<input readOnly value={item.replayRunId} /></label><button className="secondary-button" type="button" onClick={()=>void openReplayRun(item)}>Replay run 열기</button></div><pre>{JSON.stringify({baselineRunId:item.baselineRunId,replayRunId:item.replayRunId,mismatchReasons:item.mismatchReasons},null,2)}</pre></details>)}</div> : <p className="muted">Replay comparison evidence가 아직 없습니다.</p>}</section>
    <div className="attack-grid">{attacks.map(([id,title])=><article className="panel" key={id}><span>{id}</span><h2>{title}</h2></article>)}</div>
    {busy&&!run?<LoadingBlock label="Run evidence를 불러오는 중"/>:!run?<EmptyState title="Test Run을 선택하세요">B 실행부가 생성한 Run ID로 상태, Trace, Oracle, Finding을 함께 조회합니다.</EmptyState>:<><section className="run-summary"><article className="panel"><span>Status</span><strong className={`status status--${tone(run.status)}`}>{run.status}</strong></article><article className="panel"><span>Progress</span><strong>{run.completedCases}/{run.totalCases}</strong></article><article className="panel"><span>Mode</span><strong>{run.mode}</strong></article><article className="panel"><span>Errors</span><strong>{run.operationalErrorCount}</strong></article><article className="panel"><span>Event chain</span><strong className={`status status--${historyUnavailable ? 'warning' : chain?.valid ? 'positive' : 'critical'}`}>{historyUnavailable ? 'N/A' : chain?.valid ? 'VALID' : 'INVALID'}</strong></article></section>
      <div className="content-grid execution-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRACE TIMELINE</p><h2>{events.length} execution events</h2></div><ShortHash value={chain?.headHash??run.eventHeadHash}/></div>{historyUnavailable?<p className="file-hint" role="status">이전 Trace 보존 기간이 지났습니다. 현재 Run snapshot 이후의 이벤트만 표시합니다.</p>:null}<div className="event-list">{events.map(e=><details key={e.eventId}><summary><span>#{e.sequence}</span><strong>{e.eventType}</strong><em>{e.toolName??e.reasonCode??''}</em><time>{formatDate(e.occurredAt)}</time></summary><pre>{JSON.stringify({input:e.input,policyDecision:e.policyDecision,output:e.output,metadata:e.metadata,eventHash:e.eventHash},null,2)}</pre></details>)}</div></section>
      <aside className="execution-side"><ResultList title="ORACLE RESULTS" filters={<label>Outcome<select aria-label="Oracle outcome filter" value={oracleOutcomeFilter} onChange={e=>setOracleOutcomeFilter(e.target.value)}><option value="">전체 outcome</option><option value="ATTACK_SUCCESS">ATTACK_SUCCESS</option><option value="ATTACK_BLOCKED">ATTACK_BLOCKED</option><option value="INCONCLUSIVE">INCONCLUSIVE</option><option value="NORMAL_SUCCESS">NORMAL_SUCCESS</option><option value="NORMAL_FAILURE">NORMAL_FAILURE</option></select></label>} items={filteredOracles.map(o=>({id:o.id,title:o.oracleType,status:o.outcome,note:o.reasonCode}))}/><ResultList title="FINDINGS" filters={<><label>Category<select aria-label="Finding category filter" value={findingCategoryFilter} onChange={e=>setFindingCategoryFilter(e.target.value)}><option value="">전체 category</option>{findingCategories.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>Severity<select aria-label="Finding severity filter" value={findingSeverityFilter} onChange={e=>setFindingSeverityFilter(e.target.value)}><option value="">전체 severity</option>{findingSeverities.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>Status<select aria-label="Finding status filter" value={findingStatusFilter} onChange={e=>setFindingStatusFilter(e.target.value)}><option value="">전체 status</option>{findingStatuses.map(value=><option key={value} value={value}>{value}</option>)}</select></label></>} items={filteredFindings.map(f=>({id:f.id,title:`${f.category} · ${f.title}`,status:f.status,note:f.severity}))}/></aside></div></>}</>}

function ResultList({title,items,filters}:{title:string;items:Array<{id:string;title:string;status:string;note:string}>;filters?:ReactNode}){return <section className="panel"><p className="eyebrow">{title}</p><h2>{items.length} results</h2>{filters?<div className="execution-form execution-result-filters">{filters}</div>:null}{items.length?items.map(i=><div className="compact-result" key={i.id}><strong>{i.title}</strong><span className={`status status--${tone(i.status)}`}>{i.status}</span><small>{i.note}</small></div>):<p className="muted">결과가 없습니다.</p>}</section>}
