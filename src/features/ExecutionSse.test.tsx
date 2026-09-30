import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api, FinsecApiError } from '../api/client'
import type { ExecutionEvent, Release, TestRun, TestRunStatus } from '../api/contracts'
import { ExecutionPage } from './Execution'

const release: Release = {
  id: 'release-1', agentId: 'agent-1', version: '1.0', businessPurpose: 'Test',
  manifestSchemaVersion: '1.0', agentArtifactFingerprint: 'sha256:a', releaseFingerprint: 'sha256:b',
  safetyContractHash: null, lifecycleState: 'TESTING', effectiveStatus: 'TESTING', revalidationReason: null,
  analyzedAt: null, lastTestedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

function run(latestSequence: number, status: TestRunStatus = 'RUNNING'): TestRun {
  return {
    id: 'run-1', releaseId: release.id, suiteId: 'suite-1', contractVersionId: null, mode: 'BASELINE', status,
    agentArtifactFingerprint: 'sha256:a', releaseFingerprint: 'sha256:b', fixtureVersion: '1.0', fixtureDigest: 'sha256:c',
    totalCases: 2, completedCases: status === 'COMPLETED' ? 2 : 1, operationalErrorCount: 0,
    latestSequence, latestEventType: status === 'COMPLETED' ? 'RUN_COMPLETED' : 'RUN_STARTED',
    eventHeadHash: 'sha256:d', summary: {}, startedAt: '2026-09-01T00:00:00Z', completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
  }
}

function event(sequence: number, eventType = 'MODEL_REQUEST'): ExecutionEvent {
  return {
    schemaVersion: '1.0', eventId: `event-${sequence}`, traceId: 'trace-1', runId: 'run-1', testCaseRunId: null,
    sequence, occurredAt: '2026-09-01T00:00:00Z', eventType, toolName: null, input: null, output: null,
    payloadDigest: 'sha256:a', policyDecision: null, reasonCode: null, metadata: {}, prevEventHash: null,
    eventHash: 'sha256:b',
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(value: MessageEvent) => void>>()
  readonly close = vi.fn()

  constructor(readonly url: string) { FakeEventSource.instances.push(this) }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function'
      ? listener as (value: MessageEvent) => void
      : (value: MessageEvent) => listener.handleEvent(value)
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
  }

  emit(value: ExecutionEvent, name = 'trace.event') {
    const message = { data: JSON.stringify(value), lastEventId: String(value.sequence) } as MessageEvent
    this.listeners.get(name)?.forEach((listener) => listener(message))
  }
}

beforeEach(() => { FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function inspect(initialHistory = { items: [event(1)], headSequence: 1, nextCursor: null }, releases = [release]) {
  vi.spyOn(api, 'listTestSuites').mockResolvedValue([])
  vi.spyOn(api, 'listTestRuns').mockResolvedValue([{
    id: 'run-1', releaseId: release.id, suiteId: 'suite-1', mode: 'BASELINE', status: 'RUNNING',
    totalCases: 2, completedCases: 1, operationalErrorCount: 0, latestSequence: 1,
    startedAt: '2026-09-01T00:00:00Z', completedAt: null,
  }])
  vi.spyOn(api, 'listReplayComparisons').mockResolvedValue([])
  vi.spyOn(api, 'testRun').mockResolvedValue(run(1))
  vi.spyOn(api, 'eventHistory').mockResolvedValue(initialHistory)
  vi.spyOn(api, 'verifyEventChain').mockResolvedValue({
    runId: 'run-1', valid: true, eventCount: 1, firstInvalidSequence: null, headHash: 'sha256:d',
  })
  vi.spyOn(api, 'runOracleResults').mockResolvedValue([])
  vi.spyOn(api, 'runFindings').mockResolvedValue([])
  const user = userEvent.setup()
  render(<ExecutionPage releases={releases} actorId="role-a-console" />)
  await waitFor(() => expect(screen.getByLabelText('Test Run ID')).toHaveValue('run-1'))
  await user.click(screen.getByRole('button', { name: 'Run 조회' }))
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  return FakeEventSource.instances[0]!
}

function expectRunStatus(status: string) {
  const summary = document.querySelector('.run-summary')
  expect(summary).not.toBeNull()
  expect(within(summary as HTMLElement).getByText(status)).toBeInTheDocument()
}

describe('Run SSE recovery', () => {
  it('starts after the history head and repairs a gap before showing a later event', async () => {
    const stream = await inspect()
    expect(stream.url).toContain('/events?after=1')
    let resolveHistory!: (value: { items: ExecutionEvent[]; headSequence: number; nextCursor: null }) => void
    vi.mocked(api.eventHistory).mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve }))

    act(() => stream.emit(event(4)))
    expect(screen.queryByText('#4')).not.toBeInTheDocument()
    expect(api.eventHistory).toHaveBeenLastCalledWith('run-1', 'role-a-console', 1)
    await act(async () => resolveHistory({ items: [event(2), event(3), event(4)], headSequence: 4, nextCursor: null }))
    expect(await screen.findByText('4 execution events')).toBeInTheDocument()
    act(() => stream.emit(event(4)))
    expect(screen.getAllByText('#4')).toHaveLength(1)
  })

  it('uses two-second snapshot and history polling after a stream error, then reconnects at the new head', async () => {
    const stream = await inspect()
    vi.mocked(api.testRun).mockResolvedValue(run(2))
    vi.mocked(api.eventHistory).mockResolvedValue({ items: [event(2)], headSequence: 2, nextCursor: null })
    vi.useFakeTimers()
    act(() => stream.onerror?.())
    expect(stream.close).toHaveBeenCalled()
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('POLLING')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]!.url).toContain('/events?after=2')
    expect(screen.getByText('2 execution events')).toBeInTheDocument()
    expectRunStatus('RUNNING')
    act(() => FakeEventSource.instances[1]!.onopen?.())
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('LIVE')
  })

  it('keeps the current Run snapshot when initial history has expired', async () => {
    vi.spyOn(api, 'eventHistory').mockRejectedValueOnce(new FinsecApiError(410, {
      status: 410, title: 'Gone', code: 'STREAM_CURSOR_EXPIRED', retryable: false,
    }))
    const stream = await inspect()
    expect(stream.url).toContain('/events?after=1')
    expectRunStatus('RUNNING')
    expect(screen.getByText(/이전 Trace 보존 기간이 지났습니다/)).toBeInTheDocument()
    expect(screen.getByText('0 execution events')).toBeInTheDocument()
  })

  it('clears incomplete old trace on incremental 410 and resumes from the fresh snapshot', async () => {
    const stream = await inspect()
    vi.mocked(api.testRun).mockResolvedValue(run(10))
    vi.mocked(api.eventHistory).mockRejectedValueOnce(new FinsecApiError(410, {
      status: 410, title: 'Gone', code: 'STREAM_CURSOR_EXPIRED', retryable: false,
    }))
    vi.useFakeTimers()
    act(() => stream.onerror?.())
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(FakeEventSource.instances[1]!.url).toContain('/events?after=10')
    expect(screen.getByText('0 execution events')).toBeInTheDocument()
    expect(screen.getByText(/이전 Trace 보존 기간이 지났습니다/)).toBeInTheDocument()
    expectRunStatus('RUNNING')
  })

  it('reads missed final events before stopping on a terminal polling snapshot', async () => {
    const stream = await inspect()
    vi.mocked(api.testRun).mockResolvedValue(run(2, 'COMPLETED'))
    vi.mocked(api.eventHistory).mockResolvedValue({ items: [event(2, 'RUN_COMPLETED')], headSequence: 2, nextCursor: null })
    vi.useFakeTimers()
    act(() => stream.onerror?.())
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText('2 execution events')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    expectRunStatus('COMPLETED')
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('IDLE')
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('does not advance the cursor when a history batch has a later invalid event', async () => {
    const stream = await inspect()
    vi.mocked(api.eventHistory)
      .mockResolvedValueOnce({
        items: [event(2), { ...event(3), runId: 'other-run' }], headSequence: 3, nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [event(2), event(3)], headSequence: 3, nextCursor: null })
    vi.useFakeTimers()
    act(() => stream.emit(event(3)))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('1 execution events')).toBeInTheDocument()
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('POLLING')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.eventHistory).toHaveBeenLastCalledWith('run-1', 'role-a-console', 1)
    expect(screen.getByText('3 execution events')).toBeInTheDocument()
  })

  it('deduplicates a pending same-ID retry and rejects a conflicting pending event ID', async () => {
    const stream = await inspect()
    let resolveHistory!: (value: { items: ExecutionEvent[]; headSequence: number; nextCursor: null }) => void
    vi.mocked(api.eventHistory).mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve }))
    act(() => stream.emit(event(4)))
    act(() => stream.emit(event(4)))
    expect(stream.close).not.toHaveBeenCalled()
    act(() => stream.emit({ ...event(4), eventId: 'conflicting-event-4' }))
    expect(stream.close).toHaveBeenCalled()
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('POLLING')
    await act(async () => resolveHistory({ items: [event(2), event(3), event(4)], headSequence: 4, nextCursor: null }))
    expect(screen.getByText('4 execution events')).toBeInTheDocument()
    expect(screen.getAllByText('#4')).toHaveLength(1)
  })

  it('does not close a terminal gap before its history repair finishes', async () => {
    const stream = await inspect()
    vi.mocked(api.testRun).mockResolvedValue(run(4, 'COMPLETED'))
    let resolveHistory!: (value: { items: ExecutionEvent[]; headSequence: number; nextCursor: null }) => void
    vi.mocked(api.eventHistory).mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve }))
    act(() => stream.emit(event(4, 'RUN_COMPLETED'), 'run.completed'))
    expect(stream.close).not.toHaveBeenCalled()
    expect(screen.queryByText('#4')).not.toBeInTheDocument()
    await act(async () => resolveHistory({ items: [event(2), event(3), event(4, 'RUN_COMPLETED')], headSequence: 4, nextCursor: null }))
    await waitFor(() => expect(stream.close).toHaveBeenCalled())
    expect(screen.getByText('4 execution events')).toBeInTheDocument()
    expectRunStatus('COMPLETED')
  })

  it('ignores a late Run history response after switching Releases', async () => {
    const otherRelease = { ...release, id: 'release-2', version: '2.0' }
    const stream = await inspect(undefined, [release, otherRelease])
    let resolveHistory!: (value: { items: ExecutionEvent[]; headSequence: number; nextCursor: null }) => void
    vi.mocked(api.eventHistory).mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve }))
    act(() => stream.emit(event(3)))
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Release'), 'release-2')
    expect(stream.close).toHaveBeenCalled()
    await act(async () => resolveHistory({ items: [event(2), event(3)], headSequence: 3, nextCursor: null }))
    expect(screen.queryByText('3 execution events')).not.toBeInTheDocument()
    expect(screen.getByText('Test Run을 선택하세요')).toBeInTheDocument()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('closes the stream after a terminal server snapshot', async () => {
    const stream = await inspect()
    vi.mocked(api.testRun).mockResolvedValue(run(2, 'COMPLETED'))
    act(() => stream.emit(event(2, 'RUN_COMPLETED'), 'run.completed'))
    await waitFor(() => expect(stream.close).toHaveBeenCalled())
    expectRunStatus('COMPLETED')
    expect(screen.getByText(/Live stream:/)).toHaveTextContent('IDLE')
  })
})
