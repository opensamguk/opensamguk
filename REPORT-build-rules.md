# INT-28 성 건설 규칙 작업 보고

2026-11-15 · 작업 ID INT-28 2단계 · AC-INT-28 · 결정 D-106·D-107

요청서 `D:/codex-artifacts/int28-build-rules-20261115/REQUEST.md`에 따라 세 능력 조회 오류와 성 건설의 규칙·엔진 저장·서버 응답을 수정했다. 화면과 e2e는 수정하지 않았다. 커밋·푸시·PR·stash, 프로세스 종료·서버 재시작·Docker 조작·DB 삭제도 하지 않았다. 기존 작업 폴더의 다른 수정을 보존했다.

## 세 능력 조회 오류

서버 `readView`가 DB의 nullable 정치·매력 열을 그대로 넘겼다. `campaignPeople`은 필드가 있다는 이유로 다섯 능력 검증을 실행해 조정 조회까지 실패했다. 엔진에 있던 `storedGeneralStats`를 규칙 패키지로 공유하고 서버도 월드 능력치 판에 따라 같은 정규화·검증을 쓰도록 바꿨다. 세 능력 판의 null 열은 제거하며 다섯 능력 판의 누락과 세 능력 판에 저장된 실제 다섯 능력값은 계속 거부한다.

다섯 값을 필수로 가정하던 장비 조회·휘하 인물 조회·부곡 교전·기본 계략을 함께 고쳤다. 서약은 세 능력 판에서 통솔을 사용한다. 부곡 교전과 전술 전투는 같은 `commanderBattleModifiers`를 쓰며 정치·매력을 임의로 채우지 않는다. 기존 장수 생성·계승의 능력치 판별과 다섯 능력 판의 엄격 검증은 유지한다.

## 건설 범위와 수치

성 안 16종, 성 밖 32종을 등록했다. 상태는 기존 `World.campaignState.land` JSON에 함께 저장하고 엔진의 기존 World 잠금·CAS·턴 트랜잭션으로 반영한다. 새 테이블과 migration은 없다. 건설 시작은 장수 금과 도시 목재를 소비하고 월 정산에서 완공한다. 철거는 공사 중에도 가능하며 환급은 없다. 클라이언트가 비용·기간·도시·행위자를 지정할 수 없다.

| 등급 | 성 한 변 | 둘레 줄 | 성 안 자리 | 성 밖 자리 |
| --- | ---: | ---: | ---: | ---: |
| 경 | 4 | 4 | 16 | 128 |
| 특 | 3 | 4 | 9 | 112 |
| 대 | 3 | 3 | 9 | 72 |
| 중 | 2 | 3 | 4 | 60 |
| 소 | 2 | 2 | 4 | 32 |
| 현·관문·나루 | 1 | 1 | 1 | 8 |
| FIELD | 0 | 해당 없음 | 0 | 25 |

공유 정본은 `@opensamguk/shared`의 `CITY_LAND`, `OPEN_LAND`, `cityGrade`, `cityLandSlots`다. 기존 `CityScene.tsx`의 수치와 같으며 프런트 담당이 이 내보내기로 연결할 수 있다. 좌표는 기존 화면과 같고 짝수 한 변에는 반 정수를 쓴다.

| 건물 | 금 | 목재 | 기간 |
| --- | ---: | ---: | ---: |
| 암시장 | 50 | 5 | 월 정산 1회 |
| 대시장 | 300 | 30 | 월 정산 2회 |
| 성채 | 100 | 10 | 월 정산 2회 |
| 나머지 45종 | 100 | 10 | 월 정산 1회 |

