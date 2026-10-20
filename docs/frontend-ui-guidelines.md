# UI 지침

> 상태: 초안 (T1-13) · 레퍼런스: [design/references](./design/references/README.md) · 관련 결정: D-007 · 관련 AC: M1-19, M3-08
> 참고: core2026 `frontend-css-architecture.md`, `frontend-typography.md`, `frontend-page-navigation.md` (셋을 합침)

## 1. 방향: 원작 정보량 + 모던 정리

1. 한 화면에 내 장수·도시·국가·다음 턴 시각이 다 보입니다.
2. 숫자는 오른쪽 정렬, 고정폭 숫자(`font-variant-numeric: tabular-nums`). 변화량은 색과 부호를 함께 씁니다.
3. 국가색은 지도와 국가 이름표에만 씁니다. 성공·실패·경고 색은 따로 고정합니다.
4. 표는 촘촘하되 행 간격·구분선·고정 머리글로 읽기 쉽게 합니다.
5. 색만으로 의미를 전하지 않습니다 (NFR-08).

### 이전 시도(v1)에서 가져온 원칙

출처: [아이디어 수집 A절](./product/idea-harvest.md#a-이전-시도-opensamguk-v1-2026-05--10)

- 못 쓰는 버튼은 숨기지 않고 점선 테두리로 두며, 누르면 이유를 보여 줍니다. 가능 여부는 서버가 정합니다.
- 빈 목록과 불러오기 실패를 다르게 보여 줍니다.
- 턴 시각은 서버가 준 값만 보여 줍니다. 정지 뒤 밀린 턴을 따라잡을 때는 배속과 예상 시간을 띄웁니다.
- 게시 공간은 공개 커뮤니티, 국가 회의실, 기밀실(누가 읽었는지 기록)로 나눕니다 (M2 메시지 설계 때 검토).

## 2. 핵심 화면 6개 (M1)

| 화면       | 꼭 보여야 하는 것 |
| ---------- | ----------------- |
| 메인       | 장수 요약, 현재 도시, 소속 국가, 다음 턴 시각, 예턴 앞 5칸, 최근 로그 |
| 지도       | 94도시, 소유국 색, 연결선, 보급 끊김, 내 위치 |
| 예턴 편집  | 30칸, 여러 칸 선택, 명령·인자 입력, 사전 검사 경고, 저장 충돌 안내 |
| 도시 정보  | 수치와 최대치, 주둔 장수(공개 범위 내) |
| 국가 정보  | 국고·군량·세율·기술, 소속 장수, 소유 도시 |
| 기록       | 장수 로그, 국가 역사, 월드 정세 |

## 3. 글자와 색

기준 파일: `apps/web/src/styles/tokens.css`. 화면 코드에 색·크기 값을 직접 쓰지 않고 토큰을 씁니다.

| 종류 | 토큰 |
| ---- | ---- |
| 글꼴 | `--font-sans` = Pretendard Variable (npm `pretendard`, 자체 호스팅). 숫자는 `.num` 클래스(고정폭·오른쪽 정렬) |
| 글자 크기 | `--text-xs` 12 · `sm` 13 · `md` 14(본문) · `lg` 16 · `xl` 20 · `2xl` 24 |
| 간격 | `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `6` 24 · `8` 32 |
| 표 | `--row-height` 28px |
| 바탕·글자 | `--color-bg`, `--color-surface`, `--color-surface-muted`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-border-strong` |
| 강조 | `--color-accent`, `--color-accent-text` |
| 상태 | `--color-success`, `--color-danger`, `--color-warning`, `--color-info` |

- 국가색은 토큰이 아니라 데이터에서 옵니다. 그 위 글자색은 `readableTextColor()`가 대비로 고릅니다.
- 다크 모드는 같은 토큰 이름을 `prefers-color-scheme: dark`에서 바꿉니다. 다듬기는 M3(T3-10).
- 공통 부품: `StatTable`, `ValueDelta`, `NationBadge`, `EmptyState`/`ErrorState`, `DisabledReason`. 개발 모드에서 `/dev/ui`로 상태별 모습을 봅니다.

## 4. 화면 이동

라우터: TanStack Router (코드 기반, `apps/web/src/router.tsx`). 모든 주소는 직접 접근·새로고침이 됩니다 (`e2e/routes.spec.ts`).

| 주소 | 화면 |
| ---- | ---- |
| `/login`, `/signup` | 로그인, 가입 |
| `/w/:worldId` | 메인 |
| `/w/:worldId/map` | 지도 |
| `/w/:worldId/turns` | 예턴 편집 |
| `/w/:worldId/city/:cityKey` | 도시 정보 |
| `/w/:worldId/nation/:nationId` | 국가 정보 |
| `/w/:worldId/records?tab=general\|nation\|world` | 기록 |
| `/w/:worldId/create` | 장수 생성 |
| `/dev/ui` | 부품 모음 (개발 모드만) |

- 로그인 안 됨 → `/login?next=…`, 장수 없음 → `/w/:worldId/create` (T1-14·T1-15에서 연결).
- 데이터는 TanStack Query + `@trpc/tanstack-react-query`의 `useTRPC()`로 가져옵니다.

## 5. 반응형 (M3)

375px 폭에서 가로 스크롤 없이, 누르는 대상 44px 이상 (AC-M3-08).

<!-- TODO(M3): 좁은 화면에서 메인 화면 정보의 접는 순서. -->
