# B 역할 구현 명세서

## 1. 목적

이 문서는 FINSEC SEAL의 B 역할(Runtime / Attack Execution) 구현 범위를 정의한다.

B 역할은 프론트엔드에서 입력한 사용자 수준의 실행 요청을 받아, 아래 흐름을 조립하고 상태를 관리하는 책임을 가진다.

- Release 검증
- Ready 상태의 Test Suite 선택
- Test Run 생성
- FA category별 Orchestrator 실행
- Case별 이벤트 저장
- 진행률/오류 상태 갱신
- 실행 종료 상태 전이
- Oracle/Finding/Trace 조회를 위한 Evidence 생성
- Replay comparability 저장 및 D 연동


## 2. 역할 경계

### B 책임

- 공격 및 Replay 실행 시작
- Agent/Tool 실행 흐름 조립
- C Policy Gateway 호출
- 실행 Event와 Sandbox side effect 생성 및 저장
- Oracle이 사용할 Evidence 생성
- Run/Case 상태 관리
- Replay comparability 결과 저장

### C 책임

- Policy 및 Safety Contract 평가
- Replay 비교 가능 여부와 불일치 사유 계산

### D 책임

- 저장된 Evidence 기반 Oracle 판정
- Finding 생성
- Release Metrics 계산
- Replay 비교 불가 결과 반영
- Release Decision 계산 및 확정

프론트엔드는 C/D의 계산 로직을 재구현하지 않고, 백엔드가 계산한 결과를 조회해 표시한다.


## 3. 외부 공개 API 명세

### 3.1 Test Suite 목록 조회

```http
GET /api/v1/releases/{releaseId}/test-suites
```

#### 요청

- Path parameter
  - releaseId: string

- Query parameter
  - status: optional, 예: READY
  - limit: optional
  - cursor: optional

#### 응답

```json
{
  "data": {
    "items": [
      {
        "id": "suite-uuid",
        "releaseId": "release-uuid",
        "version": "1.0",
        "status": "READY",
        "suiteHash": "sha256:...",
        "caseCount": 20
      }
    ],
    "nextCursor": null
  },
  "traceId": "trace-id",
  "timestamp": "2026-09-07T00:00:00Z"
}
```

#### 구현 규칙

- releaseId가 존재하는지 검증한다.
- `READY` 상태인 Suite만 실행 가능하게 노출한다.
- `caseCount`는 최종 사용 시 수치적으로 정확해야 한다.
- `status` 값은 `READY`, `PENDING`, `INVALID` 등으로 확장 가능해야 한다.


### 3.2 Release별 Test Run 목록 조회

```http
GET /api/v1/releases/{releaseId}/test-runs
```

#### 요청

- Path parameter
  - releaseId: string

- Query parameter
  - mode: optional, values = BASELINE | SEAL_REPLAY | HELD_OUT | REGRESSION
  - status: optional
  - limit: optional
  - cursor: optional

#### 응답

```json
{
  "data": {
    "items": [
      {
        "id": "run-uuid",
        "releaseId": "release-uuid",
        "suiteId": "suite-uuid",
        "mode": "BASELINE",
        "status": "COMPLETED",
        "totalCases": 20,
        "completedCases": 20,
        "operationalErrorCount": 0,
        "latestSequence": 120,
        "startedAt": "2026-09-07T01:00:00Z",
        "completedAt": "2026-09-07T01:05:00Z"
      }
    ],
    "nextCursor": null
  },
  "traceId": "trace-id",
  "timestamp": "2026-09-07T01:05:00Z"
}
```

#### 구현 규칙

- `releaseId`의 Runs만 조회한다.
- `mode`와 `status` 필터는 선택적이며, 백엔드에서 기본 정렬을 유지한다.
- `nextCursor`는 무한 스크롤 또는 페이지네이션을 위한 기본 구조로 지원한다.
- 기존 Run ID를 외부에서 직접 알고 있지 않아도 이전 실행 결과를 확인할 수 있어야 한다.


### 3.3 공격 및 Replay 실행 시작

```http
POST /api/v1/test-runs
```

#### 요청 본문

일반 실행:

```json
{
  "releaseId": "release-uuid",
  "suiteId": "suite-uuid",
  "mode": "BASELINE",
  "contractVersionId": null,
  "caseIds": [],
  "randomSeed": 42
}
```

