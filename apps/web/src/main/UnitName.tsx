import { useWorldRules } from '../game/queries';
import styles from './UnitName.module.css';

type CrewType = NonNullable<ReturnType<typeof useWorldRules>['data']>['unitSet']['crewTypes'][number];

// 병종 능력치 한 줄. 원작 병종 풍선말의 공격·방어·기동·회피와 100명당 금·쌀이다.
export function unitStatText(unit: Pick<CrewType, 'attack' | 'defence' | 'speed' | 'avoid' | 'cost' | 'rice'>) {
  return `공격 ${unit.attack} · 방어 ${unit.defence} · 기동 ${unit.speed} · 회피 ${unit.avoid} · 100명당 금 ${unit.cost} 쌀 ${unit.rice}`;
}

// 병종 이름. 누르면 능력치와 비용을 펼친다(원작은 올리면 풍선말). 병종표가 없으면 번호만 쓴다.
export function UnitName({ worldId, crewType }: { worldId: string; crewType: number }) {
  const rules = useWorldRules(worldId);
  const unit = rules.data?.unitSet.crewTypes.find((entry) => entry.id === crewType);
  if (!unit) return <span title="병종표를 불러오지 못했습니다">{rules.isPending ? '…' : `병종 ${crewType}`}</span>;
  const stats = unitStatText(unit);
  return (
    <details className={styles.unit} data-crew-type={crewType}>
      <summary className={styles.summary} title={stats}>
        {unit.name}
      </summary>
      <span className={styles.stats}>{stats}</span>
    </details>
  );
}

// 표 칸에 쓰는 병종 이름 글자. 펼치기 없이 이름만 쓰고 풍선말로 능력치를 보인다.
export function unitNameOf(
  crewTypes: readonly CrewType[] | undefined,
  crewType: number,
): { name: string; title: string | undefined } {
  const unit = crewTypes?.find((entry) => entry.id === crewType);
  return unit ? { name: unit.name, title: unitStatText(unit) } : { name: `병종 ${crewType}`, title: undefined };
}
