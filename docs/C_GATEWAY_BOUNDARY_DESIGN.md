# C/Gateway 경계 설계 초안

## 1. 목적

이 문서는 FINSEC SEAL의 B 역할과 C/Gateway 역할 간 경계를 정의한다.

핵심 원칙은 다음과 같다.

- B는 사용자 실행 흐름, 런 상태, 결과 조회, UI 표시를 담당한다.
- C/Gateway는 정책 평가, 모델 호출, 외부 호출 안정성, 에러 분류를 담당한다.
- B 코드 안에 C의 네트워크/정책 로직을 직접 구현하지 않는다.
- C는 별도 어댑터 계층 또는 서비스 계층을 통해 B와 연결된다.

이 문서는 “설계 문서”이며, 실제 구현은 별도 C 구현 스코프로 분리한다.

---

## 2. 역할 분리 원칙

### 2.1 B 역할

B는 실행 콘솔과 런타임 상태 관리에 집중한다.

다음 책임을 가진다.

- Release 선택
- READY 상태 Test Suite 조회
- Test Run 생성 및 상태 갱신
- Run/Case 진행률 표시
- 이벤트 타임라인 조회
- Oracle/Finding/Trace 결과 표시
- Evidence 기반 사용자 확인 UI 제공
- Replay 및 결과 비교 결과 표시

B는 비즈니스 흐름을 알고 있지만, 아래 사항을 직접 구현하지 않는다.

- 외부 정책 모델 호출
- retry/backoff 정책
- timeout 관리
- circuit breaker
- gateway-specific error transformation
- model routing과 dispatch 로직

### 2.2 C/Gateway 역할

C는 외부 정책/모델/게이트웨이 호출 경계를 책임진다.

다음 책임을 가진다.

- Policy evaluation 요청
- Model invocation dispatch
- Gateway 라우팅
- Timeout, retry, backoff 처리
- Circuit breaker / fallback 처리
- 에러 타입 분류 및 표준화
- 응답 값 검증 및 변환
- B가 이해할 수 있는 결과 DTO 제공

C는 B의 UI 상태를 제어하지 않는다. C는 단순히 결과를 반환한다.

---

## 3. 경계 규칙

### 3.1 허용되는 연결 방식

B는 C를 직접 호출하는 대신, 다음 구조를 유지한다.

1. B는 사용자 액션을 도메인 요청으로 변환한다.
2. B는 C 전용 어댑터 인터페이스를 호출한다.
3. 어댑터는 C 서비스 구현체를 내부에서 선택한다.
4. C 서비스는 표준 응답을 B로 반환한다.

이 구조는 다음을 보장한다.

- B는 네트워크 세부사항을 알지 않아도 된다.
- C는 Gateway 운영 정책을 독립적으로 관리할 수 있다.
- 테스트가 쉬워진다.

### 3.2 금지되는 구현 패턴

다음은 B 영역 침범으로 간주한다.

- `Execution.tsx`에서 직접 `fetch` 호출
- C Gateway URL, timeout, retry, circuit breaker를 B 코드에 하드코딩
- B의 실행 상태 관리 로직 안에 gateway-side error map을 넣는 것
- `Runtime` 또는 `Dispatcher`가 C 호출 로직을 소유하는 것
- B의 도메인 DTO와 C의 외부 DTO를 섞는 것

---

## 4. 추천 아키텍처

### 4.1 모듈 구조

향후 C/Gateway 구현은 별도 모듈로 분리하는 것을 권장한다.

```text
src/
  api/
    client.ts                 // B API client
    contracts.ts              // B DTOs

  gateway/
    contracts.ts              // C DTOs
    GatewayClient.ts          // 인터페이스
    DefaultGatewayClient.ts   // 구현체
    retry.ts                  // retry policy
    timeout.ts                // timeout config
    errors.ts                 // normalized error models
```

### 4.2 의존성 방향

권장 방향은 다음과 같다.

```text
B UI / B Runtime
      ↓ uses
GatewayClient interface
      ↓ implemented by
C Gateway service
```

핵심은 B가 C 구현체에 직접 의존하지 않는다는 점이다.

---

## 5. 인터페이스 설계 예시

아래는 설계 초안이며, 실제 구현은 C 스코프에서 세부화한다.

```ts
export interface GatewayClient {
  request<TResponse>(request: GatewayRequest): Promise<TResponse>;
}

export type GatewayRequest = {
  operation: 'policy.evaluate' | 'model.dispatch' | 'replay.compare';
  payload: Record<string, unknown>;
  correlationId?: string;
};

export type GatewayError = {
  code: 'TIMEOUT' | 'RETRY_EXHAUSTED' | 'INVALID_RESPONSE' | 'GATEWAY_UNAVAILABLE';
  message: string;
  retryable: boolean;
  correlationId?: string;
};
```

B는 이 인터페이스를 사용하고, 내부 구현은 C가 책임진다.

---

## 6. 타임아웃 / 재시도 / 에러 처리 경계

### C 담당

- request timeout 값 설정
- retry 정책 결정
- backoff 계산
- 429/5xx 분류
- 네트워크 장애/응답 실패 표준화
- 실패 시 사용자 친화적 에러로 변환

### B 담당

- 사용자에게 실패 상태를 표시
- 재시도 버튼 UI 노출
- 운영 상태 메시지 렌더링
- 실패 원인에 대한 사용자 안내

즉, B는 “어떻게 보여줄지”를 관리하고, C는 “어떻게 호출할지/실패를 처리할지”를 관리한다.

---

## 7. Runtime / Dispatcher와 C Gateway의 관계

### 정의

- Runtime: B 영역의 실행 흐름 조정
- Dispatcher: 작업의 흐름 분배 및 상태 전이

### 권장 경계

- Runtime/Dispatcher는 B의 실행 스케줄링만 담당한다.
- C Gateway 호출은 별도 adapter/service layer로 분리한다.
- Runtime은 “결과를 요청한다” 정도만 알고, 내부 호출 전략은 모른다.

### 비권장 패턴

- Runtime/Dispatcher 내부에서 직접 `fetch` 또는 gateway logic 구현
- C Gateway 연결 코드를 B runtime 모듈에 하드코딩
- C api contract를 B runtime DTO 안에 섞음

---

## 8. 구현 우선순위

### Phase A: 경계 정리

- B/C 역할 문서화
- 인터페이스 정의
- DTO 분리
- error contract 정리

### Phase B: C 구현

- GatewayClient 구현
- timeout/retry 정책
- normalized error mapping
- telemetry / correlationId 추가

### Phase C: B 연결

- B 화면에서 adapter 인터페이스 호출
- 상태 UI 기반으로 결과 반영
- 통합 테스트

---

## 9. 최종 원칙

다음 문장을 기준으로 구현한다.

> B는 실행을 조립하고 보여주고, C는 호출을 안정적으로 수행한다.

B와 C의 경계가 무너지면, 재사용성, 테스트 가능성, 책임 분리가 모두 약해진다.
따라서 C/Gateway 구현은 별도 구현 스코프로 분리하고, B 코드에는 인터페이스 의존만 남겨야 한다.

---

## 10. 적용 기준

해당 설계에 따라 구현을 검토할 때는 아래 질문을 사용한다.

- 이 로직이 B의 사용자 실행 흐름을 조정하는가?
- 이 로직이 gateway 호출 규칙을 직접 다루는가?
- 이 로직이 timeout/retry/circuit breaker를 관리하는가?
- B 화면 코드가 C 네트워크 구현 세부사항을 알고 있는가?

하나라도 예라면, 해당 코드는 B 스코프에서 벗어난 것으로 간주한다.
