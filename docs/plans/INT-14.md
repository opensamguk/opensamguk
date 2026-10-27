# INT-14 5능력치 계약·저장·생성

> AC-INT-14 · 구현 Codex · 리뷰 Claude · 선행 INT-01 · 견적 3일
> 사용자 지시로 동결한 [통합판 v0.1](./integration-release.md)과 [5능력치](../product/five-stats.md)를 따른다.

## 계획

목표는 five-stats 프로필에 leadership·strength·intel·politics·charm을 연결한다. 신규 생성 15~90·합계275, 일반 NPC 10~85·합계250, 원본 역사 값 0~100을 엄격히 검사한다. 정치/매력은 누락을 0으로 채우지 않는다. 새 migration·생성/조회·clone/load/persist·origin/archive/hash와 입력 검사를 함께 만든다. 기존 3스탯 월드와 구형 아카이브의 값·산식·해시는 보존한다.

수정 범위는 packages/db/prisma/, packages/rules/src/model/, packages/rules/src/general/, packages/rules/src/world/, packages/rules/src/replay*, apps/engine/src/, apps/server/src/routers/general.ts다. 새 기능을 더하지 않는다. 기존 main·v1 기준 SHA와 자원 출처는 통합 기준 문서를 따른다. 세부 코드 경계·API 인증·엔진 단독 상태 변경·시드 RNG·턴 트랜잭션을 지킨다.

검증은 0/100·생성 합계·누락/추가 필드·NaN/비정수, 실제 DB 생성/재시작, origin 1·기존 archive 결과 불변, five-stats 새 판의 초기/최종 해시·외부 사용자 입력 거부

선행 인수 뒤 착수하고 검증 결과와 구현하지 않은 담당의 리뷰를 같은 문서에 남긴다. 구현자가 스스로 완료로 바꾸지 않는다.

## 구현 기록

아직 착수하지 않았다.

## 리뷰

구현·독립 리뷰 전.
