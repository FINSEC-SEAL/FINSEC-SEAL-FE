# C 저장 계약 검토·승인 화면

`#/live/policies`와 `#/live/policy`에서 실제 Release의 저장 계약을 검토하고 검증·승인·거절을 요청합니다. `src/features/policy/`가 구현이며, 두 경로는 같은 화면을 엽니다. SIMULATED 정책·Gateway·Replay 체험은 기존 동작을 유지합니다.

## 연결 API

기본 주소는 기존 `VITE_FINSEC_API_BASE_URL`이며 미설정 시 `http://localhost:8080`입니다.

| 요청 | 역할과 응답 |
| --- | --- |
| `GET /api/v1/platform/contracts?releaseId={releaseId}` | A의 실제 저장 버전 목록 |
| `GET /api/v1/platform/contracts/{versionId}/review` | C 검토 projection: 전체 identity, 상태, JSON 문자열, 기록된 승인 기준, diff, 저장 validation·검토 기록 |
| `POST /api/v1/platform/contracts/{versionId}:validate` | A 저장 검증, body `{}` |
| `POST /api/v1/platform/contracts/{versionId}:approve` | A 승인, body `{comment}` |
| `POST /api/v1/platform/contracts/{versionId}:reject` | A 거절, body `{comment}` |

검토 조회는 [BE PR36](https://github.com/FINSEC-SEAL/FINSEC-SEAL-BE/pull/36)의 구현이 필요합니다. 해당 endpoint가 없는 서버의 오류를 샘플 결과로 바꾸지 않습니다. 원 명세의 `/api/v1/contract-versions/...` 경로 및 reviewer-session 방식은 후속 통합 대상입니다. A의 이전 버전 diff는 C의 **기록된 승인 기준**에 대한 diff를 대신하지 않습니다.

## 자격·검토 범위

- 실제 Release를 선택하고 검토자 키를 명시적으로 적용해야 계약 요청을 시작합니다. 첫 Release나 첫 계약 버전을 자동 선택하지 않습니다.
- C 계약 요청에는 `X-Contract-Reviewer-Key`만 인증 자격으로 전달합니다. `X-Actor-Id`를 넣지 않으며 `credentials: omit`, `redirect: error`, `cache: no-store`를 사용합니다. 공통 inventory 조회의 기존 Actor와는 별개입니다.
- 키는 현재 화면의 메모리에만 있습니다. URL·브라우저 storage·환경 변수·로그에 저장하지 않습니다. 실제 키를 fixture나 공유 문서에 넣지 않습니다.
- Release·버전·키 변경, 같은 Release의 fingerprint/상태/updatedAt 변경, 재조회 시 기존 확인창과 동의를 해제합니다. 키·대상 변경 시 의견도 초기화합니다.
- 페이지 이동, `policies`와 `policy` 별칭 간 이동, 모드 전환, 새로고침은 C 페이지를 unmount합니다. 키·동의뿐 아니라 미확정 요청의 메모리 기록도 사라집니다. 이 기록은 영구 복구 장치가 아닙니다. 이동·대기 취소가 서버 변경 취소를 뜻하지 않으며, 미확정 요청이 있었다면 운영 확인 없이 새 작업으로 대체하지 않아야 합니다.

## 표시와 변경 요청

서버의 전체 식별자와 policy/resource hash를 표시합니다. 저장 JSON과 canonical JSON, diff의 전후 JSON 문자열은 수치·Unicode·줄바꿈을 그대로 유지합니다. 규칙 표는 브라우저의 숫자 원문 지원을 사용하며, 정밀도 보존을 확인할 수 없거나 지원하지 않는 구조는 정확한 JSON 원문으로 돌아갑니다. 브라우저에서 정책 검증·hash·diff를 재구현하지 않습니다.

baseline은 해당 후보에 기록된 승인 기준입니다. 현재 승인본·직전 버전·동일 contractKey라고 추정하지 않습니다. null이면 기준본 없음으로 표시합니다. 저장 validation은 조회 시점의 승인 권한이 아니며, 서버가 변경 요청마다 현재 조건을 확인합니다. 없는 승인 시각·정상업무 영향·공격 방어 결과는 표시하지 않습니다.

`CANDIDATE`만 검증합니다. `VALIDATED`의 저장 결과가 VALID/WARN이면 승인 확인창을 열 수 있으며, `CANDIDATE`/`VALIDATED`는 거절 검토가 가능합니다. `APPROVED`/`REJECTED`/`SUPERSEDED`는 읽기 전용입니다. 승인·거절은 실제 기준/결과 hash, 공백을 임의 정규화하지 않은 의견, 명시적 동의를 요구합니다. 취소는 POST를 보내지 않습니다.

각 작업은 최종 전송 시 body·Content-Type·Idempotency-Key·quoted `If-Match`를 고정합니다. `If-Match`는 ETag가 아닌 검토 body의 `resourceHash`입니다. 일반 409 후에는 의견을 보존하고 최신 검토를 다시 읽어 재동의를 요구합니다. 200 처리 성공과 뒤따르는 조회 실패는 따로 표시합니다.

응답 유실·중단·5xx·잘못된 성공 응답·idempotency 충돌은 처리 미확정으로 남기고 자동 재전송하지 않습니다. 같은 hash의 GET도 미실행 증거가 아닙니다. 같은 화면에서 원래 자격과 최신 대상/hash를 확인한 경우에만 별도 동의를 받아 **동일 요청**을 다시 보낼 수 있습니다. 이 재전송은 아직 처리되지 않았던 작업을 실제로 실행할 수 있습니다. 재시도의 403만으로 이전 미확정 상태를 해소하지 않습니다. 다른 버전으로 이동해도 진행 중인 요청을 기록하고, 그 응답 대기 중에는 같은 세션의 새 변경 버튼을 비활성화합니다.

## 검증

Node 24와 저장소의 pnpm 버전을 사용합니다.

```bash
pnpm exec vitest run src/features/policy/ src/App.test.tsx
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

wire/client 시험은 실제 A/C 응답 형태와 자격 격리·불변 재전송을, 표시 시험은 정밀도·원문·검토 근거를 확인합니다. 페이지 시험은 지연 HTTP 응답, 직접적인 동의 무효화, 중복 클릭·409·처리 미확정을 검증합니다. 앱 시험은 두 LIVE 경로, 실제 C client 연결, 모드 전환의 입력 초기화와 기존 SIMULATED·타 역할 탐색을 확인합니다.

HTTP fixture 시험과 브라우저 시각 QA는 합성 응답을 사용하며, 실제 BE 저장/권한/DB 불변성 회귀와 구분합니다. 최종 실행 결과와 1440px·1024px·390px, native 확인창 키보드·긴 JSON·loading/empty/error/stale 증거는 개발 하네스 Run `20260907T050640Z-3ebece26` 및 PR 검증 기록에서 확인합니다. 사용자 5173 서비스와 별도로 5175에서 시각 QA를 수행합니다.

## 남은 C 작업과 협업 경계

이 기능은 **저장된 계약의 검토·변경 요청 화면**입니다. 후보·패치 모델 호출 및 저장 orchestration, 원 명세 경로/session, 패치 승인 연결, 실제 Gateway ENFORCE·응답 격리·Replay·FA-01/02/03 검증은 후속 작업입니다.

A는 계약/패치 저장·권한·승인의 원자성, B는 provider 및 실제 실행·신뢰할 수 있는 실행 사실 전달, D는 실제 결과 판정을 맡습니다. C는 이 기반을 사용하는 후보/패치 입력·응답 검증과 orchestration, 승인 정책 바인딩, 호출 전 정책 집행, 응답 격리 및 비교 조건 검증을 계속 담당합니다. UI 시험 통과를 실제 공격 차단이나 미승인 Run 거절의 통합 증거로 계산하지 않습니다.
