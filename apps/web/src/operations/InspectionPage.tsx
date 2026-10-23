import { useQuery } from '@tanstack/react-query';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId } from '../game/queries';
import { formatTime } from '../turns/schedule';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { inspectionApi, inspectionQueryKey, type InspectionRow } from './contract';
import styles from './Operations.module.css';

// 직책 이름. 표는 T2-05의 직책 표를 따른다 (12 군주, 11 참모, 5~10 수뇌).
export function officerName(level: number): string {
  if (level >= 12) return '군주';
  if (level === 11) return '참모';
  if (level >= 5) return '수뇌';
  return '일반';
}

// 감찰 (T2-12, AC-M2-15). 자기 국가 장수의 병력·훈련·사기·예턴 앞 5칸·마지막 접속. 직책자만 받는다.
export function InspectionPage() {
  const worldId = useWorldId();
  const home = useHome(worldId);
  const members = useQuery({
    queryKey: inspectionQueryKey({ worldId }),
    queryFn: () => inspectionApi.members.query({ worldId }),
    refetchInterval: 30_000,
    retry: retryUnlessClientError,
  });

  let body;
  if (home.isError && errorCode(home.error) === 'NOT_FOUND') body = <NoGeneral worldId={worldId} />;
  else if (members.isError && errorCode(members.error) === 'FORBIDDEN')
    body = <EmptyState title="감찰은 직책자만 봅니다" />;
  else if (members.isError)
    body = (
      <QueryError error={members.error} notFound="감찰 표를 찾을 수 없습니다" onRetry={() => void members.refetch()} />
    );
  else if (!members.data) body = <LoadingState />;
  else if (members.data.items.length === 0) body = <EmptyState title="소속 장수가 없습니다" />;
  else body = <InspectionTable rows={members.data.items} />;

  return (
    <section className={styles.page}>
      <h1>감찰</h1>
      {body}
    </section>
  );
}

export function InspectionTable({ rows, now = new Date() }: { rows: InspectionRow[]; now?: Date }) {
  return (
    <table className={styles.table} data-testid="inspection-table">
      <thead>
        <tr>
          <th scope="col">장수</th>
          <th scope="col">직책</th>
          <th scope="col">도시</th>
          <th scope="col" className="num">
            병력
          </th>
          <th scope="col" className="num">
            훈련
          </th>
          <th scope="col" className="num">
            사기
          </th>
          <th scope="col">예턴 앞 5칸</th>
          <th scope="col">다음 턴</th>
          <th scope="col">마지막 접속</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.generalId} className={row.idle ? styles.idle : undefined} data-idle={row.idle}>
            <th scope="row">
              {row.name}
              {row.isHuman ? null : (
                <>
                  {' '}
                  <Tag tone="muted">NPC</Tag>
                </>
              )}
            </th>
            <td>{officerName(row.officerLevel)}</td>
            <td>{row.cityName}</td>
            <td className="num">{row.crew.toLocaleString('ko-KR')}</td>
            <td className="num">{row.train}</td>
            <td className="num">{row.atmos}</td>
            <td>{row.turns.map((t) => (t.commandKey === 'rest' ? '·' : t.name)).join(' → ')}</td>
            <td>{row.nextTurnAt ? formatTime(new Date(row.nextTurnAt), now) : '—'}</td>
            <td>
              {row.lastActiveAt ? formatTime(new Date(row.lastActiveAt), now) : '—'}
              {row.idle ? (
                <>
                  {' '}
                  <Tag tone="warning">오래 접속 안 함</Tag>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
