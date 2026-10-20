import styles from './StatTable.module.css';

export interface StatRow {
  label: string;
  value: number | null; // null = 공개 범위 밖
  max?: number;
  hiddenReason?: string;
}

// 수치 표. 숫자는 오른쪽 정렬·고정폭, 최대치가 있으면 막대를 함께 그린다.
export function StatTable({ rows, caption }: { rows: StatRow[]; caption?: string }) {
  return (
    <table className={styles.table}>
      {caption ? <caption className={styles.caption}>{caption}</caption> : null}
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className={styles.label}>
              {row.label}
            </th>
            <td className="num" title={row.value === null ? row.hiddenReason : undefined}>
              {row.value === null ? '—' : row.value.toLocaleString('ko-KR')}
            </td>
            <td className={`num ${styles.max}`}>{row.max === undefined ? '' : `/ ${row.max.toLocaleString('ko-KR')}`}</td>
            <td className={styles.barCell}>
              {row.max !== undefined && row.value !== null ? (
                <span
                  className={styles.bar}
                  role="meter"
                  aria-label={`${row.label} ${row.value} / ${row.max}`}
                  aria-valuenow={row.value}
                  aria-valuemin={0}
                  aria-valuemax={row.max}
                >
                  <span className={styles.fill} style={{ width: `${Math.min(100, (row.value / Math.max(row.max, 1)) * 100)}%` }} />
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
