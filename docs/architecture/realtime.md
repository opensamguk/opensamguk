# 실시간 갱신

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-07 · 참고: core2026 `docs/architecture/realtime-change-journal.md`
> 이 문서가 답할 질문: DB에 저장된 변화가 어떻게 2초 안에 화면에 닿나?

## 1. 원칙

- 실시간 알림은 다시 조회하라는 신호일 뿐입니다. 알림이 빠져도 새로고침하면 화면이 맞아야 합니다.
- 기준은 DB입니다. 알림 전송 성공을 저장 성공의 조건으로 쓰지 않습니다.

## 2. 경로

```text
engine 트랜잭션 commit ─▶ NOTIFY (worldId, 종류, 대상) ─▶ server LISTEN
   ─▶ 대상 사용자의 SSE 연결 ─▶ web이 해당 query를 다시 조회
```

가정 A11: Redis 없이 PostgreSQL LISTEN/NOTIFY를 씁니다. server가 여러 대가 되면 다시 검토합니다.

## 3. 알림과 복구

저장 트랜잭션이 성공한 뒤 별도 autocommit SQL로 `pg_notify`를 호출한다. 저장이 롤백되면 호출하지 않는다. 알림 SQL이나 그 commit이 실패해도 경고만 남기고 저장 결과와 HTTP 성공을 바꾸지 않는다. PostgreSQL의 [NOTIFY 문서](https://www.postgresql.org/docs/18/sql-notify.html)에 따르면 알림 큐 포화는 commit 단계에서 실패하므로 저장 트랜잭션 안의 SAVEPOINT만으로는 이 경계를 지킬 수 없다.

알림은 `turn.result`, `message.new`, `monthly.done`, `offer.new`, `treaty.new`, `notice.updated`다. 서버 내부 신호에는 대상 장수·국가가 있지만 SSE에는 종류와 필요한 범위만 담는다. 본문, 발신자, 대상 ID, 수치와 revision은 내보내지 않는다.

전용 LISTEN 연결은 server의 `realtime/`가 관리한다. `GET /sse?worldId=`는 세션 쿠키와 그 월드의 장수를 확인하고 채널 구독이 끝난 뒤 `ready`를 보낸다. 30초마다 하트비트에서 LISTEN 연결에 `SELECT 1`을 실행한다. 연결을 다시 구독하면 열려 있는 SSE 모두에 `ready`를 다시 보낸다. 화면은 `ready`마다 전체를 재조회해야 한다(T2-10).

알림과 하트비트를 보낼 때마다 현재 DB의 세션 만료, 계정 ACTIVE 상태, 월드·장수 복합키를 검사한다. 읽는 동안 세션·계정·장수 행을 공유 잠금해 권한 변경과 전송을 직렬화한다. 무효한 연결은 닫는다. 국가 알림은 지금 소속 장수만, 외교 알림은 양국의 현재 군주·참모만 받는다. 개인 턴·메시지는 해당 장수만 받는다. 로그아웃은 같은 세션의 연결을 바로 닫고 다른 서버에도 종료 신호를 보낸다.

중복되거나 순서가 바뀐 알림도 재조회 신호로 처리한다. 별도 저장과 알림 사이에 프로세스가 죽으면 신호를 놓칠 수 있고 자동 재전송은 없다. 새로고침 또는 다음 `ready`의 전체 재조회로 DB 상태를 확인한다. 정상 경로의 2초 기준과 장애 복구 시간을 구분하며 T2-09의 SSE 시험만으로 AC-M2-07을 통과시키지 않는다. 두 사용자 브라우저의 조회·화면 반영은 T2-10이 검증한다.
