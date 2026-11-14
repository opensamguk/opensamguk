// 지도 바탕 게임 화면 (INT-29, D-093). 전체 군략도를 화면 바탕에 깔고 그 위에 띠·판·기록을 얹는다.
// 1단계(껍데기): 메인(/w/:id)의 내용을 그대로 쓰되 자리만 바꾼다. 주소 ?ui=map일 때만 연다.
// - 위 띠: 플레이어가 맡은 장수(맨 앞), 소속 국가, 연월·다음 턴, 메시지·메뉴
// - 왼쪽 판 "나와 휘하": 장수·도시·국가 정보 탭
// - 오른쪽 판 "내 예턴": 방침과 30칸 예턴 편집기
// - 왼쪽 아래 기록, 맨 아래 상태 줄. 배율 단추는 지도(Map3D stage)가 오른쪽 아래에 띄운다.
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AdvicePanel } from '../advice/AdvicePanel';
import { errorCode } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { useEquipment } from '../equipment/useEquipment';
import { AccountLinks } from '../layout/AccountLinks';
import { CityInfo } from '../main/CityInfo';
import { formatClock, GeneralInfo } from '../main/GeneralInfo';
import { MainRecords } from '../main/MainRecords';
import { NationInfo } from '../main/NationInfo';
import { WorldMap } from '../main/WorldMap';
import { useAuthority } from '../messages/authority';
import { unreadTotal } from '../messages/merge';
import { useUnread } from '../messages/queries';
import { MainMenu } from '../pages/MainPage';
import { PolicyBar } from '../policy/PolicyBar';
import { Portrait } from '../portrait/Portrait';
import { TurnEditor } from '../turns/TurnEditor';
import { useTRPC } from '../trpc';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './MapStage.module.css';

type InfoTab = 'general' | 'city' | 'nation';
const INFO_TABS: ReadonlyArray<{ key: InfoTab; label: string }> = [
  { key: 'general', label: '내 장수' },
  { key: 'city', label: '도시' },
  { key: 'nation', label: '국가' },
];

const n = (value: number) => value.toLocaleString('ko-KR');
// 좁은 화면(휴대폰)은 판을 닫은 채로 열어 지도를 먼저 보인다.
const narrowScreen = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 899px)').matches === true;

