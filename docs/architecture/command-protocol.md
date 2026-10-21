# 명령 프로토콜

> 상태: M1 구현 · 관련 AC: M1-09, M1-14~16
> 참고: core2026 `docs/architecture/action-module-protocol.md`, `docs/developer/domain-and-classes.md`
> 이 문서가 답할 질문: 명령 하나를 어떻게 정의하고, 검사하고, 실행하고, 기록하나?

## 1. 명령 하나가 가진 것

| 항목       | 설명                                                    |
| ---------- | ------------------------------------------------------- |
| key        | 고유 이름 (예: `farm`, `recruit`, `attack`)             |
| 표시 이름  | 화면용 (예: 농지 개간)                                  |
| 대상       | 장수 명령 또는 국가 명령                                |
| 인자       | zod schema (예: 대상 도시, 병종, 수량)                  |
| 사전 검사  | 예턴에 넣을 때 쓰는 조건. 경고만 한다                   |
| 실행 검사  | 실행 순간의 조건. 실패하면 실패 이유를 남긴다           |
| 실행       | 상태 변경 묶음과 로그를 돌려준다. 직접 저장하지 않는다  |

## 2. 실행 흐름

```text
예턴 1칸 꺼냄 ─▶ 인자 파싱 ─▶ 실행 검사 ─┬─ 실패: 실패 로그, 상태 변경 없음
                                         └─ 성공: 실행 ─▶ 상태 변경 묶음 + 로그 + RNG 소비
                                                         ─▶ engine이 한 트랜잭션으로 저장
```

## 3. core2026에서 줄인 것

- 특기·관직·병종·장비 효과를 겹쳐 계산하는 action module 스택은 MVP에서 만들지 않습니다.
  병종 상성과 기술 보정만 둡니다. 특기·장비는 Phase 2에서 이 문서에 효과 계산 단계를 추가합니다.
- 원작과 RNG 소비 순서를 맞추지 않습니다. 대신 **우리 자신의** RNG 소비 순서는 바꾸지 않습니다
  (재생 테스트 AC-M1-13이 깨지기 때문).

## 4. 명령 목록

