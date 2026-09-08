import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Release } from '../../api/contracts'
import { EmptyState, ErrorBanner, LoadingBlock, PageHeader } from '../../components/Primitives'
import { Badge, DataTable, Modal, Notice, Panel } from '../../components/Product'
import { ContractRequestError, ContractReviewClient, prepareContractMutation, type ContractAction, type PreparedContractMutation, prepareInitialGeneration, preparePatchGeneration, type PreparedGeneration, type GenerationOperation, type ProposedPatchOperation } from './client'
import { PolicyReviewDetails } from './PolicyReviewDetails'
import type { ContractVersionIdentity, ContractVersionSummary, StoredContractReview } from './wire'

const defaultClient = new ContractReviewClient()
const actionNames = { validate: '검증', approve: '승인', reject: '거절' } as const
type OperationRecord = { operation: PreparedContractMutation; epoch: number; phase: 'pending' | 'unknown' }
type MutationResult = { ok: true; version: ContractVersionSummary } | { ok: false; error: ContractRequestError }
type GenerationRecord = { request: PreparedGeneration; epoch: number; releaseSignature: string; client: ContractReviewClient; phase: 'submitting' | 'unknown' | 'rejected' | 'accepted'; operation: GenerationOperation | null; error: ContractRequestError | null; readError: ContractRequestError | null }
type PatchBinding = { identity: ContractVersionIdentity; operation: ProposedPatchOperation; epoch: number; releaseSignature: string; client: ContractReviewClient }
type Session = { id: number; releaseId: string; releaseSignature: string; reviewerKey: string; epoch: number; client: ContractReviewClient }

function targetKey(identity: ContractVersionIdentity): string {
  return `${identity.workspaceId}/${identity.releaseId}/${identity.versionId}`
}

function sameIdentity(left: ContractVersionIdentity, right: ContractVersionIdentity): boolean {
  return left.versionId === right.versionId && left.workspaceId === right.workspaceId && left.releaseId === right.releaseId
    && left.contractKey === right.contractKey && left.version === right.version
}

function releaseSignature(release: Release): string {
  return JSON.stringify([release.id, release.updatedAt, release.agentArtifactFingerprint, release.releaseFingerprint,
    release.safetyContractHash, release.lifecycleState, release.effectiveStatus])
}

function safeError(error: unknown): ContractRequestError {
  return error instanceof ContractRequestError ? error
    : new ContractRequestError(null, { code: 'UNKNOWN_ERROR', retryable: false }, 'unknown')
}

function eligible(review: StoredContractReview, action: ContractAction): boolean {
  if (action === 'validate') return review.state === 'CANDIDATE'
  if (action === 'reject') return review.state === 'CANDIDATE' || review.state === 'VALIDATED'
  return review.state === 'VALIDATED' && (review.validation?.status === 'VALID' || review.validation?.status === 'WARN')
}

function generationBlocked(record: GenerationRecord | undefined): boolean {
  return Boolean(record && (record.phase === 'submitting' || record.phase === 'unknown'
    || (record.phase === 'accepted' && record.operation?.status !== 'SUCCEEDED' && record.operation?.status !== 'FAILED')))
}

type StoredCandidateOperation = Extract<GenerationOperation, { outcome: 'VALID' | 'WARN' | 'PROPOSED' }>
function candidateOperation(operation: GenerationOperation | null): StoredCandidateOperation | null {
  return operation?.status === 'SUCCEEDED' && (operation.outcome === 'VALID' || operation.outcome === 'WARN' || operation.outcome === 'PROPOSED') ? operation : null
}

function candidateMatches(record: GenerationRecord, version: ContractVersionSummary): boolean {
  const operation = candidateOperation(record.operation)
  return Boolean(operation && version.identity.releaseId === record.request.releaseId
    && version.identity.versionId === operation.result.contractVersionId && version.policyHash === operation.result.policyHash
    && (record.request.kind !== 'PATCH' || (version.identity.workspaceId === record.request.baseIdentity.workspaceId
      && version.identity.contractKey === record.request.baseIdentity.contractKey
      && version.identity.versionId !== record.request.baseIdentity.versionId && version.identity.version > record.request.baseIdentity.version)))
}

