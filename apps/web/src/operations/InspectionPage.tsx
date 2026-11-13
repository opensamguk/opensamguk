import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import { displayName } from '../game/names';
import { useHome, useWorldId, useWorldMap, useWorldUnits } from '../game/queries';
import { Portrait } from '../portrait/Portrait';
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
  const { units } = useWorldUnits(worldId);
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
      unit: units.name,
    };
  }, [map.data, units]);

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
  else body = <InspectionTable rows={members.data.items} names={names} worldId={worldId} />;

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

function MemberRecords({ worldId, generalId }: { worldId: string; generalId: number }) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.inspection.memberRecords.queryOptions({ worldId, generalId }),
    retry: retryUnlessClientError,
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError)
    return (
      <QueryError error={query.error} notFound="소속 장수를 찾을 수 없습니다" onRetry={() => void query.refetch()} />
    );
  const rows = [
    ...query.data.logs.map((row) => ({ ...row, key: `log-${row.id}`, label: '개인' })),
    ...query.data.battles.map((row) => ({ ...row, key: `battle-${row.tick}-${row.attackerId}`, label: '전투' })),
  ].sort((a, b) => b.tick - a.tick);
  if (!rows.length) return <p className={styles.muted}>최근 기록이 없습니다.</p>;
  return (
    <ul>
      {rows.map(({ key, text, gameDate, label }) => (
        <li key={key}>
          {gameDate.year}년 {gameDate.month}월 · {label} · {text}
        </li>
      ))}
    </ul>
  );
}

export function InspectionTable({
  rows,
  names,
  now = new Date(),
  worldId,
}: {
  rows: InspectionRow[];
  names: ArgNames;
  now?: Date;
  worldId?: string;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  const [sort, setSort] = useState<'office' | 'lastTick' | 'engagements'>('office');
  const sorted =
    sort === 'office' ? rows : [...rows].sort((a, b) => (b.battle?.[sort] ?? -1) - (a.battle?.[sort] ?? -1));
  return (
    <table className={styles.table} data-testid="inspection-table">
      <caption>
        <label>
          정렬{' '}
          <select
            value={sort}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSort(value === 'lastTick' || value === 'engagements' ? value : 'office');
            }}
          >
            <option value="office">직책</option>
            <option value="lastTick">최근 전투</option>
            <option value="engagements">교전 횟수</option>
          </select>
        </label>
      </caption>
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
          <th scope="col" className="num">
            계략 성공
          </th>
          <th scope="col" className="num">
            교전 횟수
          </th>
          <th scope="col">예턴 앞 5칸</th>
          <th scope="col">다음 턴</th>
          <th scope="col">마지막 접속</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.generalId} className={row.idle ? styles.idle : undefined} data-idle={row.idle}>
            <th scope="row">
              <Portrait
                id={row.portraitId ?? null}
                name={displayName(row.name)}
                variant="thumb"
                size={20}
                decorative
                className={styles.face}
              />
              {displayName(row.name)}
              {row.isHuman ? null : (
                <>
                  {' '}
                  <Tag tone="muted">NPC</Tag>
                </>
              )}
              {worldId ? (
                <details
                  open={opened === row.generalId}
                  onToggle={(event) => {
                    if (event.currentTarget.open) setOpened(row.generalId);
                    else setOpened((id) => (id === row.generalId ? null : id));
                  }}
                >
                  <summary>최근 기록</summary>
                  {opened === row.generalId ? <MemberRecords worldId={worldId} generalId={row.generalId} /> : null}
                </details>
              ) : null}
            </th>
            <td>{officerName(row.officerLevel)}</td>
            <td>{row.cityName}</td>
            <td className="num">{row.crew.toLocaleString('ko-KR')}</td>
            <td className="num">{row.train}</td>
            <td className="num">{row.atmos}</td>
            <td className="num">{row.stratagemSuccesses}</td>
            <td className="num">{row.battle?.engagements ?? '—'}</td>
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
