# 리소스 출처

- 원본: https://gitea.hided.net/devsam/core2026
- 커밋: `df6c926`
- 지도: `resources/map/map_che.json` → `map/che.json`
- 시나리오: `resources/scenario/scenario_1030.json` → `scenario/1030.json`
- 능력치 규칙: `resources/scenario/default.json` → `scenario/default.json`
- 병종: `resources/unitset/unitset_basic.json` → `unitset/basic.json`

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
