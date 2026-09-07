# B 완료 상태 점검표

## 1. 목적

이 문서는 개발 B의 구현 상태를 점검하기 위한 기준표이다.

B 역할이 완료로 간주되려면, 아래 항목을 모두 충족해야 한다.

---

## 2. 필수 완료 항목

### 2.1 실행 콘솔 기능

- [ ] Release 선택 UI가 동작한다
- [ ] READY 상태의 Test Suite 목록을 조회한다
- [ ] Test Suite 선택이 가능하다
- [ ] Test Run을 시작할 수 있다
- [ ] Test Run 목록을 조회할 수 있다
- [ ] 이미 생성된 Run을 선택해 상세조회할 수 있다
- [ ] 실행 상태를 표시한다
- [ ] 실행 진행률을 표시한다

### 2.2 이벤트/추적 기능

- [ ] Event History를 조회한다
- [ ] Event Chain 검증 결과를 표시한다
- [ ] 이벤트 타임라인 UI가 동작한다
- [ ] sequence, eventType, toolName, reasonCode를 표시한다
- [ ] tool input/output을 확인할 수 있다

### 2.3 결과 평가 기능

- [ ] Oracle 결과를 조회한다
- [ ] Finding 결과를 조회한다
- [ ] 결과 목록을 화면에 표시한다
- [ ] 상태/심각도/카테고리별 분류가 가능하다

### 2.4 API 안정성

- [ ] B API 요청에 actorId가 포함된다
- [ ] mutation 요청에 idempotency key가 포함된다
- [ ] 실패 응답을 FinsecApiError로 변환한다
- [ ] timeout이 처리된다
- [ ] retryable 오류가 재시도된다
- [ ] 비재시도 에러는 즉시 실패 처리된다

### 2.5 경계 관리

- [ ] B 코드가 C/Gateway 구현 세부사항을 직접 수행하지 않는다
- [ ] B는 호출 의도와 UI 상태 관리에 집중한다
- [ ] Gateway/Policy/Model dispatch는 별도 계층으로 분리되어 있다
- [ ] B 코드에서 외부 model routing을 직접 결정하지 않는다

---

## 3. 테스트 기준

다음 테스트가 통과해야 B 구현을 완료로 인정할 수 있다.

- [ ] READY suite 선택 테스트 통과
- [ ] Run list 조회 테스트 통과
- [ ] Test run start 테스트 통과
- [ ] replay comparison 조회 테스트 통과
- [ ] timeout 처리 테스트 통과
- [ ] retry 로직 테스트 통과
- [ ] 회귀 테스트 전체 통과

---

## 4. 아직 완료로 보기 어려운 항목

다음 항목은 B 완료 기준에 포함하지 않거나, 별도 C/Gateway 작업으로 분리해야 한다.

- [ ] Runtime 내부에서 실제 C Gateway 호출 구현
- [ ] Dispatcher와 Gateway의 실제 연결
- [ ] Model routing/adaptation 계층 구현
- [ ] policy enforcement logic의 외부 호출 경로 구현
- [ ] gateway circuit breaker / fallback 전략 운영

이 항목들은 B 완료 체크리스트의 “별도 구현 대상”으로 관리한다.

---

## 5. 최종 판정 기준

다음 조건을 모두 만족하면 B 구현을 완료 상태로 봐도 된다.

1. 핵심 실행 흐름 전부 동작한다
2. 테스트가 통과한다
3. 경계가 명확하다
4. C/Gateway 실제 연동이 별도 구현 대상인지 분리되어 있다

다음 조건 중 하나라도 만족하지 않으면, B는 “완료”가 아니라 “핵심 기능 구현 중”으로 봐야 한다.

- 실제 Runtime/Dispatcher가 Gateway를 호출하지 않는다
- C/Gateway call path가 정의되지 않는다
- B 코드가 외부 호출 정책을 직접 관리한다

---

## 6. 현재 상태 판단

현재 코드 기준으로 보면,

- B 실행 콘솔 기능: 완료
- B API 안정성: 완료
- B 경계 설계와 분리: 유지 중
- C/Gateway 실연동: 미구현

따라서 현재 상태는

> “B 핵심 구현 완료, C/Gateway 연결은 별도 작업”

으로 판단하는 것이 가장 정확하다.