PRD [§6.3](../product/prd.md#63-mvp-명령-세트)의 37개입니다. `commands/registry.ts`가 key와 target을 소유합니다. category는 target에서 유도하지 않습니다. 아래 표의 기존 9개 category 필드는 T1-11에서 붙이며 T1-08은 신규 28개 값을 명시합니다. `commands.list`는 general 27개만 노출합니다. nation 10개는 별도 국가 예턴에서 실행합니다.

| key | 표시 이름 | target | category | 인자 |
| --- | --- | --- | --- | --- |
| farm | 농지 개간 | general | domestic | {} |
| commerce | 상업 투자 | general | domestic | {} |
| security | 치안 강화 | general | domestic | {} |
| settle | 정착 장려 | general | domestic | {} |
| goodwill | 주민 선정 | general | domestic | {} |
| defence | 수비 강화 | general | domestic | {} |
| wall | 성벽 보수 | general | domestic | {} |
| research | 기술 연구 | general | domestic | {} |
| rest | 휴식 | general | personal | {} |
| recruit | 모병 | general | military | amount, crewType |
| conscript | 징병 | general | military | amount, crewType |
| train | 훈련 | general | military | {} |
| morale | 사기진작 | general | military | {} |
| attack | 출병 | general | military | cityKey |
| move | 이동 | general | military | cityKey |
| return | 귀환 | general | military | {} |
| dismiss | 소집해제 | general | military | {} |
| join | 임관 | general | strategy | nationId |
| join_random | 무작위 임관 | general | strategy | {} |
| found | 건국 | general | strategy | name, color |
| uprising | 거병 | general | strategy | name, color |
| resign | 하야 | general | strategy | {} |
| invite | 등용 | general | strategy | generalId |
| accept_invite | 등용 수락 | general | strategy | {} |
| heal | 요양 | general | personal | {} |
| trade_rice | 군량매매 | general | personal | amount, buy |
| donate | 헌납 | general | personal | resource, amount |
| nation_rest | 휴식 | nation | nation | {} |
| nation_reward | 포상 | nation | nation | generalId, resource, amount |
| nation_seize | 몰수 | nation | nation | generalId, resource, amount |
| nation_assign | 발령 | nation | nation | generalId, cityKey |
| nation_capital | 천도 | nation | nation | cityKey |
| nation_declare | 선전포고 | nation | nation | nationId |
| nation_peace | 종전 제의 | nation | nation | nationId |
| nation_pact | 불가침 제의 | nation | nation | nationId |
| nation_break_pact | 불가침 파기 제의 | nation | nation | nationId |
| nation_aid | 원조 | nation | nation | nationId, resource, amount |

ID와 amount는 1~1,000,000 정수입니다. resource는 gold 또는 rice이며 buy는 boolean입니다. 국명은 trim 후 1~30자이고 color는 #RRGGBB입니다. 정의한 필드 밖의 인자는 거부합니다. 같은 key를 다른 target에 넣으면 BAD_ARGS입니다.

| 실패 코드 | 조건 |
| --- | --- |
| NO_ACTOR | 실행 장수 없음 |
| NOT_NATION | 소속 국가 없음 |
| NOT_OWN_CITY | 자기 국가 도시 조건 불충족 |
| NO_SUPPLY | 출발·모집·내정 도시 보급 단절 |
| NO_GOLD, NO_RICE | 비용·이전 자원 부족 |
| AT_MAX | 능력·도시·병력 상한 |
| BAD_ARGS | 인자 파싱 실패 또는 target 불일치 |
| UNKNOWN_COMMAND | 레지스트리에 없는 key |
| NO_CREW | 병력·공격 사기 부족 |
| NOT_RULER | 국가 명령·등용을 비군주가 실행 |
| BAD_TARGET | 대상 국가·도시·장수 조건 불충족 |
| NOT_ADJACENT | 출병·이동 도시가 연결되지 않음 |
| NOT_WAR | 출병·종전 대상과 교전하지 않음 |
| BAD_STATE | 기존 소속·외교·수도·병종과 충돌 |
| NO_POPULATION | 모집할 도시 인구 부족 |
| NO_OFFER | 수락할 유효 등용 제안 없음 |
| NO_UNIT_SET | 모집·교전 병종 리소스 없음 |

실패는 Effect가 없으며 예턴을 소비하고 이유를 기록합니다. `registry.test.ts`는 37개 key와 행동 검사 목록을 대조합니다. 파일을 읽는 검사는 rules의 I/O 금지를 지키도록 `tools/command-coverage.test.ts`에 둡니다. 각 key 파일의 성공·실패 검사는 `contracts.ts`의 상태 변화·비용·실패 코드를 실제 실행해 확인합니다.

### 국가 예턴과 M1 처리

`NationTurn`은 국가별 30칸입니다. 턴 시작 시 officerLevel 12인 군주만 국가 1칸을 먼저 실행하고 장수 1칸을 재검사해 실행합니다. 다른 장수는 국가 예턴을 소비하지 않습니다. 빈 국가 칸은 nation_rest입니다. 명령 실패도 한 칸 당기며 장수·국가 효과와 로그·revision·sequence·시계는 기존 리스 펜싱을 유지한 한 트랜잭션에서 저장합니다. 국가 예턴 API는 이 작업에서 만들지 않습니다.

모집은 인구를 병력으로 옮기고 병종 비용을 지불합니다. 징병은 비용 절반과 민심 5 손실을 적용합니다. 훈련·사기는 금 100으로 10 올립니다. 이동은 연결된 자국·빈 도시만 허용하며 재야는 어느 연결 도시나 이동합니다. 귀환은 수도로 즉시 이동합니다. 소집해제는 병력·훈련·사기를 0으로 만들고 자기 도시 인구를 상한까지 돌려줍니다. 임관과 등용 수락은 수도로 이동합니다. 군주는 하야하지 못합니다. 빈 도시의 재야 장수는 금 1,000으로 건국하며 거병에는 병력도 필요합니다. 새 국가 ID는 commandMeta의 증가값으로 정해 멸망한 ID를 재사용하지 않습니다. 등용 제안은 대상 장수별 마지막 한 건만 보관하고 소속 변경·멸망 때 무효화합니다.

요양은 금 100으로 부상 10을 줄입니다. 군량매매는 M1에서 금·쌀 1:1이고 헌납·포상·몰수·원조는 같은 자원을 같은 양만큼 이전합니다. 헌납 수량만큼 공헌을 더합니다. 발령은 자국 장수를 자국 도시로 즉시 옮기며 천도는 보급 표시를 즉시 갱신합니다. 선전포고는 한 달 뒤 교전으로 바뀝니다. NPC 국가는 종전·불가침·원조를 즉시 수락하고 불가침 파기는 거절합니다. 불가침은 12개월입니다. 사람 국가에는 제안만 국가 역사에 기록하며 자원·외교를 바꾸지 않습니다. 사람 간 응답과 조약은 M2에서 만듭니다.

### 교전과 저장

연결된 교전 상대 도시나 빈 도시에 출병합니다. 병력·훈련·사기 기준을 넘긴 등장 장수가 병력 내림차순·ID 오름차순으로 수비하고 마지막에 성벽 병종 1000과 싸웁니다. 교전마다 군량을 소비하며 쌀이 0이면 사기가 30 떨어집니다. 한 교전은 최대 10페이즈입니다. 양쪽 피해는 페이즈 시작 상태로 계산해 동시에 적용합니다. 병력이나 사기가 0이면 교전을 끝내고 수비가 남으면 성벽으로 넘어가지 않습니다.

성벽이 0이고 공격 병력·사기가 남으면 점령합니다. 소유권과 공격 장수 위치를 바꾸며 수비는 0, 치안은 절반, 민심은 20 낮춥니다. 마지막 도시를 잃은 국가는 삭제하고 장수 전원을 재야로 바꾸며 국가 예턴·외교·등용 제안을 지웁니다. 수도만 잃은 국가는 자동 천도하지 않습니다. 보급 표시는 소유권 변경 직후 갱신하고 월간 손해는 정산 때만 적용합니다.

공격 기록은 GeneralLog, 수비 기록은 BattleLog에 둡니다. 수비 장수가 같은 tick에 자기 턴을 실행해도 기존 GeneralLog 유일성을 깨지 않습니다. 국가 역사는 같은 tick의 여러 사건을 events 배열에 덧붙입니다. 멸망은 국가 역사에 남고 다음 월간 연감에는 그 국가가 빠집니다. NationTurn·commandMeta도 생성 기록과 재생 상태 해시에 포함합니다. InputEvent의 기존 turns.set·general.create 계약은 바꾸지 않았습니다.

## T1-05 명령 정의와 결과

`commands/types.ts`의 CommandDef는 key·표시 이름·대상·zod 인자·precheck·check·execute를 가집니다. `runCommand()`가 입력과 실행 조건을 검사한 뒤 Effect와 로그를 반환하며, `applyEffects()`가 원본을 변경하지 않고 복사본에 적용합니다.

실패 코드: NO_ACTOR, NOT_NATION, NOT_OWN_CITY, NO_SUPPLY, NO_GOLD, AT_MAX, BAD_ARGS, UNKNOWN_COMMAND. 실패에는 설명이 있고 Effect가 없습니다.

내정은 능력치×민심×난수 점수에 치명·전선 보정을 적용합니다. 정착 장려는 인구에 round(점수×10), 주민 선정은 민심에 점수÷10(소수 유지)을 더하며 각각 금 200을 씁니다. 나머지 6종은 round(점수)를 더하고 금 100을 씁니다. 경험·공헌은 도시값의 단위 배율을 적용하기 전 점수로 계산합니다. RNG 순서는 점수 → 치명 판정 → 치명일 때만 배율입니다. 원작의 특기·장비·능력치별 치명 보정은 제외했습니다. 휴식은 비용 없이 부상을 1 회복합니다.
