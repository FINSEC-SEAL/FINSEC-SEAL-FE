# B / C 역할 분리 표

## 1. 원칙

이 문서는 FINSEC SEAL에서 B 역할과 C/Gateway 역할이 각자 무엇을 책임지고, 무엇을 직접 구현하지 않는지 명확하게 정의한다.

핵심 원칙:

- B는 사용자 실행 흐름과 UI/상태 관리에 집중한다.
- C/Gateway는 외부 호출, 정책 평가, 안전성 장치, 응답 표준화에 집중한다.
- B 코드 안에 C의 호출 전략, timeout, retry, routing 로직을 직접 넣지 않는다.
- C는 별도 어댑터 계층을 통해 B와 연결된다.

---

## 2. 역할 분리 표

| 영역 | B 역할 | C/Gateway 역할 | 비고 |
|---|---|---|---|
| 사용자 입력 | Release 선택, Suite 선택, Run 시작 매개변수 수집 | 없음 | B가 입력을 조립한다 |
| 실행 흐름 | Run 생성, 상태 전이, 이벤트 조회, 결과 표시 | 없음 | B는 실행을 orchestrate한다 |
| Test Suite 조회 | READY suite 목록 표시 | 없음 | B는 선택 UI만 담당 |
| Run 상태 관리 | queued/running/completed/failed 표시 | 없음 | 상태 모델은 B가 소유 |
| Event timeline | sequence 기반 timeline 렌더링 | 없음 | UI 표현만 담당 |
| Oracle/Finding 표시 | 결과 조회 및 표시 | 없음 | D의 판정 결과를 소비한다 |
| Policy evaluation | 요구사항 전달 | 실제 policy 평가 실행 | B는 계약만 알고, C가 실체 구현 |
| Model dispatch | 호출 의도만 정의 | 모델 선택, routing, payload 변환 | B는 호출 목적만 알 수 있음 |
| Timeout | 사용자에게 timeout 상태 표현 | 실제 timeout 설정 및 종료 처리 | B는 UI 동작만 수행 |
| Retry/backoff | 재시도 UI 및 에러 안내 | 재시도 정책, backoff, 실패 분류 | B는 실패 상태만 처리 |
| Error mapping | 사용자 친화적 메시지 렌더링 | 기술 에러 -> 표준 에러 변환 | B는 최종 사용자 메시지 담당 |
| Circuit breaker | 없음 | Gateway 안정성 장치 | C가 관리하는 운영 안정성 |
| Replay comparison | 결과 표시 및 비교 표기 | comparable, mismatchReasons 계산 | B는 UI 표시, C는 계산 |
| Evidence 보존 | 수신 결과 보관 및 노출 | Evidence 생성/검증 | B는 조회용 인터페이스만 사용 |

---

## 3. 구현 허용 기준

### B가 직접 구현해도 되는 것

- 사용자 액션에 따른 상태값 업데이트
- 선택된 Release/Suite/Run ID 관리
- API 호출의 입력값 조립
- 결과를 화면에 보여주는 렌더링 로직
- 에러 메시지 노출과 재시도 버튼 로직
- B 전용 DTO의 상태 표현

### B가 직접 구현하면 안 되는 것

- `fetch`를 직접 호출해 Gateway URL, timeout, retry 정책을 결정하는 것
- 정책 모델에 대한 실제 위임 로직
- `Runtime/Dispatcher` 안에서 C strategy를 직접 구현하는 것
- model routing, gateway selection, external response normalization
- unexpected external failure를 내부적으로 재정의하는 것

---

## 4. 의존성 방향

권장 의존성 방향은 다음과 같다.

```text
B UI / B Runtime
    ↓ uses
GatewayClient interface
    ↓ implemented by
C/Gateway service
```

이 구조를 지키면 다음 장점을 가진다.

- B 역할 단순화
- C 안정성 로직 분리
- 테스트 가능성 향상
- 역할 경계 유지

---

## 5. 구체적 판단 기준

아래 질문에 하나라도 '예'라면 해당 코드는 B 범위를 넘긴 것이다.

- 이 로직이 실제 외부 호출 전략을 직접 관리하는가?
- 이 로직이 timeout/retry/circuit breaker를 구현하는가?
- 이 로직이 gateway routing을 결정하는가?
- 이 로직이 C의 표준 에러를 변환하는가?
- 이 로직이 Runtime/Dispatcher 안에서 외부 모델 호출을 수행하는가?

만약 그렇다면, 해당 코드는 C/Gateway 스코프로 분리해야 한다.

---

## 6. 실무 체크리스트

### B에서 허용

- [ ] releaseId, suiteId, runId를 바인딩한다
- [ ] READY 상태 체크를 수행한다
- [ ] 실행 결과를 화면에 표시한다
- [ ] 사용자 액션과 에러 메시지를 연결한다
- [ ] B DTO를 기반으로 UI 상태를 관리한다

### C/Gateway에서 허용

- [ ] timeout 설정
- [ ] retry 정책
- [ ] backoff 계산
- [ ] gateway route 선택
- [ ] 정책 평가 호출
- [ ] 응답 검증 및 에러 표준화

---

## 7. 결론

B는 실행과 결과 표시를 책임지고, C/Gateway는 외부 호출과 정책 판단을 책임지는 구조가 가장 안전하다.

이 경계를 지키면 다음이 유지된다.

- B 코드가 단순하다
- C 구현이 독립적으로 발전한다
- 테스트와 유지보수 비용이 줄어든다
- role ownership가 명확해진다