export function StoredContractReviewPage({ releases, preferredReleaseId, onReleaseChange, client = defaultClient }: {
  releases: Release[]
  preferredReleaseId?: string
  onReleaseChange?: (releaseId: string) => void
  client?: ContractReviewClient
}) {
  const [releaseId, setReleaseId] = useState(() => releases.some(item => item.id === preferredReleaseId) ? preferredReleaseId! : '')
  const [reviewerKey, setReviewerKey] = useState('')
  const [epoch, setEpoch] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const nextSession = useRef(0)
  const previousPreferred = useRef(preferredReleaseId)
  const previousClient = useRef(client)
  const alive = useRef(true)
  const ledger = useRef(new Map<string, OperationRecord>())
  const [records, setRecords] = useState<ReadonlyMap<string, OperationRecord>>(new Map())
  const generationLedger = useRef(new Map<string, GenerationRecord>())
  const [generationRecords, setGenerationRecords] = useState<ReadonlyMap<string, GenerationRecord>>(new Map())
  const [patchBindings, setPatchBindings] = useState<ReadonlyMap<string, PatchBinding>>(new Map())
  const activeSession = useRef<Session | null>(null)
  const pollToken = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollFlight = useRef<AbortController | null>(null)
  const queuedPoll = useRef<Session | null>(null)
  const [generationReading, setGenerationReading] = useState(false)
  const selectedRelease = releases.find(item => item.id === releaseId)
  const currentSession = session && selectedRelease && session.releaseId === releaseId && session.epoch === epoch
    && session.releaseSignature === releaseSignature(selectedRelease) && session.client === client ? session : null

  activeSession.current = currentSession

  // The lock lives above keyed sessions. Abort is not proof that a fetch has settled.
  useEffect(() => () => {
    pollToken.current++
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null; queuedPoll.current = null
    pollFlight.current?.abort()
  }, [currentSession])

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (previousPreferred.current !== preferredReleaseId) {
      previousPreferred.current = preferredReleaseId
      const next = releases.some(item => item.id === preferredReleaseId) ? preferredReleaseId! : ''
      if (next !== releaseId) { setReleaseId(next); setSession(null) }
    } else if (releaseId && !selectedRelease) { setReleaseId(''); setSession(null) }
    if (previousClient.current !== client) {
      previousClient.current = client
      setEpoch(value => value + 1); setSession(null)
    }
  }, [preferredReleaseId, releaseId, releases, selectedRelease, client])

  function recordOperation(key: string, record: OperationRecord | null) {
    if (record) ledger.current.set(key, record)
    else ledger.current.delete(key)
    if (alive.current) setRecords(new Map(ledger.current))
  }

  async function perform(operation: PreparedContractMutation, context: Session, signal: AbortSignal): Promise<MutationResult> {
    const key = targetKey(operation.identity)
    const previous = ledger.current.get(key)
    if (previous && (previous.phase === 'pending' || previous.operation !== operation || previous.epoch !== context.epoch)) {
      return { ok: false, error: new ContractRequestError(null, { code: 'CONTRACT_REQUEST_INVALID', retryable: false }, 'not_sent') }
    }
    // Register before dispatch, outside the keyed session. Navigation cannot erase an in-flight request.
    recordOperation(key, { operation, epoch: context.epoch, phase: 'pending' })
    try {
      const version = await context.client.executeMutation(operation, context.reviewerKey, signal)
      recordOperation(key, null)
      return { ok: true, version }
    } catch (cause) {
      const error = safeError(cause)
      // A failed retry describes that attempt only; it cannot resolve an earlier unknown outcome.
      recordOperation(key, previous?.phase === 'unknown' || error.outcome === 'unknown'
        ? { operation, epoch: context.epoch, phase: 'unknown' } : null)
      return { ok: false, error }
    }
  }

  function recordGeneration(record: GenerationRecord) {
    generationLedger.current.set(record.request.releaseId, record)
    if (alive.current) setGenerationRecords(new Map(generationLedger.current))
  }

  function pollGeneration(context: Session) {
    if (!alive.current || activeSession.current !== context) return
    if (pollFlight.current) { queuedPoll.current = context; return }
    const record = generationLedger.current.get(context.releaseId)
    if (record?.phase !== 'accepted' || !record.operation) return
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
    const token = ++pollToken.current
    const controller = new AbortController(); pollFlight.current = controller
    setGenerationReading(true)
    let again = false
    const current = () => alive.current && activeSession.current === context && pollToken.current === token
      && generationLedger.current.get(context.releaseId)?.request === record.request
    void context.client.generationOperation(record.operation, context.reviewerKey, controller.signal)
      .then(operation => {
        if (!current()) return
        recordGeneration({ ...record, operation, readError: null })
        again = operation.status === 'QUEUED' || operation.status === 'RUNNING'
      })
      .catch(cause => { if (current()) recordGeneration({ ...record, readError: safeError(cause) }) })
      .finally(() => {
        pollFlight.current = null
        if (alive.current) setGenerationReading(false)
        const queued = queuedPoll.current; queuedPoll.current = null
        if (queued && activeSession.current === queued) pollGeneration(queued)
        else if (again && current()) pollTimer.current = setTimeout(() => pollGeneration(context), 1500)
      })
  }

  async function submitGeneration(request: PreparedGeneration, context: Session, signal: AbortSignal) {
    if (activeSession.current !== context || request.releaseId !== context.releaseId
      || generationBlocked(generationLedger.current.get(request.releaseId))) return
    const record: GenerationRecord = { request, epoch: context.epoch, releaseSignature: context.releaseSignature, client: context.client,
      phase: 'submitting', operation: null, error: null, readError: null }
    // Unknown admission has no safe replay window. Never unlock it through navigation or retries.
    recordGeneration(record)
    try {
      const operation = await context.client.submitGeneration(request, context.reviewerKey, signal)
      if (generationLedger.current.get(request.releaseId)?.request !== request) return
      recordGeneration({ ...record, phase: 'accepted', operation })
      if (activeSession.current === context) pollGeneration(context)
    } catch (cause) {
      const error = safeError(cause)
      if (generationLedger.current.get(request.releaseId)?.request === request) {
        recordGeneration({ ...record, phase: error.outcome === 'unknown' ? 'unknown' : 'rejected', error })
      }
    }
  }

  function bindPatch(identity: ContractVersionIdentity, operation: ProposedPatchOperation, context: Session) {
    if (activeSession.current !== context) return
    setPatchBindings(previous => new Map(previous).set(targetKey(identity), {
      identity, operation, epoch: context.epoch, releaseSignature: context.releaseSignature, client: context.client,
    }))
  }

  function applyCredentials(event: FormEvent) {
    event.preventDefault()
    if (!selectedRelease || !reviewerKey) return
    setSession({ id: ++nextSession.current, releaseId, releaseSignature: releaseSignature(selectedRelease), reviewerKey, epoch, client })
  }

  return <div className="stack">
    <PageHeader eyebrow="SAFETY CONTRACT" title="안전 정책 검토" description="저장된 정책과 변경 내역을 검토하고, 검증·승인·거절을 요청합니다." />
    <form className="panel form-grid" onSubmit={applyCredentials}>
      <label>정책 Release<select aria-label="정책 Release" value={releaseId} onChange={event => {
        const next = event.target.value; setReleaseId(next); setSession(null); onReleaseChange?.(next)
      }}><option value="">Release 선택</option>{releases.map(release => <option key={release.id} value={release.id}>Release v{release.version} · {release.id}</option>)}</select></label>
      <label>검토자 키<input aria-label="검토자 키" type="password" autoComplete="off" spellCheck={false} value={reviewerKey} onChange={event => {
        setReviewerKey(event.target.value); setEpoch(value => value + 1); setSession(null)
      }} /></label>
      <p className="muted">키는 이 화면의 메모리에만 유지됩니다. 페이지를 벗어나면 다시 입력해야 합니다.</p>
      <button className="primary-button" disabled={!selectedRelease || !reviewerKey}>계약 목록 조회</button>
    </form>
    {records.size > 0 && <Notice title={`확인할 이전 요청 ${records.size}건`} tone="amber">
      <ul>{Array.from(records.values()).map(record => <li key={targetKey(record.operation.identity)}>
        계약 v{record.operation.identity.version} · <code>{record.operation.identity.versionId}</code> · {record.phase === 'pending' ? '응답 대기 중' : '처리 여부 미확정'}
      </li>)}</ul>
      버전이나 키를 바꿔도 이전 요청이 취소되지는 않습니다. 해당 버전에서 처리 상태를 확인해 주세요.
    </Notice>}
    {Array.from(generationRecords.values()).filter(record => record.phase === 'unknown' || record.phase === 'submitting').map(record =>
      <Notice key={record.request.releaseId} title={record.phase === 'unknown' ? '생성 접수 여부 미확정' : '생성 접수 응답 대기 중'} tone="amber">
        Release <code>{record.request.releaseId}</code> · 요청 참조 <code>{record.request.idempotencyKey}</code>
        <p>화면 이동은 서버 작업 취소가 아닙니다. 미확정 요청은 재전송하지 않으며 운영 확인이 필요합니다. 이 기록은 현재 페이지 메모리에만 유지됩니다.</p>
      </Notice>)}
    {!selectedRelease ? <EmptyState title="Release를 선택하세요">검토할 실제 릴리스가 먼저 필요합니다.</EmptyState>
      : currentSession ? <ReviewSession key={currentSession.id} context={currentSession} records={records} perform={perform}
          generationRecord={generationRecords.get(currentSession.releaseId)} submitGeneration={submitGeneration}
          pollGeneration={pollGeneration} generationReading={generationReading} patchBindings={patchBindings} bindPatch={bindPatch} />
        : <Notice title="검토할 릴리스와 검토자 키를 입력해 주세요.">계약 목록을 조회한 뒤 검토할 버전을 직접 선택하세요.</Notice>}
  </div>
}