| 기본 효과 | 수치 |
| --- | --- |
| 농지·시장·염전·순찰소·무고·보루·토루·석벽·목책 | 대응 분야 기본 상한 100, 완공 점수는 상한의 절반 |
| 대시장·어시장·암시장 | 상업 상한 300·200·80 |
| 농지·시장 합병 | 같은 종류 이웃 1~2개 ×1.2, 3개 이상 ×1.5 |
| 곡창·조폐 | 이웃 농지·시장 상한 ×1.5 |
| 수리 | 이웃 농지 상한 ×1.2 |
| 둔전 | 주둔 부곡·수비 병력 합 /100의 내림값, 상한 300 |
| 민가 | 인구 상한 +1000, 철거 때 제거, 폐허 복구 시 보존 |
| 사당 | 월 민심 +1 |
| 학사·제철소 | 월 국가 기술 +1 |
| 의원 | 월 체류 아군 장수 부상 -5 |
| 주점·부절대·동작대 | 월 체류 아군 장수 경험 +1·1·5 |
| 연병소·군악대 | 월 체류 아군 부곡 훈련·사기 +1, 전투 예약 부곡 제외 |
| 암시장 | 매년 1월 공사 중인 건물까지 철거 |

관청·부절대·둔전·연병소·대시장·어시장·동작대는 도시당 하나이며 공사 중인 건물도 센다. 대시장 대 이상, 동작대 업 한정, 수리·어시장·조선소 등의 물가 조건과 염전 바닷가·제철소 산 조건을 검사한다. 군사 시설은 성 둘레 두 칸을 비우고 시설끼리 두 칸 이상 간격을 둔다. 함정 간격은 예외다.

자리별 지형 자료가 아직 없으므로 물가·산은 거점에 닿는 경로의 첫·마지막 구간과 셀, 수채 단계 1로 판단한다. 물 시설은 바깥 가장자리를 사용한다. 먼 경로 중간의 지형은 조건으로 쓰지 않는다. 자료가 없으면 해당 지형 시설을 막는다. 정확한 자리별 지형은 후속이다.

기존 월드는 모두 빈 터로 조회하고 건물로 자동 채우지 않는다. 건설하지 않은 월드에는 상태 키를 추가하지 않아 기존 재생 해시를 보존한다. **첫 점수 건물의 공사 시작 때 해당 분야만 시설 합산으로 전환한다.** 첫 시장을 지으면 상업·상업 상한이 0에서 시작하고 다른 분야는 보존한다. 전환 이력 `managed`를 저장하므로 마지막 건물을 철거하면 해당 분야는 0이다. 전환한 분야의 값·상한은 완공 시설의 점수·상한 합이며 내정 명령은 가장 덜 찬 시설부터 채운다. 직접 도시 값을 바꾸는 재해·보급 단절·함락 피해도 점수로 동기화한다. 전 도시의 기존 내정값을 보존하는 일괄 시설 이행은 구현하지 않았다.

## 서버 응답과 명령

조회는 기존 인증 경로의 `home.get({ worldId })`에 `land`를 추가했다. 자신의 장수가 있는 아군 성만 내려주고 재야·적성·거점 밖이면 null이다. 기존 예턴 편집·InputEvent 경로로 명령을 넣고 실제 상태 변경은 엔진에서 처리한다.

| 필드 | 형식 | 뜻 |
| --- | --- | --- |
| `land` | object 또는 null | 현재 아군 성의 건설 정보 |
| `land.cityKey` | number | 현재 성 키 |
| `land.grade` | 경·특·대·중·소·현 또는 null | FIELD는 null |
| `land.core` | number | 성 한 변 |
| `land.slots[]` | array | 성 안팎 전체 자리 |
| `slots[].id` | string | `i,j` 좌표를 그대로 붙인 자리 ID |
| `slots[].zone` | inside 또는 outside | 성 안 또는 성 밖 |
| `slots[].i`, `slots[].j` | number | 좌표, 반 정수 가능 |
| `slots[].building` | object 또는 null | 건물·공사, 빈 터는 null |
| `building.slotId` | string | 점유한 자리 |
| `building.building` | string | 건물 종류 키 |
| `building.remainingTurns` | integer 0~2 | 남은 월 정산 횟수, 0이면 완공 |
| `building.score` | integer | 시설의 현재 점수 |
| `land.buildings[]` | array | 건물 48종의 정의·후보 자리 |
| `buildings[].key`, `.name`, `.zone` | string | 종류 키·한글 이름·안팎 |
| `buildings[].gold`, `.wood`, `.turns` | integer | 서버가 정한 비용·기간 |
| `buildings[].field` | 분야 또는 null | 농업·상업·치안·수비 중 직접 합산 분야 |
| `buildings[].capacity`, `.unique` | integer·boolean | 기본 상한과 도시당 한 채 제한 |
| `buildings[].slots[]` | array | 같은 구역의 자리별 후보 |
| `buildings[].slots[].slotId` | string | 후보 자리 |
| `buildings[].slots[].failure` | null 또는 `{code,message}` | 실행 가능 또는 막힌 이유. 자원·권한도 포함 |

