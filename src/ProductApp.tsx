import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Agent, Release } from './api/contracts'
import { api } from './api/client'
import { ErrorBanner, LoadingBlock, PageHeader } from './components/Primitives'
import { Badge, Brand, Modal, Notice } from './components/Product'
import { AgentsPage, ReleasesPage } from './features/AgentsReleases'
import { AuditPage } from './features/Audit'
import { EvidencePage } from './features/Evidence'
import { ExecutionPage } from './features/Execution'
import { FindingsPage as LiveFindingsPage } from './features/Findings'
import { AssurancePage } from './features/Assurance'
import { RecoveryPage } from './features/Recovery'
import { createDemoPlatform, DEMO_RELEASE_ID, demoManifest } from './demo/platform'
import { ReleaseInventory, StartPage, WorkspacePage } from './product/EntryPages'
import { ChangedPage, FindingDetail, FindingsPage, GatewayPage, PoliciesPage, PolicyDetail, ReleaseContext, ReleaseOverview, ReplayPage, ReportPage, ReportsPage, RunsPage, StatesPage, TracePage, VerificationPage } from './product/VerificationPages'
import { mainNavigation, navigationParent, pageLabels, readRoute, useDemoWorkflow, type Mode, type Page } from './product/model'

export default function App() {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => { const sync = () => setRoute(readRoute()); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync) }, [])
  const go = useCallback((mode: Mode, page: Page) => { window.location.hash = `/${mode}/${page}`; setRoute({ mode, page }) }, [])
  return <ProductApp key={route.mode} mode={route.mode} page={route.page} go={go} />
}
const detailPages: Page[] = ['release','trace','finding','policy','gateway','replay','verification','report']
const livePages: Page[] = ['start','overview','agents','releases','manifest','evidence','audit','recovery','reports','runs','trace','findings','verification','report']
const detailTitles: Partial<Record<Page, [string,string]>> = {
  release: ['이 에이전트는 어디까지 허용되나요?','대출서류 검토의 업무 경계와 검증 구성을 먼저 확인하세요.'],
  trace: ['공격은 어디서 실제 행동이 됐나요?','도구 제안, 정책 판단, API 응답, 실제 영향을 순서대로 확인합니다.'],
  finding: ['타 고객 정보가 실제로 전달됐습니다.','위반 규칙과 실행 증거를 확인하고 개선 후보를 검토하세요.'],
  policy: ['안전 정책을 검토하고 승인하세요.','실행 맥락의 경계를 규칙으로 정의하고 정상업무 영향까지 확인합니다.'],
  gateway: ['어떤 요청이 차단되고 허용됐나요?','도구 호출 의도와 정책 판단, 실제 API 결과를 분리합니다.'],
  replay: ['정책 적용 전후, 무엇이 달라졌나요?','같은 조건에서 정책만 바꾸고 위험 행동과 정상업무를 함께 비교합니다.'],
  verification: ['새 공격과 정상업무도 확인합니다.','Held-out과 정상업무 검증으로 남은 위험과 오차단을 확인합니다.'],
  report: ['출시 판단의 근거를 확인하세요.','검증 범위, 실제 영향, 남은 위험을 내부 평가 보고서로 연결합니다.'],
}
function ProductApp({ mode, page, go }: { mode: Mode; page: Page; go: (mode: Mode, page: Page) => void }) {
  const simulated = mode === 'demo'
  const preview = useMemo(createDemoPlatform, [])
  const client = simulated ? preview : api
  const workflow = useDemoWorkflow()
  const [actorId, setActorId] = useState(simulated ? 'reviewer-demo' : import.meta.env.VITE_FINSEC_ACTOR_ID ?? 'role-a-console')
  const [actorDraft, setActorDraft] = useState(actorId)
  const [agents, setAgents] = useState<Agent[]>([])
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [selectedReleaseId, setSelectedReleaseId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<unknown>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const requestVersion = useRef(0)
  const mainRef = useRef<HTMLElement>(null)
  const navigate = useCallback((next: Page) => { go(mode, next); setMenuOpen(false) }, [go, mode])
  const reload = useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true); setError(undefined)
    try {
      const inventory = await client.listAgents(actorId)
      const groups = await Promise.all(inventory.map(a => client.listReleases(a.id, actorId)))
      if (version !== requestVersion.current) return
      setAgents(inventory); setReleases(groups.flat().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))); setLoaded(true)
    } catch (cause) { if (version === requestVersion.current) setError(cause) }
    finally { if (version === requestVersion.current) setLoading(false) }
  }, [actorId, client])
  useEffect(() => { void reload(); return () => { requestVersion.current++ } }, [reload])
  useEffect(() => { preview.setReportReady(workflow.phase === 'complete') }, [preview, workflow.phase])
  useEffect(() => { document.title = `${pageLabels[page]} · FINAgent SEAL`; mainRef.current?.focus(); window.scrollTo?.({ top: 0 }) }, [page])
  useEffect(() => { if (!menuOpen) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [menuOpen])
  function start() { if (!simulated) { go('demo','start'); return } workflow.start(); navigate('trace') }
  function body() {
    if (!simulated && !livePages.includes(page)) return <><PageHeader eyebrow="INTEGRATION STATUS" title={pageLabels[page]} description="현재 프론트에 이 기능의 실행 API는 연결되지 않았습니다." /><Notice title="실제 데이터와 합성 결과를 섞지 않습니다.">등록·Manifest·Fingerprint·증적·감사·복구 API는 사용 가능합니다. 실행·위험·판정 API는 각 메뉴에서 사용하고, 정책 승인 체험은 샘플 모드에서 확인하세요.<div className="button-row section-gap"><button className="primary-button" onClick={() => go('demo',page)}>이 화면을 샘플 모드로 보기</button><button className="secondary-button" onClick={() => navigate('releases')}>실제 릴리스 관리</button></div></Notice></>
    if (!simulated && (page === 'runs' || page === 'trace')) return <ExecutionPage releases={releases} actorId={actorId} />
    if (!simulated && page === 'findings') return <LiveFindingsPage releases={releases} actorId={actorId} preferredReleaseId={selectedReleaseId} onReleaseChange={setSelectedReleaseId} />
    if (!simulated && ['reports','report','verification'].includes(page)) return <AssurancePage releases={releases} actorId={actorId} preferredReleaseId={selectedReleaseId} onReleaseChange={setSelectedReleaseId} />
    if (page === 'start') return <StartPage navigate={navigate} start={start} simulated={simulated} />
    if (page === 'overview') return <WorkspacePage agents={agents} releases={releases} navigate={navigate} workflow={workflow} simulated={simulated} start={start} />
    if (page === 'agents') return <AgentsPage agents={agents} actorId={actorId} client={client} onChanged={reload} onSelect={agent => { setSelectedAgent(agent); navigate('releases') }} />
    if (page === 'releases') return <ReleaseInventory releases={releases} agents={agents} navigate={navigate} simulated={simulated} selectAgent={setSelectedAgent} />
    if (page === 'manifest') return <>{simulated && <Notice title="체험용 기본 구조 검사 · 실제 strict schema 검증 아님" tone="amber">아래 값은 UI 체험용이며 실제 hash 계산·보안 검증을 수행하지 않습니다.<details className="section-gap"><summary>붙여넣을 샘플 JSON</summary><pre className="code-block">{demoManifest}</pre></details></Notice>}<ReleasesPage agents={agents} actorId={actorId} initialAgent={selectedAgent} onReleaseSelect={release => setSelectedReleaseId(release.id)} client={client} onReleaseInventory={(items, agentId) => setReleases(current => [...current.filter(r => r.agentId !== agentId), ...items])} /></>
    if (page === 'evidence') return <>{simulated && <Notice title="샘플 증거 조회">v1.2.0은 추가 검증 후 조회할 수 있습니다. v1.1.0은 과거 증적입니다. <button className="text-button" onClick={() => navigate('changed')}>구성 변경 비교 →</button></Notice>}<EvidencePage releases={releases} actorId={actorId} client={client} simulated={simulated} /></>
    if (page === 'audit') return <>{simulated && <Notice title="샘플 감사 리소스">Resource type: AGENT_RELEASE<br /><code>{DEMO_RELEASE_ID}</code></Notice>}<AuditPage actorId={actorId} client={client} /></>
    if (page === 'recovery') return <RecoveryPage actorId={actorId} onActorChange={actor => { setActorId(actor); setActorDraft(actor) }} client={client} simulated={simulated} />
    const props = { navigate, workflow }
    const pages: Partial<Record<Page, ReactNode>> = { release: <ReleaseOverview {...props} />, runs: <RunsPage {...props} />, trace: <TracePage {...props} />, findings: <FindingsPage {...props} />, finding: <FindingDetail {...props} />, policies: <PoliciesPage {...props} />, policy: <PolicyDetail {...props} />, gateway: <GatewayPage {...props} />, replay: <ReplayPage {...props} />, verification: <VerificationPage {...props} />, reports: <ReportsPage {...props} />, report: <ReportPage {...props} />, changed: <ChangedPage navigate={navigate} />, states: <StatesPage {...props} /> }
    return pages[page]
  }
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); mainRef.current?.focus() }}>본문으로 건너뛰기</a>
    <button className="mobile-menu" aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'} aria-expanded={menuOpen} aria-controls="main-sidebar" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? '×' : '☰'}</button>
    {menuOpen && <button className="menu-backdrop" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />}
    <aside id="main-sidebar" className={`sidebar${menuOpen ? ' sidebar--open' : ''}`}><button className="brand-home" onClick={() => navigate('start')} aria-label="FINAgent SEAL 홈"><Brand /></button><p className="brand-caption">금융 AI Agent 보안 검증 플랫폼</p><p className="nav-label">WORKSPACE</p><nav aria-label="주요 메뉴">{mainNavigation.map((target, i) => <div key={target} className={i === 8 ? 'nav-group-divider' : ''}><button className={`nav-item${navigationParent(page) === target ? ' nav-item--active' : ''}`} aria-current={navigationParent(page) === target ? 'page' : undefined} onClick={() => navigate(target)}>{pageLabels[target]}{target === 'recovery' && <span className="nav-tag">OPS</span>}</button></div>)}</nav><div className="sidebar-footer"><strong>출시 전 보안 검증</strong><p>합성 데이터 · Sandbox<br />실제 거래·대출 결정 없음</p><span>FINANCE × AI × SECURITY</span></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><span>FINAgent SEAL</span><b>/</b><strong>{pageLabels[page]}</strong></div><div className="topbar-actions"><Badge tone={simulated ? 'blue' : 'amber'}>{simulated ? 'SIMULATED · 합성 체험' : 'LIVE_API · API 모드'}</Badge><button className="mode-button" onClick={() => setModeOpen(true)}>환경 설정</button><button className="icon-button" aria-label="데이터 새로고침" disabled={loading} onClick={() => void reload()}>↻</button></div></header>
      <main id="main-content" ref={mainRef} tabIndex={-1}>
        {simulated && page !== 'start' && <div className="mode-caption">합성 UI 체험 · 실제 Agent/LLM/API를 실행하지 않습니다. 입력은 새로고침 시 사라집니다.</div>}
        {!simulated && <div className="mode-caption">서버 연결 · 실제 등록·분석·복구 요청이 전송됩니다. Actor 헤더는 인증 수단을 대신하지 않습니다.</div>}
        <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
        {loading && !loaded ? <LoadingBlock label="워크스페이스 정보를 불러오는 중" /> : !loaded && !simulated && !['start','audit','recovery'].includes(page) ? <Notice title="API 연결을 확인해 주세요." tone="amber">서버에 연결되지 않아 실제 inventory를 표시할 수 없습니다.<button className="text-button" onClick={() => go('demo','start')}>샘플 모드로 보기 →</button></Notice> : <>
          {loading && loaded && <div className="refresh-status" role="status">기존 정보를 유지하며 갱신 중…</div>}
          {simulated && detailPages.includes(page) && <><PageHeader eyebrow="RELEASE VERIFICATION" title={detailTitles[page]![0]} description={detailTitles[page]![1]} /><ReleaseContext page={page} navigate={navigate} workflow={workflow} reset={() => setResetOpen(true)} /></>}
          <div key={page}>{body()}</div>
        </>}
        <footer className="page-footer"><span>정의된 합성 시험 범위의 내부 평가입니다. 공식 인증 또는 모든 취약점의 부재를 보장하지 않습니다.</span><span>Internal assessment. Not official certification.</span></footer>
      </main>
    </div>
    {resetOpen && <Modal title="이 데모를 초기 상태로 돌릴까요?" onClose={() => setResetOpen(false)}><p>고정된 샘플 Release v1.2.0의 실행·정책 승인·보고서 표시만 초기화합니다. 직접 등록한 에이전트와 다른 서버의 데이터는 변경하지 않습니다.</p><Notice title="Fixture · fixture-demo-v1 / digest f1…">원본 합성 fixture는 보존됩니다. 서버 요청은 전송하지 않습니다.</Notice>{workflow.active && <Notice title="활성 실행이 있어 초기화할 수 없습니다." tone="amber">{workflow.progress} / 40 trials. 실행을 취소하거나 완료를 기다려 주세요.</Notice>}<div className="form-actions"><button className="secondary-button" onClick={() => setResetOpen(false)}>돌아가기</button><button className="danger-button" disabled={workflow.active} onClick={() => { workflow.reset(); setResetOpen(false); navigate('release') }}>샘플 검증 초기화</button></div></Modal>}
    {modeOpen && <Modal title="워크스페이스 환경 설정" onClose={() => setModeOpen(false)}><Notice title={simulated ? '현재: SIMULATED' : '현재: LIVE_API'} tone={simulated ? 'blue' : 'amber'}>{simulated ? '실제 네트워크 요청 없이 모든 UI를 체험합니다. 실제 비밀키·고객정보를 입력하지 마세요.' : '등록·분석·실행·위험 검토·판정·복구는 실제 백엔드에 전송됩니다. 정책 승인 체험은 샘플 모드에서 제공합니다.'}</Notice>
      {!simulated && <form onSubmit={e => { e.preventDefault(); setActorId(actorDraft); setModeOpen(false) }} className="stack section-gap"><label>API actor ID<input value={actorDraft} onChange={e => setActorDraft(e.target.value)} required /></label><button className="secondary-button">Actor 적용</button></form>}
      <p className="muted section-gap">모드를 전환하면 현재 체험 상태와 미저장 입력이 초기화됩니다.</p><div className="form-actions"><button className="secondary-button" onClick={() => setModeOpen(false)}>닫기</button><button className="primary-button" onClick={() => { setModeOpen(false); go(simulated ? 'live' : 'demo', simulated ? 'overview' : 'start') }}>{simulated ? '실제 API 연결 모드로' : '샘플 체험 모드로'}</button></div></Modal>}
  </div>
}
