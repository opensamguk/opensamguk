// 지도 바탕 게임 화면 (INT-29, D-093). 전체 군략도를 화면 바탕에 깔고 그 위에 게임 화면 틀을 얹는다.
// 사용자 2026-11-14: "UI를 일종의 게임처럼 만들자. 웹사이트가 아닌. 모바일 버전은 모바일 게임을 플레이하는 것 같이."
// - 위 HUD: 나라 인장, 내 장수 초상 틀(맨 앞), 날짜와 다음 턴 원형 시계, 자원(금·쌀·병력), 아이콘 단추
// - 데스크톱: 왼쪽 아이콘 독(장수·도시·국가·기록)이 왼쪽 판을 열고, 오른쪽 판은 내 예턴이다.
// - 모바일: 지도 전체 화면, 아래 탭 막대, 판은 아래에서 끌어올리는 서랍(반쯤·끝까지)이다.
// 보이는 정보는 메인과 같고(devsam 동등성) 겉모습과 다루는 방식만 게임처럼 바꾼다. 주소 ?ui=map일 때만 연다.
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { AdvicePanel } from '../advice/AdvicePanel';
import { formatRemaining, useTurnCountdown } from '../game/countdown';
import { errorCode } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { useEquipment } from '../equipment/useEquipment';
import { AccountLinks } from '../layout/AccountLinks';
import { CityInfo } from '../main/CityInfo';
import { GeneralInfo } from '../main/GeneralInfo';
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
import { StageIcon, type StageIconName } from './stageIcons';
import { useStageSound } from './stageSound';
import styles from './MapStage.module.css';

type Panel = 'general' | 'city' | 'nation' | 'records';
const PANELS: ReadonlyArray<{ key: Panel; label: string; title: string; icon: StageIconName }> = [
  { key: 'general', label: '장수', title: '내 장수', icon: 'general' },
  { key: 'city', label: '도시', title: '도시', icon: 'city' },
  { key: 'nation', label: '국가', title: '국가', icon: 'nation' },
  { key: 'records', label: '기록', title: '기록', icon: 'records' },
];

const n = (value: number) => value.toLocaleString('ko-KR');
const NARROW = '(max-width: 899px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches === true;

