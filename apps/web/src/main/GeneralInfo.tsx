import { Link } from '@tanstack/react-router';
import { officerName } from '../game/names';
import { useWorldSummary } from '../game/queries';
import type { Home, MapNation, WorldSummary } from '../game/types';
import { Portrait } from '../portrait/Portrait';
import { NationBadge } from '../ui/NationBadge';
import { Tag } from '../ui/Tag';
import { InfoGrid } from './Panel';
import styles from './GeneralInfo.module.css';
import { EquipmentStatus } from '../equipment/EquipmentStatus';
import type { EquipmentRead } from '../equipment/useEquipment';

const n = (value: number) => value.toLocaleString('ko-KR');

export function formatClock(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// 보이는 나이. lineage-v1 월드는 가문 칸과 같게 월드 요약의 현재 게임 연도에서 출생 연도를 뺀다.
// 저장 나이(age)는 1월 월말 정산에서야 오르므로 해가 바뀐 1월에 가문 칸보다 한 살 적게 보인다. 저장값·규칙은 바꾸지 않는다.
// 기능이 꺼진 월드나 요약을 아직 받지 못했으면 저장 나이를 그대로 쓴다.
export function displayedAge(
  general: Pick<Home['general'], 'age' | 'birthYear'>,
  summary: WorldSummary | undefined,
): number {
  if (summary === undefined || !('lineageEnabled' in summary) || summary.lineageEnabled !== true) return general.age;
  return Math.max(0, summary.gameDate.year - general.birthYear);
}

// 장수 정보. 원작 GeneralBasicCard의 초상·이름·소속·능력치·자원 칸을 한 카드에 둔다.
export function GeneralInfo({
  worldId,
  home,
  cityName,
  nation,
  onSelectCity,
  campaignEnabled = false,
  equipment,
}: {
  worldId: string;
  home: Home;
  cityName: string;
  nation: MapNation | undefined;
  onSelectCity: (key: number) => void;
  campaignEnabled?: boolean;
  equipment?: EquipmentRead | undefined;
}) {
  const g = home.general;
  const summary = useWorldSummary(worldId).data;
  const board = equipment?.kind === 'ready' && equipment.data.generalId === g.id ? equipment.data : null;
  const stat = (key: 'leadership' | 'strength' | 'intel') =>
    board && board.bonus[key] > 0 ? (
      <span>
        <strong>{n(board.stats[key])}</strong>
        <small className={styles.statNote}>
          기본 {n(board.baseStats[key])} + 장비 {board.bonus[key]}
        </small>
      </span>
    ) : (
      n(board?.stats[key] ?? g[key])
    );
  return (
    <div className={styles.general} data-general-id={g.id}>
      <div className={styles.head}>
        <Portrait id={g.portraitId} name={g.name} variant="portrait" />
        <div className={styles.who}>
          <strong className={styles.name}>{g.name}</strong>
          <span className={styles.line}>
            {nation ? (
              <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(nation.id) }}>
                <NationBadge name={nation.name} color={nation.color} />
              </Link>
            ) : (
              <NationBadge name="재야" color={null} />
            )}
            <span>{officerName(g.officerLevel, g.nationId !== null)}</span>
            <button type="button" className={styles.place} onClick={() => onSelectCity(g.cityKey)}>
              {cityName}
            </button>
            {g.injury > 0 ? <Tag tone="warning">부상 {g.injury}</Tag> : null}
          </span>
        </div>
      </div>
      <InfoGrid
        items={[
          { label: '통솔', value: stat('leadership') },
          { label: '무력', value: stat('strength') },
          { label: '지력', value: stat('intel') },
          ...('politics' in g && 'charm' in g && typeof g.politics === 'number' && typeof g.charm === 'number'
            ? [
                { label: '정치', value: n(g.politics) },
                { label: '매력', value: n(g.charm) },
              ]
            : []),
          { label: '나이', value: `${displayedAge(g, summary)}세` },
          { label: '금', value: n(g.gold) },
          { label: '쌀', value: n(g.rice) },
          ...(campaignEnabled
            ? [{ label: '병력·훈련·사기', value: '부곡별 현황 참조' }]
            : [
                { label: '병력', value: n(g.crew) },
                { label: '훈련', value: n(g.train) },
                { label: '사기', value: n(g.atmos) },
              ]),
          { label: '경험', value: n(g.experience) },
          { label: '공헌', value: n(g.dedication) },
          { label: '다음 턴', value: formatClock(home.nextTurnAt) },
          { label: '기본 방침', value: g.policy.name },
        ]}
      />
      {/* 장착 장비는 원작 장수 칸처럼 여기 둔다. 가문(T4-95)은 내 정보 화면(/me)으로 옮겼다 (INT-25). */}
      {equipment ? <EquipmentStatus read={equipment} /> : null}
      <p className={styles.links}>
        <Link to="/w/$worldId/me" params={{ worldId }}>
          내 정보
        </Link>
        <Link to="/w/$worldId/me" params={{ worldId }} hash="lineage">
          가문
        </Link>
      </p>
    </div>
  );
}
