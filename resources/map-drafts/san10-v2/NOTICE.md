# 새 지도·시나리오 초안 출처

이 폴더는 [SCN-01](../../../docs/plans/SCN-01.md)의 구현 전 검토 자료다. 게임 런타임과 월드 생성은 이 폴더를 읽지 않는다. 생성 방법도 SCN-01에 적었다.

**이 자료는 공개 전 권리 관문(AC-M3-06)을 통과하지 않았다.** 사용자가 2026-11-08 모드 추출본까지 저장소에 넣도록 정했다. 게임에 적용하기 전에 아래 권리를 다시 확인해야 한다.

## 모드에서 옮긴 자료

`data/hsg-*.json`과 `data/bios-all.json`은 로컬 모드 폴더 「후삼국지 삼국지편」의 `N24001~30.S6`와 `KOEICDA.DLL`에서 읽었다. 시나리오 제목과 연월, 인물 배치와 능력치, 도시 표와 설명, 인물 표, 열전 원문이 들어 있다. `data/roster-bio.json`도 열전 원문을 쓴다.

- 모드 제작자와 이용 조건은 확인하지 못했다.
- 모드는 코에이테크모의 삼국지 10을 바탕으로 한다. 능력치와 배치는 원작에 기대고 있을 수 있다.
- 초상, 명승지 사진, 영상과 음악은 옮기지 않았다.

## 다른 출처

| 파일 | 출처 |
| --- | --- |
| `roster-merged.json` | [opensamguk-images](https://github.com/opensamguk/opensamguk-images)의 초상 ID 명단, [제타위키 삼국지 10 능력치 목록](https://zetawiki.com/wiki/%EC%82%BC%EA%B5%AD%EC%A7%80_10_%EB%8A%A5%EB%A0%A5%EC%B9%98_%EB%AA%A9%EB%A1%9D)의 생년·등장 연도, core2026의 생몰년 |
| `tools/map-data/san10-v2/build.mjs`의 입력 | [core2026](https://gitea.hided.net/devsam/core2026) `c81d304`의 시나리오 표본(MIT). 저장소에 넣지 않고 `CORE2026_DIR`로 읽는다 |
| 지도와 강 | 이 저장소의 `resources/map/san10.json`, Natural Earth(퍼블릭 도메인) 바탕 |
| 사서 인용 | 三國志, 後漢書, 資治通鑑(퍼블릭 도메인) |

## 이 작업에서 만든 자료

`data/ai/`는 모드 열전과 사서를 읽어 정리한 판독 결과다. 시나리오 정의와 설명, 지명 설명, 소속, 생몰년, 휘하 관계가 들어 있고 근거 칸이 `추정`이면 미검증이다. `data/stats-est.json`은 모드 능력치로 학습해 산정한 임시값이다. `data/zones*.json`은 거점 구역 계산 결과다. `data/data2.json`과 `data/draft2.json`은 이 자료들을 합친 생성물이다.
