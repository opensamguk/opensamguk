import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { errorCode } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { CityInfo } from '../main/CityInfo';
import { GeneralInfo } from '../main/GeneralInfo';
import { useEquipment } from '../equipment/useEquipment';
import { NationInfo } from '../main/NationInfo';
import { Panel } from '../main/Panel';
import { MainRecords } from '../main/MainRecords';
import { SeasonResult } from '../main/SeasonResult';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { PolicyBar } from '../policy/PolicyBar';
import { OfferBox } from '../personnel/OfferBox';
import { TurnEditor, type TurnEditorStatus } from '../turns/TurnEditor';
import { EmptyState, LoadingState } from '../ui/States';
import { useTRPC } from '../trpc';
import styles from './MainPage.module.css';

const SECTIONS = [
  { area: 'map', label: '지도', name: '지도로 이동' },
  { area: 'city', label: '도시', name: '도시로 이동' },
  { area: 'commands', label: '예턴', name: '예턴으로 이동' },
  { area: 'nation', label: '국가', name: '국가로 이동' },
  { area: 'general', label: '장수', name: '장수로 이동' },
  { area: 'general-records', label: '기록', name: '기록으로 이동' },
] as const;

// 바로가기 띠의 예턴 상태 (T4-97 U2). 편집기가 알린 값만 옮기며 저장은 편집기에서만 한다.
function turnStatusText(status: TurnEditorStatus): string {
  const behind = 'behind' in status && status.behind ? ' · 다른 곳에서 바뀜' : '';
  switch (status.kind) {
    case 'loading':
      return '예턴을 불러오는 중';
    case 'error':
      return '예턴을 불러오지 못했습니다';
    case 'authLost':
      return '다시 로그인해야 저장할 수 있습니다';
    case 'readOnly':
      return '읽기 전용 예턴';
    case 'ended':
      return '끝난 판이라 예턴을 바꿀 수 없습니다';
    case 'conflict':
      return `충돌 확인 필요 · 보관한 편집 ${status.edits}건`;
    case 'saving':
      return '저장하는 중';
    case 'unsaved':
      return `저장하지 않은 편집 ${status.edits}건${behind}`;
    case 'saved':
      return `저장된 목록${behind}`;
  }
}

// 좁은 단추에 얹는 짧은 표. 손볼 일이 있을 때만 보인다.
function turnStatusBadge(status: TurnEditorStatus): string | null {
  if (status.kind === 'unsaved') return String(status.edits);
  if (status.kind === 'saving') return '…';
  if (status.kind === 'conflict' || status.kind === 'error' || status.kind === 'authLost') return '!';
  return null;
}

