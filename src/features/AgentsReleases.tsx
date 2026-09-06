import { useEffect, useState, type FormEvent } from 'react'
import type { Agent, JsonValue, Release, ValidationResult } from '../api/contracts'
import { api, type PlatformClient } from '../api/client'
import { EmptyState, ErrorBanner, PageHeader, ShortHash, StatusBadge, formatDate } from '../components/Primitives'

export function AgentsPage({ agents, actorId, onChanged, onSelect, client = api }: {
  client?: PlatformClient
  agents: Agent[]
  actorId: string
  onChanged: () => Promise<void>
  onSelect: (agent: Agent) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [query, setQuery] = useState('')
  const filteredAgents = agents.filter(agent => `${agent.name} ${agent.agentKey}`.toLowerCase().includes(query.toLowerCase()))

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setBusy(true); setError(undefined)
    const data = new FormData(form)
    try {
      await client.createAgent({
        agentKey: String(data.get('agentKey') ?? ''),
        name: String(data.get('name') ?? ''),
        purposeSummary: String(data.get('purposeSummary') ?? ''),
      }, actorId)
      form.reset(); setOpen(false); await onChanged()
    } catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  async function archive(agent: Agent) {
    if (!window.confirm(`${agent.name}을 archive 할까요? 이 Agent에는 새 Release를 추가할 수 없습니다.`)) return
    setBusy(true); setError(undefined)
    try { await client.archiveAgent(agent.id, actorId); await onChanged() }
    catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="AGENT INVENTORY" title="에이전트 관리" description="검증할 에이전트의 식별자와 업무 목적을 등록합니다."
      actions={<button className="primary-button" onClick={() => setOpen((value) => !value)}>+ Agent 등록</button>} />
    <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
    <div className="filters"><label>에이전트 검색<input value={query} onChange={event => setQuery(event.target.value)} placeholder="이름 또는 Agent key" /></label><span className="muted">등록 {agents.length}건</span></div>
    <div className={open ? 'agents-layout agents-layout--open' : 'agents-layout'}>
    {open ? <form className="panel form-panel" onSubmit={create}>
      <div className="panel-heading"><div><p className="eyebrow">NEW INVENTORY ITEM</p><h2>Agent 등록</h2></div></div>
      <div className="form-grid"><label>Agent key<input name="agentKey" required pattern="[a-z0-9][a-z0-9-]{2,79}" placeholder="loan-document-review-agent" /></label>
        <label>표시 이름<input name="name" required maxLength={100} placeholder="Loan Review Agent" /></label>
        <label className="span-2">업무 목적<textarea name="purposeSummary" required maxLength={500} rows={3} placeholder="고객 서류 완전성만 검토" /></label></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>취소</button><button className="primary-button" disabled={busy}>{busy ? '등록 중…' : '등록'}</button></div>
    </form> : null}
    {agents.length === 0 ? <EmptyState title="등록된 Agent가 없습니다">첫 Agent를 등록한 뒤 Release manifest를 추가하세요.</EmptyState> :
      filteredAgents.length === 0 ? <EmptyState title="검색 결과 없음"><button className="text-button" onClick={() => setQuery('')}>필터 초기화</button></EmptyState> : <div className="card-grid">{filteredAgents.map((agent) => <article className="agent-card" key={agent.id}>
        <div className="agent-card__top"><span className="agent-monogram">{agent.name.slice(0, 1).toUpperCase()}</span><StatusBadge status={agent.status} /></div>
        <h2>{agent.name}</h2><code className="agent-key">{agent.agentKey}</code><p>{agent.purposeSummary}</p>
        <div className="agent-card__meta"><span>Updated</span><strong>{formatDate(agent.updatedAt)}</strong></div>
        <div className="card-actions"><button className="primary-button" onClick={() => onSelect(agent)}>릴리스 관리</button>
          {agent.status === 'ACTIVE' ? <button className="danger-text-button" disabled={busy} onClick={() => void archive(agent)}>Archive</button> : null}</div>
      </article>)}</div>}
    </div>
  </>
}

export function ReleasesPage({ agents, actorId, initialAgent, onReleaseInventory, client = api }: {
  client?: PlatformClient
  agents: Agent[]
  actorId: string
  initialAgent: Agent | null
  onReleaseInventory: (releases: Release[], agentId: string) => void
}) {
  const [agentId, setAgentId] = useState(initialAgent?.id ?? agents.find((a) => a.status === 'ACTIVE')?.id ?? '')
  const [releases, setReleases] = useState<Release[]>([])
  const [selected, setSelected] = useState<Release | null>(null)
  const [manifestText, setManifestText] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [fingerprint, setFingerprint] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  async function load(id = agentId) {
    if (!id) { setReleases([]); return }
    try {
      const result = await client.listReleases(id, actorId)
      setReleases(result); onReleaseInventory(result, id)
      if (selected) setSelected(result.find((release) => release.id === selected.id) ?? null)
    } catch (cause) { setError(cause) }
  }
  useEffect(() => { void load() }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined)
    try {
      if (new TextEncoder().encode(manifestText).length > 2 * 1024 * 1024) throw new Error('Manifest는 최대 2 MB까지 등록할 수 있습니다.')
      const parsed = JSON.parse(manifestText) as JsonValue
      const created = await client.createRelease(agentId, parsed, actorId)
      setManifestText(''); await load(); setSelected(created)
    } catch (cause) { setError(cause instanceof SyntaxError ? new Error('Manifest JSON 문법을 확인하세요.') : cause) }
    finally { setBusy(false) }
  }

  async function act(kind: 'validate' | 'analyze' | 'fingerprint') {
    if (!selected) return
    setBusy(true); setError(undefined); setValidation(null); setFingerprint(null)
    try {
      if (kind === 'validate') setValidation(await client.validateRelease(selected.id, actorId))
      if (kind === 'analyze') { await client.analyzeRelease(selected.id, actorId); await load() }
      if (kind === 'fingerprint') setFingerprint((await client.fingerprint(selected.id, actorId)).components)
    } catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="RELEASE CONFIGURATION" title="Manifest 등록과 구성 분석" description="에이전트가 무엇을 하고 어떤 도구를 사용하는지 검증 대상으로 고정합니다." />
    <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
    <section className="release-layout">
      <aside className="panel release-sidebar"><label>Agent<select value={agentId} onChange={(event) => { setAgentId(event.target.value); setSelected(null) }}>
        <option value="">선택하세요</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}</select></label>
        <div className="release-list">{releases.length === 0 ? <p className="muted">등록된 Release가 없습니다.</p> : releases.map((release) =>
          <button key={release.id} className={selected?.id === release.id ? 'release-item release-item--active' : 'release-item'} onClick={() => { setSelected(release); setValidation(null); setFingerprint(null) }}>
            <span><strong>v{release.version}</strong><small>{release.id.slice(0, 8)}</small></span><StatusBadge status={release.effectiveStatus} /></button>)}</div>
      </aside>
      <div className="release-main">
        <form className="panel" onSubmit={create}><div className="panel-heading"><div><p className="eyebrow">STRICT INPUT</p><h2>Manifest 등록</h2></div><span className="file-hint">JSON · max 2 MB</span></div>
          <textarea className="code-input" aria-label="Release manifest JSON" rows={9} value={manifestText} onChange={(event) => setManifestText(event.target.value)} placeholder={'{\n  "schemaVersion": "1.0",\n  ...\n}'} required />
          <div className="form-actions"><label className="secondary-button file-button">파일 불러오기<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setError(new Error('Manifest는 최대 2 MB까지 등록할 수 있습니다.')); event.target.value = ''; return } void file.text().then(setManifestText).catch(setError) }} /></label>
            <button className="primary-button" disabled={busy || !agents.some(a => a.id === agentId && a.status === 'ACTIVE')}>{busy ? '처리 중…' : 'Draft Release 등록'}</button></div></form>
        {selected ? <article className="panel release-detail"><div className="panel-heading"><div><p className="eyebrow">SELECTED RELEASE</p><h2>v{selected.version}</h2></div><StatusBadge status={selected.effectiveStatus} /></div>
          <p>{selected.businessPurpose}</p><dl className="detail-grid"><div><dt>Release ID</dt><dd><ShortHash value={selected.id} /></dd></div><div><dt>Updated</dt><dd>{formatDate(selected.updatedAt)}</dd></div>
            <div><dt>Artifact fingerprint</dt><dd><ShortHash value={selected.agentArtifactFingerprint} /></dd></div><div><dt>Release fingerprint</dt><dd><ShortHash value={selected.releaseFingerprint} /></dd></div></dl>
          <div className="button-row"><button className="secondary-button" disabled={busy} onClick={() => void act('validate')}>Manifest 검증</button><button className="secondary-button" disabled={busy || selected.lifecycleState !== 'DRAFT'} onClick={() => void act('analyze')}>Analyze 고정</button><button className="primary-button" disabled={busy || selected.lifecycleState === 'DRAFT'} onClick={() => void act('fingerprint')}>Fingerprint 확인</button></div>
          {validation ? <div className={validation.valid ? 'result-box result-box--pass' : 'result-box result-box--fail'}><strong>{validation.valid ? '✓ Manifest valid' : `${validation.issues.length}개 문제`}</strong>{validation.issues.map((issue) => <p key={`${issue.path}-${issue.code}`}><code>{issue.path}</code> {issue.message}</p>)}</div> : null}
          {fingerprint ? <div className="digest-list">{Object.entries(fingerprint).map(([name, digest]) => <div key={name}><span>{name}</span><ShortHash value={digest} /></div>)}</div> : null}
        </article> : <EmptyState title="Release를 선택하세요">왼쪽 목록에서 Release를 선택하면 무결성 작업을 시작할 수 있습니다.</EmptyState>}
      </div>
    </section>
  </>
}