type Confirmation = { kind: 'new'; action: 'approve' | 'reject'; snapshot: StoredContractReview; patch?: ProposedPatchOperation }
  | { kind: 'retry'; operation: PreparedContractMutation; snapshot: StoredContractReview }

function ReviewSession({ context, records, perform, generationRecord, submitGeneration, pollGeneration, generationReading, patchBindings, bindPatch }: {
  context: Session
  records: ReadonlyMap<string, OperationRecord>
  perform: (operation: PreparedContractMutation, context: Session, signal: AbortSignal) => Promise<MutationResult>
  generationRecord: GenerationRecord | undefined
  submitGeneration: (request: PreparedGeneration, context: Session, signal: AbortSignal) => Promise<void>
  pollGeneration: (context: Session) => void
  generationReading: boolean
  patchBindings: ReadonlyMap<string, PatchBinding>
  bindPatch: (identity: ContractVersionIdentity, operation: ProposedPatchOperation, context: Session) => void
}) {
  const [findingId, setFindingId] = useState('')
  const [generationError, setGenerationError] = useState<ContractRequestError | null>(null)
  const [candidateReadFailed, setCandidateReadFailed] = useState(false)
  const admissionController = useRef<AbortController | null>(null)
  const [versions, setVersions] = useState<readonly ContractVersionSummary[] | null>(null)
  const [selected, setSelected] = useState<ContractVersionIdentity | null>(null)
  const [review, setReview] = useState<StoredContractReview | null>(null)
  const [busy, setBusy] = useState(true)
  const [mutationPending, setMutationPending] = useState(false)
  const [error, setError] = useState<ContractRequestError | null>(null)
  const [message, setMessage] = useState('')
  const [processedReadFailed, setProcessedReadFailed] = useState(false)
  const [comment, setComment] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [consent, setConsent] = useState(false)
  const [reconciledKey, setReconciledKey] = useState<string | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const getController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const sending = useRef(false)
  const record = selected ? records.get(targetKey(selected)) : undefined
  const current = (token: number) => mounted.current && generation.current === token

  useEffect(() => {
    mounted.current = true
    const token = ++generation.current
    const controller = new AbortController(); getController.current = controller
    void context.client.listVersions(context.releaseId, context.reviewerKey, controller.signal)
      .then(items => { if (current(token)) setVersions(items) })
      .catch(cause => { if (current(token)) setError(safeError(cause)) })
      .finally(() => { if (current(token)) setBusy(false) })
    return () => {
      mounted.current = false; generation.current++
      getController.current?.abort(); mutationController.current?.abort(); admissionController.current?.abort()
    }
  }, [context])

  function patchFor(view: StoredContractReview): ProposedPatchOperation | undefined {
    const binding = patchBindings.get(targetKey(view.identity))
    return binding && binding.client === context.client && binding.epoch === context.epoch && binding.releaseSignature === context.releaseSignature
      && sameIdentity(binding.identity, view.identity) && binding.operation.result.policyHash === view.policyHash
      ? binding.operation : undefined
  }

  const selectedPatch = review ? patchBindings.get(targetKey(review.identity)) : undefined
  const patchMismatch = Boolean(review && selectedPatch && selectedPatch.client === context.client
    && selectedPatch.epoch === context.epoch && selectedPatch.releaseSignature === context.releaseSignature && !patchFor(review))

  function generate(kind: 'CONTRACT' | 'PATCH') {
    if (generationBlocked(generationRecord) || busy || mutationPending || sending.current || versions === null
      || (kind === 'PATCH' && (!review || record))) return
    try {
      const request = kind === 'CONTRACT' ? prepareInitialGeneration(context.releaseId)
        : preparePatchGeneration(findingId, review!.identity)
      setGenerationError(null)
      const controller = new AbortController(); admissionController.current = controller
      void submitGeneration(request, context, controller.signal)
    } catch (cause) { setGenerationError(safeError(cause)) }
  }

  async function openGeneratedCandidate() {
    if (!generationRecord || !candidateOperation(generationRecord.operation) || busy || mutationPending
      || generationRecord.client !== context.client || generationRecord.epoch !== context.epoch || generationRecord.releaseSignature !== context.releaseSignature) return
    const token = ++generation.current
    getController.current?.abort()
    const controller = new AbortController(); getController.current = controller
    setBusy(true); setReview(null); setSelected(null); setConfirmation(null); setConsent(false); setComment('')
    setError(null); setCandidateReadFailed(false); setMessage(''); setReconciledKey(null)
    try {
      const items = await context.client.listVersions(context.releaseId, context.reviewerKey, controller.signal)
      if (!current(token)) return
      const operation = candidateOperation(generationRecord.operation)!
      const candidate = items.find(item => item.identity.versionId === operation.result.contractVersionId)
      if (!candidate || !candidateMatches(generationRecord, candidate)) throw new ContractRequestError(null,
        { code: 'CONTRACT_RESPONSE_INVALID', retryable: false }, 'not_sent')
      const loaded = await context.client.review(candidate.identity, context.reviewerKey, controller.signal)
      if (!current(token)) return
      if (!candidateMatches(generationRecord, loaded)) throw new ContractRequestError(null,
        { code: 'CONTRACT_RESPONSE_INVALID', retryable: false }, 'not_sent')
      setVersions(items); setSelected(loaded.identity); setReview(loaded); updateVersion(loaded)
      if (operation.kind === 'PATCH' && operation.outcome === 'PROPOSED') bindPatch(loaded.identity, operation, context)
    } catch (cause) {
      if (current(token)) { setError(safeError(cause)); setCandidateReadFailed(true) }
    } finally { if (current(token)) setBusy(false) }
  }

  function updateVersion(version: ContractVersionSummary) {
    setVersions(items => items?.map(item => sameIdentity(item.identity, version.identity)
      ? { identity: version.identity, state: version.state, policyHash: version.policyHash, resourceHash: version.resourceHash } : item) ?? null)
  }

  async function readReview(identity: ContractVersionIdentity, options: { preserveMessage?: boolean; preserveError?: boolean; afterSuccess?: boolean } = {}) {
    const token = ++generation.current
    getController.current?.abort(); mutationController.current?.abort()
    const controller = new AbortController(); getController.current = controller
    setSelected(identity); setReview(null); setConfirmation(null); setConsent(false); setReconciledKey(null); setBusy(true)
    setProcessedReadFailed(false)
    if (!options.preserveMessage) setMessage('')
    if (!options.preserveError) setError(null)
    try {
      const loaded = await context.client.review(identity, context.reviewerKey, controller.signal)
      if (!current(token)) return
      setReview(loaded); updateVersion(loaded)
      const pending = records.get(targetKey(identity))
      if (pending?.phase === 'unknown') setReconciledKey(pending.operation.idempotencyKey)
    } catch (cause) {
      if (current(token)) { setError(safeError(cause)); setProcessedReadFailed(options.afterSuccess === true) }
    } finally { if (current(token)) setBusy(false) }
  }

  const canRetry = Boolean(review && record?.phase === 'unknown' && record.epoch === context.epoch
    && reconciledKey === record.operation.idempotencyKey && sameIdentity(review.identity, record.operation.identity)
    && `"${review.resourceHash}"` === record.operation.ifMatch && eligible(review, record.operation.action))

  async function send(operation: PreparedContractMutation) {
    if (sending.current) return
    sending.current = true
    setMutationPending(true)
    const token = ++generation.current
    getController.current?.abort()
    const controller = new AbortController(); mutationController.current = controller
    setConfirmation(null); setConsent(false); setReconciledKey(null); setBusy(true); setError(null); setMessage(''); setProcessedReadFailed(false)
    try {
      const result = await perform(operation, context, controller.signal)
      if (!current(token)) return
      mutationController.current = null
      if (result.ok) {
        setMessage(`계약 ${actionNames[operation.action]} 요청이 처리되었습니다.`)
        updateVersion(result.version)
        await readReview(operation.identity, { preserveMessage: true, afterSuccess: true })
      } else {
        setError(result.error)
        if (result.error.status === 409 && result.error.outcome === 'rejected') {
          setMessage('이전 동의를 해제했습니다. 최신 내용을 확인하고 다시 검토해 주세요.')
          await readReview(operation.identity, { preserveMessage: true, preserveError: true })
        }
      }
    } finally {
      sending.current = false
      if (mounted.current) setMutationPending(false)
      if (current(token)) setBusy(false)
    }
  }

  function validate() {
    if (!review || !eligible(review, 'validate') || record || busy || mutationPending || sending.current) return
    try { void send(prepareContractMutation('validate', review)) }
    catch (cause) { setError(safeError(cause)) }
  }

  function openConfirmation(action: 'approve' | 'reject') {
    if (!review || !eligible(review, action) || record || busy || mutationPending || sending.current
      || (action === 'approve' && patchMismatch)) return
    setConsent(false); setConfirmation({ kind: 'new', action, snapshot: review, patch: action === 'approve' ? patchFor(review) : undefined })
  }

  function confirm() {
    if (!confirmation || !consent || busy || mutationPending || sending.current || confirmation.snapshot !== review) return
    if (confirmation.kind === 'retry') {
      if (canRetry && record?.operation === confirmation.operation) void send(confirmation.operation)
      return
    }
    if (record || !eligible(confirmation.snapshot, confirmation.action)) return
    if (confirmation.patch !== (confirmation.action === 'approve' ? patchFor(confirmation.snapshot) : undefined)) return
    try { void send(confirmation.action === 'approve' && confirmation.patch
      ? prepareContractMutation('approve', confirmation.snapshot, comment, confirmation.patch)
      : prepareContractMutation(confirmation.action, confirmation.snapshot, comment)) }
    catch (cause) { setError(safeError(cause)); setConsent(false) }
  }

  const commentValid = comment.length > 0 && comment.length <= 1000 && comment === comment.trim()

  return <div className="stack">
    <section aria-label="후보 생성 작업">
      <Panel title="후보 생성 작업" description="생성 접수와 저장 후보 검토는 별도 단계입니다. 검증·승인 요청은 직접 확인한 뒤 전송합니다.">
        <div className="button-row"><button className="secondary-button" disabled={busy || mutationPending || versions === null || generationBlocked(generationRecord)} onClick={event => { if (event.detail < 2) generate('CONTRACT') }}>초기 계약 후보 생성</button></div>
        <label>패치 출처 Finding ID<input aria-label="패치 출처 Finding ID" value={findingId} onChange={event => setFindingId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <p className="muted">패치 기준은 현재 선택해 조회한 계약입니다. Finding의 적격성과 최신 기준본은 서버가 확인합니다.</p>
        <button className="secondary-button" disabled={!review || busy || mutationPending || Boolean(record) || !findingId || generationBlocked(generationRecord)} onClick={event => { if (event.detail < 2) generate('PATCH') }}>패치 후보 생성</button>
        <ErrorBanner error={generationError ?? generationRecord?.error ?? null} />
        {generationRecord?.phase === 'accepted' && generationRecord.operation && <>
          <DataTable caption="후보 생성 상태" headings={['기록', '값']} rows={[
            ['Operation ID', <code>{generationRecord.operation.operationId}</code>], ['종류', generationRecord.operation.kind],
            ['상태', generationRecord.operation.status], ['판단 결과', generationRecord.operation.outcome ?? '없음'],
            ['생성 시각', generationRecord.operation.createdAt], ['시작 시각', generationRecord.operation.startedAt ?? '기록 없음'],
            ['종료 시각', generationRecord.operation.finishedAt ?? '기록 없음'],
            ['오류 코드', generationRecord.operation.errorCode ?? '없음'], ['오류 단계', generationRecord.operation.errorStage ?? '없음'],
          ]} />
          {generationRecord.operation.status === 'SUCCEEDED' && <ul aria-label="생성 판단 코드">{generationRecord.operation.result.issues.map((issue, index) => <li key={index}><code>{issue.code}</code></li>)}</ul>}
          {generationRecord.readError && <Notice title="생성 상태 조회 실패" tone="amber">마지막 정상 상태를 유지합니다. 조회 실패는 작업 실패가 아닙니다.<ErrorBanner error={generationRecord.readError} /></Notice>}
          {generationRecord.operation.status === 'RECOVERY_REQUIRED' && <Notice title="생성 작업 운영 복구 필요" tone="amber">외부 실행 여부가 불확실합니다. 새 생성 요청을 보내지 말고 운영 확인을 진행해 주세요.</Notice>}
          {generationRecord.operation.status === 'SUCCEEDED' && !candidateOperation(generationRecord.operation) && <Notice title="생성 판단 완료 · 저장 후보 없음">이 결과에서 검토하거나 승인할 새 후보는 없습니다.</Notice>}
          <div className="button-row">
            <button className="secondary-button" disabled={generationReading} onClick={() => pollGeneration(context)}>생성 상태 다시 조회</button>
            {candidateOperation(generationRecord.operation) && <button className="secondary-button" disabled={busy || mutationPending || generationRecord.client !== context.client || generationRecord.epoch !== context.epoch || generationRecord.releaseSignature !== context.releaseSignature} onClick={() => void openGeneratedCandidate()}>생성된 후보 검토</button>}
          </div>
          {generationReading && <p role="status">생성 상태를 조회하는 중</p>}
        </>}
        {candidateReadFailed && <Notice title="생성 완료 · 저장 후보 조회 실패" tone="amber">생성 요청을 다시 보내지 말고 저장 후보를 다시 조회해 주세요.</Notice>}
      </Panel>
    </section>
    <ErrorBanner error={error} />
    {error && <p className="muted"><code>{error.code}</code>{error.status !== null && ` · HTTP ${error.status}`}{error.traceId && <> · 요청 추적 <code>{error.traceId}</code></>}</p>}
    {message && <div className="success-banner" role="status">{message}</div>}
    {processedReadFailed && <Notice title="변경 요청은 처리됐지만 최신 검토 내용을 불러오지 못했습니다." tone="amber">변경 요청을 다시 보내지 말고 최신 계약을 다시 조회해 주세요.</Notice>}
    {versions === null ? busy ? <LoadingBlock label="저장 계약 목록을 불러오는 중" /> : null
      : versions.length === 0 ? <EmptyState title="저장된 계약이 없습니다">이 릴리스에 저장된 계약 후보가 없습니다.</EmptyState>
        : <Panel title="저장 버전 이력" description="목록에서 버전을 선택하면 해당 저장본을 다시 조회합니다.">
          <DataTable caption="저장 버전 이력" headings={['계약 / 버전', '저장 상태', 'Policy hash', '검토']} rows={versions.map(version => [
            <><span>{version.identity.contractKey}</span><small>v{version.identity.version} · {version.identity.versionId}</small></>,
            <Badge tone="blue">{version.state}</Badge>, <code>{version.policyHash}</code>,
            <button className="secondary-button" aria-label={`계약 ${version.identity.contractKey} v${version.identity.version} 선택`} aria-pressed={selected?.versionId === version.identity.versionId}
              onClick={() => { setComment(''); void readReview(version.identity) }}>검토</button>,
          ])} />
        </Panel>}
    {selected && <div className="button-row"><button className="secondary-button" disabled={busy} onClick={() => void readReview(selected, { preserveMessage: true, afterSuccess: processedReadFailed })}>최신 계약 다시 조회</button></div>}
    {record?.phase === 'pending' && <Notice title="요청 응답을 기다리고 있습니다." tone="amber">다른 버전으로 이동해도 서버 요청이 취소되었다고 볼 수 없습니다.</Notice>}
    {mutationPending && record?.phase !== 'pending' && <Notice title="이전 변경 요청의 응답을 기다리고 있습니다." tone="amber">응답 대기가 끝나면 현재 버전의 검토 작업을 진행할 수 있습니다.</Notice>}
    {record?.phase === 'unknown' && <Notice title="요청 처리 여부가 미확정입니다." tone="amber">
      <p>새 변경 요청을 보내기 전에 처리 상태를 확인해야 합니다. 같은 hash가 조회되어도 이전 요청의 미실행을 뜻하지 않습니다.</p>
      <p>요청 참조: <code>{record.operation.idempotencyKey}</code></p>
      <div className="button-row">
        <button className="secondary-button" disabled={busy} onClick={() => selected && void readReview(selected)}>처리 상태 다시 조회</button>
        <button className="secondary-button" disabled={!canRetry || busy || mutationPending} onClick={() => {
          if (review && canRetry && !busy && !mutationPending && !sending.current) { setConsent(false); setConfirmation({ kind: 'retry', operation: record.operation, snapshot: review }) }
        }}>동일 요청 재전송 검토</button>
      </div>
      {!canRetry && <p className="muted">최신 상태와 원래 자격을 확인할 수 없거나 계약이 변경된 경우 운영 확인이 필요합니다. 현재 상태만으로 이전 요청의 처리 결과를 확정하지 않습니다.</p>}
    </Notice>}
    {selected && busy && <LoadingBlock label={record?.phase === 'pending' ? '계약 변경 응답을 기다리는 중' : '저장 계약을 불러오는 중'} />}
    {review && <>
      {patchMismatch && <Notice title="저장 후보와 패치 제안의 연결을 확인할 수 없습니다." tone="amber">정책 식별자와 hash를 다시 확인해 주세요. 이 연결로 승인 요청을 보내지 않습니다.</Notice>}
      <PolicyReviewDetails review={review} />
      {(review.state === 'CANDIDATE' || review.state === 'VALIDATED') && <Panel title="검토 작업" description="승인 가능 여부와 현재 릴리스 조건은 서버가 최종 확인합니다.">
        <div className="button-row">
          {review.state === 'CANDIDATE' && <button className="secondary-button" disabled={busy || mutationPending || Boolean(record)} onClick={validate}>계약 검증</button>}
          {review.state === 'VALIDATED' && <button className="primary-button" disabled={busy || mutationPending || Boolean(record) || patchMismatch || !eligible(review, 'approve')} onClick={() => openConfirmation('approve')}>승인 검토</button>}
          <button className="secondary-button" disabled={busy || mutationPending || Boolean(record)} onClick={() => openConfirmation('reject')}>거절 검토</button>
        </div>
      </Panel>}
    </>}
    {confirmation && <Modal title={confirmation.kind === 'retry' ? '동일 요청 재전송 확인' : `계약 ${actionNames[confirmation.action]} 확인`} onClose={() => { setConfirmation(null); setConsent(false) }}>
      <DataTable caption="변경 요청 확인" headings={['검토 대상', '값']} rows={[
        ['계약 버전', `${confirmation.snapshot.identity.contractKey} v${confirmation.snapshot.identity.version}`],
        ['Version ID', <code>{confirmation.snapshot.identity.versionId}</code>],
        ['기준 Policy hash', confirmation.snapshot.baseline ? <code>{confirmation.snapshot.baseline.policyHash}</code> : '기록된 승인 기준본 없음'],
        ['결과 Policy hash', <code>{confirmation.snapshot.policyHash}</code>],
        ['Resource hash · 변경 요청 기준', <code>{confirmation.snapshot.resourceHash}</code>],
        ...(confirmation.kind === 'new' && confirmation.patch ? [['Patch Proposal ID', <code>{confirmation.patch.result.patchProposalId}</code>]] : []),
      ]} />
      {confirmation.kind === 'new' ? <label className="section-gap">검토 의견<textarea aria-label="검토 의견" value={comment} maxLength={1000} rows={4} onChange={event => { setComment(event.target.value); setConsent(false) }} /></label>
        : <><p>이전 요청과 같은 식별자·내용으로 다시 전송합니다. 아직 처리되지 않았다면 이 요청으로 실행될 수 있습니다.</p><pre className="code-block" aria-label="이전 요청 본문" style={{ whiteSpace: 'pre-wrap' }}>{confirmation.operation.body}</pre></>}
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        {confirmation.kind === 'new' ? '정책 변경 내용과 검토 의견을 확인했습니다.' : '처리 여부가 미확정인 기존 요청을 같은 내용으로 다시 전송합니다.'}
      </label>
      <div className="form-actions"><button className="secondary-button" onClick={() => { setConfirmation(null); setConsent(false) }}>취소</button>
        <button className="primary-button" disabled={!consent || busy || mutationPending || (confirmation.kind === 'new' ? !commentValid : !canRetry)} onClick={confirm}>
          {confirmation.kind === 'retry' ? '동일 요청 재전송' : `${actionNames[confirmation.action]} 요청 전송`}
        </button></div>
    </Modal>}
  </div>
}
