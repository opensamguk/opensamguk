import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { AdminEntry } from '../auth/AdminEntry';
import { LogoutButton } from '../auth/LogoutButton';
import { PublicMapTabs } from '../publicMap/PublicMapTabs';
import { WorldTicker } from './WorldTicker';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { NationBadge } from '../ui/NationBadge';
import { Portrait } from '../portrait/Portrait';
import { displayName } from '../game/names';
import type { LobbyNotice, LobbyWorld } from './contract';
import { endedText, lobbyAction, splitWorlds, metaText, myGeneralText, shortDate, STATUS_LABEL } from './lobbyView';
import styles from './LobbyPage.module.css';

// INT-29 화면 개편(사용자 승인 시안): 표지 그림을 화면 가득 깔고 키트 틀로 판을 짠다.
const KEYART = 'apps/web/src/art/keyart.png';
const keyartUrl = hasPublicImage(KEYART) ? publicImageUrl(KEYART) : null;

// 로비 (T2-04, AC-M2-02). 로그인하지 않아도 목록을 본다. 버튼만 auth.me로 가른다.
// INT-29(사용자 2026-11-15 "로비는 devsam의 영향을 좀 받자" → "이 구성으로"): 원작 로비 구성을 따른다.
// 맨 위 공지 → 서버 선택 판(서버·정보·내 장수·선택) → 공개 지도와 고른 월드 카드 → 지난 기수·계정 → 아래 중원 정세 띠.
// 서버 선택 판의 줄, 공개 지도 탭, 정세 띠는 같은 "고른 월드"를 따른다.
// 화면 개편 시안 배치: 위 띠(계정) → 공지 틀 → 왼쪽 큰 창 「서버 선택」 표, 오른쪽 공개 지도 카드와 고른 월드, 지난 기수 → 아래 정세 띠.
export function LobbyPage() {
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.auth.me.queryOptions(), staleTime: 0 });
  // 끝난 월드까지 한 번에 받아 진행 중 줄과 지난 기수 목록으로 나눈다 (INT-26, 원작 역대 왕조).
  const worlds = useQuery({ ...trpc.lobby.worlds.queryOptions({ includeEnded: true }), staleTime: 0 });
  const { live, ended } = splitWorlds(worlds.data ?? []);
  const notices = useQuery(trpc.lobby.notices.queryOptions());
  const loggedIn = Boolean(me.data?.user);
  const [chosenId, setChosenId] = useState<string | null>(null);
  // 고른 월드: 고른 것이 없으면 내 장수가 있는 첫 월드, 그것도 없으면 첫 월드.
  const selected =
    live.find((world) => world.id === chosenId) ?? live.find((world) => world.myGeneral) ?? live[0] ?? null;

  let body;
  if (worlds.isError || me.isError) {
    body = (
      <ErrorState
        title="월드 목록을 불러오지 못했습니다"
        onRetry={() => {
          if (me.isError) void me.refetch();
          void worlds.refetch();
        }}
      />
    );
  } else if (worlds.isPending || me.isPending) body = <LoadingState />;
  else if (live.length === 0) body = <EmptyState title="열린 월드가 없습니다" />;
  else body = <WorldList worlds={live} loggedIn={loggedIn} selectedId={selected?.id ?? null} onSelect={setChosenId} />;

  return (
    <div className={styles.page} style={keyartUrl ? { backgroundImage: `url("${keyartUrl}")` } : undefined}>
      <header className={`kit-bar-top ${styles.top}`}>
        <span className={styles.brand}>오픈삼국</span>
        <h1 className={styles.title}>로비</h1>
        {me.data ? (
          loggedIn ? (
            <>
              <AdminEntry className={`kit-button ${styles.account}`} />
              <Link to="/account" className={`kit-button ${styles.account}`}>
                내 계정
              </Link>
              <LogoutButton className={`kit-button ${styles.account}`} />
            </>
          ) : (
            <Link to="/login" search={{ next: '/lobby' }} className={`kit-button ${styles.account}`}>
              로그인
            </Link>
          )
        ) : null}
      </header>
      {notices.isError ? (
        <div className={`kit-notice ${styles.light} ${styles.noticeBanner}`}>
          <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void notices.refetch()} />
        </div>
      ) : notices.data && notices.data.length > 0 ? (
        <NoticeBanner notices={notices.data} />
      ) : null}
      <main className={styles.board}>
        <section aria-labelledby="lobby-worlds" className={`kit-window ${styles.dark} ${styles.servers}`}>
          <h2 id="lobby-worlds" className={`kit-title ${styles.boardHead}`}>
            서버 선택
          </h2>
          {body}
          <LobbyRules />
        </section>
        <aside className={styles.side}>
          <div className={`kit-card ${styles.light} ${styles.mapCard}`}>
            <PublicMapTabs selectedId={selected?.id ?? null} onSelect={setChosenId} />
          </div>
          {selected ? <SelectedWorld world={selected} loggedIn={loggedIn} /> : null}
          {ended.length > 0 ? <PastSeasons worlds={ended} /> : null}
        </aside>
      </main>
      <WorldTicker worldId={selected?.id ?? null} worldName={selected?.name ?? ''} loggedIn={loggedIn} />
    </div>
  );
}

