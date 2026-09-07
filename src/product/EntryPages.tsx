import { useState } from 'react'
import type { Agent, Release } from '../api/contracts'
import { EmptyState, PageHeader, StatusBadge, ShortHash, formatDate } from '../components/Primitives'
import { Badge, DataTable, Notice, Panel, Progress, Stat } from '../components/Product'
import { DEMO_RELEASE_ID } from '../demo/platform'
import type { Navigate, Workflow } from './model'

export function StartPage({ navigate, start, simulated }: { navigate: Navigate; start: () => void; simulated: boolean }) {
  return <>
    <section className="start-hero"><div><p className="eyebrow">SECURITY EVALUATION FOR AGENT LAUNCH</p><h1>에이전트의 위험한 행동,<br /><em>출시 전에 확인하세요.</em></h1><p className="hero-description">개발한 에이전트에 공격과 규칙 위반 상황을 시험하고,<br className="desktop-break" /> 안전 정책의 효과까지 실행 증거로 확인합니다.</p><div className="button-row"><button className="primary-button" onClick={start}>{simulated ? '샘플 검증 체험 →' : '샘플 체험 모드로 →'}</button><button className="secondary-button" onClick={() => navigate('agents')}>내 에이전트 등록</button></div><p className="muted hero-hint">Agent 정보 + Manifest JSON · 실제 고객정보는 사용하지 않습니다.</p></div>
      <aside className="panel hero-agent"><Badge>검증 대상 예시</Badge><div className="hero-agent-symbol" aria-hidden="true"><img src="/assets/brand-reference.png" alt="" width="1905" height="825" /></div><h2>대출서류 검토 Agent</h2><p>문서를 읽고 고객정보를 조회하는<br />에이전트의 권한 경계를 시험합니다.</p><div className="hero-agent-bottom"><strong>이 Agent가 규칙을 어기면?</strong><p>위험 발견 → 정책 검토 → 재시험</p></div><small>대출 승인·실거래를 수행하지 않습니다.</small></aside>
    </section>
    <section className="journey-grid" aria-label="검증 서비스 이용 순서">{[['대상 준비','구성과 허용할 업무를 확인합니다.'],['공격 시험','문서 속 공격과 규칙 위반을 시험합니다.'],['위험 확인','실제 노출된 정보와 영향을 확인합니다.'],['정책 승인 · 재검증','사람이 승인한 뒤 다시 시험합니다.']].map(([title, text], i) => <article className="panel" key={title}><span className="journey-number">0{i + 1}</span><h2>{title}</h2><p>{text}</p></article>)}</section>
    <div className="content-grid"><Panel title="어떤 위험을 검증하나요?" description="답변뿐 아니라 도구 실행과 실제 영향을 확인합니다.">{[['타 고객 정보 접근','현재 신청자가 아닌 다른 고객의 정보를 조회하는 행동'],['민감정보 과다 노출','업무에 필요하지 않은 계좌·개인정보까지 전달하는 행동'],['허용되지 않은 실행','외부 반출이나 사람에게만 허용된 업무 상태를 변경하는 행동']].map(([title, text], i) => <div className={`risk-type tone-${['purple','blue','amber'][i]}`} key={title}><i /><div><h3>{title}</h3><p>{text}</p></div></div>)}</Panel>
      <Panel title="검증하면 무엇이 남나요?" description="발견부터 개선 확인까지, 실행 근거로 연결합니다." className="deliverables"><ol><li>발견한 위험과 실행 근거</li><li>정책 적용 전·후 비교</li><li>정상업무 유지 결과</li></ol><Notice title="내부 평가 · 공식 인증 아님">정의된 합성 시험 범위에서의 검증입니다.</Notice><button className="text-button" onClick={() => navigate('overview')}>검증 워크스페이스 둘러보기 →</button></Panel></div>
  </>
}

