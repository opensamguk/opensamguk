import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { retryUnlessClientError } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { useWorldSummary } from '../game/queries';
import type { Home, MapNation, WorldSummary } from '../game/types';
import { Portrait } from '../portrait/Portrait';
import { RelationList } from '../relations/RelationList';
import { NationBadge } from '../ui/NationBadge';
import { Tag } from '../ui/Tag';
import { useTRPC } from '../trpc';
import { meritText } from './infoView';
import { InfoGrid } from './Panel';
import { UnitName } from './UnitName';
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
  const merit = useMyMerit(worldId);
  const board = equipment?.kind === 'ready' && equipment.data.generalId === g.id ? equipment.data : null;
  const condition = g.condition;
  const stat = (key: 'leadership' | 'strength' | 'intel') => {
    const injured = condition?.injuredStats[key] ?? g[key];
    const leadershipBonus = key === 'leadership' ? (condition?.leadershipBonus ?? 0) : 0;
    const equipmentBonus = board?.bonus[key] ?? 0;
    const applied = injured + leadershipBonus + equipmentBonus;
    const details = [
      injured !== g[key] ? `부상 ${n(g[key])} → ${n(injured)}` : null,
      leadershipBonus > 0 ? `관직 +${n(leadershipBonus)}` : null,
      equipmentBonus > 0 ? `장비 +${n(equipmentBonus)}` : null,
    ].filter(Boolean);
    return details.length > 0 ? (
      <span>
        <strong className={injured !== g[key] ? styles.ageWarning : undefined}>{n(applied)}</strong>
        <small className={styles.statNote}>{details.join(' · ')}</small>
      </span>
    ) : (
      n(applied)
    );
  };
  const age = displayedAge(g, summary);
  const retirementAge = condition?.retirementAge ?? 70;
  const ageStyle =
    age < retirementAge * 0.75 ? styles.ageNormal : age < retirementAge ? styles.ageWarning : styles.ageHigh;
  return (
    <div className={styles.general} data-general-id={g.id}>
      <div className={styles.head}>
        <Portrait id={g.portraitId} name={displayName(g.name)} variant="portrait" />
        <div className={styles.who}>
          <strong className={styles.name}>{displayName(g.name)}</strong>
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
          { label: '나이', value: <span className={ageStyle}>{age}세</span> },
          // 성격·특기는 시나리오 장수만 값이 있다. 효과 설명은 규칙이 생긴 뒤에 붙인다 (INT-25).
          { label: '성격', value: g.personality || '—' },
          { label: '특기', value: g.special || '—' },
          { label: '금', value: n(g.gold) },
          { label: '쌀', value: n(g.rice) },
          ...(campaignEnabled
            ? [{ label: '병력·훈련·사기', value: '부곡별 현황 참조' }]
            : [
                { label: '병종', value: <UnitName worldId={worldId} crewType={g.crewType} /> },
                { label: '병력', value: n(g.crew) },
                { label: '훈련', value: n(g.train) },
                { label: '사기', value: n(g.atmos) },
              ]),
          { label: '경험', value: n(g.experience) },
          { label: '공헌', value: n(g.dedication) },
          merit.row
            ? { label: '전공', value: meritText(merit.row), title: merit.at }
            : { label: '전공', value: '—', title: merit.at },
          { label: '다음 턴', value: formatClock(home.nextTurnAt) },
          { label: '기본 방침', value: g.policy.name },
        ]}
      />
      {/* 장착 장비는 원작 장수 칸처럼 여기 둔다. 가문(T4-95)은 내 정보 화면(/me)으로 옮겼다 (INT-25). */}
      {equipment ? <EquipmentStatus read={equipment} /> : null}
      {summary && 'relationsEnabled' in summary ? <RelationList worldId={worldId} generalId={g.id} /> : null}
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

// 내 승리·점령 수 (원작 장수 상세의 승리). 실시간 값은 없고 달마다 찍는 순위 값(ranking.generals의 me)을 쓴다.
function useMyMerit(worldId: string) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.ranking.generals.queryOptions({ worldId, by: 'merit' }),
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
  const at = query.data?.at;
  return {
    row: query.data?.me ?? null,
    at: at ? `${at.year}년 ${at.month}월 정산 기준` : '월간 정산 뒤에 보입니다',
  };
}
