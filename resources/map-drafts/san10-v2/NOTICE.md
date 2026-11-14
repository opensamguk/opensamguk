# 새 지도·시나리오 초안 출처

이 폴더는 [SCN-01](../../../docs/plans/SCN-01.md)의 구현 전 검토 자료다. 게임 런타임과 월드 생성은 이 폴더를 읽지 않는다. 생성 방법도 SCN-01에 적었다.

**이 자료는 공개 전 권리 관문(AC-M3-06)을 통과하지 않았다.** 사용자가 2026-11-08 모드 추출본까지 저장소에 넣도록 정했고 2026-11-14 고친 판도 넣도록 정했다. 게임에 적용하기 전에 아래 권리를 다시 확인해야 한다.

## 모드에서 옮긴 자료

`data/hsg-*.json`과 `data/bios-all.json`은 로컬 모드 폴더 「후삼국지 삼국지편」의 `N24001~30.S6`와 `KOEICDA.DLL`에서 읽었다. 시나리오 제목과 연월, 인물 배치와 능력치, 도시 표와 설명, 인물 표, 열전 원문이 들어 있다. `data/roster-bio.json`도 열전 원문을 쓴다.

`data/mod-*.json`은 같은 폴더의 `N24001~30.S6`, `hsg_event_state/*.dat`, `SAM6.EXE`, `MIDLEMAP.S6`, `N244MID.S6`, `PALETTE.S6`에서 읽었다. 판별 도시 소유, 확장 인물의 배치와 능력치, 세력 사이 동맹과 적대 수치, 세력 칸별 색이 들어 있다.

- 모드 제작자와 이용 조건은 확인하지 못했다.
- 모드는 코에이의 삼국지 6 실행 파일(`SAM6.EXE`) 위에서 돈다. 능력치와 배치, 세력색은 코에이 원작에 기대고 있을 수 있다.
- 초상, 명승지 사진, 영상과 음악은 옮기지 않았다.

## 다른 출처

| 파일 | 출처 |
| --- | --- |
| `roster-merged.json` | [opensamguk-images](https://github.com/opensamguk/opensamguk-images)의 초상 ID 명단, [제타위키 삼국지 10 능력치 목록](https://zetawiki.com/wiki/%EC%82%BC%EA%B5%AD%EC%A7%80_10_%EB%8A%A5%EB%A0%A5%EC%B9%98_%EB%AA%A9%EB%A1%9D)의 생년·등장 연도, core2026의 생몰년 |
| `tools/map-data/san10-v2/build.mjs`의 입력 | [core2026](https://gitea.hided.net/devsam/core2026) `c81d304`의 시나리오 표본(MIT). 저장소에 넣지 않고 `CORE2026_DIR`로 읽는다 |
| 지도와 강 | 이 저장소의 `resources/map/san10.json`, Natural Earth(퍼블릭 도메인) 바탕 |
| 사서 인용 | 三國志, 後漢書, 資治通鑑, 晉書(퍼블릭 도메인). 외교 근거의 연의 항목은 三國演義 第五回 |
| 세력색 | [나무위키 삼국지 시리즈/상징색](https://namu.wiki/w/%EC%82%BC%EA%B5%AD%EC%A7%80%20%EC%8B%9C%EB%A6%AC%EC%A6%88/%EC%83%81%EC%A7%95%EC%83%89)(CC BY-NC-SA 2.0 KR)의 삼국지 14 등 색 값. `build.mjs`의 `NAMU_KEY`에 옮겼다. 원래 값은 코에이 게임의 색이다 |

## 이 작업에서 만든 자료

`data/ai/`는 모드 열전과 사서를 읽어 정리한 판독 결과다. 시나리오 정의와 설명, 지명 설명, 소속, 생몰년, 휘하 관계가 들어 있고 근거 칸이 `추정`이면 미검증이다. `data/stats-est.json`은 모드 능력치로 학습해 산정한 임시값이다. `data/zones*.json`은 거점 구역 계산 결과다. `data/data2.json`과 `data/draft2.json`은 이 자료들을 합친 생성물이다. 판별 외교 지정(`tools/map-data/san10-v2/diplomacy.mjs`)과 그 근거(`diplo-verify.mjs`)도 이 작업에서 썼고 근거가 `추정`이면 미검증이다.
