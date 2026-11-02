import { readableTextColor } from './color';
import styles from './NationBadge.module.css';

// 국가색은 이름표와 지도에만 쓴다 (UI 지침 원칙 3).
// 이름 앞의 도트 군기는 장식이라 읽지 않는다. 깃천만 국가색으로 물들인다 (INT-20).
export function NationBadge({ name, color }: { name: string; color: string | null }) {
  if (color === null) {
    return (
      <span className={styles.badge}>
        <span className={`${styles.name} ${styles.none}`}>{name}</span>
      </span>
    );
  }
  return (
    <span className={styles.badge}>
      <span className={styles.flag} style={{ color }} aria-hidden="true" />
      <span className={styles.name} style={{ background: color, color: readableTextColor(color) }}>
        {name}
      </span>
    </span>
  );
}