예턴 명령 인자는 `build: { slotId, building }`, `demolish: { slotId }`다. 예를 들어 `build`, `{ "slotId": "-0.5,-0.5", "building": "market" }`를 사용한다. 자리 ID는 응답에서 그대로 가져와야 한다. `gold`, `wood`, `turns`, `cityKey` 같은 추가 인자는 엄격 스키마가 거부한다. 건물 종류 키 전체와 수치는 `packages/rules/src/construction/catalog.ts`에 있다.

## 바꾼 파일

| 파일·묶음 | 내용 |
| --- | --- |
| `packages/shared/src/cityLand.ts`, `index.ts` | 등급표·성 안팎 좌표 공유 |
| `packages/rules/src/construction/catalog.ts`, `land.ts`, `feature.ts`, `land.test.ts` | 건물표·상태·조건·명령·합산·월 진행·회귀 시험 |
| `packages/rules/src/general/fiveStats.ts`, `legacyStats.test.ts` | DB 능력 정규화 공유·세 능력 회귀 |
| `packages/rules/src/campaign/state.ts`, `relationships.ts`, `skirmish.ts` | 건설 저장 경계 검사·서약·교전 능력 처리 |
| `packages/rules/src/equipment/stats.ts` | 세 능력에도 존재하는 장비 보너스만 계산 |
| `packages/rules/src/commands/effects.ts`, `ext/stratagem/base.ts`, `playerDoc.ts` | 시설 점수 효과·세 능력 계략·명령 설명 |
| `packages/rules/src/model/clone.ts` | 직접 도시 변경과 시설 점수 동기화 |
| `packages/rules/src/ruleRegistry.ts`, `providedRules.ts`, `index.ts` | 건설 등록·월 처리 순서·공개 내보내기 |
| `packages/rules/src/cityScale/state.ts`, `feature.ts` | 시설 분야 상한과 민가를 폐허 복구·검증에 반영 |
| `packages/rules/src/tactical/world.ts` | 교전 지휘관 보정 공유 |
| `apps/engine/src/generalStats.ts`, `persist.ts`, `cityScaleState.ts` | 정규화 재사용·시설 점수 함께 저장·폐허 검증 |
| `apps/engine/src/world/alwaysOn.test.ts` | 규칙 등록 수 33 반영 |
| `apps/server/src/game/queries.ts`, `campaignApi.ts`, `equipmentApi.ts`, `cityScale.ts`, `routers/home.ts` | 조회 정규화·세 능력 응답·폐허 검증·건설 응답 |
| `tools/docs/generate-command-catalog.ts`, `.test.ts`, `docs/user/command-catalog.generated.md` | 건설·철거의 실제 인자와 명령 수 62 반영 |
| `docs/product/decisions.md`, `docs/plans/INT-28.md`, `docs/index.md`, 이 보고서 | D-107·구현 범위·문서 지도 |

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `pnpm.cmd next` | 실행, 요청서의 최신 담당 인계를 우선 적용 |
| 최종 규칙·세 능력·재생·패키지 경계 시험 | 4파일 46건 통과 |
| 기존 12개월 재생 골든 | 통과, 건설하지 않은 월드의 골든 파일 갱신 없음 |
| 규칙·서버·엔진 타입 검사 | 각각 통과 |
| 변경 코드 ESLint | 통과 |
| 실제 DB 조회 | 지정 DB·월드만 사용, 서버 `readView`와 엔진 `loadWorld` 통과, 492명·건물표 48종 확인 |
| 실제 DB 건설 저장·재적재 | 엔진 저장 후 같은 상태 해시, 서버 응답의 공사 1회 확인 |
| 실제 DB 오래된 CAS | 같은 이전 상태의 재저장 거부 확인 |
| 실제 DB 완공 저장·재적재 | 상업 50·공사 0회 확인 |
| 실제 DB 롤백 | 건설 원장과 전체 월드 해시가 시험 전과 같음 |
| 독립 코드 리뷰 | 최초 지적과 후속 폐허·전투 예약·서버 projection 지적을 수정한 뒤 최종 통과 |
| `pnpm.cmd check` | 최종 실행도 Prisma 생성·명령 문서 검사 통과 후 lint 중단. `apps/web/.tmp-model` 세 파일의 기존 오류 25건. 최초 실행에서 발견한 이번 시험의 금지 import는 수정했고 최종 실행에는 없음 |

