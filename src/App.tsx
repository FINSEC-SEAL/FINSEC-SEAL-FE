import { useCallback, useEffect, useState } from 'react'
import type { Agent, Release } from './api/contracts'
import { api } from './api/client'
import { ErrorBanner, LoadingBlock } from './components/Primitives'
import { AgentsPage, ReleasesPage } from './features/AgentsReleases'
import { AuditPage } from './features/Audit'
import { EvidencePage } from './features/Evidence'
import { Overview } from './features/Overview'
import { RecoveryPage } from './features/Recovery'
import { FindingsPage } from './features/Findings'
import { AssurancePage } from './features/Assurance'
import { ExecutionPage } from './features/Execution'

type Page = 'overview' | 'agents' | 'releases' | 'execution' | 'findings' | 'assurance' | 'evidence' | 'recovery' | 'audit'

const navigation: Array<{ id: Page; label: string; mark: string; section?: boolean }> = [
  { id: 'overview', label: '개요', mark: '◐' },
  { id: 'agents', label: 'Agents', mark: 'A' },
  { id: 'releases', label: 'Releases', mark: 'R' },
  { id: 'execution', label: 'Runs & Trace', mark: 'X', section: true },
  { id: 'findings', label: 'Findings', mark: 'F' },
  { id: 'assurance', label: 'Assurance', mark: 'D' },
  { id: 'evidence', label: 'Evidence', mark: 'E', section: true },
  { id: 'audit', label: 'Audit', mark: 'T' },
  { id: 'recovery', label: 'Recovery', mark: '!', section: true },
]

export default function App() {
  const [page, setPage] = useState<Page>('overview')
  const [actorId, setActorId] = useState(import.meta.env.VITE_FINSEC_ACTOR_ID ?? 'role-a-console')
  const [agents, setAgents] = useState<Agent[]>([])
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [selectedReleaseId, setSelectedReleaseId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>()
  const [menuOpen, setMenuOpen] = useState(false)

  const reload = useCallback(async () => {
    setError(undefined)
    try {
      const nextAgents = await api.listAgents(actorId)
      setAgents(nextAgents)
      const releaseGroups = await Promise.all(nextAgents.map((agent) => api.listReleases(agent.id, actorId)))
      setReleases(releaseGroups.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    } catch (cause) {
      setError(cause)
    } finally {
      setLoading(false)
    }
  }, [actorId])

  useEffect(() => { void reload() }, [reload])

  function navigate(next: Page) {
    setPage(next); setMenuOpen(false)
  }

  function selectAgent(agent: Agent) {
    setSelectedAgent(agent); navigate('releases')
  }

  return (
    <div className="app-shell">
      <button className="mobile-menu" onClick={() => setMenuOpen((value) => !value)} aria-label="메뉴 열기" aria-expanded={menuOpen}>☰</button>
      <aside className={menuOpen ? 'sidebar sidebar--open' : 'sidebar'}>
        <div className="brand"><div className="brand-seal" aria-hidden="true"><span>S</span></div><div><strong>FINSEC SEAL</strong><small>Platform Console</small></div></div>
        <div className="environment"><span className="live-dot" />LOCAL PLATFORM <strong>v0.1</strong></div>
        <nav aria-label="주요 메뉴">{navigation.map((item) => <div key={item.id} className={item.section ? 'nav-section' : undefined}>
          {item.section ? <span className="nav-divider" /> : null}
          <button className={page === item.id ? 'nav-item nav-item--active' : 'nav-item'} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}>
            <span className="nav-mark" aria-hidden="true">{item.mark}</span>{item.label}{item.id === 'recovery' ? <span className="restricted-dot" title="Operator only" aria-hidden="true" /> : null}</button></div>)}</nav>
        <div className="sidebar-footer"><p>Shared console</p><strong>Platform · Data · Evidence</strong><small>Role A foundation · Role B execution · Role D assurance</small></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><div className="breadcrumb"><span>FINSEC</span><b>/</b><strong>{navigation.find((item) => item.id === page)?.label}</strong></div>
          <div className="actor-control"><span>ACTOR</span><input aria-label="API actor ID" value={actorId} onChange={(event) => setActorId(event.target.value)} /><button className="icon-button" onClick={() => void reload()} aria-label="데이터 새로고침">↻</button></div></header>
        <main>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(undefined)} /> : null}
          {loading ? <LoadingBlock label="Platform inventory를 불러오는 중" /> : <>
            {page === 'overview' ? <Overview agents={agents} releases={releases} onNavigate={navigate} /> : null}
            {page === 'agents' ? <AgentsPage agents={agents} actorId={actorId} onChanged={reload} onSelect={selectAgent} /> : null}
            {page === 'releases' ? <ReleasesPage agents={agents} actorId={actorId} initialAgent={selectedAgent} onReleaseSelect={(release) => setSelectedReleaseId(release.id)} onReleaseInventory={(items) => setReleases((current) => [...current.filter((release) => release.agentId !== items[0]?.agentId), ...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))} /> : null}
            {page === 'execution' ? <ExecutionPage releases={releases} actorId={actorId} /> : null}
            {page === 'findings' ? <FindingsPage releases={releases} actorId={actorId} preferredReleaseId={selectedReleaseId} onReleaseChange={setSelectedReleaseId} /> : null}
            {page === 'assurance' ? <AssurancePage releases={releases} actorId={actorId} preferredReleaseId={selectedReleaseId} onReleaseChange={setSelectedReleaseId} /> : null}
            {page === 'evidence' ? <EvidencePage releases={releases} actorId={actorId} /> : null}
            {page === 'audit' ? <AuditPage actorId={actorId} /> : null}
            {page === 'recovery' ? <RecoveryPage actorId={actorId} onActorChange={setActorId} /> : null}
          </>}
        </main>
      </div>
    </div>
  )
}
