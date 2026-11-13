# INT-25 원작 배치 화면 개편

> AC-INT-25 · 구현 Claude · 리뷰 Codex · 결정 [D-085](../product/decisions.md) · 사용자 직접 요청 2026-11-13
> 기준: main `f93440e0`, 점검 대상은 공개 알파 배포 커밋 `2d54c23d`. 시안: [화면 개편 시안 캔버스](https://claude.ai/artifact/UNgoJSYNWzdzFegQFbiQLd)의 `시안 A — 원작 배치`.
> 짝 계획은 [INT-26 원작 정보 동등성](./INT-26.md)이다. 화면은 INT-26이 응답에 더하는 값을 자리부터 만들고 값이 오면 채운다.

## 계획 (Claude)

### 푸는 문제

2026-11-13 공개 알파(군주 조조, 주둔 장수 151명)에서 잰 값이다.

| 항목 | 지금 | 원작 core2026 |
| --- | --- | --- |
| 메인 높이 1440px | 13,159px (14.6화면) | 약 1,540px |
| 메인 높이 375px | 51,032px (62.8화면) | 패널을 하나씩 바꿔 봄 |
| 예턴 위치 375px | 27,766px 아래 (34화면) | 하단 막대 한 번 |
| 내 장수·국가 요약 1440px | 6,140px 아래 | 첫 화면 |
| 인자 입력 | 카드 상자 아래 선택 상자 하나. 대상 도시 기본값이 내 도시 | 전체 화면 입력, 지도에서 대상 고르기, 거리별 목록, 대상 정보 |
| 장수 얼굴 | 메인에 icon 하나, 목록에는 없음 | 카드·표에 얼굴 |

메인이 긴 까닭은 주둔 장수 표 151행(`main/CityInfo.tsx`), 도시 자원 배속·물류(`CityResourcesPanel`, `LogisticsPanel`), 통치(`GovernancePanel`), 가계(`LineagePanel`), 휘하·부곡(`CampaignPanel`), 장수 지시(`RetinueOrdersPanel`)가 모두 메인 패널 안에 꽂혀 있어서다. 영역별 감사 13건과 원작 정보 대조 8묶음의 결과는 PR 본문에 붙인다.

### 화면 구조

```
위 띠: 로비 · 월드 이름 · 연월 · 다음 턴까지 · 실시간 · (계정)
공통 메뉴 띠: 세력 일람 · 장수 일람 · 순위 · 기록 · 영토 재생 · 첩보 기록 · 전투 시뮬레이터 · 도움말
메인 /w/:id
  지도 (왼쪽)                         | 예턴 30칸 (오른쪽, 앞 14칸 + 펼치기, 빈 칸 방침·군사 조언)
  도시 (수치 8칸, 태수·군사·종사, 연결, 링크: 주둔 장수·도시 자원·물류)
  국가 (성향·군주·참모 … 18항목, 공지)   | 장수 (portrait 148×210, 능력치, 10항목, 링크: 장비·가계·내 정보)
  국가 메뉴: 인사부 · 국가 예턴 · 작전 · 감찰 · 외교실 · 통치 · 세력 도시 · 세력 장수
  내 장수 메뉴: 현재 도시 · 물류 · 휘하·부곡 · 장수 지시 · 제안함 · 가계 · 장비 · 지도 크게
  기록: 장수 동향 | 개인 기록 | 중원 정세
  메시지: 받는 곳 · 쓰기 · 전체/국가/개인/외교 4칸
```

전용 화면은 원작처럼 위에 `군략도로` 단추와 제목을 둔다. 지금 주소는 그대로 쓰고 새 화면만 주소를 더한다.

| 화면 | 주소 | 옮겨 오는 것 |
| --- | --- | --- |
| 현재 도시 | `/w/:id/city/:cityKey` (기존) | 주둔 장수 표, 도시 금·쌀·수비병과 부곡 배속, 도시 관직 |
| 물류 | `/w/:id/city/:cityKey/logistics` (새) | `LogisticsPanel` |
| 세력 정보 | `/w/:id/nation/:nationId` (기존) | 국가 요약, 국가 기록(월별 수치), 공지 |
| 세력 장수 | `/w/:id/nation/generals` (새) | 소속 장수 표 (얼굴·능력치·병력·예턴, 찾기·정렬) |
| 세력 도시 | `/w/:id/nation/cities` (새) | 소속 도시 표 (수치·부족분) |
| 통치 | `/w/:id/nation/governance` (새) | `GovernancePanel` |
| 휘하·부곡 | `/w/:id/campaign` (새) | `CampaignPanel` |
| 장수 지시 | `/w/:id/campaign/orders` (새) | `RetinueOrdersPanel` |
| 내 정보 | `/w/:id/me` (새) | 장수 상세 portrait, 장비, 가계 |
| 세력 일람 | `/w/:id/ranking?tab=nations` (기존) | 중원 정세의 월별 세력 크기 목록을 함께 |

### 인자 입력

`turns/CommandPicker.tsx`의 인자 칸을 새 부품 `turns/CommandArgsScreen.tsx`로 옮긴다. 인자가 없는 명령은 지금처럼 바로 넣는다.

- 띄우기: `role="dialog" aria-modal`의 전체 화면. 주소는 바꾸지 않는다. 뒤로 가기·Esc·`명령 취소`로 닫고 `명령 다시 고르기`로 카드 목록에 돌아간다. 초안(`useTurnDraft`)은 편집기 상태에 그대로 두고 넣기만 이 화면에서 한다.
- 위 띠: 명령 취소 · 명령 다시 고르기 · 명령 이름 · `N번 칸 · 실행 시기` · 대상 찾기.
- 안내 줄: 명령 설명·비용·내 금·쌀. 설명과 비용은 `commands.list`가 아직 주지 않으므로 INT-26의 응답 추가를 기다린다. 그 전에는 줄을 비운다.
- 도시·국가 대상: 왼쪽 60%에 운영 지도(`OperationalWorldMap`)를 고르기 모드로 띄운다. 현재 도시와 고른 도시를 표시하고 고를 수 있는 도시에 거리 숫자를 얹는다. 오른쪽에 거리 묶음 목록(1칸·2칸·3칸…)을 둔다. 거리는 `world.map`의 `links`로 화면에서 센다. 아국 도시는 대상이 아닌 것으로 따로 보인다. 기본값을 내 도시로 두지 않고 고르기 전에는 넣기를 막는다.
- 장수 대상: 이름 입력 대신 장수 목록(얼굴 icon·소속·능력치·병력)에서 고른다. 번호 입력은 없앤다.
- 병종·수량: 병종 표(공격·방어·기동·회피·100명당 금·쌀·모집 가능 여부와 사유)와 수량 입력, `절반`·`채우기`·`가득`, 계산 결과.
- 아래 띠: 고른 값 요약과 `N번 칸에 넣기` 하나.
- 375px: 같은 화면을 세로로 쌓고 아래 띠를 고정한다.

### 초상과 이름

- `portrait/Portrait.tsx`에 `shape="round"`를 더해 icon을 원형으로 쓸 수 있게 한다. 메인 장수 칸은 portrait, 목록·고르기·요약은 원형 icon, 28px 행 표는 thumb을 20×28로 줄여 쓴다.
- 공개 빌드도 초상을 보인다. `portraitUrl.ts`의 공개 모드 분기, `vite.config.ts`의 `assertNoPublicImageBase`, 공개 자산 검사(`tools/public-assets`)와 D-031·T3-13·AC-M3-06 기록을 함께 고친다. 이 변경은 별도 PR로 한다.
- 장수 이름 표시는 `game/names.ts`에 `displayName()` 하나를 두고 모든 화면이 쓴다. 괄호와 그 안을 뺀다. 같은 화면에서 이름이 겹치면 괄호를 그대로 둔다.

### 로비의 내 장수

사용자가 2026-11-13 정했다. 로비 월드 카드의 내 장수도 얼굴과 정보를 보인다. 화면은 원형 icon(64px), 이름, 국가 이름표, 관직, 도시, 능력치를 그린다. 지금 `lobby.list`의 `myGeneral`은 `id`·`name`·`nationName`뿐이라 얼굴은 실루엣과 첫 글자로, 나머지 칸은 비워 둔다. Codex에 아래 응답 추가를 요청한다(값은 내 장수 본인 것이라 공개 범위 문제가 없다).

```ts
myGeneral: {
  id: number; name: string; nationName: string | null;
  portraitId: number | null; nationColor: string | null;
  officerTitle: string; cityName: string;
  stats: { leadership: number; strength: number; intel: number; politics?: number; charm?: number };
} | null
```

### 모바일

375px 메인은 하단 막대(지도 · 예턴 · 현황 · 기록 · 메시지 · 메뉴)로 패널을 하나씩 바꾼다. 예턴 칸 행은 44px, 첫 화면 12칸 이상.

### PR 나누기

| PR | 범위 | 기다리는 것 |
| --- | --- | --- |
| 1 | 인자 입력 화면 (도시·국가·장수·병종·수량·문자·색) | 없음 |
| 2 | 위 띠·공통 메뉴 띠, 메인 재배치, 전용 화면 9개 이동 | PR 1 |
| 3 | 원작 정보 중 서버가 이미 주는 값의 표시(대조 100건), 기록 3칸 틀, 관직·도시 관직 자리 | PR 2 |
| 4 | 초상 형태와 공개 빌드 초상, 이름 괄호 | PR 2 |
| 5 | 375px 하단 막대 | PR 2 |
| 6 | INT-26이 더한 값 채우기 | INT-26 |

### 깨질 수 있는 것

- 지금 배치를 굳힌 E2E: `main-sections.spec.ts`, `t4-97-game-ui.spec.ts`, `mobile-controls.spec.ts`, `mobile-map-targets.spec.ts`, `mobile-tables.spec.ts`, `command-cards.spec.ts`, `turns.spec.ts`, `routes.spec.ts`, `int19-retinue-orders.spec.ts`, `t4-93-logistics.spec.ts`, `t4-94-governance.spec.ts`, `t4-95-lineage.spec.ts`. 같은 PR에서 새 배치로 고친다. 접근성 이름과 test id는 되도록 유지한다.
- 열린 Codex PR 30여 개가 같은 화면 파일을 고친다. PR 2는 병합 순서를 Codex와 맞춘다.
- 레일을 없애면 `GameNavigation` 기반 E2E의 메뉴 찾기가 바뀐다. 메뉴 이름은 지금 이름을 유지한다.

### 검증

`pnpm check`, 기존 실제 Chromium E2E 전체, 인자 입력 새 E2E(도시·국가·장수·병종 각 1건의 실제 저장), 375/768/1440px와 라이트/다크 화면, 글자 대비 4.5:1. 메인 높이와 예턴 첫 화면 칸 수는 E2E에서 숫자로 잰다.
