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
초상 경로는 읽지 않고 `portraitId = null`로 둡니다.

## 원본 라이선스

MIT License

Copyright (c) 2025 devsam

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
