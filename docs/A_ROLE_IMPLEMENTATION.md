# A Role Implementation — Frontend

> 아래 구현/테스트 수치는 최초 A 콘솔의 기록입니다. 이후 전체 제품 UI와 샘플 B/C/D 화면이 추가됐습니다. 현재 역할별 수정 위치와 실제 API 연결 상태는 [프론트엔드 역할별 인수인계](FRONTEND_ROLE_HANDOFF.md), 디자인 적용 내용은 [Figma 인수인계](FIGMA_FRONTEND_HANDOFF.md)를 우선 확인하세요. 아래의 “역할 밖 미구현”은 최초 A 구현 범위를 뜻하며, 현재 B/C/D 샘플 화면이 없다는 의미는 아닙니다.

## 이 레포에서 A의 책임

Frontend의 A 범위는 Backend에 저장된 Platform/Data/Evidence를 안전하게 입력·조회하는
운영 콘솔입니다. 다른 역할의 결과를 보여줄 수는 있지만 그 결과를 계산하지는 않습니다.

## 구현한 화면

1. **개요**: Active Agent, Release, terminal Decision, revalidation 현황과 A 역할 경계
2. **Agents**: Agent key/name/purpose 등록, inventory 조회, archive
3. **Releases**: Agent별 Release, JSON manifest 입력/파일 불러오기, validate/analyze,
   canonical component fingerprint 조회
4. **Evidence**: confirmed ReleaseDecision의 exact Attestation 조회, stale 경고, JSON/HTML export
5. **Audit**: resource type + UUID 기반 append-only audit timeline
6. **Recovery**: operator-only pending 조회, `RELEASE`/`COMPLETE`, verification reference,
   exact confirmation phrase를 요구하는 fail-closed 화면

## 안전 사용 계약

- 모든 mutation은 Web Crypto UUID로 생성한 새 `Idempotency-Key`를 전송합니다.
- Backend Problem JSON의 `code`, `detail`, `traceId`, `retryable`을 보존합니다.
- Operator recovery key는 React 메모리에만 있고 local/session storage에 저장하지 않습니다.
- `RELEASE`는 원 작업 미실행, `COMPLETE`는 원 작업 실행과 exact response를 독립적으로
  확인한 경우에만 사용합니다.
- Attestation의 `STALE`는 증적 손상이 아니라 현재 Release를 다시 검증해야 함을 뜻합니다.

## 사용 순서

1. Backend와 PostgreSQL을 먼저 시작합니다.
2. `.env.example`을 `.env`로 복사하고 API URL/actor를 확인합니다.
3. `pnpm install --frozen-lockfile && pnpm dev`를 실행합니다.
4. Agents에서 Agent를 등록하고 Releases에서 Backend fixture 형식의 manifest를 등록합니다.
5. `Manifest 검증 → Analyze 고정 → Fingerprint 확인` 순서로 사용합니다.
6. D가 confirmed Decision을 저장한 뒤 Evidence에서 Attestation을 조회합니다.

## 검증 결과

- TypeScript strict project reference typecheck: PASS
- Vitest: 3 files / 13 tests PASS, line coverage 72.8%
- Vite production build: PASS, JS gzip 약 68.7 kB
- production dependency audit: known vulnerability 0건
- Playwright 실브라우저 production preview smoke: HTTP 200, Overview/Agents/등록 폼/Recovery
  렌더링과 내비게이션 PASS, recovery key browser storage 미저장 확인
- 테스트 범위: mutation actor/idempotency headers, Problem trace preservation,
  recovery credential header/exact confirmation, inventory/Agent form, malformed manifest,
  backend manifest issue `path`, stale/current Attestation Decision, recovery receipt persistence,
  Audit, A-role boundary, navigation/accessibility name

## 역할 밖 미구현

- Sandbox/Agent/Attack worker 실행 UI
- Safety Contract 편집·approval 판단 UI
- Oracle/Finding/Metric/Gate/Decision 계산 UI
