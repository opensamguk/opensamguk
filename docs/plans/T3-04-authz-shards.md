# T3-04 권한 통합 검사 분할

AC-M3-03·AC-M1-01에 연결한다. Claude가 계획하고 Codex가 구현한다. 구현하지 않은 담당의 독립 리뷰와 실제 CI 통과 뒤 보호 병합한다. 전체 AC 완료 판정과는 구별한다.

## 문제와 범위

API 권한 통합 작업 하나가 약 38~56분 걸렸다. 기존 Vitest의 파일 분할 기능으로 세 작업을 실행한다. 각 작업은 자기 PostgreSQL 서비스를 쓰고 파일은 직렬 실행한다. 시험 파일·개별 제한·worker·T2-15 실제 복원과 정리·fsync는 유지한다. 로컬의 인자 없는 `pnpm test:int`와 `pnpm test:authz`는 기존 순서로 전체 실행한다.

## 성공 판정

각 조각은 실제 Vitest 실행 JSON에서 성공 파일 목록을 얻고 실제 authzCase 기록을 함께 보관한다. 기록에는 커밋·workflow run·시도 번호·조각 번호·상대 파일 경로·권한 사례만 쓴다. stdout·환경 변수·DB 주소는 올리지 않는다. T2-15 정리가 성공한 뒤에만 자기 기록을 업로드한다. 같은 run의 재실행은 자기 artifact를 교체하며 성공했던 다른 조각의 이전 시도 기록은 같은 SHA·run인 경우 허용한다.

합본은 세 조각 모두 성공했는지 확인하고 현재 checkout의 전체 API 파일 목록과 실제 실행 파일의 합집합을 비교한다. 조각·파일 누락, 중복, 예상 밖 파일, 다른 SHA·run, 실패 보고, 잘못된 기록은 실패한다. Vitest5.0.5의 `list --filesOnly --json`은 분할 옵션을 줘도 전체 목록을 반환하므로 전체 목록을 얻는 데만 쓴다. 분할 알고리즘은 다시 구현하지 않는다.

완전한 합본만 기존 `compareAuthz(appRouter, evidence, exemptions)`로 대조한다. 기존 API·EXEMPT·MISSING·AUTHZ 출력과 면제 검증은 유지한다. 조각 성공은 전역 권한 통과가 아니다. 합본은 기존 `database-authz` 작업 id와 `opensamguk-database-authz` 이름을 이어받고 필수 `database-browser` 판정은 그대로 둔다. 취소·실패·건너뜀도 성공으로 바꾸지 않는다.

## 검증

단위 시험은 조각 집합·출처·파일 합집합·기록 형식·실패 보고와 기존 전역 누락/오래된 면제를 검사한다. 필수 합본 이름, 세 조각, 격리 PG, T2-15 정리와 최종 관문도 확인한다. 전체 `pnpm check`와 실제 원격 세 PG 조각·합본·기존 engine/E2E를 실행한다. 같은 제품 기준선의 API/EXEMPT/AUTHZ 결과와 작업 소요를 비교한다. 관찰 전 시간 개선을 확정하지 않는다.

공식 자료는 [Vitest 분할 옵션](https://vitest.dev/guide/cli.html#shard)과 고정한 [artifact 다운로드 동작](https://github.com/actions/download-artifact/tree/d3f86a106a0bac45b974a628896c90dbdf5c8093)을 따른다. 추가 작업 두 개로 동시 실행 대기가 늘 수 있다. 이 변경을 되돌리면 기존 직렬 작업으로 돌아간다.
