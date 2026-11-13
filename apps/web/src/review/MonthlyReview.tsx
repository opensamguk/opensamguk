import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { QueryError } from '../game/QueryState';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from '../turns/apiError';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import styles from './MonthlyReview.module.css';

const monthKey = (m: { year: number; month: number }) => `${m.year}-${m.month}`;

// 기록 화면 중원 정세 탭 맨 위의 월단평 (T3-08, AC-M3-15). 순위·소속·점수는 서버가 그달에 저장한 값 그대로다.
export function MonthlyReview({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const selectId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const latest = useQuery({ ...trpc.review.latest.queryOptions({ worldId }), retry: retryUnlessClientError });
  const months = useQuery({ ...trpc.review.months.queryOptions({ worldId }), retry: retryUnlessClientError });
  const list = months.data ?? [];
  const latestKey = list[0] ? monthKey(list[0]) : '';
  const target = picked === null ? null : (list.find((m) => monthKey(m) === picked) ?? null);
  const chosen = useQuery({
    ...trpc.review.get.queryOptions({ worldId, year: target?.year ?? 0, month: target?.month ?? 1 }),
    enabled: target !== null && monthKey(target) !== (latest.data ? monthKey(latest.data) : ''),
    retry: retryUnlessClientError,
  });

  const showLatest = target === null || (latest.data != null && monthKey(target) === monthKey(latest.data));
  const query = showLatest ? latest : chosen;
  const review = query.data ?? null;

  return (
    <section className={styles.panel} aria-labelledby={`${selectId}-h`} data-testid="monthly-review">
      <div className={styles.head}>
        <h2 id={`${selectId}-h`} className={styles.title}>
          {review ? `${review.year}년 ${review.month}월 월단평` : '월단평'}
        </h2>
        {list.length > 0 ? (
          <label className={styles.choose} htmlFor={selectId}>
            <span>월 고르기</span>
            <select
              id={selectId}
              className={styles.select}
              value={target ? monthKey(target) : latestKey}
              onChange={(event) => setPicked(event.target.value === latestKey ? null : event.target.value)}
            >
              {list.map((m) => (
                <option key={monthKey(m)} value={monthKey(m)}>
                  {m.year}년 {m.month}월
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {months.isError && !query.isError ? (
        <QueryError
          error={months.error}
          notFound="지난 월단평을 찾을 수 없습니다"
          onRetry={() => void months.refetch()}
        />
      ) : null}
      {query.isError ? (
        <QueryError error={query.error} notFound="월단평을 찾을 수 없습니다" onRetry={() => void query.refetch()} />
      ) : query.isPending && query.fetchStatus !== 'idle' ? (
        <LoadingState />
      ) : review === null ? (
        <p className={styles.muted}>{showLatest ? '아직 월단평이 없습니다' : '이 달의 월단평이 없습니다'}</p>
      ) : review.entries.length === 0 ? (
        <p className={styles.muted}>이번 달은 평판에 오른 장수가 없습니다</p>
      ) : (
        <ol className={styles.list}>
          {review.entries.map((entry) => (
            <li key={entry.generalId} className={styles.row} data-testid="monthly-review-entry">
              <span className={`num ${styles.rank}`}>{entry.rank}위</span>
              <div className={styles.body}>
                <div className={styles.who}>
                  {entry.nation ? (
                    <Link
                      className={styles.nation}
                      to="/w/$worldId/nation/$nationId"
                      params={{ worldId, nationId: String(entry.nation.id) }}
                    >
                      <strong>{entry.name}</strong>
                      <NationBadge name={entry.nation.name} color={entry.nation.color} />
                    </Link>
                  ) : (
                    <>
                      <strong>{entry.name}</strong>
                      <span className={styles.muted}>재야</span>
                    </>
                  )}
                </div>
                <p className={styles.line}>{entry.line}</p>
              </div>
              <span className={`num ${styles.score}`}>{entry.score}점</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
