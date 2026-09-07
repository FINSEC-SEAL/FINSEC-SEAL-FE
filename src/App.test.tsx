import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { mainNavigation, pageLabels } from './product/model'

const envelope = (data: unknown) => new Response(JSON.stringify({ data, traceId: 'trace-test', timestamp: '2026-09-01T00:00:00Z' }), { status: 200 })
beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => window.history.replaceState(null, '', '/'))

describe('FINAgent SEAL product shell', () => {
  it('starts in clearly marked simulated mode without calling an API', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    expect(await screen.findByRole('heading', { name: /에이전트의 위험한 행동/ })).toBeInTheDocument()
    expect(screen.getByText('SIMULATED · 합성 체험')).toBeInTheDocument()
    expect(screen.getByText('Internal assessment. Not official certification.')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(mainNavigation)('opens the %s menu without a server dependency', async page => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    window.history.replaceState(null, '', '/#/demo/' + page)
    render(<App />)
    await waitFor(() => expect(screen.queryByText('워크스페이스 정보를 불러오는 중')).not.toBeInTheDocument())
    const nav = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(nav.getByRole('button', { name: new RegExp(pageLabels[page]) })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('filters agents and keeps navigation addressable in the URL', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: /에이전트의 위험한 행동/ })
    await user.click(screen.getByRole('button', { name: /^에이전트$/ }))
    expect(screen.getByRole('heading', { name: '에이전트 관리' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/demo/agents')
    await user.type(screen.getByLabelText('에이전트 검색'), 'no-match')
    expect(screen.getByRole('heading', { name: '검색 결과 없음' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '필터 초기화' }))
    expect(screen.getByRole('heading', { name: '대출서류 검토 Agent' })).toBeInTheDocument()
  })

  it('loads real inventory only in API mode and does not invent runtime metrics', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
      String(input).endsWith('/api/v1/agents') ? envelope([{ id:'agent-1', agentKey:'loan-agent', name:'Live Agent', purposeSummary:'Document review', status:'ACTIVE', createdAt:'2026-09-01T00:00:00Z', updatedAt:'2026-09-01T00:00:00Z' }]) : envelope([]))
    render(<App />)
    expect(await screen.findByRole('heading', { name: '검증 워크스페이스' })).toBeInTheDocument()
    expect(screen.getByText('실행 집계 미연결')).toBeInTheDocument()
    expect(screen.getAllByText('N/A', { selector: '.metric-card strong' })).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('SIMULATED · 합성 체험')).not.toBeInTheDocument()
  })

  it('never silently falls back to synthetic data when the API fails', async () => {
    window.history.replaceState(null, '', '/#/live/overview')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection refused')
    expect(screen.getByText('API 연결을 확인해 주세요.')).toBeInTheDocument()
    expect(screen.queryByText('대출서류 검토 Agent')).not.toBeInTheDocument()
  })

  it('marks unconnected runtime pages explicitly in LIVE_API', async () => {
    window.history.replaceState(null, '', '/#/live/policy')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([]))
    render(<App />)
    expect(await screen.findByText('실제 데이터와 합성 결과를 섞지 않습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name:'승인 범위 확인 · 재검증' })).not.toBeInTheDocument()
  })

  it('requires human approval, handles conflicts, then shows comparison and a blocked sample report', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    window.history.replaceState(null, '', '/#/demo/policy')
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: '승인 범위 확인 · 재검증' }))
    const dialog = screen.getByRole('dialog')
    const approve = within(dialog).getByRole('button', { name:'샘플 승인 후 재검증' })
    expect(approve).toBeDisabled()
    await user.type(within(dialog).getByLabelText('검토 의견'), '고객 범위와 정상업무 영향 확인')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name:'버전 충돌 상태 체험' }))
    expect(approve).toBeDisabled()
    expect(within(dialog).getByText('409 · STALE_BASE_HASH')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name:'최신 diff 다시 검토' }))
    expect(within(dialog).getByLabelText('검토 의견')).toHaveValue('고객 범위와 정상업무 영향 확인')
    expect(approve).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(approve)
    expect(await screen.findByText('동일 조건 비교 가능 · 정책 v1 → v2 변경', {}, { timeout:4000 })).toBeInTheDocument()
    expect(screen.getByText('ATTACK_BLOCKED')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name:'Held-out · 정상업무 검증 →' }))
    await user.click(screen.getByRole('button', { name:'합성 추가 검증 실행' }))
    await user.click(await screen.findByRole('button', { name:'판정 근거 검토 →' }, { timeout:4000 }))
    expect(screen.getByText('BLOCKED · 출시 보류 · 남은 위험을 먼저 해결하세요.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name:'DEMO_ONLY · HTML / JSON 비활성' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name:'최종 판정 확인창 보기' }))
    expect(screen.getByRole('button', { name:'SIMULATED · 실제 확정 비활성' })).toBeDisabled()
    expect(fetch).not.toHaveBeenCalled()
  }, 12000)

  it('blocks reset while running and preserves a cancelled state', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name:'샘플 검증 체험 →' }))
    await user.click(screen.getByRole('button', { name:'데모 초기화' }))
    expect(screen.getByRole('button', { name:'샘플 검증 초기화' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name:'돌아가기' }))
    await user.click(screen.getByRole('button', { name:'실행 취소 요청' }))
    expect(screen.getByText('실행 취소됨 · 부분 증거 보존')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name:'데모 초기화' }))
    await user.click(screen.getByRole('button', { name:'샘플 검증 초기화' }))
    expect(screen.getByText('아직 시험하지 않았습니다.')).toBeInTheDocument()
  })

  it('supports hash navigation and restores a known route', async () => {
    render(<App />)
    await screen.findByRole('heading', { name:/에이전트의 위험한 행동/ })
    act(() => { window.location.hash = '/demo/reports'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByRole('heading', { name:'검증 보고서' })).toBeInTheDocument()
  })
})


describe('merged live console navigation', () => {
  it.each([
    ['테스트 실행', 'Runs & Trace'],
    ['발견된 위험', 'Findings'],
    ['검증 보고서', 'Metrics & Decision'],
  ])('opens the live %s feature from the product menu', async (menu, heading) => {
    window.history.replaceState(null, '', '/#/live/overview')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope([]))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '검증 워크스페이스' })
    await user.click(within(screen.getByRole('navigation', { name: '주요 메뉴' })).getByRole('button', { name: menu }))
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(screen.getByText('LIVE_API · API 모드')).toBeInTheDocument()
    expect(screen.queryByText('SIMULATED · 합성 체험')).not.toBeInTheDocument()
  })
})