export function MapStage() {
  const worldId = useWorldId();
  const { city: selected } = useSearch({ from: '/w/$worldId/' });
  const navigate = useNavigate({ from: '/w/$worldId/' });
  const summary = useWorldSummary(worldId);
  const home = useHome(worldId);
  const map = useWorldMap(worldId);
  const trpc = useTRPC();
  const mine = useQuery(trpc.general.mine.queryOptions({ worldId }));
  const equipment = useEquipment(worldId, summary.data?.equipmentEnabled === true, home.data?.general.id);
  const authority = useAuthority(worldId);
  const unread = useUnread(worldId);
  const unreadCount = unreadTotal(authority.ready ? unread.data : undefined);

  const [leftOpen, setLeftOpen] = useState(() => !narrowScreen());
  const [rightOpen, setRightOpen] = useState(() => !narrowScreen());
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<InfoTab>('general');

  // Esc는 위에 뜬 것부터 닫는다(메뉴 → 기록). 판은 닫지 않는다(예턴 편집 중 실수로 닫히지 않게).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      else if (recordsOpen) setRecordsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, recordsOpen]);

  // 지도에서 도시를 고르면 도시 탭을 연다. 주소의 city만 바꾸고 화면은 그대로다(메인과 같다).
  const selectCity = useCallback(
    (key: number) => {
      void navigate({
        search: (prev) => ({ ...prev, city: key }),
        replace: true,
        resetScroll: false,
      });
      setInfoTab('city');
      setLeftOpen(true);
    },
    [navigate],
  );

  const noGeneral = home.isError && errorCode(home.error) === 'NOT_FOUND';
  const data = home.data;
  const general = data?.general;
  const myCityKey = general?.cityKey ?? null;
  const cityKey = selected ?? myCityKey;
  const cities = map.data?.cities ?? [];
  const nations = map.data?.nations ?? [];
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const cityName = (key: number | null) =>
    key === null ? '—' : (cities.find((city) => city.key === key)?.name ?? String(key));
  const nation = data?.nation ?? null;
  const name = general ? displayName(general.name) : '';
  const date = summary.data ? `${summary.data.gameDate.year}년 ${summary.data.gameDate.month}월` : '';

  const withHome = (render: (home: NonNullable<typeof data>) => ReactNode) => {
    if (data) return render(data);
    if (noGeneral) return <NoGeneral worldId={worldId} />;
    if (home.isError)
      return <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />;
    return <LoadingState />;
  };

  return (
    <div className={styles.stage} data-testid="map-stage">
      <div className={styles.map}>
        {map.data ? (
          <WorldMap
            operationalMap={map.data.operationalMap}
            cities={cities}
            nations={nations}
            myCityKey={myCityKey}
            myNationId={general ? general.nationId : undefined}
            selectedKey={cityKey}
            onSelect={selectCity}
            generals={map.data.generals}
            fill
            stage
          />
        ) : map.isError ? (
          <QueryError error={map.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void map.refetch()} />
        ) : (
          <LoadingState />
        )}
      </div>

      <header className={styles.top}>
        {general ? (
          <Link
            to="/w/$worldId/me"
            params={{ worldId }}
            className={styles.me}
            aria-label={`내 장수 ${name}: 내 정보 열기`}
            data-testid="stage-me"
          >
            <span className={styles.meFace}>
              <Portrait id={general.portraitId} name={name} variant="icon" shape="round" size={48} decorative />
              {nation ? (
                <span className={styles.meNation} style={{ background: nation.color }} aria-hidden="true">
                  {Array.from(nation.name)[0]}
                </span>
              ) : null}
            </span>
            <span className={styles.meText}>
              <span className={styles.meLine}>
                <strong className={styles.meName}>{name}</strong>
                <span className={styles.meTag}>나</span>
                <span className={styles.muted}>
                  {nation ? nation.name : '재야'} · {officerName(general.officerLevel, general.nationId !== null)} ·{' '}
                  {cityName(general.cityKey)}
                </span>
              </span>
              <span className={styles.meStats}>
                통솔 <b>{general.leadership}</b> · 무력 <b>{general.strength}</b> · 지력 <b>{general.intel}</b> · 병력{' '}
                <b>{n(general.crew)}</b> · 금 <b>{n(general.gold)}</b> · 쌀 <b>{n(general.rice)}</b>
              </span>
            </span>
          </Link>
        ) : (
          <span className={styles.me}>{noGeneral ? '장수가 없습니다' : '장수를 불러오는 중입니다'}</span>
        )}
        {nation ? (
          <Link
            to="/w/$worldId/nation/$nationId"
            params={{ worldId, nationId: String(nation.id) }}
            className={styles.nation}
          >
            <span className={styles.nationMark} style={{ background: nation.color }} aria-hidden="true">
              {Array.from(nation.name)[0]}
            </span>
            <span className={styles.meText}>
              <strong>{nation.name}</strong>
              <span className={styles.muted}>
                도시 {nation.cityCount} · 장수 {nation.generalCount}
                {'gold' in nation &&
                typeof nation.gold === 'number' &&
                'rice' in nation &&
                typeof nation.rice === 'number'
                  ? ` · 국고 금 ${n(nation.gold)} · 쌀 ${n(nation.rice)}`
                  : ''}
              </span>
            </span>
          </Link>
        ) : null}
        <span className={styles.clock}>
          <strong>{date}</strong>
          <span className={styles.muted}>
            다음 턴 {data ? formatClock(data.nextTurnAt) : '—'}
            {summary.data ? ` · 턴 ${summary.data.turnTermMinutes}분` : ''}
          </span>
        </span>
        <span className={styles.spacer} />
        <Link to="/w/$worldId/messages" params={{ worldId }} className={styles.topButton}>
          메시지
          {unreadCount > 0 ? <span className={styles.count}>{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
        </Link>
        <Link
          to="/w/$worldId"
          params={{ worldId }}
          search={selected ? { city: selected } : {}}
          className={`${styles.topButton} ${styles.legacy}`}
        >
          기존 화면
        </Link>
        <button
          type="button"
          className={styles.topButton}
          aria-expanded={menuOpen}
          aria-controls="stage-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          메뉴
        </button>
      </header>

      {menuOpen ? (
        <nav id="stage-menu" className={styles.menu} aria-label="게임 메뉴">
          <MainMenu
            worldId={worldId}
            nationId={nation?.id ?? null}
            campaignEnabled={mine.data?.creationRules.campaignEnabled === true}
            cityKey={myCityKey}
          />
          <div className={styles.menuFoot}>
            <Link to="/lobby" className={styles.menuLink}>
              로비
            </Link>
            <Link to="/w/$worldId" params={{ worldId }} className={styles.menuLink}>
              기존 화면
            </Link>
            <AccountLinks className={styles.menuLink} logout />
          </div>
        </nav>
      ) : null}

      {leftOpen ? (
        <aside className={`${styles.panel} ${styles.left}`} aria-labelledby="stage-left-title">
          <div className={styles.panelHead}>
            <span className={styles.seal} aria-hidden="true">
              將
            </span>
            <h2 id="stage-left-title" className={styles.panelTitle}>
              나와 휘하
            </h2>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.close}
              aria-label="나와 휘하 판 닫기"
              onClick={() => setLeftOpen(false)}
            >
              닫기
            </button>
          </div>
          <div className={styles.tabs} role="tablist" aria-label="정보 갈래">
            {INFO_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={infoTab === tab.key}
                className={styles.tab}
                onClick={() => setInfoTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className={styles.panelBody}>
            {infoTab === 'general' ? (
              withHome((home) => (
                <GeneralInfo
                  equipment={equipment}
                  worldId={worldId}
                  home={home}
                  campaignEnabled={mine.data?.creationRules.campaignEnabled ?? false}
                  cityName={cityName(home.general.cityKey)}
                  nation={home.general.nationId === null ? undefined : nationById.get(home.general.nationId)}
                  onSelectCity={selectCity}
                />
              ))
            ) : infoTab === 'city' ? (
              cityKey !== null ? (
                <CityInfo
                  worldId={worldId}
                  cityKey={cityKey}
                  nations={nations}
                  onSelectCity={selectCity}
                  logisticsEnabled={summary.data?.logisticsEnabled === true}
                  summary
                />
              ) : (
                <EmptyState title="지도에서 도시를 고르세요" />
              )
            ) : (
              withHome((home) => <NationInfo worldId={worldId} nation={home.nation} cities={cities} />)
            )}
          </div>
        </aside>
      ) : (
        <button type="button" className={`${styles.handle} ${styles.handleLeft}`} onClick={() => setLeftOpen(true)}>
          나와 휘하
        </button>
      )}

      {/* 예턴 편집기는 닫아도 내리지 않고 감춘다. 저장하지 않은 편집이 남는다(메인과 같다). */}
      <aside className={`${styles.panel} ${styles.right}`} aria-labelledby="stage-right-title" hidden={!rightOpen}>
        <div className={styles.panelHead}>
          <span className={`${styles.seal} ${styles.sealBlue}`} aria-hidden="true">
            令
          </span>
          <h2 id="stage-right-title" className={styles.panelTitle}>
            내 예턴{name ? ` · ${name}` : ''}
          </h2>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.close}
            aria-label="내 예턴 판 닫기"
            onClick={() => setRightOpen(false)}
          >
            닫기
          </button>
        </div>
        <div className={styles.panelBody}>
          <PolicyBar worldId={worldId} />
          <TurnEditor
            worldId={worldId}
            selectedCityKey={selected ?? null}
            renderTop={(draft) => <AdvicePanel key={worldId} worldId={worldId} draft={draft} />}
          />
        </div>
      </aside>
      {rightOpen ? null : (
        <button type="button" className={`${styles.handle} ${styles.handleRight}`} onClick={() => setRightOpen(true)}>
          내 예턴
        </button>
      )}

      <section
        className={`${styles.records} ${recordsOpen ? styles.recordsOpen : ''}`}
        aria-labelledby="stage-records-title"
      >
        <div className={styles.panelHead}>
          <h2 id="stage-records-title" className={styles.panelTitle}>
            기록
          </h2>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.close}
            aria-expanded={recordsOpen}
            aria-controls="stage-records-body"
            onClick={() => setRecordsOpen((open) => !open)}
          >
            {recordsOpen ? '접기' : '펼치기'}
          </button>
        </div>
        {recordsOpen ? (
          <div id="stage-records-body" className={styles.panelBody}>
            <MainRecords worldId={worldId} clock={summary.data} nations={nations} cities={cities} />
          </div>
        ) : null}
      </section>

      <footer className={styles.status} aria-label="상태 줄">
        <span>
          플레이 <b>{name || '—'}</b>
          {nation ? ` (${nation.name})` : general ? ' (재야)' : ''}
        </span>
        <span>
          고른 거점 <b>{cityName(cityKey)}</b>
        </span>
        <span className={styles.spacer} />
        <span>{date}</span>
        <span>
          다음 턴 <b>{data ? formatClock(data.nextTurnAt) : '—'}</b>
        </span>
      </footer>
    </div>
  );
}
