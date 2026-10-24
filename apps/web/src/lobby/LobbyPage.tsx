import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { LogoutButton } from '../auth/LogoutButton';
import { PublicMapTabs } from '../publicMap/PublicMapTabs';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import type { LobbyNotice, LobbyWorld } from './contract';
import { lobbyAction, metaText, myGeneralText, shortDate, STATUS_LABEL } from './lobbyView';
import styles from './LobbyPage.module.css';

// 로비 (T2-04, AC-M2-02). 로그인하지 않아도 목록을 본다. 버튼만 auth.me로 가른다.
export function LobbyPage() {
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.auth.me.queryOptions(), staleTime: 0 });
  // M2 화면은 includeEnded를 보내지 않는다. 끝난 월드는 서버 기본값대로 빠진다.
  const worlds = useQuery({ ...trpc.lobby.worlds.queryOptions(), staleTime: 0 });
  const notices = useQuery(trpc.lobby.notices.queryOptions());
  const loggedIn = Boolean(me.data?.user);

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
  else if (worlds.data.length === 0) body = <EmptyState title="열린 월드가 없습니다" />;
  else body = <WorldList worlds={worlds.data} loggedIn={loggedIn} />;

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <h1 className={styles.title}>로비</h1>
        {me.data ? (
          loggedIn ? (
            <LogoutButton className={styles.account} />
          ) : (
            <Link to="/login" search={{ next: '/lobby' }} className={styles.account}>
              로그인
            </Link>
          )
        ) : null}
      </header>
      {notices.isError ? (
        <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void notices.refetch()} />
      ) : notices.data && notices.data.length > 0 ? (
        <NoticeBoard notices={notices.data} />
      ) : null}
      {/* 지연 공개 지도 (T2-25, D-026). 지도 탭은 월드 카드와 따로 움직인다. */}
      <PublicMapTabs />
      <section aria-labelledby="lobby-worlds" className={styles.worlds}>
        <h2 id="lobby-worlds" className={styles.heading}>
          월드
        </h2>
        {body}
      </section>
    </div>
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

export function WorldList({ worlds, loggedIn }: { worlds: LobbyWorld[]; loggedIn: boolean }) {
  return (
    <ul className={styles.cards}>
      {worlds.map((world) => (
        <WorldCard key={world.id} world={world} loggedIn={loggedIn} />
      ))}
    </ul>
  );
}

function WorldCard({ world, loggedIn }: { world: LobbyWorld; loggedIn: boolean }) {
  const status = STATUS_LABEL[world.status];
  const titleId = `world-${world.id}`;
  return (
    <li>
      <article className={styles.card} aria-labelledby={titleId}>
        <div className={styles.cardHead}>
          <Tag tone={status.tone}>{status.text}</Tag>
          {world.presetName === null ? null : <span className={styles.preset}>{world.presetName}</span>}
          <h3 id={titleId} className={styles.name}>
            {world.name}
          </h3>
        </div>
        <p className={styles.meta}>{metaText(world).join(' · ')}</p>
        <div className={styles.cardFoot}>
          <span className={world.myGeneral ? undefined : styles.muted}>{myGeneralText(world.myGeneral)}</span>
          <WorldAction world={world} loggedIn={loggedIn} />
        </div>
      </article>
    </li>
  );
}

function WorldAction({ world, loggedIn }: { world: LobbyWorld; loggedIn: boolean }) {
  const action = lobbyAction(loggedIn, world);
  if (action.kind === 'enter')
    return (
      <Link to="/w/$worldId" params={{ worldId: world.id }} className={styles.action}>
        들어가기
      </Link>
    );
  const label = action.kind === 'create' ? '장수 만들기' : '로그인하고 참가';
  if (action.blocked !== null) return <DisabledReason reason={action.blocked}>{label}</DisabledReason>;
  return action.kind === 'create' ? (
    <Link to="/w/$worldId/create" params={{ worldId: world.id }} className={styles.action}>
      {label}
    </Link>
  ) : (
    <Link to="/login" search={{ next: '/lobby' }} className={styles.action}>
      {label}
    </Link>
  );
}
