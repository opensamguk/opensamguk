# 리소스 출처

- 원본: https://gitea.hided.net/devsam/core2026
- 커밋: `df6c926`
- 지도: `resources/map/map_che.json` → `map/che.json`
- 시나리오: `resources/scenario/scenario_1030.json` → `scenario/1030.json`
- 능력치 규칙: `resources/scenario/default.json` → `scenario/default.json`
- 병종: `resources/unitset/unitset_basic.json` → `unitset/basic.json`
- 계략 4종 공식: `packages/logic/src/actions/turn/general/strategyCommand.ts`, `che_화계.ts`, `che_파괴.ts`, `che_선동.ts`, `che_탈취.ts` → `packages/rules/src/commands/ext/stratagem/`. 비용·부상·미보급 탈취·기록과 RNG 판정은 T4-05의 S0~S7 결정과 기술 계약을 따른다.
- 공개 국력: `app/game-engine/src/turn/monthlyNationStatsHandler.ts` → `packages/rules/src/ranking.ts`의 자원·도시·장수 합성식. 난수는 우리 시드 RNG를 쓰며 숙련도·전투 교환비·NPC 보정·국가 등급 조건은 옮기지 않았다.

각 JSON의 `$comment`에 출처를 남겼고, 시나리오 식별용 `id`를 추가했습니다.
병종은 성벽·보병·궁병·기병 4종만 남기고 제외한 병종의 계수도 제거했습니다.
추가 장수(`general_ex`), 사건(`extends`), 역사 문구(`history`)는 원본 파일에 남아 있지만 로더는 사용하지 않습니다.
원본 초상 경로는 사용하지 않습니다. 별도 한글 이름 대응표로 새 초상 ID를 부여하며, 대응하지 못한 이름은 null입니다.

## 원본 라이선스

MIT License

Copyright (c) 2025 devsam

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 초상 메타데이터와 한자 독음 표

