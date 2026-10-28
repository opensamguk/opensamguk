import { useId, useState, type ReactNode } from 'react';
import { useNarrowTable } from './useNarrowTable';
import styles from './DataTable.module.css';

export interface Column<T> {
  key: string;
  label: string;
  // 정렬 값. null은 공개 범위 밖이라 정렬할 때 항상 뒤로 보낸다. 없으면 이 열은 정렬하지 않는다.
  sortValue?: (row: T) => number | string | null;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  title?: (row: T) => string | undefined;
}

type Sort = { key: string; dir: 'asc' | 'desc' } | null;

// 정렬 가능한 표. 숫자 열은 오른쪽 정렬·고정폭이며 머리글을 누르면 정렬이 바뀐다 (T1-16 결정).
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  rowLabel,
  mobileDetails,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string | number;
  caption?: string;
  rowLabel?: (row: T) => string;
  mobileDetails?: readonly string[];
}) {
  const narrow = useNarrowTable() && mobileDetails !== undefined;
  const sortId = useId();
  const [sort, setSort] = useState<Sort>(null);
  const details = narrow ? columns.filter((c, i) => i > 0 && mobileDetails?.includes(c.key)) : [];
  const visible = columns.filter((c) => !details.includes(c));
  const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
  const sorted = column?.sortValue ? sortRows(rows, column.sortValue, sort!.dir) : rows;
  const direction = sort?.dir === 'asc' ? '오름차순' : sort ? '내림차순' : '방향 선택';

  const toggle = (key: string, numeric: boolean) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: numeric ? 'desc' : 'asc' },
    );

  return (
    <div className={[styles.wrap, mobileDetails === undefined ? null : styles.responsive].filter(Boolean).join(' ')}>
      {narrow ? (
        <div className={styles.mobileSort}>
          <label htmlFor={sortId}>{caption ?? '표'} 정렬</label>
          <select
            id={sortId}
            value={sort?.key ?? ''}
            onChange={(event) => {
              const key = event.target.value;
              const picked = columns.find((c) => c.key === key);
              setSort(picked?.sortValue ? { key, dir: picked.numeric ? 'desc' : 'asc' } : null);
            }}
          >
            <option value="">기본 순서</option>
            {columns
              .filter((c) => c.sortValue)
              .map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!column}
            onClick={() => column && toggle(column.key, Boolean(column.numeric))}
            aria-label={`${caption ?? '표'} 정렬 방향 ${direction}, 바꾸기`}
          >
            {direction}
          </button>
        </div>
      ) : null}
      <table className={styles.table}>
        {caption ? <caption className={styles.caption}>{caption}</caption> : null}
        <thead>
          <tr>
            {visible.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.numeric ? 'num' : undefined}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortValue && !narrow ? (
                    <button type="button" className={styles.sort} onClick={() => toggle(c.key, Boolean(c.numeric))}>
                      <span className={styles.sortLabel}>{c.label}</span>
                      <span aria-hidden="true" className={styles.arrow}>
                        {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} aria-label={rowLabel?.(row)}>
              {visible.map((c, i) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined} title={c.title?.(row)}>
                  {c.render(row)}
                  {i === 0 && details.length ? (
                    <dl className={styles.details}>
                      {details.map((detail) => (
                        <div key={detail.key}>
                          <dt>{detail.label}</dt>
                          <dd>
                            {detail.render(row)}
                            {detail.title?.(row) ? <span className={styles.reason}> ({detail.title(row)})</span> : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function sortRows<T>(rows: readonly T[], value: (row: T) => number | string | null, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), 'ko') * sign;
  });
}

// 공개 범위 밖 숫자. 화면에는 —, 마우스를 올리면 이유가 나온다.
export function hiddenNumber(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : value.toLocaleString('ko-KR');
}
