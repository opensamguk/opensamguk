import { Link } from '@tanstack/react-router';
import { officerName } from '../game/names';
import type { Home, MapNation } from '../game/types';
import { homePolicy } from '../policy/contract';
import { Portrait } from '../portrait/Portrait';
import { NationBadge } from '../ui/NationBadge';
import { Tag } from '../ui/Tag';
import { InfoGrid } from './Panel';
import styles from './GeneralInfo.module.css';

const n = (value: number) => value.toLocaleString('ko-KR');

export function formatClock(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// 장수 정보. 원작 GeneralBasicCard의 초상·이름·소속·능력치·자원 칸을 한 카드에 둔다.
export function GeneralInfo({
  worldId,
  home,
  cityName,
  nation,
  onSelectCity,
}: {
  worldId: string;
  home: Home;
  cityName: string;
  nation: MapNation | undefined;
  onSelectCity: (key: number) => void;
}) {
  const g = home.general;
  const policy = homePolicy(home);
  return (
    <div className={styles.general} data-general-id={g.id}>
      <div className={styles.head}>
        <Portrait id={g.portraitId} name={g.name} variant="icon" />
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
          { label: '통솔', value: n(g.leadership) },
          { label: '무력', value: n(g.strength) },
          { label: '지력', value: n(g.intel) },
          { label: '나이', value: `${g.age}세` },
          { label: '금', value: n(g.gold) },
          { label: '쌀', value: n(g.rice) },
          { label: '병력', value: n(g.crew) },
          { label: '훈련', value: n(g.train) },
          { label: '사기', value: n(g.atmos) },
          { label: '경험', value: n(g.experience) },
          { label: '공헌', value: n(g.dedication) },
          { label: '다음 턴', value: formatClock(home.nextTurnAt) },
          {
            label: '기본 방침',
            value: policy?.name ?? '—',
            title: policy ? undefined : '기본 방침을 아직 받지 못했습니다',
          },
        ]}
      />
    </div>
  );
}
