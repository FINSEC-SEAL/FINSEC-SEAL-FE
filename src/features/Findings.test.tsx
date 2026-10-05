import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Finding, FindingDetail, Release } from '../api/contracts'
import { FindingsPage } from './Findings'

// Synthetic read-response/DOM coverage only; no governance identity or mutation transport.
const release: Release = {
  id: '0198f200-0000-7000-8000-000000000101',
  agentId: '0198f200-0000-7000-8000-000000000102',
  version: '1.0.0',
  businessPurpose: 'Document completeness only',
  manifestSchemaVersion: '1.1',
  agentArtifactFingerprint: `sha256:${'a'.repeat(64)}`,
  releaseFingerprint: `sha256:${'b'.repeat(64)}`,
  safetyContractHash: null,
  lifecycleState: 'VERIFYING',
  effectiveStatus: 'VERIFYING',
  revalidationReason: null,
  analyzedAt: '2026-09-07T00:00:00Z',
  lastTestedAt: '2026-09-07T00:00:00Z',
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
}

const finding: Finding = {
  id: '0198f200-0000-7000-8000-000000000103',
  releaseId: release.id,
  sourceOracleResultId: '0198f200-0000-7000-8000-000000000104',
  category: 'FA-04', severity: 'CRITICAL', title: 'Classified data received by external collector', status: 'OPEN',
  violatedInvariant: 'INV-04', rootCause: { reasonCode: 'EXFIL_PAYLOAD_RECEIVED' }, findingGroupKey: 'sha256:group',
  firstSeenRunId: '0198f200-0000-7000-8000-000000000105', latestSeenRunId: '0198f200-0000-7000-8000-000000000105',
  createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
}

function detailFor(item: Finding, relatedFindings: Finding[] = []): FindingDetail {
  return {
    finding: item,
    oracleResult: {
      id: item.sourceOracleResultId, runId: item.firstSeenRunId, testCaseRunId: 'case-run', sourceEventId: 'source-event',
      oracleType: 'EXFILTRATION', oracleVersion: '1.0', outcome: 'ATTACK_SUCCESS', reasonCode: 'EXFIL_PAYLOAD_RECEIVED',
      invariantId: item.violatedInvariant, evidence: { sensitiveTokenCount: 1 }, evidenceDigest: `sha256:${'c'.repeat(64)}`,
      evaluatedAt: '2026-09-07T00:00:00Z', createdAt: '2026-09-07T00:00:00Z',
    },
    relatedFindings,
  }
}
const risk: Finding = { ...finding, status: 'ACCEPTED_RISK', title: 'Stored accepted risk' }
const page = () => <FindingsPage releases={[release]} actorId="role-d-console" />

beforeEach(() => { vi.spyOn(api, 'triageFinding').mockRejectedValue(new Error('Unexpected implicit triage')) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('D stored accepted-risk presentation', () => {
  it('shows accepted risk as a warning and keeps it out of processed counts', async () => {
    vi.spyOn(api, 'findings').mockResolvedValue([risk])
    render(page())
    const row = await screen.findByRole('row', { name: /Stored accepted risk/ })
    expect(within(row).getByText('ACCEPTED RISK')).toHaveClass('status--warning')
    expect(within(row).getByText('ACCEPTED RISK')).not.toHaveClass('status--positive')
    const summary = screen.getByLabelText('Finding summary')
    expect(within(within(summary).getByText('전체').parentElement!).getByText('1')).toBeInTheDocument()
    expect(within(within(summary).getByText('High / Critical').parentElement!).getByText('1')).toBeInTheDocument()
    expect(within(within(summary).getByText('처리됨').parentElement!).getByText('0')).toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  it('passes the selected stored status to the existing read API only after explicit query', async () => {
    const list = vi.spyOn(api, 'findings').mockResolvedValue([risk])
    const user = userEvent.setup()
    render(page())
    await screen.findByRole('row', { name: /Stored accepted risk/ })
    await user.selectOptions(screen.getByLabelText('Finding status'), 'ACCEPTED_RISK')
    expect(list).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '조회' }))
    await waitFor(() => expect(list).toHaveBeenNthCalledWith(2, release.id, 'role-d-console', {
      category: undefined, status: 'ACCEPTED_RISK',
    }))
    expect(screen.getByLabelText('Finding status')).toHaveValue('ACCEPTED_RISK')
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  it('explains the gate policy for accepted risk while preserving Oracle evidence and read-only related status', async () => {
    const related: Finding = { ...risk, id: '0198f200-0000-7000-8000-000000000199', title: 'Related stored risk' }
    vi.spyOn(api, 'findings').mockResolvedValue([risk])
    vi.spyOn(api, 'finding').mockResolvedValue(detailFor(risk, [related]))
    const user = userEvent.setup()
    render(page())
    await user.click(await screen.findByRole('row', { name: /Stored accepted risk/ }))
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('위험 수용은 Finding 해결이나 Release PASS를 뜻하지 않습니다.')
    expect(note).toHaveTextContent('BLOCKED 조건이 우선하며, 그 외에는 REVIEW 대상입니다.')
    expect(within(note).getByText('ACCEPTED RISK')).toHaveClass('status--warning')
    const relatedRow = screen.getByText('FA-04 · 외부 정보 유출 · Related stored risk').closest('li')!
    expect(within(relatedRow).getByText('ACCEPTED RISK')).toHaveClass('status--warning')
    expect(screen.getByText('EXFIL_PAYLOAD_RECEIVED')).toBeInTheDocument()
    expect(screen.getByText(/sensitiveTokenCount/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'TRIAGED로 전환' })).not.toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })

  it.each([
    ['OPEN', 'critical'], ['TRIAGED', 'positive'], ['RESOLVED', 'positive'],
    ['CLOSED', 'positive'], ['FUTURE_STATE', 'neutral'],
  ] as const)('preserves the existing %s status rendering', async (status, tone) => {
    const item: Finding = { ...finding, status, title: `Stored ${status}` }
    vi.spyOn(api, 'findings').mockResolvedValue([item])
    vi.spyOn(api, 'finding').mockResolvedValue(detailFor(item))
    const user = userEvent.setup()
    render(page())
    const row = await screen.findByRole('row', { name: new RegExp(item.title) })
    expect(within(row).getByText(status.replaceAll('_', ' '))).toHaveClass(`status--${tone}`)
    await user.click(row)
    await screen.findByText('EXFIL_PAYLOAD_RECEIVED')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    if (status === 'OPEN') expect(screen.getByRole('button', { name: 'TRIAGED로 전환' })).toBeDisabled()
    else expect(screen.queryByLabelText('Triage comment')).not.toBeInTheDocument()
    expect(api.triageFinding).not.toHaveBeenCalled()
  })
})
