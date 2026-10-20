# 이미지 자산

> 상태: 초안 · 필요 시점: M1 (ID 규칙), M3 (라이선스 관문) · 관련 결정: D-004
> 관련 요구사항: FR-IMG-01~04 · 관련 AC: M1-20, **M3-06**

## 1. 승계하는 저장소

[peppone-choi/opensamguk-images](https://github.com/peppone-choi/opensamguk-images) 하나만 승계합니다.
2026-10-20 조사 기준 약 10,000개 파일, 471MB입니다. 현재는 jsDelivr
(`cdn.jsdelivr.net/gh/peppone-choi/opensamguk-images/...`)로 제공됩니다.

## 2. 초상 ID 규칙

- 초상 ID는 **10001~11000**입니다. 게임 데이터는 이 숫자만 저장합니다 (FR-IMG-01).
- `portraits/rtk14/officer-id-registry.tsv`가 ID ↔ 한자 이름 ↔ 읽기 ↔ 원본 파일을 잇습니다.
- 경로: `portraits/rtk14/serving/{portrait,icon,original,thumb}/<id>.{png,webp,jpg}`

| 변형       | 형식        | 크기     |
| ---------- | ----------- | -------- |
| portrait   | PNG         | 148×210  |
| icon       | PNG, WebP   | 96×96    |
| thumb      | WebP        | 48×68    |
| original   | JPG         | 633×900  |

- 초상 URL = `VITE_IMAGE_BASE_URL` + 변형 + ID입니다. base URL만 바꾸면 전부 교체됩니다 (FR-IMG-02).
- 고정 URL이 필요하면 저장소 태그(`@vYYYY.MM.DD`)를 base URL에 넣습니다.
- 파일이 없으면 기본 이미지를 보여 줍니다 (FR-IMG-03).

### 시나리오 이름 대응 (T1-19)

- 생성물: `resources/portraits/rtk14-map.json`. `portraits`에 한글 이름 → 숫자 ID를 저장한다.
- 재생성: `pnpm portraits:map`. 고정된 registry·한자 독음 스냅샷과 출처는 `tools/portrait-map/` 및 `resources/NOTICE.md`에 있다. 실행 중 네트워크를 쓰지 않는다.
- 시나리오 1030의 **491명 중 429명 (87.37%)**이 대응된다. 목표 80% 이상을 통과했다.
- 동명이인 12명·미대응 50명은 null로 남기며, 생성물의 `ambiguous`·`unmatched`에 기록한다. 생몰년이 없는 registry만으로는 후보를 구분하지 않는다. 수동 대응에는 registry ID와 구분 근거를 요구한다. 동명이인은 후보 안에서만 선택한다.
- **후속 보완 (2026-10-20 사용자 요청):** 동명이인 12명과 미대응 50명은 나중에 추가·수정한다. 확인한 결과는 `tools/portrait-map/manual.json`의 `matches`에 `{ id, reason }`으로 넣고 재생성한다. 미대응 이름은 번호 별칭 등도 registry ID로 직접 연결할 수 있다. 수동 표는 재생성해도 유지된다.
- 새 월드를 생성할 때만 적용한다. 기존 월드의 ID를 덮어쓰지 않는다. 화면의 URL·기본 이미지 해석은 T1-17 담당이다.

## 3. 라이선스 구분 ⚠️ 공개 전 관문

| 경로                   | 내용                                     | 라이선스 상태 |
| ---------------------- | ---------------------------------------- | ------------- |
| `portraits/`           | 초상 1,000명 (약 376MB)                  | **위험.** 코에이 「삼국지14」 그림, wikiwiki.jp에서 수집 |
| `waryong/`             | 지도·전투 타일 404개                     | **위험.** 「제갈공명 와룡전」(1995)에서 추출, 권리자 불명 |
| `assets/`              | UI 아이콘 73개, 빈 상태 그림, 로고 원본 | MIT |
| `web/`                 | 앱용 아이콘·상태 이미지·파비콘          | MIT |
| `exports/stratagem-cards/` | 계략 카드 32장                       | MIT |
| `portraits-original/han-archetypes/` | 직접 만든 초상 37장        | MIT |

이미지 저장소의 `.license-boundaries.json`은 위험 경로를 "소유자가 위험을 떠안음"으로 분류합니다.

**결정 규칙 (D-004):** 개발과 비공개 테스트(M1·M2)는 기존 초상을 씁니다. 공개(M3) 전에 다음 중 하나를
결정 기록에 남기고 AC-M3-06을 통과해야 합니다.

1. 공개 빌드에서 위험 경로를 쓰지 않는다 (자체 초상·기본 이미지로 교체)
2. 위험을 알고 그대로 쓴다 (운영자 책임 명시)
3. 그 밖의 방법 (권리 확인 등)

장수 능력치 데이터의 출처도 같은 관문에서 확인합니다 (A8).

## 4. 지난 기록

- 원작 이미지 풀 `icons/<n>.jpg`(2,335장)는 2026-08-17 이력 정리로 삭제되어 해당 URL은 404입니다.
- 도시 아이콘과 아이소메트릭 자산은 2026-10-18에 삭제되었습니다.