export function WorkspacePage({ agents, releases, navigate, workflow: w, simulated, start }: { agents: Agent[]; releases: Release[]; navigate: Navigate; workflow: Workflow; simulated: boolean; start: () => void }) {
  return <><PageHeader eyebrow="WORKSPACE" title="검증 워크스페이스" description="에이전트의 검증 상태와 지금 확인할 위험을 한곳에서 봅니다." actions={<button className="primary-button" onClick={start}>샘플 검증 시작 →</button>} />
    <div className="metric-grid"><Stat label="등록 에이전트" value={agents.length} detail={simulated ? '합성 데모 inventory' : 'API 조회 결과'} /><Stat label="릴리스 버전" value={releases.length} detail="고정된 구성과 변경 이력" /><Stat label="진행 중 실행" value={simulated ? (w.active ? 1 : 0) : 'N/A'} detail={simulated ? '샘플 실행 상태' : '실행 집계 미연결'} /><Stat label="미해결 HIGH" value={simulated && w.hasBaseline ? 2 : 'N/A'} detail="판정이 아닌 검토 대상" tone="red" /></div>
    <div className="content-grid"><Panel title="이어서 검토할 릴리스" description="지금 필요한 행동을 상태와 함께 표시합니다." className="continue-card">
      {simulated ? <><h3>대출서류 검토 Agent <span>· v1.2.0</span></h3><Badge tone="amber">{w.hasBaseline ? '위험 근거 확인' : '기본 공격 시험 필요'}</Badge><p>{w.hasBaseline ? '합성 문서 공격에서 타 고객 레코드 2건이 반환되었습니다. 실행 근거를 검토하고 안전 정책 후보를 확인하세요.' : '에이전트가 도구를 호출하는 과정에서 업무 경계를 지키는지 시험해 보세요.'}</p><button className="primary-button" onClick={() => navigate(w.hasBaseline ? 'finding' : 'release')}>{w.hasBaseline ? '발견된 위험 검토 →' : '검증 구성 확인 →'}</button></> : releases.length ? <><h3>{releases[0]?.businessPurpose}</h3><StatusBadge status={releases[0]!.effectiveStatus} /><p>현재 상태는 서버의 effective status를 그대로 표시합니다.</p><button className="primary-button" onClick={() => navigate('releases')}>릴리스 열기 →</button></> : <EmptyState title="아직 릴리스가 없습니다">에이전트와 Manifest를 등록해 검증 대상을 준비하세요.</EmptyState>}
    </Panel><Panel title="최근 실행" description={simulated ? 'SIMULATED · run-baseline-demo' : '실행 목록 집계 대기'}>{simulated ? <><Progress label="완료된 trial" value={w.progress} total={40} /><p className="run-current">{w.active ? '현재 단계: 결과 검사' : w.phase === 'cancelled' ? '취소됨 · 부분 증거 보존' : w.hasBaseline ? '기본 실행 완료 · 검토 대기' : '아직 실행하지 않았습니다.'}</p><p className="muted">{w.connection ? '샘플 연결 정상' : '연결 복구 상태 예시'} · 실제 서버 실행 아님</p><button className="secondary-button full-width" onClick={() => navigate('trace')}>실행 추적 열기</button></> : <Notice title="실측값을 임의로 채우지 않습니다.">테스트 실행 메뉴에서 실제 Run을 생성·조회할 수 있습니다. 이 대시보드의 최근 실행 집계는 아직 연결되지 않았습니다.</Notice>}</Panel></div>
    <Panel title={simulated ? '최근 검증 활동' : '최근 릴리스'} description="활동과 출시 판정은 별도입니다." className="section-gap">{simulated ? <DataTable caption="합성 검증 활동" headings={['시각 · 예시','활동','다음 확인']} rows={[
      ['14:32', w.hasBaseline ? 'CASE-1001에서 실제 범위 위반 확인' : '기본 공격 시험 대기', <button className="text-button" onClick={() => navigate('finding')}>위험 근거 보기 →</button>],
      ['14:30', `Baseline · ${w.progress} / 40 trials`, <button className="text-button" onClick={() => navigate('trace')}>진행 상황 →</button>],
      ['14:28','Manifest 분석 · 합성 artifact 고정',<button className="text-button" onClick={() => navigate('release')}>구성 확인 →</button>],
    ]} /> : <DataTable caption="서버 릴리스 inventory" headings={['버전','업무 목적','상태','갱신']} rows={releases.slice(0,6).map(r => [`v${r.version}`,r.businessPurpose,<StatusBadge status={r.effectiveStatus} />,formatDate(r.updatedAt)])} />}</Panel>
  </>
}

export function ReleaseInventory({ releases, agents, navigate, simulated, selectAgent }: { releases: Release[]; agents: Agent[]; navigate: Navigate; simulated: boolean; selectAgent: (agent: Agent) => void }) {
  const [agentId, setAgentId] = useState('')
  const filtered = releases.filter(r => !agentId || r.agentId === agentId)
  return <><PageHeader eyebrow="RELEASE INVENTORY" title="릴리스 버전 관리" description="같은 에이전트의 구성과 검증 상태를 버전별로 비교합니다." actions={<button className="primary-button" onClick={() => navigate('manifest')}>+ Manifest 등록</button>} /><div className="filters"><label>에이전트<select value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">전체 에이전트</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><Badge tone="muted">등록 {filtered.length}개</Badge></div>
    <Panel title="릴리스 목록" description="현재 상태와 과거 판정은 별도 값입니다.">{filtered.length ? <DataTable caption="에이전트 릴리스 버전" headings={['버전','업무 목적','현재 상태','Artifact fingerprint','다음 행동']} rows={filtered.map(r => [<strong>v{r.version}</strong>,r.businessPurpose,<StatusBadge status={r.effectiveStatus} />,<ShortHash value={r.agentArtifactFingerprint} />,<button className="text-button" onClick={() => { const agent = agents.find(a => a.id === r.agentId); if (agent) selectAgent(agent); navigate(simulated && r.id === DEMO_RELEASE_ID ? 'release' : r.effectiveStatus === 'NEEDS_REVALIDATION' && simulated ? 'changed' : 'manifest') }}>릴리스 열기 →</button>])} /> : <EmptyState title="등록된 릴리스가 없습니다">선택한 에이전트에 Manifest를 등록하세요.</EmptyState>}</Panel>
    <div className="content-grid section-gap"><Notice title="분석된 구성은 덮어쓰지 않습니다.">Prompt·Tool·Model·RAG가 바뀌면 새 버전으로 등록하고 재검증합니다.</Notice><Notice title="정책만 변경한 비교와 구분하세요." tone="purple">정책 변경은 Release fingerprint를 바꿉니다. Agent artifact와 시험 조건이 같아야 전후 비교가 가능합니다.</Notice></div></>
}
