import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { errorCode } from '../game/errors';
import { QueryError } from '../game/QueryState';
import { serverMessage } from '../turns/apiError';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { authorityEpoch, useAuthority } from './authority';
import {
  BODY_MAX,
  BODY_TOO_LONG,
  bodyLength,
  type MessageItem,
  type MessageScope,
  type Party,
  type SendScope,
} from './api';
import { readDraft, useDraft, writeDraft } from './drafts';
import { listItems, markItemsRead, prependSent, unreadReceivedIds, visibleScopes } from './merge';
import { messageListKey, useMessageList, useRecipients, useUnread, useWorldNotices } from './queries';
import styles from './MessagePanel.module.css';

export const SCOPE_LABELS: Record<MessageScope, string> = {
  PRIVATE: '개인',
  NATION: '국가',
  DIPLOMACY: '외교',
  WORLD: '전체',
};

// 메시지 탭 묶음. 메인 오른쪽 접이식 패널과 /w/:worldId/messages 전체 화면이 같은 부품을 쓴다.
// 탭과 작성 칸은 drafts.ts에 두므로 패널을 접었다 펴도, SSE 재조회가 돌아도 그대로다.
// 국가·외교 탭은 서버가 준 안 읽음 수가 null이 아닐 때만 보인다. 권한이 바뀐 직후 새 응답 전에는 개인·전체만 둔다.
export function MessagePanel({ worldId }: { worldId: string }) {
  const authority = useAuthority(worldId);
  const unread = useUnread(worldId);
  const unreadData = authority.ready ? unread.data : undefined;
  const scopes = visibleScopes(unreadData);
  const [tab, setTab] = useDraft<MessageScope>(`messages:tab:${worldId}`, 'PRIVATE');
  const active = scopes.includes(tab) ? tab : 'PRIVATE';
  const baseId = useId();
  // 국가·외교 작성 칸은 소속 국가별로 따로 둔다. 국가를 옮기면 예전 국가에 쓰던 글이 새 국가로 가지 않는다.
  const draftKey =
    active === 'PRIVATE'
      ? `messages:compose:${worldId}:PRIVATE`
      : `messages:compose:${worldId}:${active}:${authority.nationId ?? 'none'}`;

  return (
    <div className={styles.panel}>
      <div className={styles.tabs} role="tablist" aria-label="메시지 범위">
        {scopes.map((scope) => {
          const count = unreadData?.[scope] ?? 0;
          return (
            <button
              key={scope}
              type="button"
              role="tab"
              id={`${baseId}-${scope}`}
              aria-selected={scope === active}
              aria-controls={`${baseId}-view`}
              aria-label={count > 0 ? `${SCOPE_LABELS[scope]}, 안 읽음 ${count}건` : SCOPE_LABELS[scope]}
              className={scope === active ? `${styles.tab} ${styles.activeTab}` : styles.tab}
              onClick={() => setTab(scope)}
            >
              {SCOPE_LABELS[scope]}
              {count > 0 ? <span className={styles.count}>{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div id={`${baseId}-view`} role="tabpanel" aria-labelledby={`${baseId}-${active}`} className={styles.view}>
        {/* enabled가 꺼져도 캐시의 data는 남는다. 권한 값을 정하기 전이나 서버가 권한을 거둔 뒤에는 남은 목록·받는 사람·공지를
            그리지 않고 읽음 처리와 보내기도 하지 않는다. 쓰던 글은 drafts.ts에 그대로 있다. */}
        {!authority.ready ? (
          <LoadingState />
        ) : active === 'WORLD' ? (
          <>
            <WorldNotices worldId={worldId} />
            <p className={styles.note}>전체 메시지는 운영자가 보냅니다.</p>
          </>
        ) : (
          <Compose key={draftKey} worldId={worldId} scope={active} draftKey={draftKey} />
        )}
        {authority.ready ? (
          <MessageList key={`list-${active}-${authority.epoch}`} worldId={worldId} scope={active} />
        ) : null}
      </div>
    </div>
  );
}

function WorldNotices({ worldId }: { worldId: string }) {
  const notices = useWorldNotices(worldId);
  if (notices.isError) return <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void notices.refetch()} />;
  const items = notices.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className={styles.notices} aria-label="월드 공지">
      {items.map((notice) => (
        <article key={notice.id} className={styles.notice} data-notice-id={notice.id}>
          <header className={styles.meta}>
            {notice.pinned ? <Tag tone="accent">고정</Tag> : null}
            <span>공지</span>
            <time dateTime={notice.publishedAt}>{formatTime(notice.publishedAt)}</time>
          </header>
          <p className={styles.body}>{notice.body}</p>
        </article>
      ))}
    </section>
  );
}

function MessageList({ worldId, scope }: { worldId: string; scope: MessageScope }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useMessageList(worldId, scope);
  const { mutateAsync: markRead } = useMutation(trpc.message.markRead.mutationOptions());
  const items = listItems(list.data);
  const firstPage = list.data?.pages[0]?.items;
  const requested = useRef(new Set<string>());

  // 탭을 열어 첫 쪽이 보이면 그 안의 받은 메시지를 읽음 처리한다. 버튼은 따로 두지 않는다.
  // 응답이 오기 전에 권한이 바뀌었으면 그 응답의 안 읽음 수와 읽음 표시는 넣지 않는다.
  useEffect(() => {
    if (!firstPage) return;
    const ids = unreadReceivedIds(firstPage).filter((id) => !requested.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) requested.current.add(id);
    const epoch = authorityEpoch(worldId);
    markRead({ worldId, ids })
      .then((result) => {
        if (authorityEpoch(worldId) !== epoch) return;
        queryClient.setQueryData(trpc.message.unread.queryKey({ worldId }), result.unread);
        queryClient.setQueryData(messageListKey(trpc, worldId, scope), (data) => markItemsRead(data, new Set(ids)));
      })
      .catch(() => {
        // 다음에 목록이 바뀌면 다시 읽음 처리한다.
        for (const id of ids) requested.current.delete(id);
      });
  }, [firstPage, markRead, queryClient, scope, trpc, worldId]);

  if (list.isPending) return <LoadingState />;
  if (list.isError)
    return <QueryError error={list.error} notFound="볼 수 없는 범위입니다" onRetry={() => void list.refetch()} />;
  if (items.length === 0) return <EmptyState title="메시지가 없습니다" />;

  return (
    <div className={styles.listWrap}>
      <ol className={styles.list} aria-label={`${SCOPE_LABELS[scope]} 메시지`}>
        {items.map((item) => (
          <MessageRow key={item.id} item={item} />
        ))}
      </ol>
      {list.hasNextPage ? (
        <button
          type="button"
          className={styles.more}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? '불러오는 중' : '이전 메시지 더 보기'}
        </button>
      ) : (
        <p className={styles.end}>더 이전 메시지가 없습니다.</p>
      )}
      {list.isFetchNextPageError ? <p className={styles.error}>이전 메시지를 불러오지 못했습니다.</p> : null}
    </div>
  );
}

function PartyName({ party }: { party: Party }) {
  return (
    <span className={styles.party}>
      <span>{party.name}</span>
      {party.nation && party.generalId !== null ? (
        <NationBadge name={party.nation.name} color={party.nation.color} />
      ) : null}
    </span>
  );
}

export function MessageRow({ item }: { item: MessageItem }) {
  const sent = item.direction === 'sent';
  const unread = !sent && !item.read;
  return (
    <li className={styles.row} data-message-id={item.id} data-unread={unread || undefined}>
      <div className={styles.meta}>
        <Tag tone={sent ? 'muted' : 'info'}>{sent ? '보냄' : '받음'}</Tag>
        <span className={styles.parties} aria-label={partiesLabel(item)}>
          <PartyName party={item.from} />
          {item.to ? (
            <>
              <span aria-hidden="true">→</span>
              <PartyName party={item.to} />
            </>
          ) : null}
        </span>
        <time className={styles.time} dateTime={item.sentAt}>
          {item.gameDate.year}년 {item.gameDate.month}월 · {formatTime(item.sentAt)}
        </time>
        {unread ? <Tag tone="accent">안 읽음</Tag> : null}
      </div>
      <p className={styles.body}>{item.body}</p>
    </li>
  );
}

function partiesLabel(item: MessageItem): string {
  return item.to ? `보낸 이 ${item.from.name}, 받는 이 ${item.to.name}` : `보낸 이 ${item.from.name}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface ComposeDraft {
  body: string;
  toGeneralId: number | null;
  toNationId: number | null;
}
const EMPTY_DRAFT: ComposeDraft = { body: '', toGeneralId: null, toNationId: null };

// 보내기 실패(도배 제한 등)는 입력칸 아래에 이유를 보이고 입력 내용은 지우지 않는다.
export function sendFailure(error: unknown): string {
  if (errorCode(error) === 'UNAUTHORIZED') return '로그인이 풀렸습니다. 다시 로그인한 뒤 보내세요.';
  return serverMessage(error) ?? '보내지 못했습니다. 연결을 확인하고 다시 보내세요.';
}

function Compose({ worldId, scope, draftKey }: { worldId: string; scope: SendScope; draftKey: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useDraft<ComposeDraft>(draftKey, EMPTY_DRAFT);
  const send = useMutation(trpc.message.send.mutationOptions());
  const error = send.isError ? sendFailure(send.error) : null;
  const needsRecipient = scope !== 'NATION';
  const recipients = useRecipients(worldId);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const length = bodyLength(draft.body);

  const recipient = scope === 'PRIVATE' ? draft.toGeneralId : scope === 'DIPLOMACY' ? draft.toNationId : null;
  const blocked =
    draft.body.trim() === ''
      ? '보낼 내용을 쓰세요.'
      : length > BODY_MAX
        ? BODY_TOO_LONG
        : needsRecipient && recipient === null
          ? scope === 'PRIVATE'
            ? '받는 장수를 고르세요.'
            : '받는 국가를 고르세요.'
          : send.isPending
            ? '보내는 중입니다.'
            : null;

  const submit = async () => {
    if (blocked) return;
    const epoch = authorityEpoch(worldId);
    const body = draft.body;
    try {
      const { item } = await send.mutateAsync({
        worldId,
        scope,
        body,
        ...(scope === 'PRIVATE' && draft.toGeneralId !== null ? { toGeneralId: draft.toGeneralId } : {}),
        ...(scope === 'DIPLOMACY' && draft.toNationId !== null ? { toNationId: draft.toNationId } : {}),
      });
      // 보낸 글은 이 작성 칸의 초안에서 지운다. 그사이 더 쓴 글이 있으면 그대로 둔다.
      const current = readDraft(draftKey, EMPTY_DRAFT);
      if (current.body === body) writeDraft(draftKey, { ...current, body: '' });
      // 응답 전에 권한이 바뀌었으면 새 권한의 목록에 예전 행을 넣지 않는다. 재조회가 서버 기준으로 채운다.
      if (authorityEpoch(worldId) !== epoch) return;
      queryClient.setQueryData(messageListKey(trpc, worldId, scope), (data) => prependSent(data, item));
    } catch {
      // 실패 이유는 send.error로 입력칸 아래에 보인다. 권한이 바뀐 뒤 온 실패는 새 화면에 띄우지 않는다.
      if (authorityEpoch(worldId) !== epoch) send.reset();
    }
  };

  return (
    <form
      className={styles.compose}
      aria-label={`${SCOPE_LABELS[scope]} 메시지 쓰기`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {scope === 'PRIVATE' ? (
        <label className={styles.field}>
          <span>받는 장수</span>
          <select
            value={draft.toGeneralId ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, toGeneralId: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">고르세요</option>
            {recipients.data?.generals.map((general) => (
              <option key={general.id} value={general.id}>
                {general.nation ? `${general.name} (${general.nation.name})` : `${general.name} (재야)`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {scope === 'DIPLOMACY' ? (
        <label className={styles.field}>
          <span>받는 국가</span>
          <select
            value={draft.toNationId ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, toNationId: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">고르세요</option>
            {recipients.data?.nations.map((nation) => (
              <option key={nation.id} value={nation.id}>
                {nation.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {needsRecipient && recipients.isError ? (
        <p className={styles.error}>받는 사람 목록을 불러오지 못했습니다.</p>
      ) : null}
      {scope === 'NATION' ? <p className={styles.note}>내 국가 장수 모두가 받습니다.</p> : null}
      <label className={styles.field} htmlFor={fieldId}>
        <span>메시지 내용</span>
        <span className={styles.counter} aria-hidden="true">
          {length}/{BODY_MAX}
        </span>
      </label>
      <textarea
        id={fieldId}
        className={styles.textarea}
        rows={3}
        value={draft.body}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        {blocked ? (
          <DisabledReason reason={blocked}>{send.isPending ? '보내는 중' : '보내기'}</DisabledReason>
        ) : (
          <button type="submit" className={styles.primary}>
            보내기
          </button>
        )}
      </div>
    </form>
  );
}
