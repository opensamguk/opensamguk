# 화면 레퍼런스

> 상태: 확정 v0.2 (2026-10-20) · 가정 A10 사용자 확인 완료 · 방향: 원작 정보량 + 모던 정리 (D-007)
> 기계용 목록: [sources.json](./sources.json)
> **방향 합의용입니다.** 이미지는 저장하지 않고 출처 링크와 참고할 점만 둡니다. 화면에 다시 쓰지 않습니다.

모든 링크는 2026-10-20에 직접 열어 해당 화면이 있는지 확인했습니다.

| # | 레퍼런스 | 출처 (확인한 화면) | 가져올 것 | 쓰는 화면 |
| - | -------- | ------------------ | --------- | --------- |
| R1 | 원작 메인 화면 | [core2026 `MainView.vue` @df6c926](https://gitea.hided.net/devsam/core2026/src/commit/df6c9269fa1e2862418ba9da481c8dd2d758d6c5/app/game-frontend/src/views/MainView.vue) · MIT. 지도, 예턴 목록, 도시·국가·장수 카드, 기록, 메시지를 한 화면에 조립 | 한 화면 정보량의 기준, 다섯 영역을 함께 두는 배치 | 메인 |
| R2 | 원작 국가 도시 화면 | [core2026 `NationCitiesView.vue` @df6c926](https://gitea.hided.net/devsam/core2026/src/commit/df6c9269fa1e2862418ba9da481c8dd2d758d6c5/app/game-frontend/src/views/NationCitiesView.vue) · MIT. 도시별 수치·관직·주둔 장수, 최대치 대비 부족분과 색 단계, 머리글 정렬 | 부족분 표시, 관리 필요 값 강조, 머리글 정렬 | 국가·도시 정보, `StatTable` |
| R3 | Europa Universalis IV 장부 | [Paradox Wikis "Ledger"](https://eu4.paradoxwikis.com/Ledger) · 커뮤니티 위키, CC BY-SA 3.0. 국가·군사·경제·교역·관계 범주의 국가 비교표 | 국가 사이 비교표, 범주별 탭 | 국가 정보, 순위(M2) |
| R4 | GitHub Projects 표 보기 | [GitHub Docs "Customizing the table layout"](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-table-layout) · 공식 문서, 스크린샷 4장 (머리글 메뉴, 열·행 순서 바꾸기, 2차 정렬) | 촘촘한 표, 머리글에서 정렬·열 고르기, 숫자 합계 | `StatTable`, 장수·도시 표 |
| R5 | Linear 보기 옵션 | [Linear Docs "Display options"](https://linear.app/docs/display-options) · 공식 문서. 이미지는 보기 옵션 메뉴 한 장 (목록 화면 아님) | 보일 속성 고르기, 정렬 기준, 기본값 저장 | 예턴 편집, 기록 |

## 뺀 후보

| 후보 | 이유 |
| ---- | ---- |
| Football Manager 선수 목록 | 공식 화면 출처를 찾지 못함 (팬 사이트만 있음) |
| EVE Online 시장 창 | 위키 문서에 시장 창 이미지가 없고 공식 지원 문서를 찾지 못함 |

## 지금 반영한 것 (T1-13)

- 행 높이 28px, 얇은 구분선, 숫자 고정폭·오른쪽 정렬, 최대치 막대 (`StatTable` ← R2·R4)
- 국가색은 이름표에만, 글자색은 대비로 자동 선택 (`NationBadge`)
- 메인 3열 격자에 다섯 패널 (`MainPage` ← R1)

## 다음에 반영할 것

- 머리글 정렬과 부족분 표시 (T1-16, R2·R4)
- 보일 열 고르기 (M2, R4·R5)
- 국가 비교표 (M2 순위, R3)

## 확인 (A10)

2026-10-20 사용자가 이 다섯 가지로 방향을 확정했습니다. PRD 가정 원장 A10 통과.