// 메인 작업 화면이다. 원작 core2026 MainView(R1, df6c926)의 데스크톱 배치를 따른다.
// 지도(왼쪽)와 명령 목록(오른쪽)을 한 화면에 두고, 지도 아래 도시 정보, 그 아래 국가·장수 정보, 맨 아래 기록을 둔다.
// 지도에서 도시를 고르면 주소의 ?city만 바꾼다. 같은 화면이 유지되므로 다른 칸의 상태(예턴 편집 초안 등)는 그대로다.
export function MainPage() {
  const page = useRef<HTMLElement>(null);
  const focusSection = useCallback((area: string) => {
    const heading = page.current?.querySelector<HTMLElement>(`[data-main-area="${area}"] h2`);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, []);
  const worldId = useWorldId();
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    if (hash === 'main-commands') focusSection('commands');
  }, [hash, worldId, focusSection]);
  const { city: selected } = useSearch({ from: '/w/$worldId/' });
  const navigate = useNavigate({ from: '/w/$worldId/' });
  const summary = useWorldSummary(worldId);
  const home = useHome(worldId);
  const trpc = useTRPC();
  const mine = useQuery(trpc.general.mine.queryOptions({ worldId }));
  const equipment = useEquipment(worldId, summary.data?.equipmentEnabled === true, home.data?.general.id);
  const map = useWorldMap(worldId);
  const [turnStatus, setTurnStatus] = useState<TurnEditorStatus | null>(null);
  const turnStatusId = useId();

  const selectCity = useCallback(
    (key: number) => void navigate({ search: (prev) => ({ ...prev, city: key }), replace: true, resetScroll: false }),
    [navigate],
  );

  // 지도에서 고른 도시는 이미 명령의 대상 도시 기본값이다. 여기서는 명령 칸으로 옮기기만 하고 바로 넣지 않는다.
  // 고른 칸이 있으면 명령 찾기로, 없으면 칸 목록으로 간다 (칸에서 Enter를 누르면 명령 찾기로 간다).
  const editable = turnStatus?.kind === 'saved' || turnStatus?.kind === 'unsaved';
  const chooseForCity = () => {
    const area = page.current?.querySelector('[data-main-area="commands"]');
    const hasSelection = turnStatus && 'selection' in turnStatus && turnStatus.selection > 0;
    const target = area?.querySelector<HTMLElement>(hasSelection ? 'input[type="search"]' : 'tr[tabindex="0"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  };

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
    <section className={styles.page} ref={page}>
      <header className={styles.header}>
        <h1 className={styles.h1}>군략도</h1>
        {summary.data ? (
          <p className={styles.progress} aria-label="게임 진행 정보">
            <span>
              현재 {summary.data.gameDate.year}년 {summary.data.gameDate.month}월
            </span>
            <span>턴 {summary.data.turnTermMinutes}분</span>
            <span>국가 {nations.length}</span>
            <span>
              {map.data?.operationalMap ? '거점' : '도시'} {cities.length}
            </span>
          </p>
        ) : null}
      </header>

      <nav className={styles.sections} aria-label="메인 영역 바로가기">
        {SECTIONS.map(({ area, label, name }) => {
          // 장수가 없는 계정은 예턴 상태 대신 장수 만들기 안내를 본다.
          const status = area === 'commands' && turnStatus && !noGeneral ? turnStatus : null;
          const badge = status ? turnStatusBadge(status) : null;
          return (
            <button
              key={area}
              type="button"
              className={styles.sectionLink}
              aria-label={name}
              aria-controls={`main-${area}`}
              aria-describedby={status ? turnStatusId : undefined}
              data-turn-status={status?.kind}
              title={status ? turnStatusText(status) : undefined}
              onClick={() => focusSection(area)}
            >
              {label}
              {badge ? (
                <span className={styles.turnBadge} aria-hidden="true">
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
        {turnStatus && !noGeneral ? (
          <span id={turnStatusId} className={styles.srOnly} data-testid="main-turn-status">
            {turnStatusText(turnStatus)}
          </span>
        ) : null}
      </nav>

      {/* 끝난 판이면 결과를 맨 위에 둔다. 나머지 칸은 그대로 읽는다 (T1-27). */}
      {summary.data?.status === 'ENDED' ? <SeasonResult result={summary.data.result} /> : null}
      {/* 발령 제안(T2-06, D11). 편집기와 형제라 응답 결과가 와도 예턴 초안과 지도 선택은 그대로다. */}
      <OfferBox worldId={worldId} />

      <div className={styles.layout}>
        <Panel
          title="지도"
          area="map"
          headingId="main-map"
          flush
          actions={
            <>
              {cityKey !== null ? (
                <button type="button" className={styles.action} onClick={() => focusSection('city')}>
                  도시 정보 보기
                </button>
              ) : null}
              {myCityKey !== null && cityKey !== myCityKey ? (
                <button type="button" className={styles.action} onClick={() => selectCity(myCityKey)}>
                  내 도시로
                </button>
              ) : null}
            </>
          }
        >
          {map.data ? (
            <div className={styles.mapBody}>
              <WorldMap
                operationalMap={map.data.operationalMap}
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

        <MainMenu
          worldId={worldId}
          nationId={homeData?.nation?.id ?? null}
          campaignEnabled={mine.data?.creationRules.campaignEnabled === true}
          cityKey={myCityKey}
        />

        <Panel
          title="도시 정보"
          area="city"
          headingId="main-city"
          actions={
            cityKey !== null && editable ? (
              <button type="button" className={styles.action} onClick={chooseForCity}>
                이 도시로 명령 고르기
              </button>
            ) : null
          }
        >
          {cityKey !== null ? (
            <CityInfo
              worldId={worldId}
              cityKey={cityKey}
              nations={nations}
              onSelectCity={selectCity}
              logisticsEnabled={summary.data?.logisticsEnabled === true}
              summary
            />
          ) : home.isPending ? (
            <LoadingState />
          ) : (
            <EmptyState title="지도에서 도시를 고르세요" />
          )}
        </Panel>

        {/* 30칸 예턴 편집기(T1-15). 지도 선택은 대상 도시 기본값으로만 넘긴다. 조회 상태와 무관하게 늘 같은 자리에 두어
            도시 선택·재조회 때 다시 만들지 않는다. 그래서 저장하지 않은 편집과 고른 칸이 유지된다. */}
        <Panel title="명령 목록" area="commands" headingId="main-commands">
          <PolicyBar worldId={worldId} />
          <TurnEditor worldId={worldId} selectedCityKey={selected ?? null} onStatus={setTurnStatus} />
        </Panel>

        <Panel title="국가 정보" area="nation" headingId="main-nation">
          {withHome((data) => (
            <NationInfo worldId={worldId} nation={data.nation} cities={cities} />
          ))}
        </Panel>

        <Panel title="장수 정보" area="general" headingId="main-general">
          {withHome((data) => (
            <GeneralInfo
              equipment={equipment}
              worldId={worldId}
              home={data}
              campaignEnabled={mine.data?.creationRules.campaignEnabled ?? false}
              cityName={cityName(data.general.cityKey)}
              nation={data.general.nationId === null ? undefined : nationById.get(data.general.nationId)}
              onSelectCity={selectCity}
            />
          ))}
        </Panel>

        <MainRecords
          className={styles.records}
          worldId={worldId}
          clock={summary.data}
          nations={nations}
          cities={cities}
          hasNation={homeData ? homeData.nation !== null : !noGeneral}
        />
      </div>
    </section>
  );
}

// 국가·내 장수 메뉴 (INT-25, 원작 국가 메뉴 2줄). 메인에서 옮긴 전용 화면과 기존 화면으로 한 번에 간다.
function MainMenu({
  worldId,
  nationId,
  campaignEnabled,
  cityKey,
}: {
  worldId: string;
  nationId: number | null;
  campaignEnabled: boolean;
  cityKey: number | null;
}) {
  return (
    <nav className={styles.menu} aria-label="국가와 내 장수 메뉴">
      <div className={styles.menuRow}>
        <span className={styles.menuHead}>국가</span>
        <Link to="/w/$worldId/nation/personnel" params={{ worldId }} className={styles.menuItem}>
          인사부
        </Link>
        <Link to="/w/$worldId/nation/turns" params={{ worldId }} className={styles.menuItem}>
          국가 예턴
        </Link>
        <Link to="/w/$worldId/operations" params={{ worldId }} className={styles.menuItem}>
          작전
        </Link>
        <Link to="/w/$worldId/nation/inspection" params={{ worldId }} className={styles.menuItem}>
          감찰
        </Link>
        <Link to="/w/$worldId/diplomacy" params={{ worldId }} search={{ tab: 'nations' }} className={styles.menuItem}>
          외교실
        </Link>
        <Link to="/w/$worldId/nation/governance" params={{ worldId }} className={styles.menuItem}>
          통치
        </Link>
        {nationId !== null ? (
          <Link
            to="/w/$worldId/nation/$nationId"
            params={{ worldId, nationId: String(nationId) }}
            hash="cities"
            className={styles.menuItem}
          >
            세력 도시
          </Link>
        ) : null}
        {nationId !== null ? (
          <Link
            to="/w/$worldId/nation/$nationId"
            params={{ worldId, nationId: String(nationId) }}
            className={styles.menuItem}
          >
            세력 장수
          </Link>
        ) : null}
      </div>
      <div className={styles.menuRow}>
        <span className={styles.menuHead}>내 장수</span>
        {cityKey !== null ? (
          <Link
            to="/w/$worldId/city/$cityKey"
            params={{ worldId, cityKey: String(cityKey) }}
            className={styles.menuItem}
          >
            현재 도시
          </Link>
        ) : null}
        {campaignEnabled ? (
          <Link to="/w/$worldId/campaign" params={{ worldId }} className={styles.menuItem}>
            휘하·부곡
          </Link>
        ) : null}
        {campaignEnabled ? (
          <Link to="/w/$worldId/campaign" params={{ worldId }} hash="retinue-orders" className={styles.menuItem}>
            장수 지시
          </Link>
        ) : null}
        <Link to="/w/$worldId/inbox" params={{ worldId }} className={styles.menuItem}>
          제안함
        </Link>
        <Link to="/w/$worldId/me" params={{ worldId }} className={styles.menuItem}>
          내 정보
        </Link>
        <Link to="/w/$worldId/messages" params={{ worldId }} className={styles.menuItem}>
          메시지
        </Link>
        <Link to="/w/$worldId/map" params={{ worldId }} className={styles.menuItem}>
          지도 크게
        </Link>
      </div>
    </nav>
  );
}
