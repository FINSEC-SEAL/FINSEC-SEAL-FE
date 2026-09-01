import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({
    data,
    traceId: 'trace-test',
    timestamp: '2026-09-01T00:00:00Z',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('Role A console', () => {
  it('loads platform inventory and keeps role boundaries visible', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/agents')) {
        return envelope([{
          id: '0198f200-0000-7000-8000-000000000001',
          agentKey: 'loan-agent',
          name: 'Loan Agent',
          purposeSummary: 'Document completeness only',
          status: 'ACTIVE',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        }])
      }
      if (url.includes('/releases')) return envelope([])
      throw new Error(`Unexpected request: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Release integrity, at a glance.' })).toBeInTheDocument()
    expect(screen.getByText('Platform · Data · Evidence')).toBeInTheDocument()
    expect(screen.getByText(/Attack 실행, Policy 판단/)).toBeInTheDocument()
    expect(screen.getByText('1', { selector: '.metric-card strong' })).toBeInTheDocument()
  })

  it('navigates to the Agent inventory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope([]))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Release integrity, at a glance.' })

    await user.click(screen.getByRole('button', { name: 'Agents' }))

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Agent 등록' })).toBeInTheDocument()
  })
})

