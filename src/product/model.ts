import { useEffect, useState } from 'react'

export const pageLabels = {
  start: '검증 시작', overview: '워크스페이스', agents: '에이전트', releases: '릴리스', manifest: 'Manifest 등록', release: '검증 요약',
  runs: '테스트 실행', trace: '공격 실행 추적', findings: '발견된 위험', finding: '위험 상세', policies: '안전 정책', policy: '정책 검토',
  gateway: '도구 요청 · 차단 결과', replay: '재검증', verification: '추가 검증', reports: '검증 보고서', report: '최종 보고서',
  evidence: '구성·증거', audit: '감사 로그', recovery: '운영 복구', states: '실행 상태', changed: '구성 변경',
} as const
export type Page = keyof typeof pageLabels
export type Mode = 'demo' | 'live'
export type Navigate = (page: Page) => void
export const mainNavigation: Page[] = ['start', 'overview', 'agents', 'releases', 'runs', 'findings', 'policies', 'reports', 'evidence', 'audit', 'recovery']
export function navigationParent(page: Page): Page {
  if (['manifest', 'release'].includes(page)) return 'releases'
  if (['trace', 'gateway', 'replay', 'verification', 'states'].includes(page)) return 'runs'
  if (page === 'finding') return 'findings'
  if (page === 'policy') return 'policies'
  if (page === 'report') return 'reports'
  if (page === 'changed') return 'evidence'
  return page
}
export function readRoute(): { mode: Mode; page: Page } {
  const [, rawMode, rawPage] = window.location.hash.split('/')
  const mode = rawMode === 'live' ? 'live' : 'demo'
  const page = rawPage && Object.hasOwn(pageLabels, rawPage) ? rawPage as Page : 'start'
  return { mode, page }
}
export type Phase = 'ready' | 'running' | 'review' | 'replaying' | 'compared' | 'verifying' | 'complete' | 'cancelled'
export function useDemoWorkflow() {
  const [phase, setPhase] = useState<Phase>('review')
  const [progress, setProgress] = useState(40)
  const [approved, setApproved] = useState(false)
  const [connection, setConnection] = useState(true)
  const [cancelledFrom, setCancelledFrom] = useState<Phase>('running')
  const active = ['running', 'replaying', 'verifying'].includes(phase)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setProgress(p => Math.min(40, p + 8)), 400)
    return () => window.clearInterval(timer)
  }, [active, phase])
  useEffect(() => {
    if (progress < 40) return
    if (phase === 'running') setPhase('review')
    if (phase === 'replaying') setPhase('compared')
    if (phase === 'verifying') setPhase('complete')
  }, [progress, phase])
  const start = () => { if (active) return; setApproved(false); setProgress(0); setPhase('running'); setConnection(true) }
  const approve = () => { if (phase !== 'review') return; setApproved(true); setProgress(0); setPhase('replaying') }
  const verify = () => { if (phase !== 'compared') return; setProgress(0); setPhase('verifying') }
  const reset = () => { if (active) return; setApproved(false); setProgress(0); setPhase('ready'); setConnection(true) }
  const cancel = () => { if (active) { setCancelledFrom(phase); setPhase('cancelled') } }
  const hasBaseline = ['review', 'replaying', 'compared', 'verifying', 'complete'].includes(phase) || (phase === 'cancelled' && cancelledFrom !== 'running')
  const hasReplay = ['compared', 'verifying', 'complete'].includes(phase) || (phase === 'cancelled' && cancelledFrom === 'verifying')
  const visiblePhase = phase === 'cancelled' ? cancelledFrom : phase
  const step = visiblePhase === 'ready' ? 0 : visiblePhase === 'running' ? 2 : visiblePhase === 'review' ? 4 : visiblePhase === 'replaying' ? 5 : visiblePhase === 'complete' ? 8 : 6
  return { phase, progress, approved, connection, setConnection, active, hasBaseline, hasReplay, step, start, approve, verify, reset, cancel }
}
export type Workflow = ReturnType<typeof useDemoWorkflow>
