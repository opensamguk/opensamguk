# INT-12 전체 판·장애·복원·인수

> AC-INT-12 · 구현 Codex · 리뷰 Claude · 선행 INT-09, INT-11 · 견적 4일
> 사용자 지시로 동결한 [통합판 v0.1](./integration-release.md)과 [5능력치](../product/five-stats.md)를 따른다.

## 계획

목표는 전체 53도시 지도와 정식 191년·21국·491장수 판을 실제 화면·서버·PostgreSQL로 한 기수 끝까지 진행한다. 두 월드·재시작·중복·백업 복원·재생·전체 검사와 반대쪽 리뷰를 마친다. 공개 배포 완료로 부르지 않는다.

수정 범위는 e2e/, tools/, apps/engine/src/, docs/product/acceptance-criteria.md다. 새 기능을 더하지 않는다. 기존 main·v1 기준 SHA와 자원 출처는 통합 기준 문서를 따른다. 세부 코드 경계·API 인증·엔진 단독 상태 변경·시드 RNG·턴 트랜잭션을 지킨다.

검증은 pnpm check, pnpm test:int, pnpm e2e, 고정 시드/두 월드/복원과 archive 재생의 매월·종료 해시. skip·mock만·합성 소형 월드만으로 통과하지 않는다.

선행 인수 뒤 착수하고 검증 결과와 구현하지 않은 담당의 리뷰를 같은 문서에 남긴다. 구현자가 스스로 완료로 바꾸지 않는다.

## 구현 기록

아직 착수하지 않았다.

## 리뷰

구현·독립 리뷰 전.
