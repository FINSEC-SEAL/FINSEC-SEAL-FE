# FINSEC SEAL Frontend

FINSEC SEAL의 Role A(Platform / Data / Evidence) 운영 콘솔입니다.

## Scope

- Agent inventory 등록·조회·archive
- strict Release manifest 등록과 validate/analyze/fingerprint 조회
- confirmed Decision을 기반으로 한 Attestation JSON/HTML 조회·export
- resource-scoped append-only audit 조회
- fail-closed idempotency reservation의 operator recovery

Attack 실행, Safety Policy 편집·판단, Oracle/Finding/Metric/Gate/Decision 계산은
이 콘솔의 책임이 아닙니다.

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