- `tools/portrait-map/registry.tsv`: [opensamguk-images의 ID registry](https://raw.githubusercontent.com/peppone-choi/opensamguk-images/049091911d954feee54862bea6ddcc70a3ff4e84/portraits/rtk14/officer-id-registry.tsv)에서 ID·한자 이름·읽기만 추렸다. 그림은 복사하지 않았다. 이미지 사용은 D-004·`docs/image-assets.md`의 공개 전 관문을 따른다.
- `tools/portrait-map/hanja-readings.json`: [suminb/hanja 독음 표](https://raw.githubusercontent.com/suminb/hanja/f58b6ed5eceaccb47ad2072a710bfd01e8a9687f/hanja/table.yml) 중 registry에 쓰인 805자. 아래 라이선스를 따른다.

```text
           DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                   Version 2, December 2004

Copyright (C) 2024 Sumin Byeon <suminb@gmail.com>

Everyone is permitted to copy and distribute verbatim or modified
copies of this license document, and changing it is allowed as long
as the name is changed.

           DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
  TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

 0. You just DO WHAT THE FUCK YOU WANT TO.
 1. I genuinely do not care what you do with this code. You may produce
 derivatives, integrate the code with your own products and services, train and
 evaluate large language models (LLMs), write a book about it, make a YouTube
 channel, found a company, or anything you can ever imagine. Bring your wild
 imagination into reality. Make something happen.
```

## S2 이후 추가 출처

### T4-46 추가 시나리오의 출처

원작은 위 core2026 커밋 `df6c9269fa1e2862418ba9da481c8dd2d758d6c5`이고 MIT © 2025 devsam을 따른다. 원작 전체 시나리오의 출처 83행과 원문을 복사한 9종의 바이트를 fixture에 남겼다.

- `resources/scenario/scenario_1010.json` → `resources/scenario/1010.json`
- `resources/scenario/scenario_1020.json` → `resources/scenario/1020.json`
- `resources/scenario/scenario_1040.json` → `resources/scenario/1040.json`
- `resources/scenario/scenario_1060.json` → `resources/scenario/1060.json`
- `resources/scenario/scenario_1070.json` → `resources/scenario/1070.json`
- `resources/scenario/scenario_1090.json` → `resources/scenario/1090.json`, 조조 도시 목록의 두 번째 하비 하나 삭제
- `resources/scenario/scenario_1100.json` → `resources/scenario/1100.json`, 조비 도시 목록의 두 번째 하비 하나 삭제
- `resources/scenario/scenario_1110.json` → `resources/scenario/1110.json`, 조예 도시 목록의 두 번째 하비 하나 삭제
- `resources/scenario/scenario_1120.json` → `resources/scenario/1120.json`
- 위 9종의 원작 바이트 문자열과 전체 83종의 경로·blob·SHA-256 → `tools/fixtures/t4-46-scenarios.json`
- 위 9개 사본의 내용·출처와 이 고지 전문 → `packages/db/sql/resources-scenarios.sql`

각 사본과 fixture 머리에 출처를 적었다. 1090·1100·1110은 첫 번째 하비와 국가·도시 순서를 유지한다. 원작 칸과 값은 이 세 원소와 출처·식별용 칸 외에는 바꾸지 않았다. 추가한 9종의 최상위 `extends`·`general_ex`·`history`·`life`·`fiction`·`const`·`cities` 칸은 기존 1030과 같이 보존하되 로더에서 읽지 않는다. 이 처리를 나머지 미검증 시나리오로 넓히지 않는다.
- 토너먼트 경기: `packages/logic/src/tournament/battle.ts` → `packages/rules/src/tournament/match.ts`. 등급 비율을 빼고 100합 뒤 잔여 기력으로 승자를 정하며 동률이면 원정이 이긴다. 조별 무승부 경기·HTML 기록·통계는 옮기지 않았다.
- 첩보 단계와 비용: `packages/logic/src/actions/turn/general/che_첩보.ts` → `packages/rules/src/commands/ext/intel/`. 거리별 정보 항목과 기술 비교 경계를 옮겼고 비용은 금·쌀 각 60으로 고정한다.

예형(禰衡·祢衡)의3·6·83·76·6도 위 삼국지11 목록에서 확인했다. v1의 이형(李衡10455)과는 다른 인물이므로 해당 인물의 능력치나 그림을 대신 쓰지 않는다. 보충 행의 sourceRevision은 URL·인물 표기·정본 순서의5값을 선택해 정규화한 내용 해시이며 웹 페이지 HTML의 바이트 해시가 아니다.

## 통합판 191년 5능력치 원장

`officers/191-five-stats.json`은 main `7b910312549062ad670e203015c020e13bbf6518`의 491개 장수 ID·이름·순서를 보존한 별도 대응 원장이다. 기존 `scenario/1030.json`의 값과 국가·도시 배치는 바꾸지 않는다. 원장 자체가 운영 시나리오의 연결 완료를 뜻하지 않는다.

483명의 5능력치는 `peppone-choi/opensamguk-v1`의 `bc053629710711d4c5dfa50683bae78f4baeca95`, `resources/scenario/scenario_3190.json`에서 필요한 행만 가져왔다. 원문 SHA-256은 `e4bc491e14733b46a45606273a7bc3a6dd3bc4082e96eb057a2fc00b83cae1c3`이다. 원본 personPolicies의 `rtk14-workbook:190.1`, workbook SHA-256 `bb8f6db3b5afe732cb5d019cd16e15b92dc1296530ab265f1f7577a04de34e7f`와 officerId를 보존한다. 선택한 483행의 검사 사본은 `tools/fixtures/int16-selected-officers.json`이다. 능력치 이름 intelligence만 intel로 대응하며 수치를 추정하거나 보정하지 않는다.

한자·인물 ID 대조에는 기존 [opensamguk-images 메타데이터 원장](https://github.com/peppone-choi/opensamguk-images/blob/049091911d954feee54862bea6ddcc70a3ff4e84/portraits/rtk14/officer-id-registry.tsv)을 썼다. 게임의 능력치 자료는 KOEI 삼국지 시리즈의 수치이며 이 고지가 이미지 사용권을 부여하지 않는다.

v1에 없는 7명은 2026-10-27 웹에서 확인한 삼국지11 수치를 기록했다. 기사 본문·이미지는 옮기지 않았으며 각 행에 해당 URL과 자료 판을 남긴다. 출처는 [후소제(후한)](https://d.namu.moe/w/후소제(후한)), [헌제](https://www.namu.moe/w/헌제(삼국지%20시리즈)), [사마휘](https://d.namu.moe/w/사마휘/기타%20창작물), [우길](https://www.namu.moe/w/우길/기타%20창작물), [삼국지11 능력치 목록의 화타·교현](https://zetawiki.com/wiki/삼국지_11_능력치_목록)이다. 헌제의 도전 모드 유협 값은 적용하지 않는다. 교현은 이 게임의 교국로 묘사이며 main 생몰년을 역사 인물의 생몰년으로 교체하지 않는다.

길평의 29·10·56·54·70은 [팬 제작 신무장 길본](https://wikiwiki.jp/sansinb/みんなの新武将/後漢末～三国#t85e2477)의 예시 값이다. 정식 게임의 능력치가 아니다. 사용자는 2026-10-27 이 값을 길평의 이번 판 확정값으로 채택했다. 원장에 팬 제작 출처·역사 길본과 연의 길평의 차이·사용자 확정 근거를 함께 기록한다.

## 통합판 개발용 보충 초상

사용자의 2026-10-27 요청에 따라 [Kongming’s Archives의 삼국지11 초상](https://kongming.net/11/portraits/)에서 소제·헌제·사마휘·우길·화타·교현·예형, [삼국지3 MS-DOS 초상](https://kongming.net/3/portraits/ms-dos/)에서 길평 원본을 확인했다. 그림의 권리자는 KOEI이며 오픈 라이선스 자료가 아니다. D-004·D-031의 개발·비공개 테스트 범위를 따른다.

`portraits/191-supplement.json`은 인물·게임·원본 URL·바이트 해시와 새 ID 11001~11008만 기록한다. `pnpm portraits:fetch-supplement`가 이 checkout의 Git 제외 폴더 `private/portraits-supplement/`에 원본을 받고 내용 해시를 확인한다. 기존 파일과 해시가 다르면 덮어쓰지 않는다. 원본을 수정하거나 Git·공개 dist에 넣지 않는다. 개발 서버는 등록된 원본만 읽으며 공개 빌드는 기본 SVG를 쓴다.

`portraits/191-map.json`은 인물 원장을 기준으로 기존 초상 483명과 보충 8명을 대응한 새 월드용 표다. 기존 `rtk14-map.json`과 이미 생성한 월드의 초상 ID를 바꾸지 않는다. 운영 시나리오 연결은 INT-04의 별도 검증 대상이다.

## 통합판 운영 지도 (INT-03)

`map/integration.json`·`map/integration-correspondence.json`과 생성기 `tools/map-data/operational.ts`의 기존 도시 ID·경제 값은 core2026 커밋 `df6c926`의 `map/che.json` 파생 자료다. 원저작자 devsam의 MIT 고지를 위 원문과 함께 유지한다.

`map/integration.json`은 위 Natural Earth v5.1.2 지역 GIS와 기존 `campaignSeed.ts`의 53도시·8관문·6항구·13전장 좌표를 재사용한다. GIS 원본 묶음의 바이트 SHA-256을 운영 자원에 고정한다. 생성은 `pnpm exec tsx tools/map-data/build-operational.ts`다. 좌표는 모두 같은 WGS84 투영 모델을 쓰며 실지형은 생성 이미지로 대체하지 않는다.

기존 도시의 게임 경제·방어 값은 `map/che.json`의 같은 ID에서 보존한다. 새 상당95·서평96·영창97·건안98·양평99의 게임 초깃값은 인구5000·농업/상업/치안100·방어/성벽500이고 최대값은 인구100000·농업/상업/치안2000·방어/성벽4000이다. 레벨2와 지역을 생성기에 명시했다. 새 관문은 초기 방어/성벽5000·최대10000이며 경제·인구가 없다. 이 값은 게임 편성 기준이며 역사 인구·세입의 자료로 주장하지 않는다.

81개 육로·도하·교량·수로는 생성기의 명시적 게임 연결이다. Natural Earth가 고대 도로망을 증명한다는 뜻이 아니다. 수로는 소속 도시의 항구 쌍을 쓰고 전장은 선의 경유 표시만 한다. 실제 이동 목표는61개 도시·관문이며 경유 표식 때문에 추가 이동 턴이나 거리 비용이 생기지 않는다. `map/integration-correspondence.json`은 기존 앵커 ID와 새 이름을 대조한다. 서량→무위·패→소패·하변→무도·양평관 이름을 명시하며 요동 양평99를 옛 안평60의 자동 별칭으로 등록하지 않는다.

## 통합판 191년 게시 자원 (INT-04)

`scenario/integration191.json`은 main의 `scenario/1030.json`(core2026 `df6c926`, devsam MIT)을 파생하며 원문491행과21국 ID·이름·소속·금/쌀·성격·시기를 보존한다. `generalStats`는 위 INT-16의 검수 원장491명에서 인물ID·5값·출처ID·판을 그대로 대응한다. 기존 파일과 게시 자원은 바꾸지 않는다. 생성기는 `tools/map-data/build-integration-scenario.ts`이며 새 자원4종의 이름·1판·내용 해시·출처를 `integration-manifest.json`에 고정한다. `scenario/five-stats.json`은 D-038의 게임 생성 규칙이다.

`scenario/integration191-correspondence.json`은 도시 기능을 잃은 정도81·장판89·역경77·합비82를 전장 표시로 남긴 기록과 수도 대응2건을 보존한다. 도겸의 서주12는 원본에서 함께 소유하던 하비21로 수도 기능을 통합한다. 공손도 국가17의 본거지는 [삼국지 권8 공손도전](https://zh.wikisource.org/zh-hant/三國志/卷08#公孫度)의 요동·양평 기록을 근거로 새 판의 요동 양평99에 명시했다. 이는 새 판의 대응 결정이며 옛 안평60과 같은 지명·좌표라는 주장이 아니다. 장로의 양평관75는 별도 관문으로 유지한다.

새 초상표 `portraits/191-map.json`은 위 개발 전용 초상 고지를 따른다. 이 게시 자원에는 이미지 원본을 넣지 않으며 새 공개 초상을 배포하지 않는다.

## v1 페이지 구조 참고

페이지 구조는 비공개 참고 저장소 `peppone-choi/opensamguk-v1`의 `bc053629710711d4c5dfa50683bae78f4baeca95`에서 `web/game/components/shell/GameFrame.tsx`, `web/game/lib/nav31.ts`, `web/game/components/campaign/WarRoomPage.tsx`, `web/gateway/components/lobby/LobbyScreen.tsx`를 대조했다. 현재 `apps/web/src/layout/GameNavigation.tsx`는 공통 머리줄·왼쪽 메뉴·모바일 하단 탐색을 참고하며 기존 React 주소와30칸 예약을 유지한다. v1의 게임 규칙·이미지·전체 페이지를 복사하지 않았다. v1은 MIT이며 원 고지는 `Copyright (c) 2026 빼뽀네 (peppone-choi) and OpenSamguk contributors`다. 위 MIT 허가·조건·보증 부인 전문은 이 출처에도 적용된다.
