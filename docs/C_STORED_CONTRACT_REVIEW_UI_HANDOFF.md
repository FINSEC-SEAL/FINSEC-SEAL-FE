# C 계약 후보 생성·저장 검토 화면

`#/live/policies`와 `#/live/policy`에서 초기·패치 후보 생성을 접수하고, Operation 상태를 확인한 뒤 실제 저장 후보를 검토·검증·승인/거절합니다. 두 경로는 같은 `src/features/policy/StoredContractReviewPage.tsx`를 사용합니다. 생성 완료, deterministic validation, reviewer approval은 별도 단계입니다.

## 클라이언트와 실제 API

`src/features/policy/client.ts`의 `ContractReviewClient`는 기존 `VITE_FINSEC_API_BASE_URL`을 사용하며 미설정 시 `http://localhost:8080`입니다. 생성 API의 계약 기준은 A [BE PR45](https://github.com/FINSEC-SEAL/FINSEC-SEAL-BE/pull/45)의 `f6ee5691a1f11096b96cb3fc9bfc4a1e1de01686`입니다. 이 참조는 실제 서버의 병합·배포 상태를 보장하지 않습니다.

| 요청 | 성공 응답·역할 |
|---|---|
| `POST /api/v1/releases/{releaseId}/contracts:generate` | 202 + canonical Location + Operation. body는 `{templateKey:"loan-review/1"}` |
| `POST /api/v1/findings/{findingId}/patch-proposals` | 같은 202 계약. body는 `{baseContractVersionId:"UUID"}` |
| `GET /api/v1/operations/{operationId}` | 200 Operation. ID·kind·Release와 canonical statusUrl을 대조 |
| `GET /api/v1/platform/contracts?releaseId={releaseId}` | 200 실제 저장 버전 목록 |
| `GET /api/v1/platform/contracts/{versionId}/review` | 200 C 검토 projection: full identity·상태·JSON 문자열·기록된 승인 기준·diff·저장 validation/검토 기록 |
| `POST /api/v1/platform/contracts/{versionId}:validate` | 200 저장 검증, body `{}` |
| `POST /api/v1/platform/contracts/{versionId}:approve` | 200 승인, 일반 body `{comment}`, 결합된 패치 후보는 `{comment, patchProposalId}` |
| `POST /api/v1/platform/contracts/{versionId}:reject` | 200 **계약 버전** 거절, body `{comment}` |

생성 준비 함수는 `prepareInitialGeneration(releaseId)`와 `preparePatchGeneration(findingId, baseIdentity)`입니다. 요청 대상·body·Idempotency-Key는 준비할 때 복사·동결합니다. `submitGeneration(request, reviewerKey, signal?)`은 POST 한 번, `generationOperation(reference, reviewerKey, signal?)`은 GET 한 번만 수행합니다. 전자는 If-Match를 보내지 않습니다. 기존 `listVersions`, `review`, `executeMutation` 계약은 유지합니다.

화면은 실제 Release와 명시적으로 적용한 검토자 키를 사용합니다. 패치의 기준은 사용자가 선택해 조회한 계약이며 Finding UUID를 입력합니다. Finding 적격성·held-out 출처 제한·해당 계약의 최신 버전·실행 중 Release 조건은 A가 검사합니다. FE가 Finding 판정이나 source를 만들어 보내지 않습니다.

## 인증과 응답 투영

C 계약 요청은 기존 `X-Contract-Reviewer-Key`, `credentials: omit`, `redirect: error`, `cache: no-store`를 사용합니다. `X-Actor-Id`나 reviewer/workspace 권한 JSON은 추가하지 않습니다. A가 지원하는 Cookie 없는 key 경로의 소비이며, `reviewer-session` cookie/CSRF UI는 이번 변경에 포함되지 않습니다. 키·요청 원장은 현재 페이지 메모리에만 있으며 URL·storage·로그에 저장하지 않습니다.

Operation은 실제 status/kind/outcome, 조건부 result의 candidate/proposal UUID와 hash, nullable 시간, 오류 단계를 검증하고 별도 불변 객체로 투영합니다. 필수 값 누락·모순은 부분 성공으로 바꾸지 않습니다. ADMISSION 단계의 FAILED는 startedAt가 null일 수 있습니다. 서버 시각을 브라우저 현재 시각에 맞춰 변경하지 않습니다.

문제·issue code는 확인한 공개 코드와 일반 fallback만 표시합니다. 원문 message·prompt·model response·metadata는 반환/표시하지 않습니다. Location/statusUrl은 동일 Operation의 canonical 상대 경로에 결합하며 임의 URL로 자격을 전송하지 않습니다. 정책 JSON과 diff는 기존 정밀 문자열 표시·fallback을 유지하고 브라우저에서 validator/hash/diff를 재구현하지 않습니다.

## 접수·상태 조회·미확정 처리

| 상태 | 화면 동작 |
|---|---|
| 202 / QUEUED / RUNNING | 접수·실행 중으로 표시. 202는 저장 후보 생성 완료가 아님 |
| CONTRACT SUCCEEDED + VALID/WARN | 저장 후보를 열 수 있지만 자동으로 열거나 검증·승인하지 않음 |
| PATCH SUCCEEDED + PROPOSED | 실제 candidate/proposal 연결을 보관하고 명시적 후보 검토 제공 |
| SUCCEEDED + INVALID / PATCH NO_CHANGE_NEEDED | 판단 완료·새 저장 후보 없음 |
| FAILED | 실행 실패의 안전한 코드·단계 표시. 현재 알려진 작업의 실패와 GET 조회 오류를 구분 |
| RECOVERY_REQUIRED | 외부 실행 불확실·운영 복구 필요. 같은 Release의 새 생성 차단 |

202를 받은 뒤 GET하며, QUEUED/RUNNING 응답이 끝난 다음 1.5초 뒤 다음 조회를 예약합니다. 마운트된 페이지의 Operation GET은 최대 하나입니다. Release·키·client·세션이 바뀌어도 abort가 무시된 이전 GET이 끝날 때까지 잠금을 유지합니다. 이전 응답은 새 화면에 적용하지 않습니다. terminal·GET 오류·화면 이탈에서 자동 polling을 중단하며 알려진 ID의 명시적 재조회는 가능합니다. GET 실패는 마지막 정상 Operation 상태를 지우거나 작업 FAILED로 바꾸지 않습니다.

생성 원장은 POST 전에 등록합니다. 응답 유실·abort·5xx·잘못된 202·멱등성 모호성은 **접수 여부 미확정**으로 유지합니다. 해당 Release는 같은 key와 새 key의 생성 POST를 모두 막고 재전송 UI를 제공하지 않습니다. 입력·kind·Release 왕복·키/client·세션 변경이나 장시간 탭 대기로 잠금을 해제하지 않습니다. A의 멱등 TTL 기본값은 안전한 재전송 보장이 아니며, 동일 key여도 만료 후 새 작업이 될 수 있습니다. 최초 접수가 확정적으로 거절되었거나 알려진 Operation이 성공/실패로 종료되면 사용자가 별도 새 요청을 준비할 수 있습니다. RECOVERY_REQUIRED는 이 종료 후 새 요청 허용에 포함되지 않습니다.

이 보존 범위는 **현재 페이지 인스턴스**입니다. 다른 route·별칭/모드 이동으로 unmount되거나 페이지를 reload하면 키·생성/변경 원장·proposal binding이 사라집니다. 영속 복구·탭 간 중복 차단 장치가 아니며, 이동이나 abort가 서버 취소를 뜻하지 않습니다. 미확정 요청이 있었다면 운영 확인 없이 새 작업으로 대체해서는 안 됩니다.

## 후보 검토와 승인 결합

`생성된 후보 검토`를 누르면 목록과 full review를 다시 읽습니다. Operation의 Release/contractVersionId/policyHash를 실제 저장본과 대조하고, PATCH는 base workspace·contractKey 및 다른 후속 버전임을 확인합니다. workspace·버전 번호·계약 식별자를 Operation에서 합성하지 않습니다. 이미 VALIDATED인 후보도 최신 상태 그대로 표시하며, 생성 당시 resourceHash와 현재 hash가 다르다는 이유만으로 정상 검증 후 연결을 거절하지 않습니다.

검증된 proposal binding은 해당 full candidate identity·policyHash와 client/자격 epoch/Release signature에 묶입니다. Release의 최신 생성 record가 다른 Operation으로 교체돼도 후보별 binding은 보존합니다. 다른 후보에 proposal ID를 옮기지 않습니다. 자격·client·Release signature가 바뀌면 이전 binding을 승인에 사용하지 않으며, ID를 잃어버린 patch-linked 후보의 일반 승인 성공을 보장하지 않습니다. 최종 링크와 권한은 A가 검사합니다.

기존 상태별 검토를 유지합니다. CANDIDATE는 검증, VALIDATED의 VALID/WARN은 명시적 승인 확인, CANDIDATE/VALIDATED는 거절 검토가 가능합니다. 승인·거절은 정확한 의견과 새 동의를 요구합니다. 승인 overload는 현재 review의 identity/policyHash와 실제 PATCH PROPOSED 결과를 대조하고 proposal ID만 추가합니다. quoted If-Match는 항상 **현재 review.resourceHash**이며 생성 결과의 과거 hash를 재사용하지 않습니다. 409에서는 최신 review와 재동의를 요구합니다.

생성 성공 뒤 후보 조회 실패와 변경 POST 성공 뒤 재조회 실패를 각각 표시합니다. 성공했던 POST를 조회 오류 때문에 다시 보내지 않습니다. 기존 validate/approve/reject의 미확정 원장과 조건부 동일 요청 재전송은 그대로이며, 원래 자격·최신 identity/hash·상태·새 동의를 요구합니다. 이 기존 변경 재전송을 생성 미확정 접수에 적용하지 않습니다.

## 검증

Node `24.20.0`, pnpm `11.19.0` 환경에서 다음 검증을 실행합니다.

```bash
pnpm exec vitest run src/features/policy/ src/App.test.tsx
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

하네스 Run `20260908T201907Z-e2890b6b`의 `final_focused`, `final_full`, `final_typecheck`, `final_build`에 원시 결과와 실행 전후 파일 해시를 남깁니다. `final_full`은 baseline 315개 assertion 사례의 보존도 확인합니다. 브라우저 fixture·실행 내역·캡처는 `visual/`, 최종 독립 검토와 post 결과는 해당 Run 및 PR 검증 기록을 참조합니다. 최초 browser timeout과 준비 조건 보완 뒤의 결과를 모두 보존하며, 과거 실패 원인을 소급해 확정하지 않습니다.

검증은 두 생성 경로와 DTO, 무자동 POST, 미확정 잠금, 단일 GET·stale 응답, 실제 client→화면→저장 후보 검토, 이미 VALIDATED인 패치, candidate별 proposal 보존, fresh hash·409 재동의, version reject를 포함합니다. 브라우저는 pending/terminal/unknown/조회 실패/recovery/확인창·native keyboard·긴 ID·취소·canary 비노출을 실제 실행 결과로 확인합니다. 합성 HTTP/UI 증거는 A DB 저장·감사 원자성이나 실제 B provider/model·Gateway 방어·FA/Replay/지표 증거가 아닙니다.

## 남은 owner 계약과 실제 배포 조건

- A45의 endpoint·worker/scheduling·provider 설정과 실제 reviewer 자격이 서버에 배포되어야 실제 접수·처리가 가능합니다. C FE는 A queue/auth/version 예약·저장·승인 원자성을 구현하지 않습니다. 현재 참조가 Draft였다는 사실만으로 A API가 없다고 하지 않습니다.
- 공개 Operation은 알려진 ID 조회만 지원합니다. 전체 Operation 목록, 잃어버린 접수 key→Operation 조회, 보장된 replay validity/expiry 계약이 없어 영속 복구나 미확정 생성 재전송을 제공하지 않습니다.
- A는 patch 설명을 저장하지만 확인한 Operation/Version/detail 응답에는 rootCause·normalWorkflowImpact·rollback 및 전체 generation metadata의 안전한 proposal 상세 read가 없습니다. 현재 policy/diff 표시를 FS-05 전체 proposal 설명 완료로 확대하지 않습니다.
- 현재 A reject는 계약 version을 REJECTED로 만들며 patch_proposals의 거절 상태·patch_approvals 거절 기록을 완성하지 않습니다. 이 UI의 거절은 **계약 후보 거절**입니다.
- B provider/model의 실제 패치 envelope 처리와 실행, D Finding 판정·Oracle·metrics는 별도 owner 연결/증거입니다. 모델을 FE에서 호출하거나 판정·실행 사실을 합성하지 않습니다. 기존 C Gateway/Replay 구현의 존재와 실제 인증·관측·controls 공급자 연결 완료도 구분합니다.
