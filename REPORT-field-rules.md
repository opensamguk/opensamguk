# 야전 규칙 작업 보고

2026-11-15. 작업 ID INT-27 후속, AC-INT-28. 요청서 `D:/codex-artifacts/int27-data-driven-20261115/REQUEST-FIELD-RULES.md`의 백엔드 범위를 구현했다. AC 상태는 바꾸지 않았다. 프런트 연결·실제 DB 인수·독립 리뷰·병합은 남아 있다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `packages/shared/src/tactical.ts` | 모래톱, 기상·바람·지물 schema와 응답 타입, 화계 입력 |
| `packages/rules/src/tactical/environment.ts` | 시드 기반 기상·발화·번짐·화재 피해·시야·지물 효과 |
| `packages/rules/src/tactical/environment.test.ts` | 새 규칙·입력 경계·지도 자료·재적재 시험 |
| `packages/rules/src/tactical/battle.ts` | 정산 연결, 양쪽 시야 프레임, 복병·사건·불 가림, 상태 해시 |
| `packages/rules/src/tactical/input.ts` | 함정 설치 지형과 화계 예약 검증 |
| `packages/rules/src/tactical/state.ts` | 전투 저장 schema와 기존 자료 기본값 |
| `packages/rules/src/tactical/map.ts` | 명시 지형·지물 추출, 다리 방향 |
| `packages/rules/src/tactical/world.ts` | 시작 기상, 거점 지물 생성, 종료 부상 정산 |
| `packages/rules/src/campaign/supply.ts` | 지도 야전 칸 자료를 생성 원장에 보존 |
| `packages/rules/src/world/map/operational.ts` | 지도 v3 `tacticalCells` 입력과 좌표 검증 |
| `docs/product/decisions.md` | 마지막 번호 다음 D-105 추가 |
| `docs/developer/tactical-battle.md` | 서버 계약과 지물 효과 |
| `docs/index.md` | 보고서 등록 |
| `REPORT-field-rules.md` | 이 보고서 |

기존 작업 폴더에는 다른 담당의 수정이 다수 있었다. 이 보고서는 이번 요청에서 바꾼 부분만 설명한다. `apps/web`, `e2e`는 수정하지 않았고 커밋·푸시·PR·stash·프로세스 종료·Docker 재시작은 하지 않았다. 서버는 기존 `readTactical → tacticalView` 경로로 확장 프레임과 판을 반환하므로 API 파일에 별도 계산을 넣지 않았다.

## 수치와 규칙

| 항목 | 값 |
| --- | --- |
| 지형 | 기존10종 + `sandbar` |
| 전술 이동 점수 | 평지·초지·가도·다리1, 모래톱1.5, 여울·숲·습지2, 산3. 기존 병종 통행 제한 유지 |
| 모래톱 함정 | 불함정·구멍 모두 불가 |
| 불함정 설치 | 초지·다리만 |
| 구멍 설치 | 초지·평지·가도만 |
| 화계 | 회의 책략 `fire`, 실행 점수3, 예약 턴1~30 |
| 시작 기상·바람 | 맑음·비·호우·눈·안개 각20%, 바람8방향 각12.5% |
| 기상 변경 | 정산 시작마다20%로 기상·바람 다시 추첨. 같은 값이 다시 나올 수 있음 |
| 발화·번짐 확률 | 평지·초지·숲80%, 다른 탈 수 있는 지형40%. 비×0.5, 눈×0.25 |
| 불 금지 | 바다·강·여울, 원본 자료 없는 칸, 판 밖 |
| 호우 | 기존 불 전부 제거, 발화 불가. 예약 화계는 사용 처리하되 점수 소비 없이 취소 |
| 번짐 | 현재 바람 방향 이웃 한 칸. 번짐 도중 생긴 불의 연쇄 번짐은 다음 정산부터 |
| 화재 피해 | 행동·번짐 뒤 타는 칸에 남은 부대 병력의 ceil(5%). 퇴각 완료·전멸 부대 제외 |
| 장수 부상 | 화재 피해마다20%로1~5 누적, 전투 누적 상한80. 종료 정산 때 기존 부상에 더해 상한80 적용. 기존80 초과 부상은 보존 |
| 여러 부대의 같은 장수 | 가장 큰 누적 부상 하나를 종료 때 한 번 반영 |
| 기본 시야 | 부대3, 소유 거점2, 체비쇼프 거리(8방향) |
| 시야 보정 | 안개-2, 호우-1, 관측 칸 숲-1·산+1, 최소1 |
| 시야 차폐 | 관측 칸과 목표 칸 사이 숲·산은 차폐. 목표 지형 자체는 볼 수 있음 |
| 복병 | 숲·산에서만 시작, 이동·공격·반경1 수색으로 해제. 숨은 적 위치·사건은 응답에서 제외 |
| 흙더미 | 교전에서 그 칸 부대의 받는 피해×0.85, 공격측의 반격 피해에도 적용 |
| 무너진 터 | 진입 이동 비용+1 |
| 다리 방향 | `NE-SW`, `NW-SE`. 그림용이며 실제 통행은 기존 간선·병종 규칙 사용 |
| 성채·관문·진영·마을 | 추가 전술 이동·방어 효과 없음. 기존 공성 성벽·성문 계산 유지 |
| 목적지 기본 지물 | 관→관문, 진→진영, 도시0~2→마을, 3~4→작은 성채, 5~7→중간 성채, 8~9→큰 성채. 폐허 원장에 남은 도시→무너진 터 |

