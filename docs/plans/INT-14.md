# INT-14 5능력치 계약·저장·생성

> AC-INT-14 · 구현 Codex · 리뷰 Claude · 선행 INT-01 · 견적 3일
> 사용자 지시로 동결한 [통합판 v0.1](./integration-release.md)과 [5능력치](../product/five-stats.md)를 따른다.

## 계획

목표는 five-stats 프로필에 leadership·strength·intel·politics·charm을 연결한다. 신규 생성 15~90·합계275, 일반 NPC 10~85·합계250, 원본 역사 값 0~100을 엄격히 검사한다. 정치/매력은 누락을 0으로 채우지 않는다. 새 migration·생성/조회·clone/load/persist·origin/archive/hash와 입력 검사를 함께 만든다. 기존 3스탯 월드와 구형 아카이브의 값·산식·해시는 보존한다.

수정 범위는 packages/db/prisma/, packages/rules/src/model/, packages/rules/src/general/, packages/rules/src/world/, packages/rules/src/replay*, apps/engine/src/, apps/server/src/routers/general.ts다. 새 기능을 더하지 않는다. 기존 main·v1 기준 SHA와 자원 출처는 통합 기준 문서를 따른다. 세부 코드 경계·API 인증·엔진 단독 상태 변경·시드 RNG·턴 트랜잭션을 지킨다.

검증은 0/100·생성 합계·누락/추가 필드·NaN/비정수, 실제 DB 생성/재시작, origin 1·기존 archive 결과 불변, five-stats 새 판의 초기/최종 해시·외부 사용자 입력 거부

선행 인수 뒤 착수하고 검증 결과와 구현하지 않은 담당의 리뷰를 같은 문서에 남긴다. 구현자가 스스로 완료로 바꾸지 않는다.

## 구현 기록

2026-10-27 사용자 인계로 Codex가 계약·서버와 화면을 함께 맡는다. INT-01의 로컬 check 4,912건과 실제 복구·재생7건이 통과한 기준01ade75에서 별도 checkout으로 착수했다. 기준 Chromium 재현과 전체 DB 검사는 원 checkout의 고정 소스로 이어가며 해당 결과를 이 AC의 완료로 바꾸지 않는다.

새 statRules의 count5와 five-stats 기능을 함께 검사한다. 기존 판에는 count·정치·매력 키를 추가하지 않으며 nullable DB 열을 기존 상태·해시에서 뺀다. 새 판은 누락·범위 오류를 거부한다. 역사 인물은 generalId·officerId·sourceId·sourceRevision과5값을 가진 시나리오 대응표를 요구하며 491명 실제 대응 자료는 INT-16에서 검수한다. 이 단계의 합성 월드 시험은 전체 인수가 아니다.

집중 단위8파일95건과 실제 PostgreSQL·HTTP3건을 통과했다. DB 시험은 새 판의0·100/동일 시드, 구형null·상태 불변, 잘못된 값의 DB 거부, 세션·추가 필드·합계·누락, 중복 접수1건, 엔진 단독 생성, 재접속, 월 정산·재생 해시, 위조 결과 거부와 다른 월드 보존을 포함한다. 전체491명 대응과 UI·산식은 아직 이 증거에 없다.

실제 재생에서 기존 정책 검증기의3능력치 strict 구조가 새 값을 거부해 새 판에서만5값 구조를 받도록 연결했다. 구형 호출은5값 추가를 계속 거부한다. 독립 리뷰는 편집기 공개 검증기의3*max 계산을 지적했다. count 또는 기존 기본3을 쓰도록 고치고 표준 검증기와 같은5개 수치 경계를 검사한다. 전체 check·필수 CI·최종 독립 리뷰·병합 전이다.

## 리뷰

전체 pnpm check는247파일4,925건을 통과했다. 첫 필수 CI의 Chromium4분할은 통과했으나 DB 시험은 기존5파일의26개 migration 고정 목록 때문에10건과1suite가 실패했다. 후행27번째 SQL을 명시하고 기존 행 비교에서는 새 nullable열만 분리하며 실제 값이 전부null인지 별도로 확인한다. 거주 tick의 후보 migration 검증은 그대로 두고 최신 Prisma 행을 읽는 시험에서만 후행 SQL을 적용한다. 수정한5파일과 새 계약의 실제 PostgreSQL·HTTP 집중40건이 통과했다. CI실패를 통과로 기록하지 않는다.

구현하지 않은 Codex 담당이 위5개 시험과 문서의 회귀 수정을 독립 검토해 남은 수정 요구가 없다고 판정했다. 직접 diff 검사를 통과했고 PostgreSQL40건은 구현 담당의 실행 증거로 구분했다. 후보 단독 검증·null 별도 확인·기존 제약·골든·DB 정리 경계가 유지되는지 확인했다.

Windows의 전체 PostgreSQL 재실행은1,160건 중1,122건 통과·11건 실패·27건 미실행이었다. 위 migration 실패 외에1070 정식 시나리오의 한 달 정산이30초를 넘었다. 앞선 원 checkout의 해당1070·1100·1110 집중3건은 같은30초 기한으로 통과했다. 전체 실행의 시간 초과는 아직 해결 전이며 전체 PostgreSQL·권한 대조 완료로 세지 않는다.

구현하지 않은 Codex 담당이 계약·마이그레이션·엔진 로더·API·구형/새 정책 재생을 독립 검토했다. 공개 편집기 검증기의 개수 계산 결함을 수정한 뒤 남은 수정 요구가 없다고 판정했다. 리뷰 담당의 직접 실행은 집중6파일34건이며 PostgreSQL3건은 구현 담당의 별도 실행 증거다. 전체 검사·필수 CI·병합과 정식491명 인수는 아직 남아 있다.

5be4389의 필수 Linux PostgreSQL·권한 CI는 13분54초에 통과했다. Chromium 4분할 중3개는 통과했고 메시지 권한 회수 시험만 작성폼 오류와 목록 재조회 오류를 전역 alert 하나로 찾다가 실패했다. 작성폼의 alert로 선택자를 한정하고 문구·입력 보존·접근성 설명·권한 회수 검사는 유지했다. 실제 PostgreSQL·Chromium 집중1건을8.7초에 통과했고 구현하지 않은 담당이 독립 검토했다. 전체 로컬 PostgreSQL 시간 초과와 최종 CI·병합은 계속 검증한다.
