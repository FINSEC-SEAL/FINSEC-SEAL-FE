import { useMemo, useState, type ReactNode } from 'react'
import { Badge, DataTable, Notice, Panel } from '../../components/Product'
import { projectPolicyRules } from './policyDisplay'
import type { ContractVersionIdentity, StoredContractReview } from './wire'

const exactText = { whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const }

function identityRows(identity: ContractVersionIdentity): ReactNode[][] {
  return [
    ['계약 키', <span style={exactText}>{identity.contractKey}</span>],
    ['버전', identity.version],
    ['버전 ID', <code>{identity.versionId}</code>],
    ['Workspace ID', <code>{identity.workspaceId}</code>],
    ['Release ID', <code>{identity.releaseId}</code>],
  ]
}

/** Displays the server snapshot only; it neither validates nor authorizes a mutation. */
export function PolicyReviewDetails({ review }: { review: StoredContractReview }) {
  const [jsonView, setJsonView] = useState<'stored' | 'canonical'>('stored')
  const rules = useMemo(() => projectPolicyRules(review.storedPolicyJson), [review.storedPolicyJson])
  const validation = review.validation
  const reviewer = review.review

  return <div className="stack">
    <Panel title="저장 계약" description="선택한 버전의 저장 상태와 식별자입니다."
      action={<Badge tone={review.state === 'APPROVED' ? 'green' : review.state === 'REJECTED' ? 'red' : 'blue'}>{review.state}</Badge>}>
      <DataTable caption="저장 계약 식별자" headings={['항목', '저장된 값']} rows={[
        ...identityRows(review.identity),
        ['Policy hash', <code>{review.policyHash}</code>],
        ['Resource hash · 변경 요청 기준', <code>{review.resourceHash}</code>],
      ]} />
      {['APPROVED', 'REJECTED', 'SUPERSEDED'].includes(review.state) && <p className="muted section-gap">이 버전은 읽기 전용입니다.</p>}
    </Panel>

    {rules.kind === 'table' ? <div className="equal-grid" aria-label="저장된 정책 규칙">
      {rules.sections.map(section => <Panel key={section.title} title={section.title}>
        <DataTable caption={section.title} headings={['규칙', '저장된 값']}
          rows={section.rows.map(row => [row.label, <span style={exactText}>{row.value}</span>])} />
      </Panel>)}
    </div> : <Panel title="저장된 정책 규칙">
      <Notice title="규칙을 정확한 원문으로 표시합니다." tone="amber">이 내용은 현재 환경에서 값의 정밀도를 유지한 표로 표시할 수 없습니다. 아래 저장 JSON을 확인해 주세요.</Notice>
      <pre className="code-block section-gap" aria-label="규칙 원문 대체 표시" style={exactText}>{review.storedPolicyJson}</pre>
    </Panel>}

    <Panel title="계약 JSON" description="저장 JSON은 서버에 저장된 트리의 직렬화 결과입니다. 모델 응답이나 최초 입력 원문과는 다를 수 있습니다.">
      <div className="segmented" role="group" aria-label="계약 JSON 보기">
        <button type="button" className={jsonView === 'stored' ? 'active' : ''} aria-pressed={jsonView === 'stored'} onClick={() => setJsonView('stored')}>저장 JSON</button>
        <button type="button" className={jsonView === 'canonical' ? 'active' : ''} aria-pressed={jsonView === 'canonical'} onClick={() => setJsonView('canonical')}>Canonical JSON</button>
      </div>
      <pre className="code-block section-gap" aria-label="계약 JSON" style={exactText}>{jsonView === 'stored' ? review.storedPolicyJson : review.canonicalPolicyJson}</pre>
    </Panel>

    <Panel title="기록된 승인 비교 기준" description="이 후보에 기록된 기준 계약입니다. 현재 적용 중인 승인본이나 바로 이전 버전을 뜻하지는 않습니다.">
      {review.baseline ? <DataTable caption="승인 비교 기준 식별자" headings={['항목', '기록된 값']} rows={[
        ...identityRows(review.baseline.identity),
        ['Policy hash', <code>{review.baseline.policyHash}</code>],
      ]} /> : <p className="muted">기록된 승인 기준본이 없습니다.</p>}
    </Panel>

    <Panel title="계약 변경 내역" description="서버가 기록된 승인 기준과 비교한 결과입니다. 전후 JSON 값을 그대로 표시합니다.">
      {review.changes.length ? <DataTable caption="계약 변경 내역" headings={['JSON pointer / 변경', '이전 JSON', '이후 JSON']}
        rows={review.changes.map(change => {
          const location = change.pointer === '' ? '문서 전체' : change.pointer
          return [
            <><code style={exactText}>{location}</code><small>{change.kind}</small></>,
            change.beforeJson === null ? <span>값 없음</span> : <pre className="code-block" aria-label={`변경 이전 ${location}`} style={exactText}>{change.beforeJson}</pre>,
            change.afterJson === null ? <span>값 없음</span> : <pre className="code-block" aria-label={`변경 이후 ${location}`} style={exactText}>{change.afterJson}</pre>,
          ]
        })} /> : <p className="muted">서버 비교 결과에 변경 항목이 없습니다.</p>}
    </Panel>

    <Panel title="저장된 검증 결과" description="저장 시점의 검증 결과입니다. 변경 요청 시 서버가 현재 승인 조건을 다시 확인합니다."
      action={validation && <Badge tone={validation.status === 'INVALID' ? 'red' : validation.status === 'WARN' ? 'amber' : 'green'}>{validation.status}</Badge>}>
      {validation === null ? <p className="muted">저장된 검증 결과가 없습니다.</p> : validation.issues.length ?
        <DataTable caption="저장된 검증 오류와 경고" headings={['중요도', 'JSON pointer', '코드', '검증 내용']}
          rows={validation.issues.map(issue => [
            <Badge tone={issue.severity === 'ERROR' ? 'red' : 'amber'}>{issue.severity}</Badge>,
            <code style={exactText}>{issue.jsonPointer === '' ? '문서 전체' : issue.jsonPointer}</code>,
            <code style={exactText}>{issue.code}</code>,
            <span style={exactText}>{issue.message}</span>,
          ])} /> : <p className="muted">저장된 오류·경고 항목이 없습니다.</p>}
      <p className="muted section-gap">정상업무 영향과 실제 공격 방어 결과는 이 조회에 포함되지 않습니다.</p>
    </Panel>

    <Panel title="저장된 검토 기록">
      {reviewer === null ? <p className="muted">저장된 검토 기록이 없습니다.</p> : <DataTable caption="저장된 검토 기록" headings={['항목', '기록된 값']} rows={[
        ['검토자', <span style={exactText}>{reviewer.actorId}</span>],
        ['역할', <span style={exactText}>{reviewer.role}</span>],
        ['결정', <span style={exactText}>{reviewer.decision}</span>],
        ['검토 의견', <span style={exactText}>{reviewer.comment}</span>],
      ]} />}
    </Panel>
  </div>
}
