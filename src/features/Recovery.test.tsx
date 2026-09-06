import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecoveryPage } from './Recovery'

describe('recovery notices', () => {
  it('groups both simulated-mode notices and preserves the sample operator action', async () => {
    const onActorChange = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch')
    render(<RecoveryPage actorId="reviewer-demo" onActorChange={onActorChange} simulated />)

    const notices = within(screen.getByRole('region', { name: '운영 복구 안내' }))
    expect(notices.getByText('복구 폼 체험 · 서버로 전송하지 않습니다.')).toBeInTheDocument()
    expect(notices.getByText('자동 복구 금지')).toBeInTheDocument()
    await userEvent.setup().click(notices.getByRole('button', { name: '샘플 운영자 설정' }))
    expect(onActorChange).toHaveBeenCalledWith('operator:demo')
    expect(screen.getByLabelText('Recovery key')).toHaveValue('demo-only-not-a-real-recovery-key')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains only the safety warning in API mode', () => {
    render(<RecoveryPage actorId="operator:platform" onActorChange={vi.fn()} />)

    const notices = within(screen.getByRole('region', { name: '운영 복구 안내' }))
    expect(notices.getByText('자동 복구 금지')).toBeInTheDocument()
    expect(notices.queryByText('복구 폼 체험 · 서버로 전송하지 않습니다.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '샘플 운영자 설정' })).not.toBeInTheDocument()
  })
})
