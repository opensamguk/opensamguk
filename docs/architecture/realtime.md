# 실시간 갱신

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-07 · 참고: core2026 `docs/architecture/realtime-change-journal.md`
> 이 문서가 답할 질문: DB에 저장된 변화가 어떻게 2초 안에 화면에 닿나?

## 1. 원칙

- 실시간 알림은 "다시 조회하라"는 신호일 뿐입니다. 알림이 빠져도 새로고침하면 화면이 맞아야 합니다.
- 기준은 DB입니다. 알림 전송 성공을 저장 성공의 조건으로 쓰지 않습니다.

## 2. 경로

```text
engine 트랜잭션 commit ─▶ NOTIFY (worldId, 종류, 대상) ─▶ server LISTEN
   ─▶ 대상 사용자의 SSE 연결 ─▶ web이 해당 query를 다시 조회
```

⚠️ A11: Redis 없이 PostgreSQL LISTEN/NOTIFY를 씁니다. server가 여러 대가 되면 다시 검토합니다.

## 3. 정할 것

<!-- TODO(M2): 알림 종류 목록 (내 턴 결과, 새 메시지, 월간 정산, 외교 제안). -->
<!-- TODO(M2): 끊긴 SSE를 다시 이을 때 놓친 알림을 어떻게 채울지 (마지막 revision 기준 재조회). -->
<!-- TODO(M2): 공개 범위 검사. 다른 국가의 비밀 변화가 알림 내용으로 새지 않게. -->
