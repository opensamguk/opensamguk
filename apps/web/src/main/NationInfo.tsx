import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { officerName } from '../game/names';
import { QueryError } from '../game/QueryState';
import { isDetailedGeneral, isMemberNation, type Home, type MapCity, type NationView } from '../game/types';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { InfoGrid } from './Panel';
import styles from './NationInfo.module.css';

const HIDDEN_NATION = '다른 국가 정보';
const n = (value: number) => value.toLocaleString('ko-KR');

type NationSummary = NonNullable<Home['nation']> | NationView;

// 국가 요약 칸이다. 소속국만 국고·군량·세율·기술을 받는다. 다른 국가는 —와 이유를 보여 준다.
export function NationSummaryGrid({
  nation,
  capitalName,
}: {
  nation: NationSummary;
  capitalName?: string | undefined;
}) {
  const member = isMemberNation(nation);
  const hidden = { value: '—', title: HIDDEN_NATION };
  return (
    <InfoGrid
      items={[
        { label: '속령', value: n(nation.cityCount) },
        { label: '장수', value: n(nation.generalCount) },
        member ? { label: '국고', value: n(nation.gold) } : { label: '국고', ...hidden },
        member ? { label: '군량', value: n(nation.rice) } : { label: '군량', ...hidden },
        member ? { label: '세율', value: `${Math.round(nation.taxRate * 100)}%` } : { label: '세율', ...hidden },
        member ? { label: '기술', value: n(Math.floor(nation.tech)) } : { label: '기술', ...hidden },
        member ? { label: '수도', value: capitalName ?? '—' } : { label: '수도', ...hidden },
        member ? { label: '성향', value: nation.philosophy || '—' } : { label: '성향', ...hidden },
      ]}
    />
  );
}

export function useNation(worldId: string, nationId: number, enabled = true) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.nation.get.queryOptions({ worldId, nationId }), enabled, retry: retryUnlessClientError });
}