불함정은 즉시 별도 병력 피해를 중복 적용하지 않고 칸 발화로 처리한다. 호우가 아니면 불은 계속 남는다. 다른 함정의 기존 효과는 유지한다. 물·독 함정은 원장의 수문·급수 자료 부재로 기존 제출 제한을 유지한다. 행군 SP와 전술 이동 점수는 별개이며 SP 비용은 바꾸지 않았다.

## 프런트 응답 필드

`battle.council.get`, `battle.turn.get`, `battle.replay.get` 공통이다. 아래 좌표는 전장 정수 좌표이며 `terrain`은 `y * width + x` 순서다. 프런트 담당은 `apps/web/src/battle/types.ts`와 렌더링을 이 표에 맞춰 잇는다.

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `board.terrain[]` | 기존 지형 문자열 또는 `sandbar` | 모래톱 추가 |
| `board.objects[]` | `{ x: number, y: number, kind: string, direction?: string }` | 고정 지물 목록 |
| `board.objects[].kind` | `bridge`, `fort-small`, `fort-medium`, `fort-large`, `gate`, `camp`, `village`, `earthwork`, `rubble` | 다리·성채3종·관문·진영·마을·흙더미·무너진 터 |
| 다리의 `direction` | `NE-SW` 또는 `NW-SE` | 다리에만 필수 |
| `frames[].environment` | `{ weather, wind }` | 그 턴의 기상·바람 |
| `environment.weather` | `clear`, `rain`, `downpour`, `snow`, `fog` | 맑음·비·호우·눈·안개 |
| `environment.wind` | `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW` | 북쪽은 y-1, 동쪽은 x+1 |
| `frames[].burningCells[]` | `{ x: number, y: number }` | 요청한 편에서 보이는 타는 칸 |
| `frames[].visibleCells[]` | `{ x: number, y: number }` | 요청한 편에서 보이는 칸. 목록 밖은 가림 |
| `frames[].units[].vision` | 정수1~4 | 날씨·현재 지형을 반영한 시야 반경 |
| `frames[].units[].injury` | 정수0~80 | 이번 전투의 새 화재 부상 누적 |
| `frames[].bases[].kind` | `contest` 또는 `supply` | 기존 다툼·보급 역할 유지 |
| `frames[].bases[].structure` | `fort-small`, `fort-medium`, `fort-large`, `gate`, `camp`, `village` | 거점 지물 종류, 기본 `camp` |
| `frames[].units` | 기존 부대 배열 | 아군 전부, 적은 시야 안이며 복병이 아닌 부대만 |
| `frames[].events` | 기존 사건 배열 | 숨은 주체·대상이 있는 사건 제거. 화재는 `scheme`, 함정 발동은 `trap` |

기존 저장 프레임을 읽는 호환성을 위해 shared의 새 프레임 필드는 선택 항목이다. 새로 기록한 프레임은 모두 채운다. 과거 프레임에 `visibleCells`가 없으면 화면은 빈 배열과 구분해야 한다. 전체 프레임과 시야별 프레임은 서버 내부에서 따로 저장한다. API는 시야별 프레임만 반환하며 적 병량·사기·보이지 않는 총계는 노출하지 않는다. 고정 지물·지형·거점 위치는 공개다.

화계 요청은 기존 `battle.council.set`의 `schemes`에 `{ kind: 'fire', turn: 1, x: 2, y: 3 }` 형식으로 넣는다. 기존 세션·참가·참모 권한·revision·window·mapHash·멱등 검사를 그대로 거친다. 호우·물 칸 예약은 `BAD_TERRAIN`, 원본 자료 없는 좌표는 `BAD_INPUT`이다.

## 자료와 재생

지도 v3 `tacticalCells`는 `[{ x, y, terrain?, object? }]` 형식이다. `x/y`는 16단위 원본 격자 좌표(화면 픽셀이 아님)이고 `object`는 좌표 없이 위 지물의 `kind`와 다리의 `direction`을 담는다. 생성 시 자료를 보급 원장에 고정하고 전장 추출 때 좌표를 바꾼다. 임의 지형을 만들지 않으므로 기존 지도에 모래톱·흙더미가 저절로 생기지는 않는다. 명시 자료를 넣은 새 지도 판이 필요하다.

