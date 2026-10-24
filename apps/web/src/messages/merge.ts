import type { InfiniteData } from '@tanstack/react-query';
import {
  MESSAGE_SCOPES,
  type MessageItem,
  type MessageListResponse,
  type MessageScope,
  type UnreadResponse,
} from './api';

// 서버 순서: sentAt 내림차순, 같으면 id 내림차순 (T2-09 message.list).
export function compareMessages(a: MessageItem, b: MessageItem): number {
  if (a.sentAt !== b.sentAt) return a.sentAt < b.sentAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// send 응답으로 먼저 넣은 행, 재조회, 다음 쪽 불러오기가 겹쳐도 같은 id는 한 줄이다.
// 한쪽이라도 읽음이면 읽음으로 둔다. markRead 응답을 반영한 행이 늦게 온 옛 쪽에 덮이지 않게 하기 위해서다.
export function mergeMessages(pages: readonly (readonly MessageItem[])[]): MessageItem[] {
  const byId = new Map<string, MessageItem>();
  for (const items of pages) {
    for (const item of items) {
      const seen = byId.get(item.id);
      byId.set(item.id, seen ? { ...item, read: seen.read || item.read } : item);
    }
  }
  return [...byId.values()].sort(compareMessages);
}

type Pages<P> = InfiniteData<MessageListResponse, P> | undefined;

export function listItems<P>(data: Pages<P>): MessageItem[] {
  return data ? mergeMessages(data.pages.map((page) => page.items)) : [];
}

// 보낸 행을 첫 쪽 맨 위에 넣는다. 아직 목록을 받지 않았으면 그대로 두고 다음 조회를 기다린다.
export function prependSent<P>(data: Pages<P>, item: MessageItem): Pages<P> {
  const [first, ...rest] = data?.pages ?? [];
  if (!data || !first) return data;
  return { ...data, pages: [{ ...first, items: [item, ...first.items.filter((m) => m.id !== item.id)] }, ...rest] };
}

export function markItemsRead<P>(data: Pages<P>, ids: ReadonlySet<string>): Pages<P> {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (ids.has(item.id) ? { ...item, read: true } : item)),
    })),
  };
}

// 읽음 처리할 받은 메시지. markRead는 한 번에 100개까지 받는다.
export function unreadReceivedIds(items: readonly MessageItem[]): string[] {
  return items
    .filter((item) => item.direction === 'received' && !item.read)
    .map((item) => item.id)
    .slice(0, 100);
}

// null인 범위는 볼 권한이 없어 탭을 숨긴다. 응답 전에는 개인·전체만 둔다.
export function visibleScopes(unread: UnreadResponse | undefined): MessageScope[] {
  if (!unread) return ['PRIVATE', 'WORLD'];
  return MESSAGE_SCOPES.filter((scope) => unread[scope] !== null);
}

export function unreadTotal(unread: UnreadResponse | undefined): number {
  if (!unread) return 0;
  return MESSAGE_SCOPES.reduce((sum, scope) => sum + (unread[scope] ?? 0), 0);
}