Replay 실행:

```json
{
  "releaseId": "release-uuid",
  "suiteId": "suite-uuid",
  "mode": "SEAL_REPLAY",
  "contractVersionId": "contract-version-uuid",
  "caseIds": ["case-uuid"],
  "randomSeed": 42
}
```

#### 응답

```json
{
  "data": {
    "runId": "run-uuid",
    "status": "QUEUED",
    "statusUrl": "/api/v1/test-runs/run-uuid",
    "streamUrl": "/api/v1/test-runs/run-uuid/events"
  },
  "traceId": "trace-id",
  "timestamp": "2026-09-07T01:00:00Z"
}
```

#### 구현 규칙

- `releaseId`와 `suiteId`가 존재하는지 검증한다.
- `suiteId`는 해당 Release에 속하는지 확인한다.
- 선택한 suite가 `READY` 상태여야 한다.
- `caseIds`가 비어 있으면 suite에 속한 전체 case를 실행한다.
- `randomSeed`는 선택값이며 null로 전달 가능해야 한다.
- 실행 요청이 유효하면 즉시 Run을 생성하고 status를 `QUEUED` 또는 `RUNNING` 중간 상태로 전이한다.


## 4. 내부 플랫폼 API와 공개 실행 API 구분

아래 API는 Runtime 내부의 영속화 구조로 유지한다.

```http
POST /api/v1/platform/test-runs
POST /api/v1/platform/test-runs/{runId}:status
POST /api/v1/platform/test-runs/{runId}/case-runs
POST /api/v1/platform/test-runs/{runId}/case-runs/{caseRunId}:status
```

### 정책

- 공개 실행 API는 사용자 입력만 받는다.
- 공개 실행 API는 내부 Platform API와 Orchestrator를 조립한다.
- 프론트엔드는 fixture digest, model config hash, case 상태 등 내부 구현 세부사항을 직접 조립해 호출하지 않는다.
- 공개 실행 API는 사용자 목표를 전달하고, B 백엔드가 내부 구현을 조합한다.


## 5. 실행 플로우 요구사항

### 5.1 일반 실행

1. Release 검증
2. Suite 존재 여부와 READY 상태 검증
3. Test Run 생성
4. 선택된 FA category의 Orchestrator 실행
5. 각 Case에 대해 실행 및 Event 저장
6. 상태와 진행률 갱신
7. 종료 시 Run 상태를 `COMPLETED` 또는 실패 상태로 전이
8. `runId`, `statusUrl`, `streamUrl` 응답 반환

### 5.2 Replay 실행

Replay 실행은 일반 실행에서 추가로 다음을 포함한다.

1. `baselineRunId`의 Release, Suite, fixture, model, variant 조건 확인
2. C의 Replay comparability 계산
3. `comparable`, `mismatchReasons` 저장
4. D Release Assurance에서 조회할 수 있도록 Run/Release와 연결


## 6. 상태 모델

### Test Suite 상태

- READY
- PENDING
- INVALID

### Test Run 상태

- QUEUED
- RUNNING
- COMPLETED
- FAILED
- CANCELED

### 선택 가능한 execution mode

- BASELINE
- SEAL_REPLAY
- HELD_OUT
- REGRESSION

### 이벤트 상태

- 저장 여부
- Hash 체인 검증
- Policy decision 반영
- reasonCode 포함


## 7. 데이터 계약

### 7.1 TestRun DTO

```ts
interface TestRun {
  id: string
  releaseId: string
  suiteId: string
  contractVersionId: string | null
  mode: 'BASELINE' | 'SEAL_REPLAY' | 'HELD_OUT' | 'REGRESSION'
  status: string
  agentArtifactFingerprint: string
  releaseFingerprint: string
  fixtureVersion: string
  fixtureDigest: string
  totalCases: number
  completedCases: number
  operationalErrorCount: number
  latestSequence: number
  latestEventType: string | null
  eventHeadHash: string | null
  summary: JsonValue
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}
```

### 7.2 TestRunStart DTO

```ts
interface TestRunStart {
  releaseId: string
  suiteId: string
  mode: 'BASELINE' | 'SEAL_REPLAY' | 'HELD_OUT' | 'REGRESSION'
  contractVersionId: string | null
  caseIds: string[]
  randomSeed: number | null
}
```

