# FINAgent SEAL · Figma → Frontend 적용

팀원이 이어서 구현할 파일·함수·실제 API·역할 경계·완료 조건은 [프론트엔드 역할별 인수인계](FRONTEND_ROLE_HANDOFF.md)를 참조하세요. 이 문서는 디자인 적용 범위와 당시 검수 기록입니다.

## 디자인 기준

[전체 화면 목차](https://www.figma.com/design/8UTc3nLUhdLqicazZNtAVN?node-id=24-2), `03 · 전체 제품 UI & BCD 가이드`의 P01–P26 및 두 번째 페이지의 검증 시작 화면을 기준으로 적용했다. Figma MCP Starter 한도로 `get_design_context`가 거절되어, 같은 파일에 실제로 가져온 로컬 SVG 생성 소스·토큰·검수 캡처를 사용했다.

- Navy/Purple 공통 토큰, 220px Sidebar, Noto Sans KR, 카드·표·필드·알림을 React/CSS로 구현.
- 사용자가 제공한 브랜드 이미지의 정확한 원본을 `public/assets/brand-reference.png`에 복사하고 CSS로 해당 로고 영역만 표시. 로고를 새로 그리지 않았다.
- 기존 Role A 컴포넌트와 API client를 재사용하고, `PlatformClient` 주입으로 실제 API와 합성 fixture를 분리.
- 정적인 1440×1040 프레임의 절대 좌표를 복사하지 않고 Grid/Flex로 반응형 재구성. 긴 증거·표는 페이지 또는 표 내부에서 스크롤한다.
- 주요 버튼은 텍스트 대비를 위해 Figma의 표시용 purple보다 어두운 `--primary`를 사용한다.

## 화면 매핑

라우트는 hash 기반이므로 정적 호스팅에서도 별도 rewrite 없이 새로고침·뒤로 가기가 가능하다. `/demo/`와 `/live/`는 **hash 안의 경로**다.

| Figma | 체험 URL hash | 구현 |
|---|---|---|
| 기존 검증 시작 | `#/demo/start` | 서비스 설명, 샘플 실행, 등록 진입 |
| P01 | `#/demo/overview` | inventory, 현재 실행, 다음 검토 |
| P02 | `#/demo/agents` | 검색·등록·보관·릴리스 진입 |
| P03 | `#/demo/releases` | Agent 필터·버전·현재 상태 |
| P04 | `#/demo/manifest` | JSON/파일 입력·Draft·검증·Analyze·Fingerprint |
| P05 | `#/demo/release` | 업무 경계·고정 구성·8단계 흐름 |
| P06 | `#/demo/runs` | 실행 목록 필터·설정·선행 단계 안내 |
| P07 | `#/demo/trace` | 대표 사례 6단계 이벤트·마스킹 증거·취소 |
| P08–09 | `#/demo/findings`, `#/demo/finding` | 검색·심각도 필터·근거·개선 후보 |
| P10–12 | `#/demo/policies`, `#/demo/policy` | 버전·8가지 규칙·JSON 발췌·승인 확인창 |
| P13 | `#/demo/gateway` | 공격 DENY / 정상 ALLOW 전환·API 실제 호출 여부 |
| P14 | `#/demo/replay` | 동일 조건 증거 비교·유형별 차트·정상 control |
| P15 | `#/demo/verification` | Held-out·정상업무·FBR·남은 critical 위험 |
| P16–17, P26 | `#/demo/reports`, `#/demo/report` | 현재/과거/초안·판정 입력·확정 확인창 |
| P18, P25 | `#/demo/changed`, `#/demo/evidence` | 구성 변경·비교 불가·과거 증적, Manifest의 fingerprint 조회 |
| P19 | `#/demo/audit` | resource-scoped 감사 조회·digest·metadata |
| P20–21 | `#/demo/recovery` | 샘플 운영자·대기열·RELEASE/COMPLETE 확인 입력 |
| P22–23 | `#/demo/states` 및 각 목록 | 예외 가이드·연결 상태·로딩·빈 결과 |
| P24 | 상세 화면의 데모 초기화 | 확인창·활성 실행 차단·검증 표시 초기화 |
| P25 승인 충돌 | 정책 승인 확인창 | 409 예시·의견 보존·재검토·재동의 |

P00은 Figma 인수인계용 목차이므로 별도 서비스 메뉴로 노출하지 않았다.

## 체험 순서와 데이터 경계

1. **샘플 검증 체험** → 합성 진행 표시 → 기본 시험 완료.
2. CASE-1001의 도구 요청·응답·타 고객 2건/민감 필드 1종 확인.
3. **정책 후보 검토** → 의견과 체크박스로 범위 확인 → **샘플 승인 후 재검증**.
4. 같은 사례의 API 미호출·0 effect와 정상 control ALLOW를 비교.
5. **합성 추가 검증 실행** → Held-out 1/40, 정상 29/30, FBR 1/30.
6. 남은 GC critical success에 대한 **BLOCKED 합성 보고서** 확인.

준비된 초기 상태는 기본 시험이 끝난 검토 단계다. 시작 화면에서 다시 실행하거나 상세 화면에서 초기화할 수 있다. 샘플 승인은 로컬 상태만 바꾸며 실제 API/LLM/정책/금융 거래를 호출하지 않는다. 최종 확정·증적 내보내기는 SIMULATED에서 비활성이다.

단일 대표 사례의 완성된 trace는 CASE-1001이다. 다른 사례는 제목·분류와 미제공 근거 안내를 표시하며 상세 증거를 만들어내지 않는다. 모든 ID·시각·hash·수치는 fixture이다. `demo/platform.ts`의 validation은 기본 구조 체험이지 strict schema나 보안 검증이 아니다.

## 실제 API 모드

`#/live/overview`로 진입하거나 환경 설정에서 전환한다. `VITE_FINSEC_API_BASE_URL`은 기존 설정을 유지한다. API actor는 환경 설정에서 적용한다. Actor 헤더는 인증 대체 수단이 아니다.

기존 Agent create/archive, Release create/validate/analyze/fingerprint, Attestation 조회/export, Audit, 운영자 Recovery가 실제 클라이언트를 그대로 사용한다. 운영자 키는 화면 상태에만 유지한다. inventory 조회가 실패해도 독립적인 Audit/Recovery 폼은 접근할 수 있다.

B·C·D 화면은 실제 API 모드에서 **연동 대기**를 표시한다. 서버 오류를 합성 성공으로 바꾸지 않는다. 실제 API 연동 및 서버 권한/무결성 검사 구현은 별도 작업이다. 이번 작업은 백엔드 코드를 변경하지 않았다.

## 검수

- Node 24.19.0: TypeScript 검사 및 Vite production build 성공.
- Vitest: 기존 API·Role A 동작, 모드 격리, 메뉴, 필터, 승인·충돌, Replay·추가 검증, BLOCKED 보고서, 활성 실행 초기화 차단, fixture 격리 테스트 통과.
- 실제 브라우저: 22개 체험 라우트의 heading/main 렌더와 1440px 가로 넘침 검사. 페이지 실행 오류 없음.
- 390px: 시작·추적·정책·Agent·Manifest·복구의 가로 넘침 검사 및 캡처 확인.
- 정책 승인 → Replay → 추가 검증 → 보고서 흐름을 브라우저에서 직접 조작해 확인.
- 모바일 메뉴 열기·Escape 닫기, 환경 설정 dialog의 Tab 포커스 제한·Escape 닫기·호출 버튼으로 포커스 복귀 확인.
- 브라우저 캡처는 `output/playwright/`에 로컬 QA 자료로 보관하며 Git 대상에서 제외한다.

모바일에서 증거 패널은 별도 dialog로 열리며, 네이티브 dialog의 Escape·포커스 제한을 사용한다. 전체 스크린리더·색 대비·모든 브라우저 전수 검증 완료를 의미하지 않는다. 사용자 지정 실제 Agent의 공격 실행은 B·C·D API 연결 전까지 지원하지 않는다.
