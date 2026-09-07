# B 역할 프론트엔드 구현 및 백엔드 연동 요청서

## 1. 목적

이 문서는 FINSEC SEAL의 B 역할(Runtime / Attack Execution) 프론트엔드 구현 범위와 현재 백엔드 연동 상태를 공유하고, B 백엔드에서 추가로 제공해야 할 API를 정의한다.

현재 프론트엔드 작업 브랜치는 `feat/b-execution-console`이다. B 백엔드의 `origin/feat/b-execution-api`(`de0f2ea`) 계약을 반영했다.

## 2. 구현된 프론트엔드

사이드바에 `Runs & Trace` 화면을 추가했다.

### 공격 카탈로그

- FA-01: 악성 문서 지시
- FA-02: 타 고객 데이터 조회
- FA-03: 민감정보 과다 조회
- FA-04: 외부 정보 유출
- FA-05: 고위험 상태 변경

### Test Run 조회

- Test Run ID 입력
- 실행 상태 표시
- 실행 모드 표시: `BASELINE`, `SEAL_REPLAY`, `HELD_OUT`, `REGRESSION`
- 전체 Case 수 및 완료 Case 수 표시
- 운영 오류 수 표시
- 시작·완료 시각 및 실행 요약을 받을 수 있는 타입 정의

### Trace 및 Evidence 조회

- Run의 Execution Event History 조회
- Event sequence 기반 타임라인 표시
- `eventType`, `toolName`, `reasonCode` 표시
- Tool input/output JSON 표시
- Policy decision JSON 표시
- Event metadata 표시
- Event hash 및 head hash 표시
- Event hash chain 무결성 검증 결과 표시

### D 평가 결과 연결

- Run별 Oracle 결과 조회 및 표시
- Run별 Finding 결과 조회 및 표시
- B 실행 결과에서 D 평가 결과까지 한 화면에서 추적

### 화면 상태

- Loading, Empty, Error 상태 처리
- 백엔드 미제공 기능을 `START API PENDING`으로 표시
- 모바일 반응형 레이아웃 적용

## 3. 현재 연결된 백엔드 API

다음 API는 현재 BE `dev`에 구현되어 있으며 프론트엔드에 연결했다.

| 기능 | Method | Endpoint |
|---|---|---|
| Test Run 상세 | GET | `/api/v1/test-runs/{runId}` |
| Event History | GET | `/api/v1/test-runs/{runId}/event-history?after=0&limit=100` |
| Event Chain 검증 | GET | `/api/v1/test-runs/{runId}/events:verify` |
| Run별 Oracle 결과 | GET | `/api/v1/test-runs/{runId}/oracle-results` |
| Run별 Finding | GET | `/api/v1/test-runs/{runId}/findings` |
| Event 실시간 스트림 | GET (SSE) | `/api/v1/test-runs/{runId}/events` |

현재 프론트엔드는 Run ID를 알고 있을 때 Run 상세, Trace, Oracle, Finding을 조회할 수 있다.

## 4. B 백엔드에 필요한 API

실행 시작 API는 B의 `feat/b-execution-api` 브랜치에 추가됐다. 아직 BE `dev`에는 병합 전이며 Test Suite/Run 목록 API는 없다.

### 4.1 Test Suite 목록 조회

프론트엔드에서 실행할 Suite를 선택하기 위해 필요하다.

```http
GET /api/v1/releases/{releaseId}/test-suites
```

권장 응답:

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
    ]
  },
  "traceId": "trace-id",
  "timestamp": "2026-09-07T00:00:00Z"
}
```

프론트에서 실행 가능한 Suite는 최소한 `READY` 상태인지 구분할 수 있어야 한다.

### 4.2 Release별 Test Run 목록 조회

현재는 Run ID를 외부에서 알아야만 조회할 수 있다. Release를 선택하면 이전 실행을 찾을 수 있도록 목록 API가 필요하다.

```http
GET /api/v1/releases/{releaseId}/test-runs
```

권장 Query Parameter:

- `mode`: 선택, `BASELINE`, `SEAL_REPLAY`, `HELD_OUT`, `REGRESSION`
- `status`: 선택
- `limit`: 선택
- `cursor`: 선택

권장 응답:

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

### 4.3 공격 및 Replay 실행 시작

현재 `Fa02ExecutionOrchestrator`부터 `Fa05ExecutionOrchestrator`까지 서비스는 존재하지만 프론트엔드에서 호출할 공개 Controller가 없다.

```http
POST /api/v1/test-runs
```

일반 실행 요청 예시:

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

Replay 요청 예시:

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

권장 응답:

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

### 실행 API 내부 책임

실행 API는 다음 흐름을 조립해야 한다.

1. Release와 READY Test Suite 검증
2. Test Run 생성
3. 선택된 FA category의 Orchestrator 호출
4. Case Run 및 Event 저장
5. 실행 상태와 Case 진행률 갱신
6. 실행 종료 시 Run을 `COMPLETED` 또는 실패 상태로 전이
7. 생성된 `runId`, `statusUrl`, `streamUrl` 반환

Replay 실행이라면 추가로 다음이 필요하다.

1. `baselineRunId`의 Release, Suite, fixture, model 및 variant 조건 확인
2. C의 Replay comparability 계산
3. `comparable`, `mismatchReasons` 저장
4. D Release Assurance에서 조회할 수 있도록 Run/Release와 연결

## 5. 내부 Platform API와 공개 실행 API 구분

현재 아래 API는 존재한다.

```http
POST /api/v1/platform/test-runs
POST /api/v1/platform/test-runs/{runId}:status
POST /api/v1/platform/test-runs/{runId}/case-runs
POST /api/v1/platform/test-runs/{runId}/case-runs/{caseRunId}:status
```

이 API들은 Runtime 내부의 영속화 계약이다. 사용자 프론트엔드에서 fixture digest, model config hash, Case 상태 등을 직접 조립하여 호출하는 용도로 사용하지 않는다.

프론트엔드는 Release, Suite, mode, category, baselineRun 같은 사용자 수준 입력만 전달하고, B 백엔드의 공개 실행 서비스가 내부 Platform API와 Orchestrator를 조립하는 구조를 권장한다.

## 6. 역할 경계

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

- 저장된 Evidence를 Oracle로 판정
- 공격 성공 시 Finding 생성
- Release Metrics 계산
- Replay 비교 불가 결과를 Evidence completeness와 Gate에 반영
- Release Decision 계산 및 확정

프론트엔드가 C 또는 D의 평가 로직을 재구현해서는 안 된다. 백엔드가 저장하고 계산한 결과를 조회하여 표시한다.

## 7. B 담당자에게 전달할 요약

> `feat/b-execution-api`의 `POST /api/v1/test-runs`는 FE 실행 화면에 연결했습니다. 현재 추가로 필요한 것은 `GET /api/v1/releases/{releaseId}/test-suites`와 `GET /api/v1/releases/{releaseId}/test-runs` 두 목록 API입니다. 지금은 Suite ID와 Run ID를 수동 입력해야 합니다. Replay 실행의 comparability 저장 및 D 조회 연결 여부도 확인 부탁드립니다.

## 8. 현재 검증 결과

- TypeScript typecheck 통과
- Frontend test 17개 통과
- Production build 통과
- Runs & Trace 브라우저 화면 확인 완료