// 메인의 국가 정보 칸. 요약을 먼저 보이고, 소속 장수·소유 도시 표는 같은 자리에서 펼친다.
export function NationInfo({
  worldId,
  nation,
  cities,
  onSelectCity,
}: {
  worldId: string;
  nation: Home['nation'];
  cities: readonly MapCity[];
  onSelectCity: (key: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (nation === null)
    return <EmptyState title="재야입니다">국가에 임관하면 국고·군량과 소속 장수를 여기서 봅니다.</EmptyState>;
  const capital = isMemberNation(nation) ? cities.find((city) => city.key === nation.capitalCityKey) : undefined;
  return (
    <div className={styles.nation} data-nation-id={nation.id}>
      <div className={styles.title} style={{ background: nation.color }}>
        <NationBadge name={nation.name} color={nation.color} />
        <Link
          to="/w/$worldId/nation/$nationId"
          params={{ worldId, nationId: String(nation.id) }}
          className={styles.more}
        >
          국가 화면
        </Link>
      </div>
      <NationSummaryGrid nation={nation} capitalName={capital?.name} />
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '소속 장수·도시 접기' : '소속 장수·도시 펼치기'}
      </button>
      {open ? <NationTables worldId={worldId} nationId={nation.id} onSelectCity={onSelectCity} /> : null}
    </div>
  );
}

// 국가의 소유 도시·소속 장수 표. 관리가 필요한 칸은 글자 표시와 색을 함께 쓴다.
export function NationTables({
  worldId,
  nationId,
  onSelectCity,
}: {
  worldId: string;
  nationId: number;
  onSelectCity?: (key: number) => void;
}) {
  const query = useNation(worldId, nationId);
  if (query.isPending) return <LoadingState />;
  if (query.isError)
    return <QueryError error={query.error} notFound="없는 국가입니다" onRetry={() => void query.refetch()} />;
  const data = query.data;
  const capitalKey = isMemberNation(data) ? data.capitalCityKey : null;
  const cityName = new Map(data.cities.map((city) => [city.key, city.name]));
  type City = (typeof data.cities)[number];
  type General = (typeof data.generals)[number];

  const cityColumns: Column<City>[] = [
    {
      key: 'name',
      label: '도시',
      sortValue: (c) => c.name,
      render: (c) =>
        onSelectCity ? (
          <button type="button" className={styles.cityButton} onClick={() => onSelectCity(c.key)}>
            {c.name}
          </button>
        ) : (
          <Link to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(c.key) }}>
            {c.name}
          </Link>
        ),
    },
    { key: 'level', label: '규모', numeric: true, sortValue: (c) => c.level, render: (c) => c.level },
    {
      key: 'state',
      label: '상태',
      sortValue: (c) => (c.supplied ? 1 : 0),
      render: (c) => (
        <span className={styles.tags}>
          {c.key === capitalKey ? <Tag tone="accent">수도</Tag> : null}
          {c.supplied ? null : <Tag tone="danger">보급 끊김</Tag>}
        </span>
      ),
    },
  ];

  const num = (pick: (g: Extract<General, { leadership: number }>) => number) => ({
    numeric: true,
    sortValue: (g: General) => (isDetailedGeneral(g) ? pick(g) : null),
    render: (g: General) => (isDetailedGeneral(g) ? n(pick(g)) : '—'),
    title: (g: General) => (isDetailedGeneral(g) ? undefined : HIDDEN_NATION),
  });
  const generalColumns: Column<General>[] = [
    { key: 'name', label: '장수', sortValue: (g) => g.name, render: (g) => g.name },
    {
      key: 'officer',
      label: '직책',
      sortValue: (g) => (isDetailedGeneral(g) ? g.officerLevel : null),
      render: (g) => (isDetailedGeneral(g) ? officerName(g.officerLevel, g.nationId !== null) : '—'),
    },
    {
      key: 'city',
      label: '위치',
      sortValue: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? String(g.cityKey)) : null),
      render: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? g.cityKey) : '—'),
    },
    { key: 'leadership', label: '통솔', ...num((g) => g.leadership) },
    { key: 'strength', label: '무력', ...num((g) => g.strength) },
    { key: 'intel', label: '지력', ...num((g) => g.intel) },
    { key: 'crew', label: '병력', ...num((g) => g.crew) },
    { key: 'train', label: '훈련', ...num((g) => g.train) },
    { key: 'atmos', label: '사기', ...num((g) => g.atmos) },
    {
      key: 'care',
      label: '관리',
      render: (g) => (isDetailedGeneral(g) ? <GeneralCare general={g} /> : null),
    },
  ];

  return (
    <div className={styles.tables}>
      {isMemberNation(data) ? null : (
        <p className={styles.note} role="note">
          {HIDDEN_NATION}라 장수 수치와 국고는 보이지 않습니다.
        </p>
      )}
      <DataTable
        caption={`소유 도시 ${data.cities.length}곳`}
        rows={data.cities}
        columns={cityColumns}
        rowKey={(c) => c.key}
      />
      <DataTable
        caption={`소속 장수 ${data.generals.length}명`}
        rows={data.generals}
        columns={generalColumns}
        rowKey={(g) => g.id}
      />
    </div>
  );
}

// 관리 필요 표시 (myosam 아이디어). 부상, 병력이 있는데 훈련·사기가 낮은 경우를 노랑으로 표시한다.
export function careTags(general: { injury: number; crew: number; train: number; atmos: number }): string[] {
  const tags: string[] = [];
  if (general.injury > 0) tags.push(`부상 ${general.injury}`);
  if (general.crew > 0 && general.train < 50) tags.push('훈련 부족');
  if (general.crew > 0 && general.atmos < 50) tags.push('사기 부족');
  return tags;
}

function GeneralCare({ general }: { general: { injury: number; crew: number; train: number; atmos: number } }) {
  const tags = careTags(general);
  return (
    <span className={styles.tags}>
      {tags.map((tag) => (
        <Tag key={tag} tone="warning">
          {tag}
        </Tag>
      ))}
    </span>
  );
}
