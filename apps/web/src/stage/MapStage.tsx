// 지도 바탕 게임 화면 (INT-29, D-093). 전체 군략도를 화면 바탕에 깔고 그 위에 게임 화면 틀을 얹는다.
// 사용자 2026-11-14: "UI를 일종의 게임처럼 만들자. 웹사이트가 아닌. 모바일 버전은 모바일 게임을 플레이하는 것 같이."
// - 위 HUD: 나라 인장, 내 장수 초상 틀(맨 앞), 날짜와 다음 턴 원형 시계, 자원(금·쌀·병력), 아이콘 단추
// - 데스크톱: 왼쪽 아이콘 독(장수·도시·국가·기록)이 왼쪽 판을 열고, 오른쪽 판은 내 예턴이다.
// - 모바일: 지도 전체 화면, 아래 탭 막대, 판은 아래에서 끌어올리는 서랍(반쯤·끝까지)이다.
// 보이는 정보는 메인과 같고(devsam 동등성) 겉모습과 다루는 방식만 게임처럼 바꾼다. 주소 ?ui=map일 때만 연다.
// D-106(사용자 2026-11-15 "전자로."): 첫 화면은 내 성 화면이다. 성 화면(성 밖이면 진영 화면)에만 맨 아래 명령 띠가 있고,
// 전체 지도는 보기만 한다(예턴은 아래 띠에서 보기만). 왼쪽 위는 도식 축소 지도(D-101).
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { AdvicePanel } from '../advice/AdvicePanel';
import { formatRemaining, useTurnCountdown } from '../game/countdown';
import { errorCode } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { useEquipment } from '../equipment/useEquipment';
import { bureauName } from '../governance/governanceModel';
import { AccountLinks } from '../layout/AccountLinks';
import { CityInfo } from '../main/CityInfo';
import { GeneralInfo } from '../main/GeneralInfo';
import { MainRecords } from '../main/MainRecords';
import { RealmPanel } from './RealmPanel';
import { NationInfo } from '../main/NationInfo';
import { WorldMap } from '../main/WorldMap';
import { useAuthority } from '../messages/authority';
import { unreadTotal } from '../messages/merge';
import { useUnread } from '../messages/queries';
import { MainMenu } from '../pages/MainPage';
import { CampaignPanel } from '../personnel/CampaignPanel';
import { RetinueOrdersPanel } from '../personnel/RetinueOrdersPanel';
import { PolicyBar } from '../policy/PolicyBar';
import { Portrait } from '../portrait/Portrait';
import { TurnEditor } from '../turns/TurnEditor';
import { useTRPC } from '../trpc';
import { EmptyState, LoadingState } from '../ui/States';
import { StageIcon, type StageIconName } from '../ui/GameIcon';
import { SchematicMap } from '../main/SchematicMap';
import { cityConditions, seasonOf } from './cityConditions';
import { CampScene, CityScene, asSiteKind, cityGrade } from './CityScene';
import { CastleWindow } from './CastleWindow';
import { DraftBridge, LotWindow, reserveInDraft, type LandTurn } from './LotWindow';
import { reserveScale, type ScaleCommand } from './nationScale';
import { usePersonnelApi } from '../personnel/contract';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { TurnPeek } from './TurnPeek';
import { CityCard, GeneralCard, LogCard, TurnsCard } from './StageCards';
import { useStageSound } from './stageSound';
import styles from './MapStage.module.css';

