# C Gateway 저장 판단 이력 연동

LIVE `/#/live/gateway`는 저장된 정책 판단을 조회합니다. Release와 Run을 선택하고,
CaseRun·Tool·판단 필터, 두 위치의 사유 코드, 이벤트 출처를 확인할 수 있습니다.
SIMULATED Gateway와 B의 LIVE Runs/Trace·실행·SSE 화면은 기존 경로를 유지합니다.

## C 진입점과 입출력

- 화면: `src/features/policy/GatewayEvidencePage.tsx`의 `GatewayEvidencePage`.
  입력은 `releases: Release[]`, `actorId: string`, 선택적 `preferredReleaseId`,
  `onReleaseChange(id)`, 시험용으로 주입 가능한 `client: GatewayEvidenceApi`입니다.
- 조회: `src/features/policy/gatewayEvidence.ts`의 `GatewayEvidenceClient`.
  기본 주소는 기존 `VITE_FINSEC_API_BASE_URL`, 미설정 시 `http://localhost:8080`입니다.
- `listRuns(releaseId, actorId, signal?)` → `Promise<readonly GatewayRunOption[]>`.
  저장 Run의 ID·Release ID·mode·status를 반환합니다.
- `loadRun(releaseId, runId, actorId, signal?)` → `Promise<GatewayRunEvidence>`.
  별도로 조회한 Run 정보와 `contractVersionId`, 최초 `headSequence`, 그 범위의
  `GatewayPolicyEvent[]`를 반환합니다. 결과 객체와 배열은 동결된 별도 투영입니다.
- 실패는 `GatewayEvidenceError.code`로 전달합니다:
  `INVALID_REQUEST`, `INVALID_RESPONSE`, `INCOMPLETE_HISTORY`, `LIMIT_EXCEEDED`,
  `REQUEST_FAILED`, `REQUEST_ABORTED`. 부분 목록을 성공 결과로 반환하지 않습니다.
  화면은 실패를 고정 문구로 표시하며 서버 오류 본문과 임의 예외 메시지를 노출하지 않습니다.

사용하는 기존 조회 API는 다음 세 가지입니다. 모두 GET이며 본문·변경 요청·SSE가 없습니다.

| API | 서버 응답의 사용 부분 |
| --- | --- |
| `/api/v1/releases/{releaseId}/test-runs?limit=100&cursor=…` | `data.items`, 문자열 `nextCursor` |
| `/api/v1/test-runs/{runId}` | Run/Release ID, mode, status, contractVersionId |
| `/api/v1/test-runs/{runId}/event-history?after=…&limit=1000` | items, headSequence, 숫자 nextCursor |

기존 `X-Actor-Id`를 그대로 전달합니다. 이 헤더가 서버 인증을 대신하지 않습니다.
인증·접근 제어는 서버의 책임이며 검토자 키나 실행 권한을 화면에서 만들어 보내지 않습니다.
기존 공용 FE client는 Run 목록 cursor를 버리고 이력 첫 페이지만 읽으므로 C 조회 모듈에서
원래 API의 페이지 계약을 직접 사용합니다. 공용 client와 서버 API는 수정하지 않았습니다.

## 표시와 조회 범위

이력 API의 head 조회와 행 조회는 별도이므로 같은 응답에도 head 이후의 행이 올 수 있습니다.
최초 head를 고정하고 `1..head`의 연속 순서·Run 소속·중복 이벤트 ID·hash 연결 포인터와
cursor 진행을 확인한 후 정책 이벤트만 표시합니다. 그 이후 행은 표시하지 않습니다.
Run 정보는 이력과 별도 시점의 관찰이며, 실행 중 추가된 기록은 명시적 새로고침으로 조회합니다.
표시된 hash와 연결 포인터 확인은 클라이언트의 암호학적 체인 검증이 아닙니다.

브라우저 조회 한도는 Run 10,000개, 최초 이력 head 100,000입니다. 초과·누락·보존 기간 만료·
잘못된 응답·중간 페이지 실패는 전체 조회 실패이며, 빈 이력이나 안전한 실행으로 바꾸지 않습니다.
Release·Run·actor·client 변경, 새로고침, 화면 이탈 시 이전 응답을 취소하고 늦은 결과도 버립니다.
브라우저 저장소에 기록이나 요청자를 저장하지 않습니다.

조회 클라이언트의 선택 표시 필드인 `toolName`과 이벤트 `reasonCode`는 `null` 또는
0–100자 문자열을 받습니다. 서버가 허용하는 빈 문자열을 `null`로 합치거나 잘라내지 않습니다.
비정책 이벤트의 빈 표시값도 유효한 이력으로 읽습니다. 중첩 사유의 빈 문자열 역시 보존합니다.
빈 Tool은 `Tool 이름 빈 문자열`, 빈 사유는 `빈 문자열`로 표시하여 기록 부재와 구분합니다.
Tool 필터의 JSON 인코딩 값은 전체 선택·빈 문자열·`null`을 각각 구분합니다.
필수 문자열과 UUID·hash·순서·페이지 완전성 검증은 그대로 유지합니다.