### 7.3 TestRunRegistered DTO

```ts
interface TestRunRegistered {
  runId: string
  status: string
  statusUrl: string
  streamUrl: string
}
```

### 7.4 Event DTO

```ts
interface ExecutionEvent {
  schemaVersion: string
  eventId: string
  traceId: string
  runId: string
  testCaseRunId: string | null
  sequence: number
  occurredAt: string
  eventType: string
  toolName: string | null
  input: JsonValue
  output: JsonValue
  payloadDigest: string
  policyDecision: JsonValue
  reasonCode: string | null
  metadata: JsonValue
  prevEventHash: string | null
  eventHash: string
}
```

#### Event 규칙

- `eventId`는 고유해야 한다.
- `sequence`는 run 단위로 증가해야 한다.
- `prevEventHash`와 `eventHash`를 사용해 hash chain을 구성한다.
- `policyDecision`은 C 평가 결과를 반영해야 한다.
- `reasonCode`는 정상/오류/정책거부 등을 구분하여 기록해야 한다.


## 8. 구현 체크리스트

### 필수 구현

- [ ] Release별 Test Suite 목록 API 구현
- [ ] Release별 Test Run 목록 API 구현
- [ ] 공개 POST /api/v1/test-runs 구현
- [ ] Ready Suite 검증 로직 추가
- [ ] Run 생성 및 상태 전이 로직 추가
- [ ] Case 실행 및 event 저장 로직 추가
- [ ] Event hash chain 계산 로직 추가
- [ ] Replay comparability 저장 로직 추가
- [ ] D 검토용 결과 연결 확인

### 선택 구현

- [ ] SSE stream 엔드포인트 안정화
- [ ] 업그레이드 가능한 에러 코드 표준화
- [ ] 목록 API pagination 개선
- [ ] run 상태 집계/실시간 통계 제공


## 9. 비기능 요구사항

### 9.1 안정성

- 요청 실패 시 traceId를 포함해 추적 가능해야 한다.
- `QUEUED` 상태부터 `COMPLETED` 상태까지의 lifecycle가 항상 추적 가능해야 한다.
- 중간 실패 시 상태를 명확하게 남겨야 한다.

### 9.2 관찰성

- `traceId`와 `runId`를 로그에 포함한다.
- Event sequence, hash, reasonCode를 함께 저장한다.
- 운영자/리뷰어가 이전 실행을 추적할 수 있어야 한다.

### 9.3 보안

- 사용자 입력으로 준 `caseIds`는 허용 범위를 검증한다.
- 생성된 run은 해당 release/suite 범위 안에서만 접근 가능해야 한다.
- 정책 거부와 side effect는 audit trail로 남겨야 한다.


## 10. 프론트엔드 연동 포인트

현재 프론트엔드는 아래 흐름으로 동작한다.

- [src/features/Execution.tsx](src/features/Execution.tsx)
  - `start()` 호출
  - `inspect()` 호출
- [src/api/client.ts](src/api/client.ts)
  - `startTestRun()`
  - `testRun()`
  - `eventHistory()`
  - `verifyEventChain()`
  - `runOracleResults()`
  - `runFindings()`

즉, B 백엔드가 해당 API를 제공하면 프론트엔드 화면은 즉시 동작 가능하다.


## 11. 최종 구현 우선순위

1. GET /api/v1/releases/{releaseId}/test-suites
2. GET /api/v1/releases/{releaseId}/test-runs
3. POST /api/v1/test-runs
4. Replay comparability 저장
5. D 연동 확인

이 순서를 우선적으로 구현하면 현재 FE 요구사항을 가장 빠르게 충족할 수 있다.


## 12. 완료 기준

다음 조건을 모두 만족하면 B 역할 구현은 완료로 판단한다.

- Release 선택 시 Suite 목록을 조회할 수 있다.
- Suite READY 여부를 프론트에서 구분할 수 있다.
- 실행 시작 시 Run ID를 발급받고 status를 확인할 수 있다.
- 생성된 Run을 다시 조회해 Trace/Event/Oracle/Finding을 확인할 수 있다.
- Replay 실행 시 comparability를 저장하고 D가 조회할 수 있다.
- Error, Empty, Loading 상태가 정상적으로 표시된다.
