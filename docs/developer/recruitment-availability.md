# 모집 조건 응답

> AC-INT-22 · 서버 계약 구현 중 · 프론트 연결·병합 대기

`campaign.get`, `cityResources.get`, `logistics.get`, `resources.worldRules`는 조건이 있는 병종 판에서 서버 세션 장수의 모집 조건을 계산한다. 기존 병종 목록·ID·정본 `unitSet`은 유지하고 다음 선택 키를 더한다.

```ts
recruitment?: {
  tick: number;
  byCrewType: Record<string, { code: 'BAD_STATE'; message: string } | null>;
};
```

`tick`은 같은 읽기 트랜잭션의 저장된 월드 시각이다. `byCrewType`은 성벽을 뺀 모든 병종 ID를 문자열 키로 쓴다. 값이 `null`이면 병종 모집 조건을 만족한다. 실패 객체면 `message`가 처음 막힌 이유다. 기술·州·거점·규모·연도·연구·초토화·수뇌·모집 불가 조건의 순서와 문구는 순수 규칙 `crewContext`·`crewTypeFailure`를 그대로 쓴다.

금·쌀·철·말·인구·병력 수량·보급·권한의 최종 검사는 포함하지 않는다. 선택한 명령은 기존 `turns.precheck`로 확인하고 엔진에서 다시 판정한다. 모집 조건을 잃어도 기존 병력의 배속·이동·훈련을 막지 않는다.

조건 없는 기존 판에는 키를 넣지 않는다. `resources.worldRules`는 장수가 없는 관람자에게도 기존 공통 규칙을 내려주고 개인 모집 조건만 생략한다. 나머지 세 조회는 기존 장수 존재·권한 검사를 유지한다. 도시·물류 응답은 기존 비공개 도시 분기에서 키를 내리지 않는다. 장수·국가 ID를 입력받는 새 필드는 없으며 기존 입력·인증 오류는 그대로다.

예를 들어 기술1000이 필요한 병종1101은 `byCrewType['1101']`에 `BAD_STATE`와 기술 요구 문구를 내린다. 프론트는 사유를 표시하되 같은 조건을 다시 계산하지 않는다. 키가 없는 판에서 병종 전체를 비활성화해서도 안 된다.

검증은 `tools/int22-recruitment-api.integration.test.ts`의 실제 PG·HTTP 응답과 기존 공통 규칙 조회·도시 자원·물류 시험으로 한다. UI의 실제 Chromium·375px 배치 검증은 별도다.
