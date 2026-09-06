# FINAgent SEAL Frontend

금융 AI Agent 보안 검증 플랫폼입니다. Figma의 Navy–Purple 디자인과 전체 제품 화면을 적용했으며, 기존 Role A(Platform / Data / Evidence) API 기능을 보존합니다.

기본 진입은 **SIMULATED 체험 모드**입니다. 실제 서버를 실행하지 않아도 화면을 확인할 수 있습니다. 상단 **환경 설정 → 실제 API 연결 모드로**에서 기존 백엔드를 사용할 수 있습니다. API 실패를 샘플 성공 결과로 대체하지 않습니다.

- `/#/demo/start`: 서비스 소개와 샘플 검증 체험
- `/#/demo/overview`: 전체 워크스페이스
- `/#/live/overview`: 실제 Role A API inventory
- [Figma 적용 범위와 검수 기록](docs/FIGMA_FRONTEND_HANDOFF.md)
- [팀원용 역할별 프론트 작업 가이드](docs/FRONTEND_ROLE_HANDOFF.md)

## 팀원별 이어서 작업할 곳

| 담당 | 시작할 코드 | 다음 작업 |
| --- | --- | --- |
| A · Platform/Data/Evidence | `ProductApp.tsx`, `EntryPages.tsx`, `features/`의 A 화면 | 실제 Release/Run 선택, 상태·SSE·구성 변경·증적 연결 |
| B · Runtime/Attack | `VerificationPages.tsx`의 `RunsPage`, `TracePage` | 실제 실행·취소·도구 Trace 연결 |
| C · Policy/Security | `VerificationPages.tsx`의 `PoliciesPage`, `PolicyDetail`, `GatewayPage` | 후보·검증·승인·Gateway 및 Replay 비교 조건 연결 |
| D · Evaluation/Assurance | `VerificationPages.tsx`의 Finding/Verification/Report 화면 | Oracle·지표·판정 API와 A 증적 연결 |

위 `EntryPages.tsx`와 `VerificationPages.tsx`는 `src/product/`, 나머지는 `src/` 기준입니다.
**각자 어디를 어떻게 수정할지, 이미 있는 BE API와 미확정 계약, Replay 책임 경계, PR 완료 조건은 [역할별 인수인계](docs/FRONTEND_ROLE_HANDOFF.md)에 정리했습니다.**
현재 B·C·D 화면은 샘플이며, 백엔드에 일부 API가 존재하더라도 프론트 실연동이 끝난 것은 아닙니다.

## Design system

[통합 Design System](design_system.md)은 사용자 참조 이미지에 기반한 차콜·바이올렛 디자인 초안입니다.
공통 토큰·컴포넌트·상태 의미·반응형 규칙, 현재 A 화면 적용안과 B·C·D 확장 기준을 정리합니다.
현재 UI에는 Figma의 브랜드 원본·220px Sidebar·Navy/Purple 토큰과 화면 구조를 반영했습니다. 기존 API 계약은 변경하지 않았습니다.

## Scope

- Agent inventory 등록·조회·archive
- strict Release manifest 등록과 validate/analyze/fingerprint 조회
- confirmed Decision을 기반으로 한 Attestation JSON/HTML 조회·export
- resource-scoped append-only audit 조회
- fail-closed idempotency reservation의 operator recovery

공격 추적, Finding, 정책 승인, 전후 비교, Held-out/정상업무, 보고서와 예외 상태의 **대화형 UI**도 제공합니다. 현재 이 부분은 준비된 합성 fixture만 사용하며 실제 B·C·D 실행 API에 연결되지 않았습니다. 실제 Attack 실행, Policy 판단, Oracle/Metric/Gate/Decision 계산은 담당 서비스의 책임입니다.

샘플 등록값과 입력은 메모리에만 유지되며 페이지 새로고침·모드 전환 시 사라집니다. 실제 비밀키·고객정보를 입력하지 마세요. SIMULATED에서는 실제 정책 변경·판정 확정·HTML/JSON 증적 내보내기를 수행하지 않습니다.

## Stable baseline

- Node.js 24 LTS
- pnpm 11.19.0
- React / React DOM 19.2.8
- TypeScript 7.0.2
- Vite 8.2.2
- Vitest 4.1.11

## Run

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

Backend는 기본 `http://localhost:8080`, Frontend는 `http://localhost:5173`을 사용합니다.
Backend CORS의 `FINSEC_CORS_ALLOWED_ORIGINS`에 Frontend origin이 포함되어야 합니다.

Homebrew Node가 손상된 현재 개발 환경에서는 Codex bundled Node 24로 검증했습니다.
`nvm use` 또는 동등한 Node 24 런타임을 사용하세요.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```

상세 역할·사용법·제한은 [`docs/A_ROLE_IMPLEMENTATION.md`](docs/A_ROLE_IMPLEMENTATION.md),
선임 검토 기록은 [`docs/A_SENIOR_REVIEW_LOG.md`](docs/A_SENIOR_REVIEW_LOG.md)를 참조하세요.
