import type { AppRouter } from '@opensamguk/server/router';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { QueryError } from '../game/QueryState';
import { useTRPC } from '../trpc';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import type { Relation } from './contract';
import styles from './Diplomacy.module.css';

// 외교 현황 (INT-26, 원작 중원 정보의 국가×국가 관계표). treaty.relations가 모든 국가 쌍의 관계를 준다.
// 다른 국가끼리의 불가침은 서버가 통상으로 가려 보낸다. 화면은 받은 값을 그대로 기호로 옮긴다.
// 색만으로 가르지 않도록 칸마다 기호를 쓰고, 읽기 프로그램에는 관계 이름을 함께 읽힌다.

export type RelationsReply = inferRouterOutputs<AppRouter>['treaty']['relations'];
type Pair = RelationsReply['pairs'][number];

export const RELATION_SYMBOL: Record<Relation, { symbol: string; label: string; tone: string }> = {
  WAR: { symbol: '★', label: '교전', tone: 'war' },
  DECLARED: { symbol: '▲', label: '선포', tone: 'declared' },
  NON_AGGRESSION: { symbol: '@', label: '불가침', tone: 'pact' },
  NONE: { symbol: 'ㆍ', label: '통상', tone: 'none' },
};

// 범례 순서는 원작 캡처와 같다.
const LEGEND: Relation[] = ['WAR', 'DECLARED', 'NON_AGGRESSION', 'NONE'];

// 쌍 목록을 양방향으로 찾는 표. 서버는 작은 번호를 nationA에 둔다. 화면은 순서를 가정하지 않는다.
export function relationLookup(pairs: readonly Pair[]): (a: number, b: number) => Pair | undefined {
  const byKey = new Map<string, Pair>();
  for (const pair of pairs) {
    byKey.set(`${pair.nationA}:${pair.nationB}`, pair);
    byKey.set(`${pair.nationB}:${pair.nationA}`, pair);
  }
  return (a, b) => byKey.get(`${a}:${b}`);
}

export function RelationGrid({ worldId, ownNationId }: { worldId: string; ownNationId: number }) {
  const trpc = useTRPC();
  const relations = useQuery({
    ...trpc.treaty.relations.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: 30_000,
  });
  if (relations.isError)
    return (
      <QueryError
        error={relations.error}
        notFound="외교 현황을 찾을 수 없습니다"
        onRetry={() => void relations.refetch()}
      />
    );
  if (!relations.data) return <LoadingState />;
  return <RelationGridView data={relations.data} ownNationId={ownNationId} />;
}

export function RelationGridView({ data, ownNationId }: { data: RelationsReply; ownNationId: number }) {
  const { nations } = data;
  const find = relationLookup(data.pairs);
  if (nations.length < 2) return null;
  // 우리 국가 줄·칸은 class와 data-own을 함께 단다. 시험은 data-own으로 본다.
  const own = (id: number) =>
    id === ownNationId ? { className: styles.gridOwn, 'data-own': true } : { className: undefined };
  return (
    <section className={styles.gridSection} aria-labelledby="relation-grid-title">
      <h2 id="relation-grid-title" className={styles.gridTitle}>
        외교 현황
      </h2>
      <ul className={styles.legend} aria-label="범례">
        {LEGEND.map((key) => {
          const mark = RELATION_SYMBOL[key];
          return (
            <li key={key}>
              <span className={`${styles.mark} ${styles[mark.tone]}`} aria-hidden="true">
                {mark.symbol}
              </span>{' '}
              {mark.label}
            </li>
          );
        })}
      </ul>
      <p className={styles.muted}>
        우리 국가의 줄과 칸은 붉게 칠하고 「우리」를 붙입니다. 다른 국가끼리의 불가침은 통상으로 보입니다.
      </p>
      <div className={styles.gridBox} tabIndex={0} role="region" aria-label="국가별 관계표, 옆으로 밀어 봅니다">
        <table className={styles.grid} data-testid="relation-grid">
          <thead>
            <tr>
              <th scope="col">
                <span className={styles.srOnly}>국가</span>
              </th>
              {nations.map((nation) => (
                <th key={nation.id} scope="col" {...own(nation.id)}>
                  <NationBadge name={nation.name} color={nation.color} />
                  {nation.id === ownNationId ? <span className={styles.ownMark}>우리</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nations.map((row) => (
              <tr key={row.id}>
                <th scope="row" {...own(row.id)}>
                  <NationBadge name={row.name} color={row.color} />
                  {row.id === ownNationId ? <span className={styles.ownMark}>우리</span> : null}
                </th>
                {nations.map((col) => {
                  const cls = own(row.id === ownNationId ? row.id : col.id);
                  if (row.id === col.id)
                    return (
                      <td key={col.id} {...cls}>
                        <span aria-hidden="true" className={styles.muted}>
                          —
                        </span>
                      </td>
                    );
                  const pair = find(row.id, col.id);
                  const relation: Relation = pair?.relation ?? 'NONE';
                  const mark = RELATION_SYMBOL[relation];
                  const until = pair?.relationEndAt ? ` (${formatYearMonth(pair.relationEndAt)}까지)` : '';
                  const text = `${row.name}·${col.name} ${mark.label}${until}`;
                  return (
                    <td key={col.id} {...cls} title={text} data-relation={relation}>
                      <span className={`${styles.mark} ${styles[mark.tone]}`} aria-hidden="true">
                        {mark.symbol}
                      </span>
                      <span className={styles.srOnly}>{text}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
