# FINAgent SEAL 프론트엔드 역할별 인수인계

> 각 담당자는 아래에서 **자기 화면 → 수정 파일 → 연결할 데이터/API → 완료 조건**을 확인하고 작업하면 됩니다.
> 공통 디자인과 대화형 샘플 화면은 준비됐지만, 샘플 화면의 존재가 실제 검증 엔진 연동 완료를 의미하지는 않습니다.

## 1. 기준과 현재 상태

- 작성 기준: 2026-09-06, FE `feat/role-a-console`의 디자인 적용 작업 트리. 이 문서는 해당 프론트 변경과 함께 공유하기 위한 문서입니다.
- 백엔드 확인 기준: BE `dev`의 `6cff50a`. 아래 API의 **코드 존재 여부**를 Controller/DTO에서 확인했으며, 이번 문서 작성 중 실제 서버 통합 테스트를 수행한 것은 아닙니다.
- 역할 기준: [BE 4인 역할 분담 §7–8](https://github.com/taegeon3/FINSEC-SEAL-BE/blob/6cff50a/FINSEC_SEAL_4인_역할분담.md). A/B/C/D의 기존 책임을 프론트 작업 단위로 풀어 쓴 것이며 역할이나 기여도를 새로 배정하지 않습니다.
- 화면/디자인 기준: [Figma 적용 기록](FIGMA_FRONTEND_HANDOFF.md), [디자인 시스템](../design_system.md), 실제 [공통 스타일](../src/styles.css).

### 1.1 이미 준비된 것과 남은 것

| 구분 | 현재 준비된 범위 | 이어서 해야 하는 일 |
| --- | --- | --- |
| 공통 UI | 브랜드, Sidebar, Topbar, hash 탐색, 모바일 메뉴, 공통 카드·표·알림·확인창 | 실제 리소스 ID가 유지되는 상세 탐색, 서버 상태와 공통 화면 연결 |
| A | Agent 등록·조회·보관, Release 등록·검증·분석·Fingerprint, Attestation·Audit·Recovery의 기존 API client 연결 유지 | 새 검증 요약/구성 변경 화면과 실제 데이터 연결, Run projection·SSE 소비 계층, 새 DTO 정합성 확인 |
| B | 실행 설정·목록, 대표 공격 Trace, 취소·연결 끊김의 대화형 예시 | 실제 실행 생성·취소와 상태/이벤트 연결, 선택한 사례의 실제 Trace 표시 |
| C | 정책 목록·규칙·승인 확인창·충돌 예시, Gateway·Replay 비교 화면 | Candidate/검증/diff/승인 API, 실제 정책 판단과 비교 가능성 연결 |
| D | Finding·Oracle 근거·지표·Held-out/정상업무·판정 보고서 예시 | 이미 있는 조회·평가 API 연결, 실제 판정 확정 및 A 증적 화면 연결 |

**작업 원칙: 담당 화면을 처음부터 새로 만들기보다, 기존 UI에서 샘플 데이터와 버튼 동작을 자기 도메인의 실제 계약으로 교체합니다.** 공통 파일 분리는 아래 8절의 협업 제안이며 아직 적용되지 않았습니다.

### 1.2 SIMULATED와 LIVE_API를 혼동하지 않기

| 모드 | 진입 예시 | 데이터/동작 |
| --- | --- | --- |
| SIMULATED | `/#/demo/start` | 메모리 fixture와 타이머로 UI 체험. 실제 Agent/LLM/업무 API 호출 없음 |
| LIVE_API | `/#/live/overview` | 연결된 A 기능은 서버 요청. 미연결 화면은 연동 대기 안내 |

- 기본 모드는 SIMULATED입니다. 상단 `환경 설정`에서 모드를 바꿉니다.
- `/#/live/reports`는 현재 D의 새 보고서 목록이 아니라 **A의 `EvidencePage`**를 표시합니다. `/#/live/report`의 새 상세 보고서는 아직 연동 대기입니다.
- 샘플 승인·취소·재시험은 로컬 상태만 바꿉니다. 최종 확정과 Attestation export는 샘플 모드에서 비활성입니다.
- 샘플 입력과 검증 상태는 새로고침/모드 전환 시 사라집니다. 실제 키·고객정보를 입력하지 않습니다.
- `LIVE_API` 배지는 실제 LLM 또는 전체 검증 파이프라인이 가동 중이라는 뜻이 아닙니다. 현재 연결된 API 범위를 뜻합니다.

## 2. 먼저 실행해서 확인하기

FE 레포 루트에서 실행합니다. Node 24와 `package.json`에 명시된 pnpm 11.19.0을 사용합니다.

```bash
nvm use
pnpm install --frozen-lockfile
pnpm dev
```

기본 주소는 `http://localhost:5173`입니다. 5173이 이미 사용 중이면 `pnpm dev --port 5174`처럼 비어 있는 포트를 명시합니다. 다른 팀원의 프로세스를 임의로 종료하지 않습니다.

실제 API 확인 시 `.env`가 없다면 `.env.example`을 복사합니다. 이미 있는 `.env`는 덮어쓰지 않습니다.

```dotenv
VITE_FINSEC_API_BASE_URL=http://localhost:8080
VITE_FINSEC_ACTOR_ID=role-a-console
```

- 환경 변수 변경 후 Vite를 재시작합니다. Backend CORS의 `FINSEC_CORS_ALLOWED_ORIGINS`에 실제 접속 origin을 추가해야 합니다. `localhost`/`127.0.0.1`, 5173/5174는 서로 다른 origin입니다.
- `VITE_*`는 브라우저에 공개되는 설정입니다. Provider 비밀키나 운영자 Recovery key를 넣지 않습니다.
- `X-Actor-Id`는 사용자 인증을 대신하지 않습니다. 브라우저에서 권한을 결정하지 않습니다.
- SIMULATED 확인에는 BE/AI/MOCK 실행이 필요 없습니다. 실제 API 확인은 해당 서비스의 실행 안내를 따릅니다.

권장 체험 순서: `start → trace → finding → policy → replay → verification → report`.
초기 샘플은 기본 실행이 끝난 검토 상태이며, 시작 화면의 체험 버튼을 누르면 새 샘플 실행부터 볼 수 있습니다.

## 3. 코드와 화면 찾기

### 3.1 공통 파일 지도

| 파일 | 현재 역할 | 수정 시 주의 |
| --- | --- | --- |
| [src/App.tsx](../src/App.tsx) | `ProductApp` 진입점을 다시 export | 실제 화면 조립 코드는 여기에 없음 |
| [src/ProductApp.tsx](../src/ProductApp.tsx) | 모드 선택, client 주입, inventory 로딩, 탐색, 화면 조립, `livePages` | 모든 역할이 만지는 충돌 지점. 필요한 변경만 작은 PR로 분리 |
| [src/product/model.ts](../src/product/model.ts) | `Page`, `pageLabels`, 메뉴, `readRoute`, `useDemoWorkflow` | `useDemoWorkflow`는 실제 실행 엔진/서버 상태 모델이 아님 |
| [src/product/EntryPages.tsx](../src/product/EntryPages.tsx) | 시작·워크스페이스·릴리스 목록 | LIVE의 Run/Finding 집계는 현재 `N/A` |
| [src/product/VerificationPages.tsx](../src/product/VerificationPages.tsx) | 검증 상세와 B/C/D 화면 전체 | 여러 역할이 공유 중. 함수 단위로 범위를 정하거나 먼저 분리 |
| [src/features/AgentsReleases.tsx](../src/features/AgentsReleases.tsx) | A의 Agent/Manifest 실제 API 폼 | 기존 `client` 주입, validation, busy/error 처리 유지 |
| [src/features/Evidence.tsx](../src/features/Evidence.tsx), [Audit.tsx](../src/features/Audit.tsx), [Recovery.tsx](../src/features/Recovery.tsx) | A의 증적·감사·운영 복구 | 보고서 계산·정책 승인 로직을 넣지 않음 |
| [src/api/client.ts](../src/api/client.ts) | `FinsecApiClient`, `FinsecApiError`, 요청 헤더/응답 처리, `PlatformClient` | 공통 응답/오류 계약을 재사용. 현재 B/C/D 메서드는 없음 |
| [src/api/contracts.ts](../src/api/contracts.ts) | 현재 A API의 TypeScript DTO | BE enum/DTO와 대조. 타입 선언은 응답의 런타임 검증이 아님 |
| [src/demo/platform.ts](../src/demo/platform.ts) | `createDemoPlatform`, 샘플 ID/Manifest, 격리된 메모리 adapter | 실제 payload·hash·보안 검증 구현으로 재사용 금지 |
| [src/components/Product.tsx](../src/components/Product.tsx) | `Panel`, `Notice`, `Badge`, `DataTable`, `Progress`, `Modal`, `Brand` | 화면마다 복사하지 않고 재사용 |
| [src/components/Primitives.tsx](../src/components/Primitives.tsx) | `PageHeader`, `StatusBadge`, `EmptyState`, `ErrorBanner`, `ShortHash` 등 | 서버 상태와 UI 상태를 한 enum으로 섞지 않음 |
| [src/styles.css](../src/styles.css), [브랜드 원본](../public/assets/brand-reference.png) | 공통 스타일·반응형·로고 | 레이아웃/토큰 변경은 관련 담당자와 함께 확인 |

`src/features/Overview.tsx`는 파일이 남아 있지만 현재 앱에서 사용하지 않습니다. 워크스페이스 수정은 `EntryPages.tsx`의 `WorkspacePage`에서 시작합니다.

### 3.2 역할별 화면 지도

아래 경로는 모두 hash입니다. 실제 접속은 `http://localhost:5173/#/demo/…` 형태입니다.

| 화면 hash | 함수/파일 | 작업 책임 | 현재 실제 API 상태 |
| --- | --- | --- | --- |
| `#/demo/start` | `StartPage` / `EntryPages.tsx` | 공통 제품 소개 | 샘플 진입·등록 탐색 |
| `#/demo/overview` | `WorkspacePage` / `EntryPages.tsx` | A 조립, B 실행·D Finding 요약 제공 | inventory만 연결 |
| `#/demo/agents` | `AgentsPage` / `AgentsReleases.tsx` | A | 연결 코드 있음 |
| `#/demo/releases` | `ReleaseInventory` / `EntryPages.tsx` | A | 목록 연결 코드 있음 |
| `#/demo/manifest` | `ReleasesPage` / `AgentsReleases.tsx` | A | 등록·validate·analyze·fingerprint 연결 |
| `#/demo/release` | `ReleaseOverview`, `ReleaseContext` / `VerificationPages.tsx` | A, 단계별 사실은 B/C/D 제공 | 새 검증 요약은 샘플 |
| `#/demo/runs` | `RunsPage` / `VerificationPages.tsx` | B, 상태 조회 기반은 A | 샘플 |
| `#/demo/trace` | `TracePage` / `VerificationPages.tsx` | B 실행 표시, A 이벤트 조회, D Oracle 근거 | 샘플 |
| `#/demo/findings`, `#/demo/finding` | `FindingsPage`, `FindingDetail` / `VerificationPages.tsx` | D, 정책 후보 링크는 C 협업 | 샘플 |
| `#/demo/policies`, `#/demo/policy` | `PoliciesPage`, `PolicyDetail` / `VerificationPages.tsx` | C | 샘플 |
| `#/demo/gateway` | `GatewayPage` / `VerificationPages.tsx` | C 판단, B 호출 사실, D 결과 | 샘플 |
| `#/demo/replay` | `ReplayPage`, `ComparisonEvidence` / `VerificationPages.tsx` | B 실행 + C 적용/비교 조건 + D 평가 | 샘플 |
| `#/demo/verification` | `VerificationPage` / `VerificationPages.tsx` | D 결과, B 실행, C 집행 | 샘플 |
| `#/demo/reports`, `#/demo/report` | `ReportsPage`, `ReportPage` / `VerificationPages.tsx` | D 판정, A 증적 연결 | 새 화면은 샘플; LIVE reports는 A Evidence로 연결 |
| `#/demo/changed` | `ChangedPage` / `VerificationPages.tsx` | A diff/재검증 상태, C 비교 가능성 | 샘플 |
| `#/demo/evidence` | `EvidencePage` / `features/Evidence.tsx` | A | 실제 조회/export 연결 코드 있음 |
| `#/demo/audit` | `AuditPage` / `features/Audit.tsx` | A | 연결 코드 있음 |
| `#/demo/recovery` | `RecoveryPage` / `features/Recovery.tsx` | A | 연결 코드 있음 |
| `#/demo/states` | `StatesPage` / `VerificationPages.tsx` | 공통, 오류 의미는 해당 도메인 담당 | 예외 상태 가이드 |

## 4. A — Platform / Data / Evidence

### 어디를 수정하나요?

주 작업 파일: `ProductApp.tsx`, `EntryPages.tsx`, `AgentsReleases.tsx`, `Evidence.tsx`, `Audit.tsx`, `Recovery.tsx`.
검증 요약/상단 단계/구성 변경은 `VerificationPages.tsx`의 `ReleaseOverview`, `ReleaseContext`, `ChangedPage`입니다.

### 어떻게 이어서 구현하나요?

1. **실제 리소스 선택부터 연결합니다.** 현재 `readRoute()`는 mode/page만 읽고, `ProductApp`은 Agent 선택만 공유합니다. 상세 URL에 `releaseId/runId/findingId/contractVersionId`를 복원할 계약은 없습니다. 여러 담당자와 탐색 계약을 먼저 정하고, parser·navigate·뒤로 가기 테스트를 함께 수정합니다. 화면 이동 후 임의의 첫 Release 또는 고정 `DEMO_RELEASE_ID`로 되돌아가면 안 됩니다.
2. **Release 목록 → 선택한 버전**을 유지합니다. 현재 `ReleaseInventory`의 열기 동작은 주로 Agent를 선택해 Manifest 화면으로 이동하며, 클릭한 Release를 상세 선택 상태로 끝까지 전달하지 않습니다. B/C/D가 같은 Release를 보도록 실제 ID 전달을 보강합니다.
3. **새 검증 요약과 구성 변경을 서버 데이터로 바꿉니다.** 아래 기존 API를 client/DTO에 추가해 business purpose, fingerprint, diff, effective status를 표시합니다. 원문 Prompt를 내려받아 보여주는 방식으로 대체하지 않습니다.
4. **Run 상태·이벤트 소비 계층을 제공합니다.** BE의 snapshot/history/SSE를 사용해 cursor·순서·중복 제거·연결 상태를 일관되게 처리합니다. B는 이 결과로 실행 화면을 만들고, D는 같은 이벤트/증거 ID를 참조합니다. 진행률은 서버 집계이지 프론트 타이머가 아닙니다.
5. **enum 차이를 먼저 맞춥니다.** FE `ReleaseLifecycle`에는 BE의 `TESTING`, `REMEDIATION`, `DECISION_PENDING`이 아직 없습니다. DTO와 상태 배지를 확장하고, Lifecycle·Run status·최종 Decision을 분리합니다.
6. **Manifest 1.1을 실제 연결 기준으로 확인합니다.** FE의 `demoManifest`는 UI용 축약 JSON입니다. 실제 등록에는 BE `src/test/resources/fixtures/valid-release-manifest-v1.1.json`과 서버 검증을 사용합니다. 기존 1.0 Release를 임의로 1.1로 바꾸지 않습니다.
7. **D가 확정한 판정을 A 증적으로 연결합니다.** D `DecisionView.id`와 Release를 기준으로 Attestation을 조회합니다. 확정 전·stale·조회 실패를 구분하고 D의 판정을 재계산하지 않습니다.

### 현재 BE에 있는 추가 연결 지점

공통 prefix는 `/api/v1`입니다. 아래 메서드는 아직 FE client에 없는 연결 대상입니다.

| API | 사용할 곳 |
| --- | --- |
| `GET /releases/{releaseId}` | 선택한 Release의 실제 검증 요약 |
| `GET /releases/{releaseId}/diff?against={otherReleaseId}` | `ChangedPage`, 구성 요소 변경 근거 |
| `GET /releases/{releaseId}/tool-catalog` | Manifest 1.1의 검증된 Tool 원천 정보, C 연동 |
| `GET /test-runs/{runId}` | 실제 Run snapshot: status, totalCases, completedCases, latestSequence 등 |
| `GET /test-runs/{runId}/event-history?after={sequence}&limit=100` | 초기/재접속 이벤트 복원, fallback polling |
| `GET /test-runs/{runId}/events` | SSE. JSON envelope endpoint와 별도 처리 |
| `GET /test-runs/{runId}/events:verify` | 서버 이벤트 chain 검증 결과 표시 |
| `GET /evidence-references?ownerType={type}&ownerId={id}` | D와 함께 Evidence 참조 연결 |

SSE는 `run.status`, `run.completed`, `finding.created`, `trace.event`라는 named event를 보내고 heartbeat를 별도로 보냅니다. 기본 `onmessage`만으로 처리한다고 가정하지 않습니다. 재접속은 `Last-Event-ID`/history cursor와 중복 제거를 고려하고, 필요 헤더·인증·CORS 방식은 A와 합의합니다. 키를 URL query로 우회 전달하지 않습니다.

### 완료 조건

- [ ] 여러 Agent/Release 중 선택한 대상이 탭 이동·뒤로 가기·새로고침에서도 유지됩니다.
- [ ] Run/Finding 요약에 실제 결과가 없으면 `N/A`/미연결을 표시하며 0으로 채우지 않습니다.
- [ ] SSE 끊김을 Run 실패로 표시하지 않고, 재접속 후 순서/중복/누락을 확인합니다.
- [ ] 새 Release 상태와 diff/재검증 상태가 서버와 일치합니다.
- [ ] 기존 Agent·Manifest·Attestation·Audit·Recovery의 API 동작과 오류/권한 경계가 보존됩니다.

## 5. B — Agent Runtime / Attack

### 어디를 수정하나요?

`VerificationPages.tsx`의 `RunsPage`, `TracePage`, `trialSteps`가 시작점입니다.
`EntryPages.tsx`의 최근 실행, `ReleaseContext`의 Run 표시, `StatesPage`의 실행/취소/연결 상태는 A와 연결합니다.

### 어떻게 이어서 구현하나요?

1. **실제 실행의 진입 계약을 확정합니다.** 선택된 Release, suite, mode, 승인된 Contract, Run/CaseRun 식별자를 BE 실행 orchestration과 연결합니다. 현재 dev에는 실행 서비스가 있지만 사용자용 실행 목록/시작/취소 REST Controller는 확인되지 않았습니다. endpoint 이름을 추측해 프론트에서 먼저 호출하지 않습니다.
2. **저장 API와 실행 API를 구분합니다.** `/api/v1/platform/test-runs` 및 `:status`는 Run/CaseRun 등록·상태 저장 기반입니다. 프론트가 여기에 `RUNNING`/`COMPLETED`를 써서 실제 실행을 흉내 내면 안 됩니다. 시작/취소 요청은 B의 검증된 orchestration 진입점을 통해 처리합니다.
3. **`useDemoWorkflow()` 호출을 실제 동작으로 바꿉니다.** LIVE의 시작/취소/재시험은 서버 응답과 Run snapshot을 소비해야 합니다. `w.start()`, `w.cancel()` 또는 400ms 타이머는 SIMULATED에만 남깁니다. 취소 요청 수락과 최종 `CANCELLED`는 별도 상태입니다.
4. **Trace의 고정 배열을 실제 이벤트로 교체합니다.** A가 제공하는 `ExecutionEvent`의 `eventId`, `runId`, `testCaseRunId`, `sequence`, `eventType`, `toolName`, redacted input/output, `policyDecision`, `reasonCode`, digest를 사용합니다. CASE-1001의 6단계 예시를 모든 사례에 재사용하지 않습니다.
5. **제안 → 정책 판단 → 실제 호출 → 실제 영향 → Oracle**을 구분합니다. B는 제안/실행 사실을 제공하고 C의 이유 코드와 D의 Oracle 결과를 그대로 연결합니다. API가 호출되지 않았다는 사실만으로 공격 차단 성공을 정하지 않습니다.
6. **UI 모드 문자열과 BE enum을 맞춥니다.** 현재 샘플의 `ENFORCE`는 BE `TestRunMode`의 값이 아닙니다. BE 값은 `BASELINE / SEAL_REPLAY / HELD_OUT / REGRESSION`입니다. `HELD_OUT + REGRESSION`도 단일 서버 enum이 아니므로 두 시험의 실행/집계 경계를 합의합니다.
7. **FE → Python 직접 호출은 하지 않습니다.** 현재 AI 서비스는 BE가 전체 맥락을 전달하는 stateless step 경계입니다. FE가 Provider key를 받거나 Python/Tool adapter를 직접 호출해 Gateway·Run·증거 저장 경로를 우회하지 않습니다.

### 확인할 백엔드 파일

BE의 `runtime/AgentRuntimeService.java`, `runtime/AgentToolLoopService.java`, `runtime/ai/HttpAgentAiClient.java`, `execution/Fa05ExecutionOrchestrator.java`, `sandbox/tool/ToolDispatcher.java`에서 실행 경계를 확인합니다. 브라우저는 내부 메서드가 아니라 합의된 사용자용 HTTP 계약을 소비합니다.

조회는 A의 `/test-runs/{runId}` 및 history/SSE를 재사용합니다. Run 목록·suite/variant 목록·실행 생성·취소·재시험은 현재 branch의 Controller 존재 여부를 다시 확인한 후 A/B와 계약을 정합니다. AI의 새 원격 기능 브랜치가 `main`에 자동 병합됐다고 가정하지 않습니다.

### 완료 조건

- [ ] 시작 버튼이 실제 Run ID를 받고 선택된 Release/시험 조건이 표시됩니다.
- [ ] 페이지를 떠났다 돌아와도 서버 실행 상태를 복원하고 중복 실행하지 않습니다.
- [ ] 요청 중 버튼 비활성화, timeout/실행 실패/연결 끊김/취소 중/취소 완료가 구분됩니다.
- [ ] 실제 선택한 CaseRun의 Trace와 부분 증거가 표시됩니다.
- [ ] Replay는 동일 공격/variant/trial/fixture/model 조건으로 실행하고 C/D에 근거를 전달합니다.

## 6. C — Policy / Security / Replay

### 어디를 수정하나요?

`VerificationPages.tsx`의 `PoliciesPage`, `PolicyDetail`, `GatewayPage`, `rules`가 주 작업 대상입니다.
`ReplayPage`의 비교 가능성/정책 정보와 `FindingDetail`의 정책 후보 영역은 B/D와 함께 연결합니다.

### 어떻게 이어서 구현하나요?

1. **Candidate 생성·조회 → 결정적 validation → diff → 사람 승인/거절**을 각각 실제 서버 상태로 연결합니다. 현재 `w.approved`, 체크박스, 충돌 버튼은 데모 상태입니다. 체크만 했다고 서버 정책을 승인된 것으로 표시하지 않습니다.
2. **BE의 기존 core를 재사용하고 HTTP 경계를 정합니다.** dev에는 `SafetyContractSchemaValidator`, `SafetyContractSemanticValidator`, `ReleaseToolCatalogContractAdapter`, 정책 evaluator와 `EnforcePolicyPostCallResponseGuard`가 있습니다. 정책 목록/후보/승인용 Controller는 확인되지 않았으므로 C가 A와 persistence·version·audit·권한·오류 계약을 합의해야 합니다. core 구현이 없다고 새로 만들거나, 반대로 승인 API까지 있다고 간주하지 않습니다.
3. **Tool 수와 규칙을 실제 카탈로그에서 표시합니다.** 샘플 화면의 `7개 tool`/`등록된 7개 tool`은 API 계약이 아닙니다. Manifest 1.1의 정상 실행 Tool은 5개이며, `LOAN_DECISION_UPDATE`는 별도 server catalog의 `agentExecutable=false`, `HUMAN_ONLY` 대상입니다. 이 수치와 허용 범위를 화면 문자열로 결정하지 않습니다.
4. **JSON 발췌를 실제 요청 payload로 보내지 않습니다.** 현재 `DEMO_ONLY_NOT_API_PAYLOAD` JSON은 설명용입니다. 실제 candidate DTO/schema, validation result, before/after hash와 승인 version을 연결합니다.
5. **승인 충돌을 실제 오류와 연결합니다.** 샘플 `STALE_BASE_HASH`는 확정된 서버 오류 계약이 아닙니다. 합의된 최신 base/hash와 조건부 요청 방식으로 승인하고, 충돌 시 의견 보존 → 최신 diff 재조회 → 재동의를 요구합니다. 자동 승인/자동 재전송을 하지 않습니다.
6. **Gateway의 사실을 분리합니다.** C의 ALLOW/DENY·reason과 B의 실제 API 호출/응답, D의 Oracle 결과를 별개 필드로 표시합니다. 정책 평가 오류는 공격 차단 성공이 아닙니다. post-call response guard의 격리도 pre-call DENY와 구분해야 합니다.
7. **Replay의 통제 조건을 서버에서 확인합니다.** artifact, resolved model/parameters, attack case, variant, trial, fixture digest, runtime/tool/RAG 조건이 같다는 C의 검증 결과가 있어야 `동일 조건 비교 가능`을 표시합니다. Contract만 달라졌다면 releaseFingerprint가 다른 것은 정상일 수 있습니다.

### 완료 조건

- [ ] 후보·검증 실패·승인 대기·승인·거절·충돌·무결성 실패를 구분합니다.
- [ ] 승인된 Contract는 읽기 전용이고 실제 version/hash/reviewer가 표시됩니다.
- [ ] 승인되지 않은 후보로 ENFORCE/Replay가 실행되지 않습니다.
- [ ] DENY, API 미호출, post-call 격리, Oracle 판정이 근거와 함께 구분됩니다.
- [ ] 비교 조건 불일치 시 개선 효과를 단정하지 않고 재검증 행동을 안내합니다.

## 7. D — Evaluation / Release Assurance

### 어디를 수정하나요?

`VerificationPages.tsx`의 `FindingsPage`, `FindingDetail`, `VerificationPage`, `ReportsPage`, `ReportPage`, `findings`가 주 작업 대상입니다.
`TracePage`의 Oracle/영향 수치, `GatewayPage`의 Oracle, `ReplayPage`/`ComparisonEvidence`의 결과와 차트, `WorkspacePage`의 Finding 요약도 D의 실제 결과를 소비하도록 연결합니다.

### 어떻게 이어서 구현하나요?

1. **Finding 조회부터 연결합니다.** `releaseId`/`runId` 기준 목록과 `findingId` 상세를 연결하고, 모든 행이 FND-001로 이동하는 샘플 동작을 제거합니다. 현재 BE 목록 응답은 배열이 아니라 `data.items`, 상세는 `data.finding`, `data.oracleResult`, `data.relatedFindings` 구조입니다.
2. **Severity와 판정 불명확을 분리합니다.** 샘플 `findings` 배열은 `INCONCLUSIVE`를 심각도 열에 넣지만, 실제로는 Oracle 결과/증거 충분성 상태입니다. D의 DTO 기준으로 severity·Finding status·Oracle outcome을 별도 표시합니다.
3. **Oracle와 증거를 연결합니다.** Tool proposal이 아니라 실제 응답/상태 변경/collector/evidence reference를 기준으로 나온 D의 결과를 표시합니다. 근거가 부족한 경우 `INCONCLUSIVE`/`N/A`로 남깁니다.
4. **지표를 서버 응답으로 교체합니다.** `12/40`, `2/40`, `1/40`, `29/30`, `1/30`과 차트 막대는 모두 샘플입니다. 서버 `MetricValue`의 `status`, `numerator`, `denominator`, `value`, `reason`, `sourceRunIds`를 연결합니다. `N_A`를 0%로 바꾸지 않고, 비율의 단위와 분모를 지표별로 표시합니다.
5. **Held-out/정상업무 결과와 실행을 분리합니다.** D가 평가/집계를 제공하고 실제 실행은 B, 승인 정책 적용은 C와 연결합니다. 숨겨진 공격 payload를 UI나 정책 후보 생성 입력으로 노출하지 않습니다.
6. **판정 후보 생성과 확정을 분리합니다.** `decision:evaluate`는 상태/audit를 변경하는 POST이므로 단순 화면 렌더/useEffect에 묶지 않습니다. 명시적 검토 동작으로 proposal을 받고, 확정 시 `inputDigest`를 `If-Match`에 보내며 decision/comment와 actor를 전달합니다.
7. **충돌/권한 실패를 보여줍니다.** 현재 서버는 판정 입력 변경 시 `RELEASE_CHANGED`를 반환하고 상향 판정 덮어쓰기를 거절합니다. 실패 시 확정된 것으로 표시하거나 새 digest로 자동 재확정하지 않습니다.
8. **확정 후 A의 증적을 엽니다.** 서버가 확정한 `DecisionView`를 반영하고 A의 Attestation 조회/export로 연결합니다. FE에서 canonical JSON·hash·PASS/BLOCKED를 계산하지 않습니다. `#/live/reports`의 기존 Evidence 연결을 교체할 때는 증적 접근 경로를 보존합니다.

### 현재 BE에 있는 연결 지점

공통 prefix는 `/api/v1`이며, 아래 API들은 현재 FE client에 아직 없습니다.

| API | 연결 대상/주의 |
| --- | --- |
| `GET /findings?releaseId={id}` | Finding 목록. 서버 필터는 category/status/findingGroupKey; severity 필터 지원을 가정하지 않음 |
| `GET /findings/{findingId}` | 실제 선택한 Finding 상세/Oracle/연관 Finding |
| `GET /test-runs/{runId}/findings` | Run 범위 Finding 목록 |
| `POST /findings/{findingId}:triage` | 현재 요청 DTO는 `{ comment }`. 임의의 status 필드를 추가하지 않음 |
| `GET /oracle-results/{resultId}` | Oracle 단건 조회 |
| `GET /test-runs/{runId}/oracle-results` | Run 범위 Oracle 결과 |
| `GET /releases/{releaseId}/metrics` | `MetricsView.metrics`와 각 지표의 분자/분모/출처 |
| `POST /releases/{releaseId}/decision:evaluate` | 후보: proposedDecision, gatePolicyVersion, inputDigest, inputSnapshot |
| `POST /releases/{releaseId}/decision:confirm` | `If-Match`, `{ decision, comment }`, reviewer actor; 공통 mutation 계약 준수 |

### 완료 조건

- [ ] Finding 목록/상세가 선택한 실제 리소스와 맞고 severity/status/outcome이 구분됩니다.
- [ ] 지표마다 분모와 source Run을 확인할 수 있으며 미측정·운영 오류를 성공/차단으로 세지 않습니다.
- [ ] Replay 비교 가능 여부는 C, 실제 결과 평가는 D의 근거를 사용합니다.
- [ ] 평가 후보/확정 전/확정 후/stale/충돌 상태가 구분됩니다.
- [ ] 근거 없는 상향 판정이 불가능하며 확정 결과와 A Attestation이 일치합니다.

## 8. 공통 구현 규칙과 충돌 방지

### 8.1 API 연결은 이 순서로 합니다

1. BE branch/Controller/DTO/enum과 필수 header·오류 코드를 확인합니다. 문서에만 있는 예정 API와 코드에 있는 API를 구분합니다.
2. DTO와 client 메서드를 추가합니다. `FinsecApiClient.request()`는 private이므로 외부에서 호출하지 말고 클래스 내부의 public 도메인 메서드 또는 합의한 공통 transport를 사용합니다.
3. **실제 데이터 조회/controller와 표시 컴포넌트를 분리**해 loading/error/empty/data 및 서버 action을 주입합니다. 기존 카드·표 구조는 재사용할 수 있지만 `Workflow` 기반 샘플 실행 로직을 LIVE에 그대로 주입하지 않습니다.
4. A와 리소스 선택/탐색을 연결합니다. 현재 없는 ID 포함 URL이나 hook이 이미 구현된 것처럼 사용하지 않습니다.
5. `ProductApp.tsx`의 `body()`에서 실제 데이터 경로를 연결한 뒤 해당 화면만 `livePages`에 개방합니다. 목록에 이름만 추가하면 샘플 화면이 LIVE로 노출되므로 금지합니다. 현재 `detailPages`의 헤더/Stepper는 SIMULATED에서만 조립되는 점도 함께 처리합니다.
6. 메뉴·모드 격리·해당 API와 오류 상태 테스트를 추가하고 회귀를 확인합니다.

### 8.2 타입·샘플·오류 처리

- 현재 `PlatformClient = Pick<FinsecApiClient, keyof FinsecApiClient>`입니다. public 메서드를 추가하면 `createDemoPlatform()`도 같은 인터페이스를 구현해야 합니다. 필요하면 A와 도메인별 interface로 분리합니다. `as any`나 demo의 실서버 fallback으로 타입 오류를 숨기지 않습니다.
- A fixture는 `demo/platform.ts`, B/C/D의 여러 고정 배열/JSON/수치는 `VerificationPages.tsx`, 실행 타이머는 `model.ts`에 흩어져 있습니다. adapter 하나만 교체했다고 실제 연결이 끝나는 것은 아닙니다.
- FE가 Gateway/Oracle/Gate/Fingerprint를 재구현하지 않습니다. 표시용 포맷 변환과 분류만 수행합니다.
- `FinsecApiError`는 status/code/traceId/retryable을 보존하지만 현재 `ErrorBanner`는 주로 message만 출력합니다. 도메인별 복구 안내와 trace ID 노출이 필요하면 공통 오류 UI를 함께 확장합니다. 내부 비밀/원문 payload를 오류에 출력하지 않습니다.
- 현재 mutation 메서드는 호출마다 새 Idempotency-Key를 만듭니다. 동일 작업의 자동 재시도를 추가할 때는 A와 키 수명/동일 요청 재사용 계약을 정하고, 응답을 잃었다고 새 키로 무조건 재실행하지 않습니다.
- 요청 중에는 중복 submit을 막고, 조회 응답 역전·모드 전환·언마운트 시 이전 결과가 새 대상에 섞이지 않게 합니다.

### 8.3 여러 명이 동시에 수정할 때

현재 `VerificationPages.tsx` 하나에 역할별 화면이 모여 있습니다. 다음은 **후속 작업 제안이며 현재 존재하는 폴더가 아닙니다.**

| 분리 제안 | 옮길 대상 |
| --- | --- |
| `src/features/runtime/` | B: Runs, Trace |
| `src/features/policy/` | C: Policies, Policy detail, Gateway |
| `src/features/evaluation/` | D: Findings, Verification, Reports |
| `src/features/release/` | A: ReleaseContext, ReleaseOverview, Changed |

Replay는 파일 위치보다 책임 구분이 먼저입니다. **B는 실행/취소, C는 승인 정책·비교 조건, D는 Oracle·지표, A는 선택된 Release/Run·증거 참조 기반**을 제공합니다. 각자 Replay 전체를 별도로 만들지 말고 화면 조립 지점과 데이터 props를 합의합니다.

- 첫 PR에서 화면 이동만 하고 동작을 유지한 다음, 역할별 API 연결 PR을 나누면 충돌을 줄일 수 있습니다.
- `ProductApp.tsx`, `model.ts`, `client.ts`, `contracts.ts`, 공통 CSS 변경은 PR에 명시하고 관련 담당자가 확인합니다.
- 이번 문서 공유만으로 파일 분리나 새로운 브랜치 생성이 수행된 것은 아닙니다. 팀의 작업 브랜치/merge 기준은 별도로 합의합니다.

### 8.4 디자인을 유지하는 방법

- [Product.tsx](../src/components/Product.tsx)의 카드/알림/표/모달과 [Primitives.tsx](../src/components/Primitives.tsx)의 헤더/상태/오류/빈 화면을 재사용합니다.
- 색은 `src/styles.css`의 의미 토큰과 기존 tone을 사용합니다. 각 페이지에서 새로운 팔레트/Sidebar/Topbar를 만들지 않습니다.
- 카드 간격은 기존 `section-gap`/grid/stack 또는 범위가 명확한 컨테이너 gap으로 처리합니다. 운영 복구의 `recovery-notices`는 안내 사이 16px, 다음 폼까지 22px를 보장하도록 수정돼 있습니다.
- 임의의 고정 너비를 추가하지 않습니다. 긴 hash/JSON/표와 390px·1024px·1440px에서 넘침/겹침을 확인합니다.
- 버튼 레이블은 실제 동작을 설명하고, disabled에는 필요한 선행 단계/권한/진행 상태를 함께 안내합니다.
- 데모와 실서버 데이터를 섞지 않고, 공식 인증/모든 취약점 부재를 보장하는 문구를 사용하지 않습니다.

## 9. 팀 통합 순서

| 순서 | 먼저 연결할 작업 | 다음 담당자에게 넘길 결과 |
| --- | --- | --- |
| 1 | A: 실제 Release/Run 선택·DTO·조회 경계, B: 실행 진입 계약 | 같은 Release/Run을 바라보는 탐색과 식별자 |
| 2 | A 이벤트 조회 + B 실행/Trace | 정상 요청 및 대표 공격의 실제 Run/CaseRun/Event ID |
| 3 | D Finding/Oracle | 실제 영향과 증거 참조가 연결된 Finding ID |
| 4 | C 후보/validation/승인 + B Replay 실행 | 승인 Contract version/hash, Baseline/Replay Run, 비교 조건 |
| 5 | D 비교·Held-out·정상업무·Decision + A 증적 | 근거/지표 → 판정 후보 → 사람 확정 → Attestation |

UI-only PR은 SIMULATED에만 적용하고 LIVE의 연동 대기 경계를 유지한 상태로 병합할 수 있습니다. 서버 연동 PR은 최소 한 개 실제 데이터 흐름과 실패 상태까지 확인한 후 완료로 표시합니다.

## 10. PR / push 전 확인

### 10.1 공통 검사

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

직전 코드 검증 기준: 2026-09-06, 프론트 Vitest **5개 파일 / 36개 테스트 통과**, TypeScript/Vite build 통과. 운영 복구 간격은 1440px/390px에서 확인했습니다. 이 기록은 이후 API 연결이나 BE 전체 통합 테스트를 보증하지 않습니다. 변경 PR마다 다시 실행합니다.

| 테스트 파일 | 유지/확장할 내용 |
| --- | --- |
| [src/App.test.tsx](../src/App.test.tsx) | 메뉴·hash 탐색, demo/live 분리, API 실패 시 샘플로 대체하지 않음, 승인/충돌/취소 |
| [src/api/client.test.ts](../src/api/client.test.ts) | URL/method/DTO/actor/조건부 header/idempotency/error 계약 |
| [src/demo/platform.test.ts](../src/demo/platform.test.ts) | fixture 격리, 실제 네트워크 차단, 샘플 증적 제한 |
| [src/features/features.test.tsx](../src/features/features.test.tsx) | 기존 A 폼·증적·감사·복구 회귀 |
| [src/features/Recovery.test.tsx](../src/features/Recovery.test.tsx) | demo/live 안내 및 샘플 운영자 설정. 실제 간격은 브라우저로 확인 |

### 10.2 수동 확인

- [ ] 담당 페이지를 URL로 직접 열고, 뒤로 가기/새로고침/다른 대상 선택을 확인했습니다.
- [ ] loading / empty / 정상 응답 / 실패 / 권한 부족 / 충돌 / 미측정을 필요한 범위에서 확인했습니다.
- [ ] SIMULATED에서 API 호출이 없고, LIVE 실패가 샘플 성공으로 바뀌지 않습니다.
- [ ] 정책 승인·판정 확정은 사람 확인과 최신 서버 근거를 요구합니다.
- [ ] 긴 데이터·표·알림이 겹치지 않고, 모바일 메뉴와 dialog의 키보드 접근이 유지됩니다.
- [ ] 관련 역할의 화면/샘플 체험 전체 흐름을 깨뜨리지 않았습니다.

### 10.3 Git에 포함할 것과 제외할 것

- 포함: 이번 디자인 적용의 tracked 수정과 `src/ProductApp.tsx`, `src/product/`, `src/demo/`, `src/components/Product.tsx`, `src/features/Recovery.test.tsx`, `public/assets/`, `design_system.md`, `docs/`의 공유 자료. 새 파일은 untracked이므로 기존 파일만 commit하면 빠질 수 있습니다.
- 제외: `.env`, 실제 자격 증명, `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.playwright-cli/`, `output/playwright/`. 현재 `.gitignore`를 유지하고 강제 추가하지 않습니다.
- 파일 분리/API 연동을 하지 않은 이번 공유를 “전체 서비스 실연동 완료”라고 설명하지 않습니다.
- PR 본문에 담당 역할/화면, 연결한 실제 API, 남은 샘플/연동 대기, 검증 결과, 다른 역할이 이어서 연결할 ID/DTO를 적습니다.

### 팀 공유용 요약

> FINAgent SEAL의 공통 디자인과 전체 화면의 대화형 샘플을 프론트에 반영했습니다.
> A의 기존 등록·구성·증적·감사·복구 API 기능은 유지했고, B/C/D 화면은 실제 API 연결을 이어서 진행해야 합니다.
> 각자 이 문서의 역할별 파일/함수에서 시작해 기존 UI에 본인 도메인 데이터를 연결해 주세요.
> Replay는 B 실행 / C 정책 적용·비교 조건 / D 결과 평가로 나누고, 공통 Release·Run·증거 연결은 A와 맞춥니다.
> 미연결 기능은 LIVE에서 열지 않고, 준비된 샘플은 SIMULATED로 명확히 유지합니다.
