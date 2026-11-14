# INT-29 기록 이름 조각 v1

연결 인수조건: AC-INT-29. 백엔드 담당은 Codex, 화면과 독립 구현 리뷰는 Claude다. 사용자와 양측 담당이 2026-11-14 합의한 계약 v1의 1~8절을 구현한다. 운영 DB 적용과 프런트 렌더러는 이 변경의 범위 밖이다.

## 저장과 조회

공유 `LogPart`는 text·general·nation·city·num·act·crew·office와 한 단계 tone을 지원한다. 노드는 tone을 포함해 64개, JSON UTF-8 크기는 2,048바이트까지다. HTML·개행·잘못된 식별자와 색을 거절한다. 숫자는 ko-KR 쉼표와 지정 자릿수로 표시한다. 조사는 사건 당시 이름으로 규칙에서 붙인다. 사용자 이름의 괄호는 보존한다. 시스템 이름으로 확인한 장수의 한자·출생 연도 꼬리표만 뺀다.

`logPartsToText`가 신규 구조화 기록의 본문을 만든다. 검증에 실패하거나 크기를 넘으면 본문만 저장한다. 조회는 버전 1의 유효한 조각만 반환한다. 옛 null 행·빈 조각·손상된 조각·미지원 버전은 본문으로 대체한다.

Prisma migration은 GeneralLog·PublicNationEvent·BattleLog에 nullable 열만 추가한다. GeneralLog에는 명령 불가 code, BattleLog에는 실제 defenderId·cityKey도 추가한다. 기존 행을 역파싱하거나 채우지 않는다. 초상은 같은 월드의 현재 장수에서 찾는다. 없는 장수는 null로 응답한다.

개인 명령의 논리적 줄마다 GeneralLog 한 행을 쓴다. ordinal 0은 첫 명령 줄이다. 추가 명령 줄 뒤에 가계·인사 기록의 ordinal을 잇는다. 기존 tick·ID 내림차순 커서로 명령 줄 순서를 읽도록 명령 행은 역순으로 삽입한다. 모든 쓰기는 기존 턴 트랜잭션 안에 있다.

국가 역사 JSON은 events·intelAlerts를 보존하고 structuredEvents를 더한다. 각 사건은 events 배열의 ordinal, kind(command·intel), visibility(nation), text·parts·partsVersion을 가진다. 옛 문자열은 legacy kind와 null 조각으로 읽는다. `records.nationEvents`는 현재 소속국만 조회하며 tick·ordinal 커서로 같은 tick의 여러 사건을 이어 읽는다. 기존 숫자 표 `records.nation`은 그대로다.

`records.general`은 code·조각·버전, `records.activity`는 평판 본문·조각과 국가 사건 조각, `records.battles`는 조각·버전·수비자·초상·도시를 더한다. 전환 기간을 위해 새 응답 필드의 생략도 타입에서 허용한다. 평판은 기존 이름 스냅샷으로 본문과 조각을 함께 만들며 열을 추가하지 않는다.

## 변환한 경로

- 규칙: 내정 8종, 모집·훈련·사기·이동·귀환·소집해제, 요양·군량매매·헌납·휴식·교역, 건국·거병·임관·등용·하야, 기본 국가 명령, 기본·부곡 출병, 계략 4종, 첩보.
- 엔진: 개인 턴의 성공·명령 불가, 국가 명령의 기록, 기존 공개 건국·멸망·점령·선전포고, 전투 보고와 국가 역사.
- 계략 시도 실패는 효과와 비용을 유지하고 로그 kind만 failure로 바꾼다. 첩보 피해국의 익명 주체는 text로 남긴다.

월 정산·인사·빙의·가계·관리자와 그 밖의 미변환 경로는 기존 본문과 null 조각을 쓴다. 기존 BattleLog 키는 바꾸지 않으며 공격자 보고를 새로 만들지 않는다.

## 검증과 남은 관문

공유 제한·숫자·조사·tone·버전 대체, 규칙의 본문·조각 일치, 엔진 쓰기와 서버 스냅샷 변환을 단위 검사한다. 기존 규칙 골든은 출력 계약 변경을 반영하되 효과·검사·RNG 기준을 유지한다.

PostgreSQL 통합 시험에는 null·미지원 버전 조회, 같은 tick의 개인·국가 사건 쪽 넘김, 평판·국가 혼합 원장 쪽 넘김, 소속국 격리, 전투 메타데이터를 추가한다. 새 절차도 기존 HTTP 권한 검사 대상에 넣는다. 로컬 PC에는 PostgreSQL과 Docker가 없어 실제 DB 검증은 CI에서 해야 한다. 정확한 커밋의 CI와 Claude 독립 리뷰, main 병합 전이므로 AC는 미완료다.

후속은 공개 행동 동향 확대, 공격자 전투 기록, 장수 열전, 합별 전투 기록, 공개 국가열전, 연감 월별 동향이다. 화면의 조각 렌더러·옛 개행 분리·현지 시각 HH:MM 표시는 Claude가 맡는다.
