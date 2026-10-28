import { useRef } from 'react';
import { NationBadge } from '../ui/NationBadge';
import { useNarrowTable } from '../ui/useNarrowTable';
import styles from './Ranking.module.css';
import {
  GENERAL_COLUMNS,
  NATION_COLUMNS,
  rankTone,
  type GeneralRanking,
  type GeneralSortKey,
  type NationRanking,
  type NationSortKey,
  type RankedGeneral,
} from './rankingView';

const number = (value: number) => value.toLocaleString('ko-KR');

function MobileSort<K extends string>({
  columns,
  by,
  onSort,
  label,
}: {
  columns: ReadonlyArray<{ key: K; label: string }>;
  by: K;
  onSort: (key: K) => void;
  label: string;
}) {
  return (
    <div className={styles.mobileSort} role="group" aria-label={`${label} 정렬`}>
      {columns.map((column) => (
        <button
          type="button"
          key={column.key}
          className={styles.sortButton}
          aria-pressed={column.key === by}
          onClick={() => onSort(column.key)}
        >
          {column.label}
          {column.key === by ? ' ▼' : ''}
        </button>
      ))}
    </div>
  );
}

function RankCell({ rank }: { rank: number }) {
  const tone = rankTone(rank);
  return (
    <td className="num">
      {tone ? (
        <span className={styles.rankBadge} data-tone={tone}>
          {rank}
        </span>
      ) : (
        rank
      )}
    </td>
  );
}

// 머리글을 눌러 기준을 바꾼다 (레퍼런스 R4). 순위는 큰 값부터라 방향은 하나뿐이다.
function SortHeader<K extends string>({
  column,
  active,
  onSort,
}: {
  column: { key: K; label: string };
  active: boolean;
  onSort: (key: K) => void;
}) {
  return (
    <th scope="col" className="num" aria-sort={active ? 'descending' : 'none'}>
      <button type="button" className={styles.sortButton} aria-pressed={active} onClick={() => onSort(column.key)}>
        {column.label}
        <span aria-hidden="true" className={styles.sortMark}>
          {active ? '▼' : ''}
        </span>
      </button>
    </th>
  );
}

function GeneralRow({
  row,
  me,
  rowRef,
  narrow,
}: {
  row: RankedGeneral;
  me: boolean;
  rowRef?: (el: HTMLElement | null) => void;
  narrow: boolean;
}) {
  return (
    <tr ref={rowRef} tabIndex={me ? -1 : undefined} data-me={me || undefined} className={me ? styles.meRow : undefined}>
      <RankCell rank={row.rank} />
      <td>
        <span className={styles.name}>{row.name}</span>
        {me ? <span className={styles.meChip}>나</span> : null}
        {narrow ? (
          <dl className={styles.details}>
            {GENERAL_COLUMNS.map((column) => (
              <div key={column.key}>
                <dt>{column.label}</dt>
                <dd>{number(row[column.key])}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </td>
      <td>
        {row.nation ? (
          <NationBadge name={row.nation.name} color={row.nation.color} />
        ) : (
          <NationBadge name="재야" color={null} />
        )}
      </td>
      {narrow ? null : (
        <>
          <td className="num">{number(row.dedication)}</td>
          <td className="num">{number(row.experience)}</td>
          <td className="num">{number(row.merit)}</td>
        </>
      )}
    </tr>
  );
}

// 장수 순위. 내 장수는 강조하고 「나」를 붙인다. 상위 목록 밖이면 표 끝에 따로 한 줄 둔다.
// v1 월단평 순위(web/game/components/yuedan/YuedanParts.tsx:44-115)의 「나」 칩과 「내 순위로」를 이어받았다.
export function GeneralRankingTable({
  ranking,
  by,
  onSort,
}: {
  ranking: GeneralRanking;
  by: GeneralSortKey;
  onSort: (key: GeneralSortKey) => void;
}) {
  const mine = useRef<HTMLElement | null>(null);
  const narrow = useNarrowTable();
  const meId = ranking.me?.generalId ?? null;
  const meInTop = meId !== null && ranking.top.some((row) => row.generalId === meId);
  const mineRef = (el: HTMLElement | null) => {
    mine.current = el;
  };
  const jump = () => {
    mine.current?.scrollIntoView({ block: 'center' });
    mine.current?.focus();
  };

  return (
    <div className={styles.wrap}>
      {narrow ? <MobileSort columns={GENERAL_COLUMNS} by={by} onSort={onSort} label="장수 순위" /> : null}
      <table className={styles.table} aria-label="장수 순위">
        <thead>
          <tr>
            <th scope="col" className="num">
              순위
            </th>
            <th scope="col">장수</th>
            <th scope="col">소속</th>
            {narrow
              ? null
              : GENERAL_COLUMNS.map((column) => (
                  <SortHeader key={column.key} column={column} active={column.key === by} onSort={onSort} />
                ))}
          </tr>
        </thead>
        <tbody>
          {ranking.top.map((row) => {
            const me = row.generalId === meId;
            return (
              <GeneralRow key={row.generalId} row={row} me={me} narrow={narrow} {...(me ? { rowRef: mineRef } : {})} />
            );
          })}
        </tbody>
        {ranking.me && !meInTop ? (
          <tbody className={styles.outside}>
            <tr aria-hidden="true">
              <td colSpan={narrow ? 3 : 6} className={styles.gap}>
                ⋯
              </td>
            </tr>
            <GeneralRow row={ranking.me} me rowRef={mineRef} narrow={narrow} />
          </tbody>
        ) : null}
      </table>
      {ranking.me ? (
        <button type="button" className={styles.jump} onClick={jump}>
          내 순위로
        </button>
      ) : null}
    </div>
  );
}

// 국가 순위. 국력은 공개용 계산값만 온다. 국고·군량 원값은 열을 두지 않는다 (AC-M2-19).
export function NationRankingTable({
  ranking,
  by,
  onSort,
}: {
  ranking: NationRanking;
  by: NationSortKey;
  onSort: (key: NationSortKey) => void;
}) {
  const narrow = useNarrowTable();
  return (
    <div className={styles.wrap}>
      {narrow ? <MobileSort columns={NATION_COLUMNS} by={by} onSort={onSort} label="국가 순위" /> : null}
      <table className={styles.table} aria-label="국가 순위">
        <thead>
          <tr>
            <th scope="col" className="num">
              순위
            </th>
            <th scope="col">국가</th>
            {narrow
              ? null
              : NATION_COLUMNS.map((column) => (
                  <SortHeader key={column.key} column={column} active={column.key === by} onSort={onSort} />
                ))}
          </tr>
        </thead>
        <tbody>
          {ranking.items.map((row) => (
            <tr key={row.nationId}>
              <RankCell rank={row.rank} />
              <td>
                <NationBadge name={row.name} color={row.color} />
                {narrow ? (
                  <dl className={styles.details}>
                    {NATION_COLUMNS.map((column) => (
                      <div key={column.key}>
                        <dt>{column.label}</dt>
                        <dd>{number(row[column.key])}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </td>
              {narrow ? null : (
                <>
                  <td className="num">{number(row.cities)}</td>
                  <td className="num">{number(row.generals)}</td>
                  <td className="num">{number(row.power)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
