# 리소스 출처

- 원본: https://gitea.hided.net/devsam/core2026
- 커밋: `df6c926`
- 지도: `resources/map/map_che.json` → `map/che.json`
- 시나리오: `resources/scenario/scenario_1030.json` → `scenario/1030.json`
- 능력치 규칙: `resources/scenario/default.json` → `scenario/default.json`
- 병종: `resources/unitset/unitset_basic.json` → `unitset/basic.json`
- 계략 4종 공식: `packages/logic/src/actions/turn/general/strategyCommand.ts`, `che_화계.ts`, `che_파괴.ts`, `che_선동.ts`, `che_탈취.ts` → `packages/rules/src/commands/ext/stratagem/`. 비용·부상·미보급 탈취·기록과 RNG 판정은 T4-05의 S0~S7 결정과 기술 계약을 따른다.
- 공개 국력: `app/game-engine/src/turn/monthlyNationStatsHandler.ts` → `packages/rules/src/ranking.ts`의 자원·도시·장수 합성식. 난수는 우리 시드 RNG를 쓰며 숙련도·전투 교환비·NPC 보정·국가 등급 조건은 옮기지 않았다.
- 토너먼트 경기: `packages/logic/src/tournament/battle.ts` → `packages/rules/src/tournament/match.ts`. 등급 비율을 빼고 100합 뒤 잔여 기력으로 승자를 정하며 동률이면 원정이 이긴다. 조별 무승부 경기·HTML 기록·통계는 옮기지 않았다.
- 첩보 단계와 비용: `packages/logic/src/actions/turn/general/che_첩보.ts` → `packages/rules/src/commands/ext/intel/`. 거리별 정보 항목과 기술 비교 경계를 옮겼고 비용은 금·쌀 각 60으로 고정한다.

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
