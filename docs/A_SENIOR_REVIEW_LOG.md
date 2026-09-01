# A Senior Review Log — Frontend

## F0 — Scope and stack baseline

- Role boundary: A가 소유한 inventory/release/fingerprint/evidence/audit/recovery만 mutation 가능
- Stack: Node 24 LTS, React 19.2, Vite 8.2, TypeScript 7, Vitest 4
- Backend과 동일한 typed envelope/problem/actor/idempotency/recovery credential 계약 반영
- 검토 상태: 구현 후 fixed commit 기준 선임 독립 검토 예정

## F1 — Implementation self-verification

- `pnpm typecheck`: PASS
- `pnpm test:coverage`: 3 files / 10 tests PASS, line coverage 64.8%
- `pnpm build`: PASS
- `pnpm audit --prod`: known vulnerability 0건
- DOM 접근성 테스트가 nav 장식 문자를 accessible name에 포함하는 문제를 탐지해
  `aria-hidden` 처리 후 재검증
- Agent 등록 비동기 submit의 `await` 후 React event `currentTarget` 참조가 유효하지 않은
  실패를 테스트가 탐지해, await 전 form reference를 고정하도록 수정
- Recovery key가 browser storage에 저장되지 않고, 잘못된 credential은 Backend pre-filter에서
  idempotency reservation 전에 거부되는 계약 확인
- 검토 상태: fixed commit 생성 후 선임 review 예정

## F2 — First senior review

- Result: rejected
- Reviewed fixed commit: `edbcd8f47597f9f10a847e35acda7d3fce27a291`
- Independent verification: 선임이 Node 24 컨테이너에서 typecheck/test/build를 재실행
- Feedback:
  - Backend Manifest Issue JSON은 `path`인데 FE가 `pointer`로 해석해 검증 위치가 표시되지 않음
  - current Attestation을 실제 confirmed Decision과 무관하게 `PASS`로 표시
  - recovery 성공 알림이 queue 재조회 중 즉시 제거됨
- Applied:
  - `ManifestIssue.path`/`severity`를 Backend record와 일치시키고 실제 path 표시 테스트 추가
  - Attestation canonical document의 `PASS`/`REVIEW`/`BLOCKED`를 검증해 그 결과를 badge로 표시;
    비정상 값은 `INVALID`, stale은 기존대로 `STALE`
  - recovery 성공 receipt를 queue 재조회 후에도 보존하고 회귀 테스트 추가
- Reverification: Node 24.19.0 / pnpm 11.19.0에서 typecheck, 3 files / 13 tests,
  line coverage 72.8%, production build, production dependency audit, `git diff --check` 전부 통과
- Gate: fixed commit 생성 후 선임 second review 요청

## F3 — Second senior review

- Result: approved
- Reviewed fixed commit: `8b14e8a5959e53705326db888f5abeb5f474a889`
- Independent verification:
  - `ManifestIssue.path`/`severity` Backend 계약과 화면 path 표시 일치
  - current Attestation이 canonical `PASS`/`REVIEW`/`BLOCKED`를 표시하고
    malformed/stale는 `INVALID`/`STALE`로 분리
  - recovery queue 재조회 후 성공 receipt 유지
  - Node 24.19.0 / pnpm 11.19.0, typecheck PASS, 13/13 tests PASS, production build PASS
- Remaining findings: none
- Gate: F3 PASS
