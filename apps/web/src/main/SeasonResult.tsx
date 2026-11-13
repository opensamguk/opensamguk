import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { InfoGrid } from './Panel';
import { useWorldId } from '../game/queries';
import type { WorldSummary } from '../game/types';
import { useTRPC } from '../trpc';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './SeasonResult.module.css';

export const END_REASON_TEXT = { UNIFIED: '천하통일', END_YEAR: '종료 연도 도달' } as const;

// 끝난 판의 결과 칸 (T1-27). 값은 모두 서버의 world.summary.result에서 읽는다.
// 승자는 국가색만으로 구별하지 않게 이름표에 이름을 함께 쓴다. 결과 기록이 없는 예전 종료 월드는 끝났다는 것만 알린다.
export function SeasonResult({ result }: { result: WorldSummary['result'] }) {
  if (result === null) {
    return (
      <section className={styles.result} aria-label="기수 결과">
        <p className={styles.lead}>이 판은 끝났습니다.</p>
      </section>
    );
  }
  return (
    <section className={styles.result} aria-labelledby="season-result-title">
      <h2 id="season-result-title" className={styles.title}>
        기수 결과
      </h2>
      <dl className={styles.grid}>
        <div className={styles.cell}>
          <dt>끝난 이유</dt>
          <dd data-testid="season-reason">{END_REASON_TEXT[result.reason]}</dd>
        </div>
        <div className={styles.cell}>
          <dt>승자</dt>
          <dd data-testid="season-winner">
            {result.winner ? <NationBadge name={result.winner.name} color={result.winner.color} /> : '승자 없음'}
          </dd>
        </div>
        <div className={styles.cell}>
          <dt>종료 연월</dt>
          <dd className="num" data-testid="season-date">
            {result.year}년 {result.month}월
          </dd>
        </div>
        <div className={styles.cell}>
          <dt>남은 국가</dt>
          <dd className="num" data-testid="season-nations">
            {result.remainingNations}
          </dd>
        </div>
      </dl>
      <p className={styles.lead}>지도와 기록은 그대로 볼 수 있고 예턴은 더 바꿀 수 없습니다.</p>
      <SeasonGenerals winnerNationId={result.winner?.nationId ?? null} />
    </section>
  );
}

const SEASON_BY = [
  { key: 'dedication', label: '공헌' },
  { key: 'experience', label: '경험' },
  { key: 'merit', label: '전공' },
] as const;
type SeasonBy = (typeof SEASON_BY)[number]['key'];
type SeasonRow = { name: string; nation: { id: number } | null; wins: number };

// 오호장군 (원작 왕조 상세). 승자 국가 장수 가운데 승리가 많은 다섯 명이다. 승리가 없는 장수는 넣지 않는다.
export function fiveTigers(rows: readonly SeasonRow[], winnerNationId: number | null): string[] {
  if (winnerNationId === null) return [];
  return rows
    .filter((row) => row.nation?.id === winnerNationId && row.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 5)
    .map((row) => `${displayName(row.name)}(${row.wins})`);
}

// 끝난 기수의 장수 최종 순위 (원작 명예의 전당·왕조 상세). records.season이 기준별 전원 순위를 준다. 위 10명만 보인다.
function SeasonGenerals({ winnerNationId }: { winnerNationId: number | null }) {
  const worldId = useWorldId();
  const trpc = useTRPC();
  const [by, setBy] = useState<SeasonBy>('dedication');
  const query = useQuery({ ...trpc.records.season.queryOptions({ worldId, by }), retry: retryUnlessClientError });
  const merit = useQuery({
    ...trpc.records.season.queryOptions({ worldId, by: 'merit' }),
    retry: retryUnlessClientError,
  });
  const tigers = merit.data ? fiveTigers(merit.data.generals, winnerNationId) : [];
  const winner = merit.data?.winnerSummary;
  const n = (value: number) => value.toLocaleString('ko-KR');
  return (
    <div className={styles.generals} data-testid="season-generals">
      {winner && (
        <>
          <h3>통일 국가 현황</h3>
          <InfoGrid
            items={[
              { label: '성향', value: winner.philosophy },
              { label: '국력', value: n(winner.power) },
              { label: '도시', value: n(winner.cities) },
              { label: '장수', value: n(winner.generals) },
              { label: '주민', value: `${n(winner.population)} / ${n(winner.populationMax)}` },
              { label: '국고', value: `금 ${n(winner.gold)} · 쌀 ${n(winner.rice)}` },
            ]}
          />
          {winner.officers.length > 0 && (
            <ul>
              {winner.officers.map((officer) => (
                <li key={officer.officerLevel + ':' + officer.name}>
                  {officer.title ?? officerName(officer.officerLevel)} · {displayName(officer.name)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tigers.length > 0 ? (
        <p className={styles.lead} data-testid="season-tigers">
          오호장군: {tigers.join(' · ')}
        </p>
      ) : null}
      <div className={styles.byRow} role="group" aria-label="최종 순위 기준">
        <span className={styles.byLabel}>최종 장수 순위</span>
        {SEASON_BY.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={styles.byButton}
            aria-pressed={entry.key === by}
            onClick={() => setBy(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <p className={styles.lead}>최종 순위를 불러오지 못했습니다.</p>
      ) : query.data.generals.length === 0 ? (
        <EmptyState title="남은 장수 기록이 없습니다" />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} aria-label="최종 장수 순위">
            <thead>
              <tr>
                <th scope="col" className="num">
                  순위
                </th>
                <th scope="col">장수</th>
                <th scope="col">소속</th>
                <th scope="col" className="num">
                  공헌
                </th>
                <th scope="col" className="num">
                  경험
                </th>
                <th scope="col" className="num">
                  승리
                </th>
                <th scope="col" className="num">
                  점령
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.generals.slice(0, 10).map((row) => (
                <tr key={row.generalId}>
                  <td className="num">{row.rank}</td>
                  <td>{displayName(row.name)}</td>
                  <td>
                    {row.nation ? (
                      <NationBadge name={row.nation.name} color={row.nation.color} />
                    ) : (
                      <NationBadge name="재야" color={null} />
                    )}
                  </td>
                  <td className="num">{n(row.dedication)}</td>
                  <td className="num">{n(row.experience)}</td>
                  <td className="num">{n(row.wins)}</td>
                  <td className="num">{n(row.captures)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
