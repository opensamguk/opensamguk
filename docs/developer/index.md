# 개발자 핸드북

> 상태: 뼈대 · 필요 시점: M1 · 참고: core2026 `docs/developer/index.md`

## 읽기 순서

1. [PRD](../product/prd.md)의 한 줄 요약과 §5 핵심 게임 루프
2. [인수조건](../product/acceptance-criteria.md)에서 지금 진행 중인 AC
3. [아키텍처 개요](../architecture/overview.md) → [패키지 경계](../architecture/package-boundaries.md)
4. [요청·턴·저장 흐름](./request-turn-persistence.md)
5. 맡은 기능의 문서 (아래 표)

## 질문별 문서

| 질문                                   | 문서 |
| -------------------------------------- | ---- |
| 무엇이 어디서 실행되나요?              | [개요](../architecture/overview.md), [런타임](../architecture/runtime.md) |
| 어느 파일부터 읽나요?                  | [파일 지도](./code-map.md) |
| 명령 하나는 어떻게 계산되나요?         | [명령 프로토콜](../architecture/command-protocol.md) |
| 언제 저장되고 실패는 어떻게 하나요?    | [요청·턴·저장 흐름](./request-turn-persistence.md) |
| 시간 정지·재개는?                      | [게임 시계](../architecture/game-clock.md) |
| 월드 초기 상태는 어떻게 만드나요?      | [시나리오 합성](../architecture/scenario-composition.md) |
| 화면에 변화가 어떻게 전달되나요?       | [실시간 갱신](../architecture/realtime.md) |
| 무엇을 어떻게 테스트하나요?            | [테스트 정책](../testing-policy.md) |
| 숫자는 정수인가요, 소수인가요?         | [수치 상태 정책](../numeric-state-policy.md) |

## 작업 시작 체크

- [ ] 이 작업의 AC ID가 있다
- [ ] 다른 진행 중 AC가 없다
- [ ] AC의 검증 방법을 어떻게 실행할지 안다