전체 조회 범위를 검증하고 필터를 적용한 뒤 이벤트 카드와 접힌 상세 표를 페이지당 최대
50개씩 생성합니다. 전체 일치 건수와 현재 표시 범위·페이지를 구분하며 이전·다음 페이지로
이동할 수 있습니다. CaseRun·Tool·판단 필터를 바꾸면 첫 페이지로 돌아갑니다.
페이지 이동과 필터링은 같은 조회 결과를 사용하므로 API 요청을 추가하지 않습니다.
고유 Tool·CaseRun 선택지는 전체 조회 범위를 유지하므로 이 제한은 이벤트 카드·상세 표에
적용됩니다. 전체 DOM 크기나 최대 조회 한도에서의 실행 성능을 보장하는 수치는 아닙니다.

`policyDecision.decisionType`이 기록된 경우 `ALLOW/true`, `DENY/false`, `ERROR/false`처럼
유형과 실제 boolean `allowed`가 일치하는 조합만 해당 판단으로 표시합니다. 명시된 유형이
잘못됐거나 허용 값과 모순되면 UNKNOWN입니다. `decisionType` 키가 없는 기존 기록에만
literal boolean `allowed`의 ALLOW/DENY 판독을 유지하며, boolean이 아니면 UNKNOWN입니다.
ERROR는 운영 오류로 별도 표시·필터링하고 DENY 필터에 포함하지 않습니다.
이벤트 `reasonCode`와 `policyDecision.reasonCode`는 별개의 기록값으로 표시하며,
생소한 코드나 서로 다른 코드에 새로운 의미·우선순위를 부여하지 않습니다.
원시 input/output/metadata와 사용하지 않는 policyDecision 필드는 반환·표시하지 않습니다.

DENY·ERROR, 운영 오류 사유, 빈 이력, BASELINE/SEAL_REPLAY 모드 또는 `gateway: c`만으로
ATTACK_BLOCKED·API 미호출·누출 없음·상태 변경 없음·격리 성공·차단율·controlled comparison을
산출하지 않습니다. `successfulSecurityBlock` 값도 이 화면에서 방어 결과로 투영하지 않습니다.
평가 단계와 호출 연결은 현재 화면의 투영·표시 범위에 포함하지 않습니다.

## 저장 계약과 남은 연동

- C Gateway의 BE PR #53에는 `policyDecision.decisionType`, ENFORCE의 `evaluatedStages`와
  실패 단계, BASELINE의 `stageOutcomes`와 관찰 사유가 있습니다. `metadata.toolCallId`는
  대응 `TOOL_PROPOSED` 이벤트 ID를 가리키는 연결값입니다.
  A의 이력 DTO는 `policyDecision`과 `metadata`를 제공합니다. 이 화면은 그중 판단과 두 사유만
  투영하므로 단계별 집행이나 호출·응답 전달을 검증하는 상세 화면과 구분해야 합니다.
  PR #53은 기본 비활성이며 실제 인증·관측 공급자가 필요합니다. 저장 형식의 구현이 존재한다는
  사실만으로 모든 기존 이벤트에 새 필드가 있다고 가정하지 않습니다.
- Replay: D의 BE PR #52는 저장된 `replay_links`의 비교 결과를 지표의 `replaySummary`와
  Decision snapshot·gate에서 소비합니다. 이 화면이 조회하는 Run과 정책 이력만으로는 같은
  case/trial·정상 control·두 정책의 비교 snapshot·실제 영향 비교를 완결할 수 없습니다.
  전체 비교에는 A/B의 역사적 입력·대응 연결, 실제 C 비교 판정 및 대응 D 결과 연결이 필요합니다.
- 실제 관측·필드 분류·정상 Tool 연결과 FAILED Run의 저장 운영 오류 집계는 별도 연동 범위입니다.
  UI의 GET 요청·DOM 비노출 검사는 API 미호출, 모델 미전달, 상태 변화 없음이나 실제 지표 제외의
  실행 증거를 대신하지 않습니다.

## 검증 기준

초기 `dev@ace50fbb`의 PlatformClient 메서드 누락과 테스트의 stream undefined 오류는
팀원의 FE PR #5, `dev@7a28a8c`에서 수정됐습니다. 이 기능은 해당 수정이 반영된 기준선에서
재개했습니다. C 작업으로 공용 client·데모 구현·담당자 테스트를 수정하지 않았습니다.

검증 명령은 `pnpm test`, `pnpm typecheck`, `pnpm build`입니다. 새 조회·화면 테스트는
`src/features/policy/gatewayEvidence.test.ts`, `GatewayEvidencePage.test.tsx`에,
실제 shell·client를 합성 HTTP 응답으로 연결한 회귀 검증은 `src/App.test.tsx`에 있습니다.
브라우저에서는 desktop/narrow의 저장 ERROR와 HTTP 조회 실패를 각각 확인하고, native 키보드
필터·details·긴 기록의 배치·한영 공통 고지·원시 데이터 비노출을 검증합니다. 합성 HTTP 응답의
화면 검증은 실제 공격·운영 ENFORCE 시험으로 취급하지 않습니다.
빈 표시값의 비정책 이벤트 뒤 정책 이력을 읽는 경우, 빈 값과 `null`의 표시·필터 구분,
50·51·101건의 페이지 경계와 각 필터의 페이지 초기화를 회귀 검증합니다.
브라우저의 101건 fixture에서는 카드·상세 표 50개 상한, 페이지별 출처와 캡처한 head,
페이지 이동·필터링 중 추가 GET이 없음을 확인합니다.
