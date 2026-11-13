import { useRef } from 'react';
import { displayName } from '../game/names';
import { Portrait } from '../portrait/Portrait';
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
// 전공(승리+점령)을 나눈 두 값 (원작 명장일람의 승리·점령). 서버 순위 기준에는 없어 정렬하지 않는다.
const MERIT_PARTS = [
  { key: 'wins', label: '승리' },
  { key: 'captures', label: '점령' },
] as const;

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

function generalValue(row: RankedGeneral, key: GeneralSortKey) {
  if (key === 'stratagem') return number(row.stratagemSuccesses);
  if (key === 'dedication' || key === 'experience' || key === 'merit') return number(row[key]);
  const value = row.battleStats?.[key];
  if (value === undefined) return '—';
  return key === 'winRate' || key === 'killRate' || key === 'humanKillRate'
    ? `${(value * 100).toFixed(1)}%`
    : number(value);
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
        {/* 28px 표 행은 thumb을 20×28로 줄여 쓴다 (D-085). 순위 응답에 초상 번호가 오면 얼굴, 아니면 실루엣. */}
        <Portrait
          id={row.portraitId ?? null}
          name={displayName(row.name)}
          variant="thumb"
          size={20}
          decorative
          className={styles.face}
        />
        <span className={styles.name} data-testid="ranked-general-name" data-general-name>
          {displayName(row.name)}
        </span>
        {row.isHuman === false ? <span className={styles.name}> NPC</span> : null}
        {me ? <span className={styles.meChip}>나</span> : null}
        {narrow ? (
          <dl className={styles.details}>
            {GENERAL_COLUMNS.map((column) => (
              <div key={column.key}>
                <dt>{column.label}</dt>
                <dd>{generalValue(row, column.key)}</dd>
              </div>
            ))}
            {MERIT_PARTS.map((part) => (
              <div key={part.key}>
                <dt>{part.label}</dt>
                <dd>{number(row[part.key])}</dd>
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
          {GENERAL_COLUMNS.map(({ key }) => (
            <td key={key} className="num">
              {generalValue(row, key)}
            </td>
          ))}
          <td className="num">{number(row.wins)}</td>
          <td className="num">{number(row.captures)}</td>
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
            {narrow
              ? null
              : MERIT_PARTS.map((part) => (
                  <th key={part.key} scope="col" className="num">
                    {part.label}
                  </th>
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
              <td colSpan={narrow ? 3 : 3 + GENERAL_COLUMNS.length + MERIT_PARTS.length} className={styles.gap}>
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
                {row.forceEstimate ? (
                  <details>
                    <summary>현재 병력 추정</summary>
                    <dl className={styles.details}>
                      <div>
                        <dt>소속 장수</dt>
                        <dd>{number(row.forceEstimate.totalGeneralCount)}명</dd>
                      </div>
                      <div>
                        <dt>사람 전투장</dt>
                        <dd>
                          {number(row.forceEstimate.userCombatGeneralCount)}명 · 약{' '}
                          {number(row.forceEstimate.userTroops)}명
                        </dd>
                      </div>
                      <div>
                        <dt>NPC 전투장</dt>
                        <dd>
                          {number(row.forceEstimate.npcCombatGeneralCount)}명 · 약 {number(row.forceEstimate.npcTroops)}
                          명
                        </dd>
                      </div>
                      <div>
                        <dt>장기 미활동 장수</dt>
                        <dd>{number(row.forceEstimate.inactiveGeneralCount)}명</dd>
                      </div>
                    </dl>
                  </details>
                ) : null}
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
