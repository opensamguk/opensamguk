// 로비·로그인 화면 아래의 중원 정세 띠 (INT-29, 사용자 2026-11-15 "해당하는 서버 누르면 아래쪽에 중원 정세 등 로그가
// 출력되게 해. 한줄로 흐르게 하거나 여러줄로 띄우거나 그건 알아서"). 고른 월드의 정세가 한 줄로 흐르고, 누르면 여러 줄로
// 펼친다. 움직임 줄이기 설정이면 흐르지 않고 가장 최근 줄만 둔다.
// 로그인한 사람은 기록 조회(records.activity, 중원 정세 범위)를 쓴다. 로그인하지 않은 사람용 공개 조회(지연 공개)는
// 서버 계약 대기(Codex 요청서 7절 lobby.headlines)라 그때까지는 안내만 둔다.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { LogKindIcon, Rich, TextEntityScope } from '../text/RichText';
import { useTRPC } from '../trpc';
import styles from './WorldTicker.module.css';

const REFRESH_MS = 60_000;
const LINES = 15;

export function WorldTicker({
  worldId,
  worldName,
  loggedIn,
}: {
  worldId: string | null;
  worldName: string;
  loggedIn: boolean;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const activity = useQuery({
    ...trpc.records.activity.queryOptions({ worldId: worldId ?? '', scope: 'world' }),
    enabled: loggedIn && worldId !== null,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  if (worldId === null) return null;
  const items = (activity.data?.items ?? []).filter((item) => item.source === 'nation').slice(0, LINES);
  const head = <span className={styles.head}>중원 정세 · {worldName}</span>;

  if (!loggedIn)
    return (
      <aside className={`kit-bar-bottom ${styles.bar}`} aria-label="중원 정세" data-testid="world-ticker">
        {head}
        <span className={styles.note}>로그인하면 이 월드의 중원 정세가 흐릅니다.</span>
      </aside>
    );
  if (activity.isError || (activity.isSuccess && items.length === 0))
    return (
      <aside className={`kit-bar-bottom ${styles.bar}`} aria-label="중원 정세" data-testid="world-ticker">
        {head}
        <span className={styles.note}>
          {activity.isError ? '정세를 불러오지 못했습니다.' : '아직 정세가 없습니다. 월간 정산 뒤에 쌓입니다.'}
        </span>
      </aside>
    );

  const line = (item: (typeof items)[number], key: string) => (
    <span key={key} className={styles.item}>
      <span className={`num ${styles.date}`}>
        {item.year}년 {item.month}월
      </span>
      <LogKindIcon kind={item.kind} />
      <Rich text={item.text} />
    </span>
  );

  return (
    <TextEntityScope worldId={worldId}>
      <aside
        className={open ? `kit-bar-bottom ${styles.bar} ${styles.open}` : `kit-bar-bottom ${styles.bar}`}
        aria-label="중원 정세"
        data-testid="world-ticker"
      >
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
          <span className={styles.toggleText}>{open ? '접기' : '펼치기'}</span>
        </button>
        {open ? (
          <ol id={listId} className={styles.list}>
            {items.map((item) => (
              <li key={item.id}>{line(item, item.id)}</li>
            ))}
          </ol>
        ) : (
          // 한 줄로 흐르는 띠. 같은 줄을 두 번 이어 붙여 끊김 없이 돈다(두 번째 묶음은 화면 낭독에서 뺀다).
          <div id={listId} className={styles.track} aria-live="off">
            <div className={styles.run}>
              {items.map((item) => line(item, item.id))}
              <span aria-hidden="true" className={styles.repeat}>
                {items.map((item) => line(item, `again-${item.id}`))}
              </span>
            </div>
          </div>
        )}
      </aside>
    </TextEntityScope>
  );
}
