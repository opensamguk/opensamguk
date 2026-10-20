# 파일 지도

> 상태: 뼈대 · 필요 시점: M1 (코드가 생기면 채움) · 참고: core2026 `docs/developer/code-map.md`
> 이 문서가 답할 질문: 어떤 일을 바꾸려면 어느 파일을 고치나?

## 변경 종류별 위치 (예정)

| 바꾸려는 것             | 고칠 곳                                                     |
| ----------------------- | ----------------------------------------------------------- |
| 새 명령                 | `packages/rules/src/commands/` + 테스트 + 명령 목록 생성     |
| 전투 계산               | `packages/rules/src/war/`                                   |
| 월간 정산               | `packages/rules/src/monthly/` + `apps/engine`의 정산 단계    |
| NPC 판단                | `packages/rules/src/npc/`                                   |
| 새 저장 필드            | `packages/db` schema + 새 migration + 엔진 적재·저장 + 재적재 테스트 |
| 새 API                  | `apps/server/src/routers/` + 권한 테스트                     |
| 새 화면                 | `apps/web/src/routes/`                                      |
| 지도·시나리오·프리셋     | `resources/`                                                |

<!-- TODO(M1): 실제 경로가 생기면 위 표를 고치고, 각 디렉터리의 핵심 파일 3개씩 적는다. -->

## 새 저장 필드를 추가할 때 빠뜨리기 쉬운 것

core2026 지침에서 가져온 체크리스트입니다.

- [ ] schema와 새 migration (기존 migration은 고치지 않음)
- [ ] 도메인 타입
- [ ] 엔진의 월드 적재
- [ ] 변경 추적과 저장
- [ ] 재시작 뒤 다시 읽는 테스트
