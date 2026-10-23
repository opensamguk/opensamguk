# 초기화 자원 DB 이전과 편집기, 도트 바탕 지도

> 상태: 승인 (2026-10-23, 제안 초안 → 승인). 사용자 원문은 “D-028 계획 승인한다. T4-76~T4-87 상세 계획을 세션들에 나눠 맡겨.”다 <!-- lint-text-ignore J-2 -->
> 결정: [D-028](../product/decisions.md#d-028-운영자-지도-편집기와-도트-바탕-지도를-만든다-2026-10-23) · 승인 뒤 상세 계획 여섯 묶음을 대조해 §2의 재생 서술, C-M1~C-M4, §4~§6을 정정했다
> AC: AC-P2-26 (자원 DB 이전), AC-P2-27 (편집기), AC-P2-28 (바탕 지도) · 작업: T4-76~T4-90 ([Phase 2 명세 §6](./phase2-expansion.md#6-작업-분해)) · 작업마다 착수 전에 `T4-xx.md`를 따로 쓰고 Codex 기술 검토(명세 G-03)를 받는다

## 1. 목표

- 월드 초기화 자원(지도, 시나리오, 병종, 기본 능력치 규칙, 초상 대응표)을 DB의 판으로 읽는다. 기존 JSON은 초기화 SQL로 바꾼 뒤 지운다 (2026-10-23 소유자 지시).
- 운영자가 게임 안 관리자 콘솔에서 지도를 편집한다. 지형(해안·강·산맥·호수), 도시 위치, 연결, 도시 추가와 삭제까지 고친다.
- 운영자가 나머지 초기화 자원도 편집한다. 시나리오(국가, 장수, 도시 소유, 시작 연월), 병종, 기본 능력치 규칙, 초상 대응표다 (2026-10-23 소유자 지시).
- 검증을 통과한 판만 게시한다. 게시한 판은 새 월드를 만들 때 고른다. 진행 중인 월드는 영향받지 않는다.
- 게시한 판의 지형 층을 밑그림으로 삼아 고전 게임 느낌의 도트 바탕 지도를 만들고 메인·공개 지도 아래에 깐다.

## 2. 지금 상태 (main `0115e6b`, 재생 서술은 `3e5b52a`로 다시 확인)

- 지도는 `resources/map/che.json` 하나다. core2026 `df6c926`의 `map_che.json`을 옮긴 것이고 MIT 고지가 있다. 좌표계는 700×500, 도시 94개다(`apps/web/src/main/WorldMap.tsx:5-7`).
- 월드를 만들면 도시가 월드별 `City` 행으로 복사된다(`packages/db/prisma/schema.prisma:115`). 월드는 `mapKey`를 저장한다.
- 월드 초기화 자원은 엔진의 `loadInitialWorld` 한 곳이 파일 5개를 읽는다(`apps/engine/src/world/resources.ts:11-21`): `map/<키>.json`, `scenario/<키>.json`, `unitset/<키>.json`, `scenario/default.json`(능력치 규칙), `portraits/rtk14-map.json`.
- 재생은 자원 파일을 다시 읽지 않는다. 월드를 만들 때 `World.replayOrigin`에 초기 상태 전체와 `resourceHash`를 적고(`apps/engine/src/world/persistence.ts:48-58`) 재생은 이 생성 기록만으로 돈다. `resourceHash`는 기록 안의 키 셋과 병종·능력치 규칙을 해시한 값이다(`apps/engine/src/replay.ts:51-58`). 재생할 때 기록 안의 값으로 다시 계산해 대조할 뿐(`replay.ts:135`) 자원 판의 해시와 대조하지 않는다. 그래서 같은 키의 파일이나 판이 바뀌어도 옛 월드의 재생은 그대로다.
- 시뮬레이터와 시험 고정물도 같은 함수를 DB 없이 부른다(`tools/sim/cli.ts:42`, `apps/engine/test/monthlyFixture.ts:4`).
- 지도 그리기에는 바탕 그림이 없다. 도시 점과 연결선만 그린다.
- 옛 독립 편집기 [opensamguk-map-editor](https://github.com/peppone-choi/opensamguk-map-editor)(`e15ce32`)는 1000×740 캔버스의 다른 형식이다. 기능 목록(배경 배치, 성 추가·이동·삭제, 연결 편집, JSON 가져오기·내보내기)만 참고한다.

## 3. 핵심 계약

### C-M1. 자원 카탈로그와 바뀌지 않는 판

- 새 모델 `GameResource`에 자원을 판 단위로 둔다. 기본 키는 `id`(UUID)이고 `(kind, name, version)`에 유일 제약을 둔다. 종류마다 이름 공간이 따로라 지도 `che`와 시나리오 `che`가 함께 있어도 된다. API와 감사 로그는 `id`로, 화면 주소는 `kind`·`name`·`version`으로 행을 가리킨다.
- 열은 `kind`(`MAP`·`SCENARIO`·`UNIT_SET`·`STAT_RULES`·`PORTRAIT_MAP`), `name`, `version`(1 이상), `status`(`DRAFT`·`PUBLISHED`), `content`(`jsonb`), `hash`(정규 해시, 초안에도 있다), `source`(출처와 라이선스 한 줄, NOT NULL), `mapKey`(시나리오만, 짝 지도 판의 정규 키), `revision`, `createdBy`·`updatedBy`·`publishedBy`, `createdAt`·`updatedAt`·`publishedAt`이다. 모델과 CHECK는 [T4-77](./T4-77.md)의 migration이 만든다. [T4-78](./T4-78.md)의 새 migration은 둘을 더한다. 종류·이름마다 초안 하나를 지키는 부분 유일 색인 `(kind, name) WHERE status = 'DRAFT'`와 복제 원본의 정규 키를 적는 `baseKey` 열(`String?`)이다. 초기화 SQL이 넣은 내장 판의 `baseKey`는 null이다.
- 이름은 영문·숫자·밑줄·하이픈 1~40자(`^[a-zA-Z0-9_-]{1,40}$`, T4-78 규칙)다.
- 정규 키는 모든 이름에서 같다. 1판은 이름만(`che`) 쓰고 2판부터 `<이름>@<판 번호>`(`che@2`)로 쓴다. 입력 `che@1`도 받아 `che`로 바꾼다. 이름만 쓴 키는 늘 1판을 가리키고 가장 최근 판을 뜻하지 않는다. 월드·감사·바탕 그림 경로에 남기는 키는 정규 키다.
- 내장 자원의 1판 이름은 지도 `che`, 시나리오 `1030`, 병종 `basic`, 능력치 규칙 `default`, 초상 대응표 `rtk14-map`이다. 지금 키가 그대로 1판의 정규 키라 기존 월드의 `mapKey`·`scenarioKey`와 재생 기록은 바꾸지 않는다.
- 시나리오가 함께 쓸 지도 판은 내용 안이 아니라 카탈로그의 `mapKey` 열에 둔다. `1030` 1판의 내용을 바꾸지 않기 위해서다. 내장 `1030`의 `mapKey`는 `che`다.
- 게시한 판은 고칠 수 없다. 고치려면 새 판을 만든다. 서버(T4-78)가 게시 판 수정 요청을 거부하고 DB 트리거(T4-77 migration)도 `PUBLISHED` 행의 `UPDATE`·`DELETE`를 막는다. 초안 행은 내용 갱신, 게시 전환, 삭제만 받는다. 로더는 읽을 때 해시를 다시 대조한다.
- 재생은 카탈로그를 읽지 않는다. §2대로 생성 기록만 해시하므로 판 해시를 재생에서 대조하지 않는다. 판 불변이 지키는 것은 같은 키로 새 월드를 만들 때의 결과다.

### C-M1a. JSON을 없애고 초기화 SQL로 넣는다 (2026-10-23 소유자 지시)

- 내장 JSON 5종(`resources/map/che.json`, `scenario/1030.json`, `scenario/default.json`, `unitset/basic.json`, `portraits/rtk14-map.json`)을 한 번 변환해 초기화 SQL `packages/db/sql/resources-init.sql`을 만든다. 변환이 끝나면 JSON 파일과 파일 읽기 코드(`apps/engine/src/world/resources.ts`의 자원 `readFile`)를 지운다.
- 월드 프리셋 JSON(`resources/preset/*.json`)은 위 다섯 종류에 없다. 옮길지는 사용자 결정 U-77-3이고 그 전까지 파일로 남는다.
- 초기화 SQL은 마이그레이션 뒤에 `pnpm db:init-resources`로 따로 돌린다. 내용은 `INSERT ... ON CONFLICT DO NOTHING` 뒤 정규 해시를 대조하는 검사다. 두 번 돌려도 결과가 같다. 같은 키에 다른 내용이 있으면 실패한다. 이 명령은 `tools/run-integration.ts`(`pnpm test:int`)와 CI의 DB 준비 단계(`ci.yml`, `simulation.yml`, `season-throughput.yml`)가 마이그레이션 다음에 부른다.
- `pnpm db:up`은 초기화를 부르지 않는다. 이 명령은 `docker compose up -d --wait`로 PostgreSQL 컨테이너만 띄우고(`package.json:21`, `docker-compose.yml`) 마이그레이션도 하지 않는다(T4-77 Z-7). 로컬에서는 `pnpm db:migrate` 다음에 사람이 `pnpm db:init-resources`를 부르고 그 순서를 `docs/architecture/runtime.md` §3에 적는다.
- 자원 판이 없는 DB에서 월드를 만들면 어떤 자원이 없는지 알려 주고 실패한다. 빈 지도로 넘어가지 않는다.
- 출처: SQL 머리에 core2026 `df6c926` MIT 고지를 그대로 옮기고 각 행의 `source` 열에도 적는다. `resources/NOTICE.md`는 SQL 파일을 가리키도록 고친다. 고지는 지우지 않는다.
- 초상 대응표 생성기(`tools/portrait-map/generate.ts`)는 JSON을 쓰지 않는다. DB의 시나리오 1판으로 대응을 계산해 DB의 1판과 비교만 하고 새 판은 T4-78 저장소 함수로만 넣는다.
- 정규화: `jsonb`는 키 순서와 숫자 표기를 바꾼다. 해시는 키를 정렬한 정규 JSON으로 계산한다. 변환 전 JSON과 DB에서 읽은 값으로 만든 `buildInitialWorld` 결과와 `resourceHash`가 같아야 한다. 이 대조는 변환 작업 안에서 한 번 하고 결과를 구현 기록에 남긴다.

### C-M1b. 읽는 곳

- `loadInitialWorld`는 DB에서 판을 읽는다. 엔진의 월드 생성, 시뮬레이터(`pnpm sim`, `tools/season-throughput.ts`), E2E 준비(`e2e/rankingSeed.ts`)가 모두 이 길을 쓴다. 재생은 §2대로 이 길을 쓰지 않는다. 시뮬레이터가 DB를 읽게 할지는 사용자 결정 U-77-1로 열어 두며 아래 시뮬레이터 문장은 그 기본안이다.
- 규칙 패키지는 지금처럼 DB를 모른다 (AGENTS §6). 읽은 값을 인자로 받는다.
- 지금 JSON을 읽는 시험과 고정물은 아래처럼 옮긴다. 전체 목록과 PR 배정은 [T4-77 계획](./T4-77.md)의 표다.
  - DB를 쓰는 통합 시험으로 옮겨 `pnpm check`에서 빠지고 `pnpm test:int`에 들어가는 것: `apps/engine/src/simulation.test.ts`, `apps/engine/src/world/resources.test.ts`, `tools/commands.test.ts`, `tools/world-bootstrap.test.ts`, `tools/world-presets.test.ts`의 로더 부분, `tools/portrait-map/convert.test.ts`.
  - 작은 고정물로 바꾸는 것: `tools/t1-11.test.ts`, 엔진 고정물 `apps/engine/test/monthlyFixture.ts`·`warFixture.ts`(지금 결과를 한 번 저장해 읽는다), 서버 고정물 `apps/server/test/readFixture.ts`(DB에서 읽고 이를 쓰는 단위 시험은 자른 고정물이나 통합으로).
  - 화면 쪽: `apps/web/src/battleSim/request.test.ts`와 `e2e/battleSim.spec.ts`는 T4-86, `apps/web/src/mapEditor/contract.test.ts`·`validate.test.ts`와 `e2e/mapEditor.spec.ts`는 T4-88이 JSON 경로를 버린다.
  - 규칙 단위 시험은 작은 고정물로 돈다.
- 시뮬레이터가 DB를 쓰므로 `.github/workflows/simulation.yml`에 PostgreSQL 서비스를 더한다(`season-throughput.yml:18-28`과 같은 방식). AC-M1-18의 15분 측정을 이전 뒤 다시 잴지는 사용자 결정 U-77-2다. 시뮬레이션 결과 해시가 이전 전과 같아야 한다.
- 화면: 전투 시뮬레이터가 번들에 넣던 병종 자료(`apps/web/src/battleSim/publicUnitSet.ts:4`)는 [T4-85](./T4-85.md)의 `resources.worldRules`로 받는다. 값은 카탈로그가 아니라 월드 행에 저장된 병종·능력치 규칙이다. E2E 기대값(`e2e/battleSim.spec.ts:17`)도 DB에서 읽는다.

### C-M2. 지도 형식 v2

`mapSchema`(`packages/rules/src/world/resources.ts:18`)에 판 형식 v2를 더한다. 도시 필드는 지금 형식 그대로다. 정본은 [T4-76](./T4-76.md) 3.1이다.

```ts
type Terrain = {
  coast: Array<Array<[number, number]>>;     // 바다와 땅의 경계, 닫힌 다각형
  lakes: Array<Array<[number, number]>>;     // 닫힌 다각형
  rivers: Array<{ name?: string; points: Array<[number, number]> }>; // 열린 선
  mountains: Array<Array<[number, number]>>; // 산맥 영역, 닫힌 다각형
};
// v1 = 지금 MapResource (version 칸 없음, 지형 없음)
// v2 = { version: 2, canvas: { width, height }, terrain: Terrain, ... } 네 층 모두 필수, 빈 배열 가능
```

- v1에는 지형이 없다. v2는 `terrain`과 네 층이 모두 있고 모르는 칸을 거부한다. 그래서 같은 지도는 한 가지 모양뿐이다. 초안의 `terrain?`는 v1에 지형이 없다는 뜻이었다(T4-76 I-9).
- 지도 초안은 v2만 저장·게시한다. v1 판(내장 `che` 1판)을 복제하면 서버(T4-78)가 `normalizeMapToV2`로 v2로 올려 초안에 넣는다. 내장 `che` 1판은 v1 그대로 남고 지형이 든 che는 새 판(`che@2`)이다.
- 좌표는 도시와 같은 좌표계다. 캔버스 칸은 지도마다 있지만 이번 범위의 화면은 700×500만 그리므로 검증기도 700×500 한 가지만 받는다. 다른 크기와 도시·지형 점 한도는 사용자 결정(T4-76 P-2)이다.
- 지형 층은 표시 전용이다. 이동·전투 규칙은 지금처럼 도시 연결만 본다. 지형이 규칙에 들어가는 것은 이 범위가 아니다 (AGENTS §3).

### C-M3. 검증기

게시 전에 아래를 모두 통과해야 한다. 같은 검사를 편집 화면과 서버가 함께 쓴다.

- 도시 ID와 이름이 겹치지 않는다. 좌표가 캔버스 안이다. 규모·지역 값이 범위 안이다.
- 연결이 양쪽에 있고 자기 자신을 가리키지 않는다. 모든 도시가 하나의 연결망에 이어진다.
- 지형 다각형이 닫혀 있다.
- 이 지도와 함께 쓸 시나리오가 참조하는 도시(국가 수도, 장수 위치)가 모두 있다. 없으면 어느 시나리오의 어느 항목인지 알려 준다. 지도 게시 때 이 검사는 서버(T4-78)가 한다. 짝 지도 키가 이 판인 시나리오의 문제는 오류로, 이 초안의 복제 원본을 짝으로 쓰는 게시 시나리오의 문제는 경고로 낸다. 편집 화면의 지도 검사는 지도 내용만 본다.

검증 결과는 `{ ok, issues, value }`다. 항목마다 `code`, `severity`(`error`·`warning`), `message`, `target`, `params`가 있다. `ok`와 게시 판정은 `error`만 센다. `warning`은 보여 주기만 하고 게시를 막지 않는다. 오류 코드 목록은 T4-76 3.3·3.4다.

### C-M3a. 지도 밖 자원의 검증

- 시나리오: 국가 이름이 겹치지 않는다. 장수 소속 국가와 위치 도시가 있다. 국가 수도와 도시 소유가 함께 쓸 지도 판의 도시를 가리키고 한 도시를 두 국가가 갖지 않는다. 장수 이름이 겹치지 않는다. 시나리오 판은 함께 쓸 지도 판 하나를 카탈로그 `mapKey` 열로 기록한다(C-M1).
- 병종: key가 겹치지 않고 수치가 규칙 스키마(`packages/rules/src/world/resources.ts:77`) 범위 안이다.
- 능력치 규칙: 스키마(`resources.ts:102`)를 지나고 합계·최솟값·최댓값이 서로 모순되지 않는다.
- 초상 대응표: 초상 ID가 10001~11000 안이다 (이미지 자산 §2).
- 초안이 적었던 항목 가운데 지금 형식에 없는 것은 사용자 결정 P-1(T4-76)과 함께 열어 둔다. 장수 ID 중복(장수 ID가 배열 순서라 따로 겹칠 수 없어 이름 중복으로 대신 본다), 시나리오가 쓰는 병종(시나리오에 병종 참조가 없다), 시작 연월과 종료 조건(시작 연도만 있고 형식 범위만 본다)이다. 칸을 더하면 시나리오 편집(T4-87)과 월드 생성(T4-79)이 함께 바뀐다.
- 검사는 종류마다 규칙 패키지의 순수 함수로 두고 편집 화면과 서버가 같은 함수를 쓴다. 하위 경로 `@opensamguk/rules/resources`의 `validateResource(kind, content, ctx)`와 종류별 함수다.

### C-M4. 권한과 감사

- 편집·게시는 관리자 권한(T3-05)이 있는 계정만 한다. 관리자 전원에게 줄지 자원 편집 권한을 따로 둘지는 사용자 결정 U-T78-1이다. 종류마다 권한을 나누지 않는다. 행위자는 세션에서 정한다.
- API는 tRPC `resourceAdmin.list`, `get`, `clone`, `save`, `publish`, `discard`다(T4-78). 판 복제(`clone`)는 초안을 만든다. 초안 버리기(`discard`)는 초안 행을 지운다. 종류·이름마다 초안은 하나다.
- 초안 만들기(복제), 초안 저장, 초안 버리기, 게시는 모두 감사 로그(T3-05)에 남는다. action은 `resource.draft.create`, `resource.draft.save`, `resource.draft.discard`, `resource.publish`이고 내용 사본 없이 해시만 남긴다. 게시 사유를 필수로 받을지는 사용자 결정 U-T78-3이다.
- 초안 저장은 `revision`으로 동시 편집 충돌을 막는다. 두 운영자가 같은 초안을 고치면 늦은 저장이 거부된다.

## 4. 도트 바탕 지도

- 게시한 판마다 바탕 그림 하나를 둔다. 크기는 캔버스의 3배(2100×1500)이고 형식은 WebP다. 이번 범위의 화면은 700×500 지도만 그린다. 다른 크기는 사용자 결정(T4-76 P-2)이다.
- 만드는 순서: 편집기가 지형 층을 단색 도트 밑그림(바다·땅·강·산·호수 5색)으로 내보낸다. Codex가 이 밑그림만 입력으로 고전 게임 느낌의 도트 그림을 생성한다. 도시 점과 이름은 그림에 넣지 않는다. 생성 방식과 비용은 [T4-83](./T4-83.md)의 사용자 결정이다.
- 보관: 이미지 저장소(D-016) `maps/<정규 키>/base.webp`. 정규 키는 C-M1 규칙이라 1판은 `maps/che/base.webp`, 2판은 `maps/che@2/base.webp`다. 판마다 경로가 달라 덮어쓰지 않는다. 지형이 없는 `che` 1판에 그림을 둘지는 사용자 결정(T4-83 MB-3)이다.
- 서버가 판마다 그림이 있는지 아는 DB 자리와 `world.map`·`world.publicMaps`의 바탕 그림 칸은 T4-89가 만든다. 출처 표는 이미지 저장소에 있어 서버가 읽지 못한다.
- 화면: 그림이 있으면 지도 그리기가 도시 점·연결선 아래에 깐다. 없으면 지금처럼 바탕 없이 그린다.
- 출처 기록: 그림마다 밑그림 파일 해시, 밑그림 래스터 해시, 생성 도구, 생성 일시를 이미지 저장소의 출처 표에 남긴다. 래스터 해시는 `너비(u32 BE) ‖ 높이(u32 BE) ‖ 팔레트 15바이트 ‖ 화소 번호 배열`의 SHA-256이다. PNG 바이트는 브라우저 압축기에 따라 달라질 수 있어 대조는 래스터 해시로 한다(T4-82 MT-3).

### 외부 그림을 참고할 때

와룡전 리메이크(`phixteam1/GRZ` v1.1)의 그림은 원작 그림을 확대한 것으로 보이며 이용 허락이 없다 (D-028).

- 해도 되는 것: 화풍, 색 구성, 어떤 지형을 표시할지 정할 때 보고 참고하기.
- 하면 안 되는 것: 따라 그리기, 이미지 생성의 입력 그림이나 참조 이미지로 넣기, 지형 배치를 그대로 옮기기, 저장소·이미지 서버에 올리기.

## 5. 작업 순서

```text
T4-76 형식 v2·검증기 ─┬─▶ T4-77 자원 카탈로그 DB (PR 1) ─▶ T4-78 초안·게시 API ◀── T3-05
                      ├─▶ T4-80 편집 캔버스
                      ├─▶ T4-88 캔버스를 rules v2로
                      └─▶ T4-82 che 지형 층 초안 ◀── T4-80
T4-78 ─┬─▶ T4-79 월드 생성 판 고르기 ─▶ T4-90 관리자 양식 판 고르기 ◀── T3-06
       ├─▶ T4-89 바탕 그림 칸·DB 자리 ─▶ T4-84 지도 화면에 깔기 ◀── T4-83, T2-25
       ├─▶ T4-83 바탕 그림 생성 ◀── T4-82
       └─▶ T4-81 관리자 콘솔 연결 ◀── T4-80, T4-88, T3-05, T3-06 ─▶ T4-87 표 편집 화면 ◀── T4-76, T3-06
T4-85 병종·능력치 조회 API ─▶ T4-86 전투 시뮬레이터 API 값
T4-77 PR 2 JSON 삭제는 PR 1, T4-86, T4-88 뒤에 병합
```

- T4-77은 편집기와 상관없이 혼자 가치가 있다. JSON을 초기화 SQL로 바꾸고 지운 뒤에도 기존 월드 재생 해시가 그대로임을 증명한다. PR 1(DB 이전)과 PR 2(JSON 삭제)로 나눈다.
- T4-85는 카탈로그가 아니라 월드 행에 이미 있는 병종·능력치 규칙 열을 읽으므로 T4-77을 기다리지 않는다. T4-86은 T4-85 뒤다. 화면과 시험이 JSON 경로를 모두 버려야 PR 2가 빌드를 깨뜨리지 않으므로 T4-77 PR 2는 T4-86과 T4-88 뒤에 병합한다.
- T4-88은 T4-80 편집 캔버스의 임시 타입과 검증을 T4-76의 rules v2 타입·검증기로 바꾸고 편집기 시험의 che 입력을 JSON 파일에서 떼어 낸다.
- T4-80 편집 캔버스는 서버 없이 JSON 가져오기·내보내기로 돈다. 그래서 T4-78과 관리자 콘솔(T3-05·T3-06)을 기다리지 않고 T4-82까지 먼저 갈 수 있다. T4-82는 T4-76 검증기도 기다린다. T4-83은 T4-82의 밑그림과 T4-78의 판 게시 뒤다.
- T4-81 연결은 T4-88, T3-05(관리자·감사), T3-06(관리자 콘솔)이 main에 들어온 뒤다. T4-87은 T4-81과 T4-76 뒤다. T4-84는 T4-83, T2-25, T4-89 뒤다.
- 위 그림은 상세 계획의 선행을 모은 것이고 정본은 [단계 계획](../product/phases.md) Phase 2 표다.

## 6. 검증 요약

| 무엇 | 어떻게 |
| ---- | ------ |
| 초기화 SQL | PostgreSQL: 두 번 돌려도 같은 결과, 같은 키 다른 내용은 실패, 출처 열 보존, 자원 없는 DB의 월드 생성은 이유와 함께 실패 |
| 변환 대조 | 변환 작업 안에서 한 번: 변환 전 JSON과 DB 값의 `buildInitialWorld` 결과·`resourceHash`가 같다 |
| 시뮬레이터 | CI: DB로 `pnpm sim --seeds 10` 결과 해시가 이전 전 실행과 같다. 시간은 기록만 하고 AC-M1-18 판정은 따로 |
| 남은 파일 | 정적 검사: 범위는 `resources/` 전체와 자원 로더다. `resources/`에 JSON이 없고(사용자 결정 U-77-3 전까지 프리셋 JSON `resources/preset/`만 뺀다) 자원 로더가 다섯 종류를 `readFile`로 읽지 않는다. T4-82 결과 `tools/map-terrain/che.v2.json`은 `resources/` 밖의 도구 입력(도시까지 든 v2 지도)이라 대상이 아니다 |
| 기존 재생 | 통합: 이전 전 고정물(`apps/engine/test/fixtures/replay-v1-b8f5074.json`)과 이전 뒤 재생 해시가 같다 |
| 판 불변 | PostgreSQL: 게시 판 `UPDATE`·`DELETE`를 트리거가 거부, HTTP 게시 판 수정 요청 거부, 같은 키로 만든 새 월드의 `resourceHash`가 바뀌지 않음 |
| 진행 중 월드 | 통합: 새 판 게시 뒤 기존 월드의 `City`와 재생 결과가 그대로 |
| 검증기 | 단위: 위 C-M3 항목마다 통과 1건·실패 1건, `che` 통과, 경고는 `ok`를 바꾸지 않음 |
| 권한 | HTTP: 무인증·일반 계정·제재 계정의 편집·게시·버리기 거부, 감사 로그 기록 |
| 동시 편집 | HTTP: 늦은 초안 저장 거부 |
| 편집 화면 | Playwright: 도시 추가·이동·삭제, 연결, 지형 그리기, 검증 오류 표시, 내보내기·가져오기 왕복 |
| 자원 편집 | Playwright: 시나리오 장수 추가·국가 소유 변경, 병종 수치 변경, 능력치 규칙 변경을 초안 저장 → 검증 오류 → 고쳐서 게시. 새 판으로 월드 생성, 기존 월드 그대로 |
| 자원 검증 | 단위: C-M3a 항목마다 통과 1건·실패 1건, 내장 판 통과 |
| 바탕 그림 | Playwright: 그림 있는 판은 도시 점 아래에 그림, 없는 판은 바탕 없음. 출처 표에 파일 해시와 래스터 해시가 있다 |

## 7. 하지 않는 것

- 지형을 이동·전투 규칙에 넣기
- 플레이어가 지도를 만들어 올리기
- 진행 중인 월드의 지도 바꾸기
- 변환 전에 JSON 내용 고치기 (내용은 그대로 옮긴다)
