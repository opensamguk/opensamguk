# SAN10 지도 조사와 레벨 배치 초안

이 폴더는 사용자가 제공한 SAN10MAP.png의 이름·대략적 픽셀 위치·길과 나루 연결을 조사한 배치 데이터다. 원본 표기는 艾克氏電玩特攻, xgodgame.blogspot.com, 2015/11/1이며 이미지 SHA-256은 `742991a74a40db25f7ca4638900c4ec4e260e4189c13abc0219b439246a5fb03`이다. 원본 그림은 저장소와 공개 빌드에 포함하지 않는다. 이 고지는 원본 그림의 이용 허가를 뜻하지 않는다.

레벨은 이 저장소의 `resources/map/integration.json`과 `resources/map/che.json`의 게임 편성을 참고한 첫 제안이다. 원본 데이터는 core2026 `df6c926`의 devsam MIT 자료와 이 저장소의 통합판 편성에서 파생했다. 해당 MIT 원문은 [상위 자원 고지](../../NOTICE.md)에 보존되어 있다. 레벨은 역사 도시 규모의 조사값이 아니다.

연결 2구간의 포함과 2구간의 제외, 공터 61곳을 전략 거점으로 다룬다는 선택은 2026-10-29 사용자 검토에 따른다. 상세 기준과 실제 교체 전 필요한 작업은 [배치 문서](../../../docs/plans/san10-map-placement.md)에 기록한다.

같은 날 요청한 강·오환·남만·산월·선비·흉노·저는 원본 지도에 없는 추가 배치다. 6곳의 4레벨은 기존 che 자원에서 가져오고 선비의 4레벨과 7곳의 좌표·14연결은 게임 배치 제안으로 기록한다.

한반도 지도 2장의 성읍·집단 분포와 일본 게임 지도는 사용자 첨부 참고 자료이며 그림 원본은 포함하지 않는다. 왜 소국의 이름·현대 위치 대응은 규슈대학교 종합연구박물관, 후쿠오카시박물관, 요시노가리 역사공원 자료를 참고했다. 웹페이지와 그림을 복제하지 않았으며 URL·확인일·사실 요약만 `east-asia-reference.json`에 기록한다.

`east-asia-selection.json`은 위 참고 자료에서 고른 이름·대표 권역과 작업 기준을 저장한다. 추가 출처는 무나카타시 박물관, 우미정, 에히메현, 가가와현립박물관, 국사편찬위원회 우리역사넷, 한국학중앙연구원 한국민족문화대백과사전이다. 출처 URL과 확인일은 각 JSON의 sources에 남긴다. 논쟁 중인 위치설의 채택과 지역 대표 명명은 게임 선정이며 원문이나 지도를 복제하지 않았다.

`coordinate-placement.json`과 `coordinate-sites.csv`는 현재 통합판 좌표계의 추가 배치 초안이다. 현대 지역 중심점 일부는 Natural Earth v5.1.2의 `ne_10m_populated_places.geojson`을 참고했다. 나머지는 선정 권역 안의 대표점 제안이다. `coordinate-basemap.geojson`은 같은 판의 `ne_10m_land.geojson`을 동경 94~138도·북위 17~46도로 자르고 0.012도 허용 오차로 단순화한 육지 자료다. Natural Earth 자료는 Public domain이며 출처 URL과 원본·파생 해시는 배치 JSON에 기록한다. 현재 운영 지도의 원본 출처·고지는 변경하지 않는다.

`merged-placement.json`과 두 merged CSV는 위 자료와 현재 통합판 80표식의 대응을 합친 초안이다. 기존 80좌표와 SAN10 판독 연결을 보존하고 중국 공터 46곳의 대표 게임 좌표를 제안했다. 대표 권역을 검토한 지방사·도시계획 자료의 URL은 JSON과 배치 문서에 남긴다. 웹 문장이나 지도 그림은 복제하지 않았다. 재생성 도구는 `tools/map-data/build-san10-merged.py`다.

`adopted-placement.json`과 `adopted-sites.csv`는 사용자가 채택한 159표식을 1400×1000으로 옮긴 배치 정본이다. `adopted-basemap.geojson`은 같은 Natural Earth v5.1.2 육지를 동경 94~148도·북위 15.457~54.029도로 자르고 0.012도 허용 오차로 단순화했다. Public domain이며 원본 URL·해시와 파생 파일 해시는 채택 JSON에 남긴다. 재생성 도구는 `tools/map-data/build-san10-expanded.py`다. 지리적 위치를 유지한 좌표 평행이동이며 새 고대 지명이나 국가 경계를 추정하지 않았다.

2026-10-30 D-045의 실행 파생물은 `resources/map/san10.json`, `resources/scenario/san10-191.json`, `resources/scenario/san10-empty.json`, `resources/san10-manifest.json`이다. 역사 인물·국가·능력치의 원본과 MIT 고지는 상위 고지와 기존 191년 검수 원장을 따른다. 공백지판은 같은 인물의 소속과 국가·외교를 비운 게임 편성이다. 45제안의 도로 활성화는 사용자 결정이며 역사 도로의 실재를 뜻하지 않는다.

`apps/web/src/main/san10-basemap.json`은 위 육지를 같은 투영의 SVG 경로로 변환한 Public domain 파생물이다. `build-san10-basemap.py`는 입력 해시를 검사하고 `build-san10-resources.ts`가 화면 묶음의 바이트 해시를 지도·게시 명세에 고정한다. 이 새 범위에는 기존 지형 음영 그림을 늘여 쓰지 않는다. 옛 GIS와 게시 판은 보존한다.
