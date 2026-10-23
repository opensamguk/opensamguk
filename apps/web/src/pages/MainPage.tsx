import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, type ReactNode } from 'react';
import { errorCode } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { CityInfo } from '../main/CityInfo';
import { GeneralInfo } from '../main/GeneralInfo';
import { NationInfo } from '../main/NationInfo';
import { Panel } from '../main/Panel';
import { RECORD_LABELS, RecordList } from '../main/Records';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { PolicyBar } from '../policy/PolicyBar';
import { TurnEditor } from '../turns/TurnEditor';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './MainPage.module.css';

// 메인 작업 화면이다. 원작 core2026 MainView(R1, df6c926)의 데스크톱 배치를 따른다.
// 지도(왼쪽)와 명령 목록(오른쪽)을 한 화면에 두고, 지도 아래 도시 정보, 그 아래 국가·장수 정보, 맨 아래 기록을 둔다.
// 지도에서 도시를 고르면 주소의 ?city만 바꾼다. 같은 화면이 유지되므로 다른 칸의 상태(예턴 편집 초안 등)는 그대로다.
export function MainPage() {
  const worldId = useWorldId();
  const { city: selected } = useSearch({ from: '/w/$worldId/' });
  const navigate = useNavigate({ from: '/w/$worldId/' });
  const summary = useWorldSummary(worldId);
  const home = useHome(worldId);
  const map = useWorldMap(worldId);

  const selectCity = useCallback(
    (key: number) => void navigate({ search: (prev) => ({ ...prev, city: key }), replace: true, resetScroll: false }),
    [navigate],
  );

  const noGeneral = home.isError && errorCode(home.error) === 'NOT_FOUND';
  const homeData = home.data;
  const myCityKey = homeData?.general.cityKey ?? null;
  const cityKey = selected ?? myCityKey;
  const cities = map.data?.cities ?? [];
  const nations = map.data?.nations ?? [];
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const cityName = (key: number) => cities.find((city) => city.key === key)?.name ?? String(key);

  const withHome = (render: (data: NonNullable<typeof homeData>) => ReactNode) => {
    if (homeData) return render(homeData);
    if (noGeneral) return <NoGeneral worldId={worldId} />;
    if (home.isError)
      return <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />;
    return <LoadingState />;
  };

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.h1}>메인</h1>
        {summary.data ? (
          <p className={styles.progress} aria-label="게임 진행 정보">
            <span>
              현재 {summary.data.gameDate.year}년 {summary.data.gameDate.month}월
            </span>
            <span>턴 {summary.data.turnTermMinutes}분</span>
            <span>국가 {nations.length}</span>
            <span>도시 {cities.length}</span>
          </p>
        ) : null}
      </header>

      <div className={styles.layout}>
        <Panel
          title="지도"
          area="map"
          flush
          actions={
            myCityKey !== null && cityKey !== myCityKey ? (
              <button type="button" className={styles.action} onClick={() => selectCity(myCityKey)}>
                내 도시로
              </button>
            ) : null
          }
        >
          {map.data ? (
            <div className={styles.mapBody}>
              <WorldMap
                cities={cities}
                nations={nations}
                myCityKey={myCityKey}
                selectedKey={cityKey}
                onSelect={selectCity}
              />
              <MapLegend cities={cities} nations={nations} />
            </div>
          ) : map.isError ? (
            <QueryError error={map.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void map.refetch()} />
          ) : (
            <LoadingState />
          )}
        </Panel>

        {/* 30칸 예턴 편집기(T1-15). 지도 선택은 대상 도시 기본값으로만 넘긴다. 조회 상태와 무관하게 늘 같은 자리에 두어
            도시 선택·재조회 때 다시 만들지 않는다. 그래서 저장하지 않은 편집과 고른 칸이 유지된다. */}
        <Panel title="명령 목록" area="commands">
          <PolicyBar worldId={worldId} />
          <TurnEditor worldId={worldId} selectedCityKey={cityKey} />
        </Panel>

        <Panel title="도시 정보" area="city">
          {cityKey !== null ? (
            <CityInfo worldId={worldId} cityKey={cityKey} nations={nations} onSelectCity={selectCity} />
          ) : home.isPending ? (
            <LoadingState />
          ) : (
            <EmptyState title="지도에서 도시를 고르세요" />
          )}
        </Panel>

        <Panel title="국가 정보" area="nation">
          {withHome((data) => (
            <NationInfo worldId={worldId} nation={data.nation} cities={cities} onSelectCity={selectCity} />
          ))}
        </Panel>

        <Panel title="장수 정보" area="general">
          {withHome((data) => (
            <GeneralInfo
              worldId={worldId}
              home={data}
              cityName={cityName(data.general.cityKey)}
              nation={data.general.nationId === null ? undefined : nationById.get(data.general.nationId)}
              onSelectCity={selectCity}
            />
          ))}
        </Panel>

        <div className={styles.records}>
          <Panel title={RECORD_LABELS.general} area="general-records">
            <RecordList kind="general" worldId={worldId} clock={summary.data} nations={nations} compact />
          </Panel>
          <Panel title={RECORD_LABELS.nation} area="nation-records">
            <RecordList
              kind="nation"
              worldId={worldId}
              clock={summary.data}
              nations={nations}
              hasNation={homeData ? homeData.nation !== null : !noGeneral}
              compact
            />
          </Panel>
          <Panel title={RECORD_LABELS.world} area="world-records">
            <RecordList kind="world" worldId={worldId} clock={summary.data} nations={nations} compact />
          </Panel>
        </div>
      </div>
    </section>
  );
}