type Panel = 'realm' | 'general' | 'retinue' | 'city' | 'nation' | 'records';
const PANELS: ReadonlyArray<{ key: Panel; label: string; title: string; icon: StageIconName }> = [
  // 천하 형세: 전체 지도 모드의 판(세력 견주기). INT-29 모드 나누기.
  { key: 'realm', label: '형세', title: '천하 형세', icon: 'realm' },
  { key: 'general', label: '장수', title: '내 장수', icon: 'general' },
  // 내 장수가 연 부(府): 휘하·부곡과 장수 지시(INT-29 남은 것 "휘하·부곡 목록"). 전용 화면(/campaign)과 같은 부품을 쓴다.
  // 이름은 직위·관직에 따라 대장군부·표기장군부·승상부 등, 부를 열지 않는 장수는 휘하다(bureauName).
  { key: 'retinue', label: '휘하', title: '휘하', icon: 'troops' },
  { key: 'city', label: '도시', title: '도시', icon: 'city' },
  { key: 'nation', label: '국가', title: '국가', icon: 'nation' },
  { key: 'records', label: '기록', title: '기록', icon: 'records' },
];

const n = (value: number) => value.toLocaleString('ko-KR');
// 좁은 세로 창만 아래 서랍을 쓴다. 휴대폰·태블릿은 가로로 플레이한다(사용자 2026-11-15 "휴대폰 가로모드로", "A안 양손 서랍").
const NARROW = '(max-width: 899px) and (orientation: portrait)';
const matches = (query: string) => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
const isNarrow = () => matches(NARROW);

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
  // 휘하 판 이름(조정 직위·장군 관직이면 그 부). 황실 자료를 못 읽으면 휘하.
  const governance = useQuery({ ...trpc.governance.get.queryOptions({ worldId }), retry: false });
  const bureau = bureauName(governance.data);
  const labelOf = (item: (typeof PANELS)[number]) => (item.key === 'retinue' ? bureau : item.label);
  const titleOf = (item: (typeof PANELS)[number]) => (item.key === 'retinue' ? bureau : item.title);
  const equipment = useEquipment(worldId, home.data?.general.id);
  const authority = useAuthority(worldId);
  const unread = useUnread(worldId);
  const unreadCount = unreadTotal(authority.ready ? unread.data : undefined);
  const sound = useStageSound();
  const narrow = useNarrow();

  // 데스크톱은 장수 판과 예턴 판을 연 채로, 모바일은 모두 닫은 채로 시작해 지도를 먼저 보인다.
  // 성 화면은 늘 보이는 작은 판(카드)을 두고 큰 판은 닫은 채로 연다(완성 그림 04).
  const [panel, setPanel] = useState<Panel | null>(null);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  // 성 화면(첫 화면)과 전체 지도(D-106). 전체 지도로 가면 천하 형세 판을 연다.
  const [view, setView] = useState<'city' | 'overview'>('city');
  const switchView = useCallback(
    (next: 'city' | 'overview') => {
      sound.play('tap');
      setView(next);
      // 전체 지도는 지도를 보는 화면이라 판을 모두 닫고 연다(사용자 2026-11-15 "전체지도가 안보인다?"). 판은 왼쪽 단추로 다시 연다.
      if (next === 'overview') {
        setPanel(null);
        setTurnsOpen(false);
      }
    },
    [sound],
  );
  // 성 안 창(D-106): 가운데 성을 누르면 연다.
  const [castleOpen, setCastleOpen] = useState(false);
  // 성 밖 자리 창(D-107): 누른 자리 ID. 건설과 철거는 예턴 편집기와 같은 초안에 넣는다.
  const [lot, setLot] = useState<string | null>(null);
  const draftRef = useRef<TurnDraftState | null>(null);
  // 명령 띠 자리(성 화면 맨 아래). 자리가 생긴 뒤 예턴 편집기가 띠를 이리로 옮겨 그린다.
  const [bandSlot, setBandSlot] = useState<HTMLDivElement | null>(null);
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
  // 증축, 감축(INT-30, D-109)은 국가 예턴 연속 다섯 칸에 넣는다. 넣은 뒤 국가 예턴과 성 정보를 다시 읽는다.
  const personnelApi = usePersonnelApi();
  const queryClient = useQueryClient();
  const reserveScaleHere = useCallback(
    async (command: ScaleCommand) => {
      const cityKey = home.data?.land?.cityKey;
      if (cityKey === undefined) return { ok: false as const, message: '이 도시 정보를 아직 받지 못했습니다.' };
      const result = await reserveScale(personnelApi, worldId, command, cityKey);
      if (result.ok) void queryClient.invalidateQueries();
      return result;
    },
    [home.data?.land?.cityKey, personnelApi, queryClient, worldId],
  );
  const reserveLand = useCallback(
    (turn: LandTurn) => {
      const result = reserveInDraft(draftRef.current, turn);
      // 넣은 칸이 보이도록 예턴 판을 연다. 저장은 판의 [저장]으로 한다.
      if (result.ok && !turnsOpen) {
        setTurnsOpen(true);
        if (narrow) setPanel(null);
      }
      return result;
    },
    [narrow, turnsOpen],
  );
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
  // 성 화면과 성 안 창은 내 도시의 종류, 규모, 이름, 지역만 쓴다. 지도 조회(world.map)는 무거워 늦게 올 수 있으므로
  // 그 전에는 home이 준 같은 도시 자료를 쓴다. 지도에서 성을 눌러도 창이 지도 조회를 기다리지 않는다.
  // 이름, 규모, 종류는 home을 먼저 쓴다. 증축 직후 turn.result는 home.get만 다시 받으므로 캐시된 지도의 옛 규모와
  // 새 영지 칸이 한 화면에 섞이지 않게 한다(PR #674 Codex 리뷰). 지역처럼 home에 없는 값만 지도에서 채운다.
  const homeCity = data?.city;
  const mapCity = cities.find((city) => city.key === homeCity?.key);
  const myCity = homeCity
    ? {
        key: homeCity.key,
        name: homeCity.name,
        level: homeCity.level,
        kind: homeCity.kind,
        region: 'region' in homeCity ? homeCity.region : mapCity?.region,
      }
    : undefined;
  // 성 화면 대사의 이름 자리: 군주 자리에 내 세력 이름(세력은 군주 이름을 쓴다), 태수 자리에 내 장수, 적은 도시가 가장 많은 다른 세력, 성 안 장수.
  const myNationName = nations.find((nation) => nation.id === general?.nationId)?.name;
  const rival = nations
    .filter((nation) => nation.id !== general?.nationId)
    .map((nation) => ({ name: nation.name, n: cities.filter((city) => city.nationId === nation.id).length }))
    .sort((a, b) => b.n - a.n)[0]?.name;
  const cityTalkContext = {
    ruler: myNationName ?? '주공',
    taesu: general?.name ?? '태수',
    enemy: rival ?? '적',
    generals: (map.data?.generals ?? [])
      .filter((g) => g.cityKey === data?.city?.key && g.id !== general?.id)
      .map((g) => g.name)
      .slice(0, 8),
  };
  const myGrade = myCity ? cityGrade(asSiteKind(myCity.kind), myCity.level) : null;
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
          cityName={cityName(home.general.cityKey)}
          nation={home.general.nationId === null ? undefined : nationById.get(home.general.nationId)}
          onSelectCity={selectCity}
        />
      ));
    if (key === 'realm')
      return map.data ? (
        <RealmPanel
          worldId={worldId}
          nations={nations}
          cities={cities}
          generals={map.data.generals}
          myNationId={general?.nationId ?? null}
        />
      ) : (
        <LoadingState />
      );
    if (key === 'retinue')
      return withHome(() => (
        <>
          <CampaignPanel worldId={worldId} />
          <RetinueOrdersPanel worldId={worldId} />
        </>
      ));
    if (key === 'city')
      return cityKey !== null ? (
        <CityInfo worldId={worldId} cityKey={cityKey} nations={nations} onSelectCity={selectCity} summary />
      ) : (
        <EmptyState title="지도에서 도시를 고르세요" />
      );
    if (key === 'nation')
      return withHome((home) => <NationInfo worldId={worldId} nation={home.nation} cities={cities} />);
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
      data-view={view}
    >
      <div className={styles.map}>
        {view === 'city' && data ? (
          data.city ? (
            <CityScene
              cityName={cityName(data.city.key)}
              kind={asSiteKind(myCity?.kind)}
              level={myCity?.level}
              place={myCity ? { name: myCity.name, region: myCity.region, key: myCity.key } : undefined}
              land={data.land}
              upgrading={Boolean(data.land?.upgrade?.preparing.length)}
              season={seasonOf(summary.data?.gameDate.month)}
              conditions={cityConditions(data.city)}
              water={myCity?.kind === 'PORT' ? 'coast' : myCity?.level === 1 ? 'river' : null}
              talkContext={cityTalkContext}
              factionColor={nations.find((nation) => nation.id === general?.nationId)?.color ?? undefined}
              onOpenCastle={() => {
                sound.play('open');
                setLot(null);
                setCastleOpen(true);
              }}
              onLot={(slotId) => {
                sound.play('open');
                setCastleOpen(false);
                setLot(slotId);
              }}
            />
          ) : (
            <CampScene placeName={cityName(myCityKey)} crewType={general?.crewType ?? null} />
          )
        ) : map.data ? (
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
          <MainMenu worldId={worldId} nationId={nation?.id ?? null} cityKey={myCityKey} />
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
        <button
          type="button"
          className={styles.dockButton}
          aria-pressed={view === 'overview'}
          onClick={() => switchView(view === 'overview' ? 'city' : 'overview')}
          data-testid="stage-view"
        >
          <StageIcon name={view === 'overview' ? 'city' : 'map'} />
          <span>{view === 'overview' ? '내 성' : '전체 지도'}</span>
        </button>
        {PANELS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.dockButton}
            aria-pressed={panel === item.key}
            onClick={() => openPanel(item.key)}
          >
            <StageIcon name={item.icon} />
            <span>{labelOf(item)}</span>
          </button>
        ))}
        <button type="button" className={styles.dockButton} aria-pressed={turnsOpen} onClick={toggleTurns}>
          <StageIcon name="turns" />
          <span>예턴</span>
        </button>
      </nav>

      {/* 왼쪽 위 축소 지도(D-101 도식). 성 화면에서만 둔다. 누르면 그 도시 판을 연다. */}
      {view === 'city' && map.data ? (
        <section className={`kit-list-nation ${styles.minimap}`} aria-label="축소 지도">
          <SchematicMap
            cities={cities}
            nations={nations}
            candidates={null}
            value={selected ?? null}
            here={myCityKey}
            onPick={selectCity}
            label="축소 지도"
            compact
          />
        </section>
      ) : null}

      {/* 성 화면의 작은 판들. 큰 판이 열리면 그 자리 카드는 감춘다. */}
      {view === 'city' && data && !narrow ? (
        <>
          {panel === null ? (
            <div className={styles.cardLeft}>
              <GeneralCard home={data} cityName={cityName(myCityKey)} onOpen={() => openPanel('general')} />
            </div>
          ) : null}
          {!turnsOpen ? (
            <div className={styles.cardRight}>
              <CityCard home={data} cityName={cityName(myCityKey)} onOpen={() => openPanel('city')} />
              <TurnsCard home={data} onOpen={toggleTurns} />
            </div>
          ) : null}
          {panel === null ? (
            <div className={styles.cardLog}>
              <LogCard home={data} onOpen={() => openPanel('records')} />
            </div>
          ) : null}
        </>
      ) : null}

      {view === 'city' && castleOpen && myGrade && myCity ? (
        <CastleWindow
          cityName={myCity.name}
          grade={myGrade}
          land={data?.land}
          onReserve={reserveLand}
          onScaleReserve={reserveScaleHere}
          nationTurnsHref={`/w/${worldId}/nation/turns`}
          onClose={() => setCastleOpen(false)}
        />
      ) : null}
      {view === 'city' && lot && data?.land && data.land.slots.some((slot) => slot.id === lot) ? (
        <LotWindow land={data.land} slotId={lot} onReserve={reserveLand} onClose={() => setLot(null)} />
      ) : null}

      {/* 명령 띠 자리: 성 화면(진영 화면) 맨 아래. 예턴 편집기가 띠를 이리로 그린다(D-106). */}
      {view === 'city' ? <div ref={setBandSlot} className={styles.band} data-testid="stage-band" /> : null}

      {active ? (
        <aside className={`${styles.frame} ${styles.panel} ${styles.left}`} aria-labelledby="stage-left-title">
          {narrow ? grip : null}
          <div className={styles.panelHead}>
            <span className={styles.headIcon}>
              <StageIcon name={active.icon} size={18} />
            </span>
            <h2 id="stage-left-title" className={styles.panelTitle}>
              {titleOf(active)}
            </h2>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.close}
              aria-label={`${titleOf(active)} 판 닫기`}
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
          <button
            type="button"
            className={styles.close}
            aria-label="내 예턴 판 닫기"
            onClick={narrow ? closeSheet : toggleTurns}
          >
            <StageIcon name="close" size={18} />
          </button>
        </div>
        <div className={styles.panelBody}>
          <PolicyBar worldId={worldId} />
          {view === 'overview' ? (
            // 전체 지도에서는 예턴을 보기만 한다. 넣기와 고치기는 성 화면에서 한다(D-106).
            <TurnPeek worldId={worldId} onBack={() => switchView('city')} backLabel="성으로 돌아가기" />
          ) : null}
          <div hidden={view === 'overview'}>
            <TurnEditor
              worldId={worldId}
              selectedCityKey={selected ?? null}
              renderTop={(draft) => (
                <>
                  <DraftBridge draft={draft} target={draftRef} />
                  <AdvicePanel key={worldId} worldId={worldId} draft={draft} />
                </>
              )}
              pickerTarget={view === 'city' ? bandSlot : null}
            />
          </div>
        </div>
      </aside>

      {/* 모바일 아래 탭 막대: 엄지가 닿는 자리에 큰 단추. */}
      <nav className={styles.tabbar} aria-label="게임 탭" data-testid="stage-tabbar">
        {PANELS.filter((item) => item.key === 'general' || item.key === 'city' || item.key === 'nation').map((item) => (
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
        <button
          type="button"
          className={`${styles.tabButton} ${styles.tabMain}`}
          aria-pressed={turnsOpen}
          onClick={toggleTurns}
        >
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

      {/* 세로로 든 휴대폰·태블릿: 가로로 돌려 달라는 안내(CSS가 세로 터치 기기에서만 보인다). */}
      <div className={styles.rotate} role="note">
        <span className={styles.rotateIcon} aria-hidden="true" />
        <strong>가로로 돌려 주세요</strong>
        <span>휴대폰과 태블릿은 가로 화면으로 플레이합니다.</span>
      </div>

      {view === 'overview' ? (
        <footer className={`kit-bar-bottom ${styles.status}`} aria-label="상태 줄">
          <button type="button" className="kit-button" data-kind="accent" onClick={() => switchView('city')}>
            내 성으로 ({cityName(myCityKey)})
          </button>
          <span>
            플레이 <b>{name || '—'}</b>
            {nation ? ` (${nation.name})` : general ? ' (재야)' : ''}
          </span>
          <span>
            세력 <b>{nations.filter((item) => cities.some((city) => city.nationId === item.id)).length}</b>, 내 도시{' '}
            <b>{nation ? cities.filter((city) => city.nationId === nation.id).length : 0}</b> / {cities.length}
          </span>
          <TurnPeek worldId={worldId} inline />
          <span className={styles.spacer} />
          <span>{date}</span>
          <span>
            다음 턴 <b>{left === null ? '—' : formatRemaining(left)}</b>
          </span>
        </footer>
      ) : null}
    </div>
  );
}