// 화면 폭이 바뀌면(회전, 창 크기) 데스크톱 배치와 모바일 서랍을 오간다.
function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

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
  const sound = useStageSound();
  const narrow = useNarrow();

  // 데스크톱은 장수 판과 예턴 판을 연 채로, 모바일은 모두 닫은 채로 시작해 지도를 먼저 보인다.
  const [panel, setPanel] = useState<Panel | null>(() => (isNarrow() ? null : 'general'));
  const [turnsOpen, setTurnsOpen] = useState(() => !isNarrow());
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  const drag = useRef<number | null>(null);

  // 모바일 서랍은 한 번에 하나만 연다.
  const openPanel = useCallback(
    (key: Panel | null) => {
      const next = key === null || panel === key ? null : key;
      sound.play(next ? 'open' : 'close');
      setPanel(next);
      if (narrow && next !== null) setTurnsOpen(false);
      setSheetFull(false);
    },
    [narrow, panel, sound],
  );
  const toggleTurns = useCallback(() => {
    sound.play(turnsOpen ? 'close' : 'open');
    setTurnsOpen(!turnsOpen);
    if (narrow) setPanel(null);
    setSheetFull(false);
  }, [narrow, sound, turnsOpen]);
  const closeSheet = useCallback(() => {
    sound.play('close');
    if (narrow) {
      setPanel(null);
      setTurnsOpen(false);
    }
    setSheetFull(false);
  }, [narrow, sound]);

  // 폭이 모바일로 줄면 서랍이 둘 다 열려 있지 않게 한다.
  useEffect(() => {
    if (narrow && panel !== null && turnsOpen) setTurnsOpen(false);
  }, [narrow, panel, turnsOpen]);

  // Esc는 위에 뜬 것부터 닫는다(메뉴 → 모바일 서랍). 데스크톱 판은 닫지 않는다(예턴 편집 중 실수로 닫히지 않게).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      else if (narrow && (panel !== null || turnsOpen)) closeSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, narrow, panel, turnsOpen, closeSheet]);

  // 지도에서 도시를 고르면 도시 판을 연다. 주소의 city만 바꾸고 화면은 그대로다(메인과 같다).
  const selectCity = useCallback(
    (key: number) => {
      void navigate({ search: (prev) => ({ ...prev, city: key }), replace: true, resetScroll: false });
      setPanel('city');
      if (narrow) setTurnsOpen(false);
      sound.play('tap');
    },
    [navigate, narrow, sound],
  );

  // 서랍 손잡이: 위로 끌면 끝까지, 아래로 끌면 반쯤 → 닫기. 누르기만 하면 반쯤·끝까지를 오간다.
  const onGripDown = (event: PointerEvent<HTMLButtonElement>) => {
    drag.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onGripUp = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    drag.current = null;
    if (start === null) return;
    const dy = event.clientY - start;
    if (dy < -40) setSheetFull(true);
    else if (dy > 40) {
      if (sheetFull) setSheetFull(false);
      else closeSheet();
    } else setSheetFull((full) => !full);
  };

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
  const countdown = useTurnCountdown(data?.nextTurnAt ?? null, () => void home.refetch());
  const termSeconds = (summary.data?.turnTermMinutes ?? 0) * 60;
  const left = countdown.seconds;
  // 원형 시계: 이번 턴에서 지난 몫만큼 금빛이 찬다.
  const passed = left !== null && termSeconds > 0 ? Math.min(1, Math.max(0, 1 - left / termSeconds)) : 0;

  const withHome = (render: (home: NonNullable<typeof data>) => ReactNode) => {
    if (data) return render(data);
    if (noGeneral) return <NoGeneral worldId={worldId} />;
    if (home.isError)
      return <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />;
    return <LoadingState />;
  };

  const panelBody = (key: Panel) => {
    if (key === 'general')
      return withHome((home) => (
        <GeneralInfo
          equipment={equipment}
          worldId={worldId}
          home={home}
          campaignEnabled={mine.data?.creationRules.campaignEnabled ?? false}
          cityName={cityName(home.general.cityKey)}
          nation={home.general.nationId === null ? undefined : nationById.get(home.general.nationId)}
          onSelectCity={selectCity}
        />
      ));
    if (key === 'city')
      return cityKey !== null ? (
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
      );
    if (key === 'nation') return withHome((home) => <NationInfo worldId={worldId} nation={home.nation} cities={cities} />);
    return <MainRecords worldId={worldId} clock={summary.data} nations={nations} cities={cities} />;
  };
  const active = PANELS.find((item) => item.key === panel) ?? null;
  const sheetOpen = narrow && (panel !== null || turnsOpen);

  const grip = (
    <button
      type="button"
      className={styles.grip}
      aria-label={sheetFull ? '서랍 반쯤 내리기' : '서랍 끝까지 올리기'}
      onPointerDown={onGripDown}
      onPointerUp={onGripUp}
    >
      <span aria-hidden="true" />
    </button>
  );

  return (
    <div
      className={`${styles.stage} ${sheetOpen ? styles.sheetOpen : ''} ${sheetFull ? styles.sheetFull : ''}`}
      data-testid="map-stage"
    >
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

      {/* 위 HUD: 나라 인장 → 내 장수 → 날짜·턴 시계 → 자원 → 단추. */}
      <header className={styles.hud}>
        {nation ? (
          <Link
            to="/w/$worldId/nation/$nationId"
            params={{ worldId, nationId: String(nation.id) }}
            className={styles.seal}
            style={{ ['--seal' as string]: nation.color }}
            aria-label={`${nation.name}: 국가 정보 열기`}
          >
            {Array.from(nation.name)[0]}
          </Link>
        ) : (
          <span className={`${styles.seal} ${styles.sealNone}`} aria-label="재야">
            野
          </span>
        )}
        {general ? (
          <Link
            to="/w/$worldId/me"
            params={{ worldId }}
            className={styles.me}
            aria-label={`내 장수 ${name}: 내 정보 열기`}
            data-testid="stage-me"
          >
            <span className={styles.face}>
              <Portrait id={general.portraitId} name={name} variant="icon" shape="round" size={44} decorative />
            </span>
            <span className={styles.meText}>
              <span className={styles.meLine}>
                <strong className={styles.meName}>{name}</strong>
                <span className={styles.meTag}>나</span>
              </span>
              <span className={styles.meSub}>
                {nation ? nation.name : '재야'} · {officerName(general.officerLevel, general.nationId !== null)} ·{' '}
                {cityName(general.cityKey)}
              </span>
            </span>
          </Link>
        ) : (
          <span className={styles.me}>{noGeneral ? '장수가 없습니다' : '장수를 불러오는 중입니다'}</span>
        )}

        <span className={styles.clock} title={termSeconds ? `턴 ${summary.data?.turnTermMinutes}분` : undefined}>
          <span className={styles.ring} style={{ ['--passed' as string]: `${passed * 360}deg` }} aria-hidden="true" />
          <span className={styles.clockText}>
            <strong>{date || '—'}</strong>
            <span>
              다음 턴 <b>{left === null ? '—' : countdown.waiting ? '정산 중' : formatRemaining(left)}</b>
            </span>
          </span>
        </span>

        {general ? (
          <span className={styles.resources} aria-label="내 자원">
            <span className={styles.res} title="금">
              <StageIcon name="gold" size={18} />
              <b>{n(general.gold)}</b>
            </span>
            <span className={styles.res} title="쌀">
              <StageIcon name="rice" size={18} />
              <b>{n(general.rice)}</b>
            </span>
            <span className={`${styles.res} ${styles.resWide}`} title="병력">
              <StageIcon name="troops" size={18} />
              <b>{n(general.crew)}</b>
            </span>
            {/* 능력: 다섯 능력 월드는 정치·매력까지 보인다(장수 정보판과 같은 조건). */}
            <span className={`${styles.res} ${styles.resWide}`} title="능력">
              통<b>{general.leadership}</b> 무<b>{general.strength}</b> 지<b>{general.intel}</b>
              {'politics' in general && typeof general.politics === 'number' ? (
                <>
                  {' '}
                  정<b>{general.politics}</b>
                </>
              ) : null}
              {'charm' in general && typeof general.charm === 'number' ? (
                <>
                  {' '}
                  매<b>{general.charm}</b>
                </>
              ) : null}
            </span>
          </span>
        ) : null}

        <span className={styles.spacer} />
        <Link to="/w/$worldId/messages" params={{ worldId }} className={styles.iconButton} aria-label="메시지">
          <StageIcon name="message" />
          {unreadCount > 0 ? <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
        </Link>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.soundHud}`}
          aria-label={sound.enabled ? '효과음 끄기' : '효과음 켜기'}
          aria-pressed={sound.enabled}
          onClick={sound.toggle}
        >
          <StageIcon name={sound.enabled ? 'soundOn' : 'soundOff'} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="메뉴"
          aria-expanded={menuOpen}
          aria-controls="stage-menu"
          onClick={() => {
            sound.play(menuOpen ? 'close' : 'open');
            setMenuOpen((open) => !open);
          }}
        >
          <StageIcon name="menu" />
        </button>
      </header>

      {menuOpen ? (
        <nav id="stage-menu" className={`${styles.frame} ${styles.menu}`} aria-label="게임 메뉴">
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
            <Link
              to="/w/$worldId"
              params={{ worldId }}
              search={selected ? { city: selected } : {}}
              className={styles.menuLink}
            >
              기존 화면
            </Link>
            <AccountLinks className={styles.menuLink} logout />
            <button
              type="button"
              className={`${styles.menuLink} ${styles.menuSound}`}
              aria-pressed={sound.enabled}
              onClick={sound.toggle}
            >
              <StageIcon name={sound.enabled ? 'soundOn' : 'soundOff'} size={18} />
              효과음 {sound.enabled ? '켬' : '끔'}
            </button>
          </div>
        </nav>
      ) : null}

      {/* 데스크톱 왼쪽 아이콘 독. 모바일에서는 아래 탭 막대가 대신한다. */}
      <nav className={styles.dock} aria-label="판 열기" data-testid="stage-dock">
        {PANELS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.dockButton}
            aria-pressed={panel === item.key}
            onClick={() => openPanel(item.key)}
          >
            <StageIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
        <button type="button" className={styles.dockButton} aria-pressed={turnsOpen} onClick={toggleTurns}>
          <StageIcon name="turns" />
          <span>예턴</span>
        </button>
      </nav>

      {active ? (
        <aside className={`${styles.frame} ${styles.panel} ${styles.left}`} aria-labelledby="stage-left-title">
          {narrow ? grip : null}
          <div className={styles.panelHead}>
            <span className={styles.headIcon}>
              <StageIcon name={active.icon} size={18} />
            </span>
            <h2 id="stage-left-title" className={styles.panelTitle}>
              {active.title}
            </h2>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.close}
              aria-label={`${active.title} 판 닫기`}
              onClick={() => (narrow ? closeSheet() : openPanel(null))}
            >
              <StageIcon name="close" size={18} />
            </button>
          </div>
          <div className={styles.panelBody}>{panelBody(active.key)}</div>
        </aside>
      ) : null}

      {/* 예턴 편집기는 닫아도 내리지 않고 감춘다. 저장하지 않은 편집이 남는다(메인과 같다). */}
      <aside
        className={`${styles.frame} ${styles.panel} ${styles.right}`}
        aria-labelledby="stage-right-title"
        hidden={!turnsOpen}
      >
        {narrow ? grip : null}
        <div className={styles.panelHead}>
          <span className={`${styles.headIcon} ${styles.headIconBlue}`}>
            <StageIcon name="turns" size={18} />
          </span>
          <h2 id="stage-right-title" className={styles.panelTitle}>
            내 예턴{name ? ` · ${name}` : ''}
          </h2>
          <span className={styles.spacer} />
          <button type="button" className={styles.close} aria-label="내 예턴 판 닫기" onClick={narrow ? closeSheet : toggleTurns}>
            <StageIcon name="close" size={18} />
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

      {/* 모바일 아래 탭 막대: 엄지가 닿는 자리에 큰 단추. */}
      <nav className={styles.tabbar} aria-label="게임 탭" data-testid="stage-tabbar">
        {PANELS.slice(0, 3).map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.tabButton}
            aria-pressed={panel === item.key}
            onClick={() => openPanel(item.key)}
          >
            <StageIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
        <button type="button" className={`${styles.tabButton} ${styles.tabMain}`} aria-pressed={turnsOpen} onClick={toggleTurns}>
          <StageIcon name="turns" size={28} />
          <span>예턴</span>
        </button>
        <button
          type="button"
          className={styles.tabButton}
          aria-pressed={panel === 'records'}
          onClick={() => openPanel('records')}
        >
          <StageIcon name="records" />
          <span>기록</span>
        </button>
      </nav>

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
          다음 턴 <b>{left === null ? '—' : formatRemaining(left)}</b>
        </span>
      </footer>
    </div>
  );
}
