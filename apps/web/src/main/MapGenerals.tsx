import { displayName } from '../game/names';
import { Portrait } from '../portrait/Portrait';
import { Tag } from '../ui/Tag';
import { tooltipGenerals, type MapGeneral } from './mapGeneralList';
import styles from './MapGenerals.module.css';

// 지도 풍선의 장수 줄 (INT-26). 원형 icon 얼굴과 괄호 뺀 이름, 사람이 맡지 않은 장수는 NPC 딱지를 단다.
export function MapGenerals({ generals }: { generals: readonly MapGeneral[] }) {
  if (generals.length === 0) return null;
  const { shown, rest } = tooltipGenerals(generals);
  return (
    <div className={styles.generals} data-testid="map-tooltip-generals">
      <p className={styles.count}>장수 {generals.length}명</p>
      <ul className={styles.list}>
        {shown.map((general) => {
          const name = displayName(general.name);
          return (
            <li key={general.id} className={styles.row} data-general-id={general.id}>
              <Portrait id={general.portraitId} name={name} variant="icon" shape="round" size={24} decorative />
              <span className={styles.name}>{name}</span>
              {general.isHuman ? null : <Tag tone="muted">NPC</Tag>}
            </li>
          );
        })}
      </ul>
      {rest > 0 ? <p className={styles.count}>외 {rest}명</p> : null}
    </div>
  );
}
