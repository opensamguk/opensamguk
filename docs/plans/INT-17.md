# INT-17 기본 계략4종 운영 연결

> AC-INT-17 · 구현 Codex · 리뷰 Claude · 선행 INT-14, INT-15 · 견적 3~4일
> 사용자 지시로 동결한 [통합판 v0.1](./integration-release.md)과 [5능력치](../product/five-stats.md)를 따른다.

## 계획

목표는 기존 화계·파괴·선동·탈취 순수 규칙을 선택 재사용해 새 프로필에 등록한다. five-stats의 공격 점수와 지력 저항, 기존 비용·RNG·피해를 연결한다. 기존 ext/personnel 충돌 플래그를 없애는 우회는 금지하고 필요한 네 명령만 typed 저장/입력/재생 어댑터로 잇는다. 장비·전략8종·특수병종·카드 명령은 제외한다.

수정 범위는 packages/rules/src/commands/ext/stratagem/, packages/rules/src/ruleRegistry.ts, apps/engine/src/, apps/server/src/, e2e/다. 새 기능을 더하지 않는다. 기존 main·v1 기준 SHA와 자원 출처는 통합 기준 문서를 따른다. 세부 코드 경계·API 인증·엔진 단독 상태 변경·시드 RNG·턴 트랜잭션을 지킨다.

검증은 인사/서약과4계략 공존, 실제 DB 실행·비용/실패·타인/제재·중복 입력·재시작, source RNG 검증·archive 재생/해시, UI 명령 목록과 엔진 가능 명령 일치

선행 인수 뒤 착수하고 검증 결과와 구현하지 않은 담당의 리뷰를 같은 문서에 남긴다. 구현자가 스스로 완료로 바꾸지 않는다.

## 구현 기록

아직 착수하지 않았다.

## 리뷰

구현·독립 리뷰 전.