모든 난수는 기존 `rngFor`에서 시작 기상·턴 기상·좌표별 발화·부대별 부상 경로로 분리했다. 같은 시드·명령과 JSON 저장/재적재에서 결과가 같다. 상태 해시에 판·기상·바람·타는 칸을 더해 야전 상태 변경을 검출한다. 기존 전투 물리 해시는 바뀐다. 시간·접속 모드는 계속 제외한다.

기존 월간 `packages/rules/test/replay-golden.json`의 재생 시험5건은 그대로 통과했다. 기존 전술 시험에는 고정 해시 골든이 없어 `environment.test.ts`에 D-105 전술 시작·3턴 골든을 새로 고정했다. 값은 순서대로 `b8237e10f92d6adb`, `6cfb98ea30bba966`, `97d2f492a046f89d`, `042a0aa2a9b89a04`다. 판·기상·불을 해시에 포함한 변경을 검출한다. 다른 담당의 기능 변경으로 실패한 골든은 이 작업에서 일괄 갱신하지 않았다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| `pnpm.cmd next` | 실행. AC-INT-28 후속 요청을 우선 적용 |
| 전술·서버 접근 경계·지도·기존 재생·패키지 경계 시험 | 7파일76건 통과. 새 야전 시험11건, 기존 전술18건 포함. 이후 지도 끝 좌표의 반올림 보정 뒤 영향2파일28건 재검사도 통과 |
| 보급 시험을 함께 실행한 확장 검사 | 당시6파일63건 중62통과·1실패. `campaign/supply.test.ts`의 재생 초기화가 `initialLineageState`의 성별 검증에서 실패. 전체 작업 폴더의 변경을 대상으로 한 결과이며 독립 기준선과 비교하지 않음 |
| 규칙 타입 검사 | `pnpm.cmd --filter @opensamguk/rules typecheck` 통과 |
| 서버 타입 검사 | `pnpm.cmd --filter @opensamguk/server typecheck` 통과 |
| 변경 TypeScript 파일 ESLint | 통과 |
| 변경 코드 Prettier | 통과. Markdown은 프로젝트 설정상 포맷터 대상에서 제외되므로 직접 검토 |
| 서버 계약 문구 검사 | strict 통과 |
| 결정 기록 전체 문구 검사 | 기존 문구 포함55건으로 실패. 추가한 D-105에서는 지적 없음 |
| `pnpm.cmd check` | Prisma 생성·명령 문서 검증 통과 후 lint에서 중단. 기존 `apps/web/.tmp-model/drafts.tsx`, `ui-stage.tsx`의 경계·any 오류15건. 요청상 프런트 파일은 수정하지 않음 |
| 실제 전술 DB 통합 | `tools/tactical-battle.integration.test.ts` 실행. `beforeAll`에서 `127.0.0.1:5433` 연결 불가로 실패, 본문1건 미실행. 성공으로 세지 않음 |
| 전체 단위 시험 | `pnpm.cmd test` 실행 중 여러 조약·자원·Git·인사 시험 실패를 확인했다. 마지막 출력 이후 종료되지 않아 최종 집계를 확보하지 못했다. 프로세스 종료 금지 지침에 따라 그대로 두었다. 작업 중 소스가 바뀐 실행이라 새 야전 시험2건의 중간 실패도 포함하며, 최종 소스로 별도 실행한 관련76건과 영향28건은 통과했다. 전체 성공으로 세지 않는다 |

최종 통과 묶음 명령은 `pnpm.cmd exec vitest run packages/rules/src/tactical apps/server/src/game/tacticalApi.test.ts apps/server/src/routers/battle.test.ts packages/rules/src/world/map/operational.test.ts packages/rules/src/replay.test.ts tools/lint-boundaries.test.ts`다.

추가 전체 실행 출력은 작업 폴더의 `.field-tests.log`, 전체 검사 출력은 `.field-check.log`에 남겼다. 작업 로그이므로 커밋 대상이 아니다. 전체 단위 실행 세션은14879이며 추가 출력이 멈춘 상태에서 이 보고서를 마쳤다. 독립 기준선에서 전체 실패를 재현하거나 원인을 모두 분리한 결과는 아니다.

## 남은 검증

실제 DB·HTTP·공개 빌드·화면 E2E·부하·독립 리뷰·병합은 완료로 보고하지 않는다. UI 연결은 요청대로 프런트 담당의 후속 작업이다. 현재 실행 Node는22.23.2이고 프로젝트 요구는24 이상이다.
