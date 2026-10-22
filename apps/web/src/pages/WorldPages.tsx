import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { isMemberNation } from '../game/types';
import { CityInfo } from '../main/CityInfo';
import { NationSummaryGrid, NationTables, useNation } from '../main/NationInfo';
import { Panel } from '../main/Panel';
import { RECORD_LABELS, RecordList, type RecordKind } from '../main/Records';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './WorldPages.module.css';

// 직접 주소로 들어오는 보조 화면들. 메인 작업 화면의 부품을 그대로 쓰며, 메인에서 하는 조작을 대신하지 않는다.

const backToMain = (worldId: string, city?: number) => (
  <Link to="/w/$worldId" params={{ worldId }} search={city === undefined ? {} : { city }} className={styles.back}>
    메인에서 보기
  </Link>
);

// /w/:worldId/map: 지도를 크게 본다. 도시를 고르면 아래에 그 도시 정보가 나온다.
export function MapPage() {
  const worldId = useWorldId();
  const map = useWorldMap(worldId);
  const home = useHome(worldId);
  const [selected, setSelected] = useState<number | null>(null);
  const myCityKey = home.data?.general.cityKey ?? null;
  const cityKey = selected ?? myCityKey;
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>지도</h1>
        {backToMain(worldId, cityKey ?? undefined)}
      </header>
      {map.data ? (
        <>
          <Panel title="중원 지도" flush>
            <div className={styles.mapBody}>
              <WorldMap
                cities={map.data.cities}
                nations={map.data.nations}
                myCityKey={myCityKey}
                selectedKey={cityKey}
                onSelect={setSelected}
              />
              <MapLegend cities={map.data.cities} nations={map.data.nations} />
            </div>
          </Panel>
          {cityKey !== null ? (
            <Panel title="도시 정보">
              <CityInfo worldId={worldId} cityKey={cityKey} nations={map.data.nations} onSelectCity={setSelected} />
            </Panel>
          ) : null}
        </>
      ) : map.isError ? (
        <QueryError error={map.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void map.refetch()} />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}

// /w/:worldId/city/:cityKey: 도시 하나의 정보와 주둔 장수.
export function CityPage({ cityKeyParam }: { cityKeyParam: string }) {
  const worldId = useWorldId();
  const map = useWorldMap(worldId);
  const navigate = useNavigate();
  const cityKey = /^[1-9][0-9]{0,9}$/.test(cityKeyParam) ? Number(cityKeyParam) : null;
  const name = cityKey === null ? undefined : map.data?.cities.find((city) => city.key === cityKey)?.name;
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>{name ? `도시 정보 · ${name}` : '도시 정보'}</h1>
        {cityKey !== null ? backToMain(worldId, cityKey) : null}
      </header>
      {cityKey === null ? (
        <EmptyState title="도시 번호가 올바르지 않습니다" />
      ) : (
        <Panel title="도시 정보">
          <CityInfo
            worldId={worldId}
            cityKey={cityKey}
            nations={map.data?.nations ?? []}
            onSelectCity={(key) =>
              void navigate({ to: '/w/$worldId/city/$cityKey', params: { worldId, cityKey: String(key) } })
            }
          />
        </Panel>
      )}
    </section>
  );
}

// /w/:worldId/nation/:nationId: 국가 요약과 소유 도시·소속 장수 표. 다른 국가는 공개 범위만.
export function NationPage({ nationIdParam }: { nationIdParam: string }) {
  const worldId = useWorldId();
  const map = useWorldMap(worldId);
  const nationId = /^[1-9][0-9]{0,9}$/.test(nationIdParam) ? Number(nationIdParam) : null;
  const nation = useNation(worldId, nationId ?? 1, nationId !== null);
  const capitalKey = nation.data && isMemberNation(nation.data) ? nation.data.capitalCityKey : null;
  const capital = map.data?.cities.find((city) => city.key === capitalKey)?.name;
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>{nation.data ? `국가 정보 · ${nation.data.name}` : '국가 정보'}</h1>
        {backToMain(worldId)}
      </header>
      {nationId === null ? (
        <EmptyState title="국가 번호가 올바르지 않습니다" />
      ) : nation.data ? (
        <>
          <Panel title="국가 요약">
            <div className={styles.nationHead}>
              <NationBadge name={nation.data.name} color={nation.data.color} />
            </div>
            <NationSummaryGrid nation={nation.data} capitalName={capital} />
          </Panel>
          <Panel title="소유 도시·소속 장수">
            <NationTables worldId={worldId} nationId={nationId} />
          </Panel>
        </>
      ) : nation.isError ? (
        <QueryError error={nation.error} notFound="없는 국가입니다" onRetry={() => void nation.refetch()} />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}

const RECORD_TABS: Array<{ kind: RecordKind; label: string }> = [
  { kind: 'general', label: '내 장수' },
  { kind: 'nation', label: '국가 역사' },
  { kind: 'world', label: '월드 정세' },
];

// /w/:worldId/records?tab=: 기록을 넓게 이어 본다. 메인 아래 기록 칸과 같은 목록이다.
export function RecordsPage({ tab }: { tab: RecordKind }) {
  const worldId = useWorldId();
  const summary = useWorldSummary(worldId);
  const map = useWorldMap(worldId);
  const home = useHome(worldId);
  const label = RECORD_TABS.find((entry) => entry.kind === tab)!.label;
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>기록 · {label}</h1>
        {backToMain(worldId)}
      </header>
      <nav className={styles.tabs} aria-label="기록 종류">
        {RECORD_TABS.map((entry) => (
          <Link
            key={entry.kind}
            to="/w/$worldId/records"
            params={{ worldId }}
            search={{ tab: entry.kind }}
            className={styles.tab}
            aria-current={entry.kind === tab ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </nav>
      <Panel title={RECORD_LABELS[tab]}>
        <RecordList
          key={tab}
          kind={tab}
          worldId={worldId}
          clock={summary.data}
          nations={map.data?.nations ?? []}
          hasNation={home.data ? home.data.nation !== null : true}
        />
      </Panel>
    </section>
  );
}