최종 통과 묶음은 `pnpm.cmd exec vitest run packages/rules/src/construction/land.test.ts packages/rules/src/general/legacyStats.test.ts packages/rules/src/replay.test.ts tools/lint-boundaries.test.ts`다.

실제 DB 확인은 `127.0.0.1:5561/opensamguk_int29_test`, 월드 `1cfdd777-1573-4178-9779-d0292e751e36`에서 수행했다. 최종 시험은 기존 엔진 저장·물류 소비 원장까지 같은 트랜잭션에 반영하고 의도적으로 롤백했다. 실제 DB의 해당 월드는 다섯 능력 판이므로 세 능력 DB 월드를 직접 재현한 증거로 세지 않는다. 그 회귀는 null DB 행과 실제 규칙의 휘하·장비·계략·교전 시험으로 확인했다. 다른 DB는 접속하지 않았다.

확장 실행에서는 기존 성별 없는 초기 고정물, 국가 생애 원장 없는 저장 고정물, 계략 동등성·명령 설명의 기존 기대값 차이로 실패가 있었다. 독립 기준선과 비교해 원인을 모두 확정한 결과는 아니다. 확장 묶음의 실패를 숨기거나 전체 성공으로 세지 않는다. DB 확인 초기 시도에서는 물류 소비 원장 누락, sequence 0 제약, 잘못 지정한 월 경계 tick 때문에 실패했고 검증 스크립트를 고친 뒤 위 최종 결과를 얻었다. 실패한 DB 트랜잭션도 롤백됐다.

실행 출력은 작업 폴더의 `.build-*.log`, DB 확인 스크립트는 `.tmp-int29/build-check.ts`에 남겼다. 작업 메모이므로 커밋 대상이 아니다. 현재 Node는 22.23.2이며 저장소 요구는 24 이상이다.

## 남은 범위와 미검증

프런트 연결·공개 화면 E2E·실제 인증 HTTP를 통한 예턴 접수부터 자동 엔진까지의 전체 흐름, 두 행위자의 실제 동시 건설, 장기 운영·부하·병합은 인수하지 않았다. 전체 검사는 기존 웹 lint 오류로 통과하지 않았다. AC를 완료로 바꾸지 않았다.

병영·대장간·마구간·공방·조선소의 생산·병종 연동, 관청의 분야별 비용 할인, 군사 시설의 자동 사격·시야·장애물·함정·보급·길 연결은 후속이다. 이 시설들도 자리·건설 조건·자원 소비·공사·완공·철거 상태는 제공한다. 자리별 실제 지형과 기존 전 도시의 내정값 보존 이행도 남아 있다. 이 한계는 D-107에도 기록했다.
