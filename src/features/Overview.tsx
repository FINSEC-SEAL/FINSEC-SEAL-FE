import type { Agent, Release } from '../api/contracts'
import { EmptyState, PageHeader, StatusBadge, formatDate } from '../components/Primitives'

export function Overview({ agents, releases, onNavigate }: {
  agents: Agent[]
  releases: Release[]
  onNavigate: (page: 'agents' | 'releases' | 'evidence') => void
}) {
  const active = agents.filter((agent) => agent.status === 'ACTIVE').length
  const terminal = releases.filter((release) => ['PASS', 'REVIEW', 'BLOCKED'].includes(release.effectiveStatus)).length
  const revalidation = releases.filter((release) => release.effectiveStatus === 'NEEDS_REVALIDATION').length

  return (
    <>
      <PageHeader
        eyebrow="A · Platform / Data / Evidence"
        title="Release integrity, at a glance."
        description="Agent와 Release의 불변 식별자, 증거 출처, Attestation 상태를 한 곳에서 확인합니다."
      />
      <section className="metric-grid" aria-label="플랫폼 현황">
        <Metric label="Active agents" value={active} detail={`전체 ${agents.length}개`} accent="mint" />
        <Metric label="Tracked releases" value={releases.length} detail={`판정 완료 ${terminal}개`} accent="blue" />
        <Metric label="Needs revalidation" value={revalidation} detail="변경 후 재검증 필요" accent={revalidation ? 'amber' : 'slate'} />
        <Metric label="Canonicalization" value="JCS" detail="RFC 8785 + NFC / v1" accent="violet" />
      </section>

      <section className="content-grid content-grid--overview">
        <article className="panel panel--wide">
          <div className="panel-heading"><div><p className="eyebrow">RECENT INVENTORY</p><h2>최근 Release</h2></div>
            <button className="text-button" onClick={() => onNavigate('releases')}>전체 보기 →</button>
          </div>
          {releases.length === 0 ? (
            <EmptyState title="아직 Release가 없습니다">Agent를 등록하고 strict manifest를 업로드하세요.</EmptyState>
          ) : (
            <div className="table-wrap"><table><thead><tr><th>Version</th><th>Purpose</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>{releases.slice(0, 6).map((release) => <tr key={release.id}>
                <td><strong>v{release.version}</strong><small>{release.id.slice(0, 8)}</small></td>
                <td>{release.businessPurpose}</td><td><StatusBadge status={release.effectiveStatus} /></td>
                <td>{formatDate(release.updatedAt)}</td></tr>)}</tbody></table></div>
          )}
        </article>
        <aside className="panel mandate-card">
          <p className="eyebrow">ROLE BOUNDARY</p><h2>A가 보장하는 것</h2>
          <ul className="check-list">
            <li><span>✓</span> Manifest와 artifact의 deterministic fingerprint</li>
            <li><span>✓</span> Append-only trace, evidence, audit provenance</li>
            <li><span>✓</span> Confirmed Decision의 exact Attestation projection</li>
          </ul>
          <div className="boundary-note"><strong>계산하지 않음</strong><p>Attack 실행, Policy 판단, Metric·Gate·Decision 계산은 각 담당 서비스의 소유입니다.</p></div>
          <button className="secondary-button full-width" onClick={() => onNavigate('evidence')}>증거 직접 확인</button>
        </aside>
      </section>
    </>
  )
}

function Metric({ label, value, detail, accent }: { label: string; value: string | number; detail: string; accent: string }) {
  return <article className={`metric-card metric-card--${accent}`}><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>
}

