import { readableTextColor } from './color';
import styles from './NationBadge.module.css';

// 국가색은 이름표와 지도에만 쓴다 (UI 지침 원칙 3).
export function NationBadge({ name, color }: { name: string; color: string | null }) {
  if (color === null) {
    return <span className={`${styles.badge} ${styles.none}`}>{name}</span>;
  }
  return (
    <span className={styles.badge} style={{ background: color, color: readableTextColor(color) }}>
      {name}
    </span>
  );
}
