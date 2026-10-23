import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap } from '../game/queries';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import type { ArgNames } from '../turns/args';
import { formatTime } from '../turns/schedule';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import type { InspectionRow } from './contract';
import styles from './Operations.module.css';
import { EMPTY_SLOT_TITLE, slotLabel } from './timeline';

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
  const trpc = useTRPC();
  const home = useHome(worldId);
  const map = useWorldMap(worldId);
  const members = useQuery({
    ...trpc.inspection.members.queryOptions({ worldId }),
    refetchInterval: 30_000,
    retry: retryUnlessClientError,
  });
  const names: ArgNames = useMemo(() => {
    const cities = map.data?.cities ?? [];
    const nations = map.data?.nations ?? [];
    return {
      city: (key) => cities.find((c) => c.key === key)?.name,
      nation: (id) => nations.find((n) => n.id === id)?.name,
    };
  }, [map.data]);

  let body;
  if (home.isError && errorCode(home.error) === 'NOT_FOUND') body = <NoGeneral worldId={worldId} />;
  else if (members.isError && errorCode(members.error) === 'FORBIDDEN')
    body = <EmptyState title="감찰은 직책자만 봅니다">{serverMessage(members.error)}</EmptyState>;
  else if (members.isError)
    body = (
      <QueryError error={members.error} notFound="감찰 표를 찾을 수 없습니다" onRetry={() => void members.refetch()} />
    );
  else if (!members.data) body = <LoadingState />;
  else if (members.data.items.length === 0) body = <EmptyState title="소속 장수가 없습니다" />;
  else body = <InspectionTable rows={members.data.items} names={names} />;

  return (
    <section className={styles.page}>
      <h1>감찰</h1>
      {body}
    </section>
  );
}

// 예턴 앞 5칸은 비워 둔 칸과 직접 넣은 휴식을 나누고 인자를 붙인다. 비워 둔 칸의 방침 명령은 짐작하지 않는다.
function TurnPreview({ turns, names }: { turns: InspectionRow['turns']; names: ArgNames }) {
  return (
    <ol className={styles.turnPreview}>
      {turns.map((turn, i) => {
        const label = slotLabel(turn, names);
        return (
          <li key={i} data-kind={label.kind}>
            {label.kind === 'empty' ? (
              <span className={styles.muted} title={EMPTY_SLOT_TITLE}>
                {label.text}
              </span>
            ) : (
              label.text
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function InspectionTable({
  rows,
  names,
  now = new Date(),
}: {
  rows: InspectionRow[];
  names: ArgNames;
  now?: Date;
}) {
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
            <td>
              <TurnPreview turns={row.turns} names={names} />
            </td>
            {/* 시각이 null이면 지어내지 않는다. 월드가 진행 중이 아니면 서버가 시각을 주지 않는다. */}
            <td>{row.nextTurnAt !== null ? formatTime(new Date(row.nextTurnAt), now) : '시각 없음'}</td>
            <td>
              {row.lastActiveAt !== null ? formatTime(new Date(row.lastActiveAt), now) : '기록 없음'}
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