// 맨 위 공지(원작처럼 큰 글씨). 가장 최근 공지를 띄우고 누르면 공지 목록을 펼친다.
function NoticeBanner({ notices }: { notices: LobbyNotice[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const latest = notices[0]!;
  return (
    <div className={`kit-notice ${styles.light} ${styles.noticeBanner}`}>
      <button
        type="button"
        className={styles.noticeHeadline}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.noticeLabel}>공지</span>
        <span>{latest.title}</span>
        <span className={styles.muted}>{open ? '접기' : `목록 ${notices.length}`}</span>
      </button>
      <div id={id} hidden={!open}>
        <NoticeBoard notices={notices} />
      </div>
    </div>
  );
}

// 원작 로비 꼬리말: 이용 규칙(다중 계정·대리 입력 금지)과 계정 안내.
function LobbyRules() {
  return (
    <div className={styles.rules}>
      <p className={styles.rulesWarn}>
        한 사람이 계정을 둘 이상 쓰거나 다른 사람의 턴을 대신 넣으면 차단될 수 있습니다.
      </p>
      <p>계정은 한 번 만들면 계속 씁니다. 새 기수가 열리면 장수만 새로 만들면 됩니다.</p>
    </div>
  );
}

// 고른 월드 카드: 로비의 주인공 자리라 내 장수 얼굴은 portrait(148×210)로 크게 쓴다(초상 쓰는 순서: 메인 portrait,
// 목록 icon, 줄일 때만 thumb). 장수가 없으면 실루엣과 참가 단추.
function SelectedWorld({ world, loggedIn }: { world: LobbyWorld; loggedIn: boolean }) {
  const general = world.myGeneral;
  const name = general ? displayName(general.name) : '미등록';
  return (
    <section
      className={`kit-card ${styles.light} ${styles.chosen}`}
      aria-label={`고른 월드 ${world.name}`}
      data-testid="lobby-selected-world"
    >
      <h2 className={styles.heading}>{world.name}</h2>
      <div className={styles.chosenBody}>
        <Portrait id={general?.portraitId ?? null} name={name} variant="portrait" className={styles.chosenFace} />
        <div className={styles.chosenInfo}>
          <strong className={styles.chosenName}>{name}</strong>
          {general ? (
            <>
              {general.officerTitle ? <span className={styles.muted}>{general.officerTitle}</span> : null}
              <span className={styles.myMeta}>
                <NationBadge
                  name={general.nationName ?? '재야'}
                  color={general.nationName ? (general.nationColor ?? null) : null}
                />
                {general.cityName ? <span>{general.cityName}</span> : null}
              </span>
              {general.stats ? (
                <span className={`num ${styles.myStats}`}>
                  통 {general.stats.leadership} · 무 {general.stats.strength} · 지 {general.stats.intel}
                  {general.stats.politics !== undefined ? ` · 정 ${general.stats.politics}` : ''}
                  {general.stats.charm !== undefined ? ` · 매 ${general.stats.charm}` : ''}
                </span>
              ) : null}
            </>
          ) : (
            <span className={styles.muted}>이 월드에 내 장수가 없습니다</span>
          )}
          <span className={styles.chosenMeta}>{metaText(world).join(' · ')}</span>
          <WorldAction world={world} loggedIn={loggedIn} />
        </div>
      </div>
    </section>
  );
}

// 공지는 서버 순서 그대로 두고 첫 줄만 펼친다. 한 번에 하나만 연다.
export function NoticeBoard({ notices }: { notices: LobbyNotice[] }) {
  const [openId, setOpenId] = useState<string | null>(notices[0]?.id ?? null);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className={styles.notices}>
      <h2 id={`${id}-title`} className={styles.heading}>
        공지
      </h2>
      <ul className={styles.noticeList}>
        {notices.map((notice) => {
          const open = notice.id === openId;
          const bodyId = `${id}-${notice.id}`;
          return (
            <li key={notice.id} className={styles.notice}>
              <button
                type="button"
                className={styles.noticeHead}
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpenId(open ? null : notice.id)}
              >
                <span>{notice.title}</span>
                <time className={styles.muted} dateTime={notice.publishedAt}>
                  {shortDate(notice.publishedAt)}
                </time>
              </button>
              <p id={bodyId} className={styles.noticeBody} hidden={!open}>
                {notice.body}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// 서버 선택 판: 원작 "서 버 선 택" 표의 칸(서버, 정보, 내 장수, 선택)을 키트 표 머리와 줄로 그린다(INT-29 승인 시안).
// 줄은 높이를 넉넉히 두고, 줄을 누르면 그 월드를 고른다. 고른 줄은 키트 표의 세 번째 줄 그림이다.
export function WorldList({
  worlds,
  loggedIn,
  selectedId = null,
  onSelect,
}: {
  worlds: LobbyWorld[];
  loggedIn: boolean;
  selectedId?: string | null;
  onSelect?: (worldId: string) => void;
}) {
  return (
    <>
      {/* 표 머리(원작 「서버 선택」 표의 칸 이름). 줄은 목록과 글로 읽히므로 화면 낭독에서는 뺀다. */}
      <div className={`kit-thead ${styles.thead}`} aria-hidden="true">
        <span>서버</span>
        <span>정보</span>
        <span>내 장수</span>
        <span>선택</span>
      </div>
      <ul className={styles.rows}>
        {worlds.map((world) => (
          <WorldCard
            key={world.id}
            world={world}
            loggedIn={loggedIn}
            selected={world.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

function WorldCard({
  world,
  loggedIn,
  selected,
  onSelect,
}: {
  world: LobbyWorld;
  loggedIn: boolean;
  selected: boolean;
  onSelect?: ((worldId: string) => void) | undefined;
}) {
  const status = STATUS_LABEL[world.status];
  const titleId = `world-${world.id}`;
  return (
    <li>
      <article
        className={`kit-row ${styles.row}`}
        data-selected={selected ? 'true' : undefined}
        aria-labelledby={titleId}
        onClick={onSelect ? () => onSelect(world.id) : undefined}
      >
        <div className={styles.cellServer}>
          {onSelect ? (
            <button
              type="button"
              className={styles.pick}
              aria-pressed={selected}
              aria-label={`${world.name} 고르기`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(world.id);
              }}
            />
          ) : null}
          <h3 id={titleId} className={styles.name}>
            {world.name}
          </h3>
          <span className={styles.cardHead}>
            <Tag tone={status.tone}>{status.text}</Tag>
            {world.presetName === null ? null : <span className={styles.preset}>{world.presetName}</span>}
          </span>
          {world.status === 'PAUSED' ? <span className={styles.paused}>턴 일시정지 · 조회/예약턴 가능</span> : null}
        </div>
        <p className={styles.meta}>{metaText(world).join(' · ')}</p>
        <div className={styles.cellGeneral}>
          {world.myGeneral ? (
            <MyGeneral general={world.myGeneral} />
          ) : (
            <span className={styles.muted}>{myGeneralText(world.myGeneral)}</span>
          )}
        </div>
        <div className={styles.cellAction} onClick={(event) => event.stopPropagation()}>
          <WorldAction world={world} loggedIn={loggedIn} />
        </div>
      </article>
    </li>
  );
}

// 로비 카드의 내 장수 (D-085). 얼굴과 소속·관직·능력치를 함께 보인다.
// 서버가 아직 주지 않는 값은 칸을 그리지 않는다 (INT-25 PR 4, lobby.list 응답 확장 대기).
type MyGeneralInfo = NonNullable<LobbyWorld['myGeneral']>;
function MyGeneral({ general }: { general: MyGeneralInfo }) {
  const name = displayName(general.name);
  const stats = general.stats;
  return (
    <div className={styles.myGeneral} role="group" aria-label="내 장수">
      <Portrait id={general.portraitId ?? null} name={name} variant="icon" shape="round" className={styles.myFace} />
      <div className={styles.myInfo}>
        <span className={styles.myName}>
          {name}
          {general.officerTitle ? <span className={styles.muted}> · {general.officerTitle}</span> : null}
        </span>
        <span className={styles.myMeta}>
          <NationBadge
            name={general.nationName ?? '재야'}
            color={general.nationName ? (general.nationColor ?? null) : null}
          />
          {general.cityName ? <span>{general.cityName}</span> : null}
        </span>
        {stats ? (
          <span className={`num ${styles.myStats}`}>
            통 {stats.leadership} · 무 {stats.strength} · 지 {stats.intel}
            {stats.politics !== undefined ? ` · 정 ${stats.politics}` : ''}
            {stats.charm !== undefined ? ` · 매 ${stats.charm}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// 지난 기수 (INT-26, p7-records-20). 줄마다 기수 이름, 통일 국가 이름과 색, 끝난 연월, 영토 재생 공유를 둔다.
// 서버 순서(끝난 월드는 최근 시작 순)를 그대로 쓴다. 승자 기록이 없는 월드는 「통일 국가 없음」으로 쓴다.
export function PastSeasons({ worlds }: { worlds: LobbyWorld[] }) {
  return (
    <section aria-labelledby="lobby-past" className={`kit-card ${styles.light} ${styles.past}`}>
      <h2 id="lobby-past" className={styles.heading}>
        지난 기수
      </h2>
      <ul className={styles.pastList}>
        {worlds.map((world) => (
          <li key={world.id} className={styles.pastRow} data-testid="past-season">
            <span className={styles.pastName}>{world.name}</span>
            <span className={styles.pastWinner}>
              {world.winner ? (
                <>
                  <span className={styles.muted}>통일</span>
                  <NationBadge name={world.winner.name} color={world.winner.color} />
                </>
              ) : (
                <span className={styles.muted}>통일 국가 없음</span>
              )}
              <span className="num">{endedText(world)}</span>
            </span>
            <span className={styles.pastLinks}>
              <Link
                to="/share/timelapse/$worldId"
                params={{ worldId: world.id }}
                className={`kit-button ${styles.pastAction}`}
                data-kind="secondary"
                aria-label={`${world.name} 영토 재생 보기`}
              >
                영토 재생
              </Link>
              {world.myGeneral ? (
                <Link
                  to="/w/$worldId"
                  params={{ worldId: world.id }}
                  className={`kit-button ${styles.pastAction}`}
                  data-kind="secondary"
                  aria-label={`${world.name} 기록 보기`}
                >
                  기록 보기
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorldAction({ world, loggedIn }: { world: LobbyWorld; loggedIn: boolean }) {
  const action = lobbyAction(loggedIn, world);
  if (action.kind === 'enter')
    return (
      <Link to="/w/$worldId" params={{ worldId: world.id }} className={`kit-button ${styles.action}`}>
        들어가기
      </Link>
    );
  const label = action.kind === 'create' ? '장수 만들기' : '로그인하고 참가';
  if (action.blocked !== null) return <DisabledReason reason={action.blocked}>{label}</DisabledReason>;
  return action.kind === 'create' ? (
    <Link
      to="/w/$worldId/create"
      params={{ worldId: world.id }}
      className={`kit-button ${styles.action}`}
      data-kind="secondary"
    >
      {label}
    </Link>
  ) : (
    <Link to="/login" search={{ next: '/lobby' }} className={`kit-button ${styles.action}`} data-kind="secondary">
      {label}
    </Link>
  );
}
