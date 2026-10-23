import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageScope } from '../messages/contract';
import { readDraft, writeDraft } from '../messages/drafts';
import { trpc } from '../trpc';
import {
  applyWorldEvent,
  DOWN_NOTICE_MS,
  invalidationTargets,
  parseWorldEvent,
  sseUrl,
  WorldEventConnection,
  type EventSourceLike,
  type RealtimeStatus,
  type WorldEvent,
} from './useWorldEvents';

const WORLD = 'w1';
// 메시지 화면(messages/queries.ts)과 같은 생성 키다.
const listKey = (scope: MessageScope) => trpc.message.list.infiniteQueryKey({ worldId: WORLD, scope });
const unreadKey = trpc.message.unread.queryKey({ worldId: WORLD });

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
  emit(kind: string, data = '{}') {
    for (const listener of this.listeners.get(kind) ?? []) listener(new MessageEvent(kind, { data }));
  }
}

function connect(onEvent?: (event: WorldEvent) => void) {
  const sources: FakeSource[] = [];
  const statuses: RealtimeStatus[] = [];
  const events: unknown[] = [];
  const connection = new WorldEventConnection({
    url: '/sse?worldId=w1',
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    onStatus: (status) => statuses.push(status),
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
  });
  connection.start();
  return { connection, sources, statuses, events, last: () => sources.at(-1)! };
}

describe('SSE 알림 해석', () => {
  it('알려진 종류만 받고 범위가 맞지 않으면 버린다', () => {
    expect(parseWorldEvent('ready', '')).toEqual({ kind: 'ready' });
    expect(parseWorldEvent('message.new', '{"scope":"NATION"}')).toEqual({ kind: 'message.new', scope: 'NATION' });
    expect(parseWorldEvent('message.new', '{"scope":"SECRET"}')).toBeNull();
    expect(parseWorldEvent('notice.updated', '{"scope":"world"}')).toEqual({ kind: 'notice.updated', scope: 'world' });
    expect(parseWorldEvent('notice.updated', 'not json')).toBeNull();
    expect(parseWorldEvent('unknown', '{}')).toBeNull();
  });

  it('알림 종류마다 계획의 query만 다시 조회하고 메시지 키는 생성된 infinite 키 모양이다', () => {
    expect(invalidationTargets({ kind: 'ready' }, WORLD, trpc)).toBe('all');
    expect(invalidationTargets({ kind: 'message.new', scope: 'PRIVATE' }, WORLD, trpc)).toEqual([
      [['message', 'list'], { input: { worldId: WORLD, scope: 'PRIVATE' }, type: 'infinite' }],
      [['message', 'unread'], { input: { worldId: WORLD }, type: 'query' }],
    ]);
    expect(invalidationTargets({ kind: 'turn.result' }, WORLD, trpc)).toEqual([
      trpc.home.get.queryKey({ worldId: WORLD }),
      trpc.turns.get.queryKey({ worldId: WORLD }),
      trpc.records.general.pathKey(),
    ]);
    expect(invalidationTargets({ kind: 'notice.updated', scope: 'nation' }, WORLD, trpc)).toEqual([
      trpc.notice.nation.get.queryKey({ worldId: WORLD }),
    ]);
    expect(invalidationTargets({ kind: 'notice.updated', scope: 'world' }, WORLD, trpc)).toEqual([
      trpc.notice.world.list.queryKey({ worldId: WORLD }),
    ]);
    expect(sseUrl('w 1')).toBe('/sse?worldId=w%201');
  });
});

describe('SSE 재조회와 초안', () => {
  const seed = (client: QueryClient) => {
    client.setQueryData(listKey('PRIVATE'), { pages: [], pageParams: [] });
    client.setQueryData(listKey('NATION'), { pages: [], pageParams: [] });
    client.setQueryData(unreadKey, { PRIVATE: 1, NATION: 0, DIPLOMACY: null, WORLD: 0 });
    client.setQueryData(trpc.turns.get.queryKey({ worldId: WORLD }), { revision: 1, slots: [] });
  };
  const invalidated = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

  it('message.new는 그 범위 목록과 안 읽음 수만 무효화한다', () => {
    const client = new QueryClient();
    seed(client);
    applyWorldEvent(client, trpc, WORLD, { kind: 'message.new', scope: 'PRIVATE' });
    expect(invalidated(client, listKey('PRIVATE'))).toBe(true);
    expect(invalidated(client, unreadKey)).toBe(true);
    expect(invalidated(client, listKey('NATION'))).toBe(false);
    expect(invalidated(client, trpc.turns.get.queryKey({ worldId: WORLD }))).toBe(false);
  });

  it('ready는 전체를 다시 조회하지만 캐시 밖의 초안은 건드리지 않는다', () => {
    const client = new QueryClient();
    seed(client);
    writeDraft('messages:compose:w1:PRIVATE', { body: '쓰던 글', toGeneralId: 3, toNationId: null });
    writeDraft('messages:compose:w1:NATION:1', { body: '국가에 쓰던 글', toGeneralId: null, toNationId: null });
    writeDraft('notice:edit:w1:1', '고치던 공지');
    applyWorldEvent(client, trpc, WORLD, { kind: 'ready' });
    expect(invalidated(client, listKey('NATION'))).toBe(true);
    expect(invalidated(client, trpc.turns.get.queryKey({ worldId: WORLD }))).toBe(true);
    expect(readDraft('messages:compose:w1:PRIVATE', null)).toEqual({
      body: '쓰던 글',
      toGeneralId: 3,
      toNationId: null,
    });
    expect(readDraft('messages:compose:w1:NATION:1', null)).toMatchObject({ body: '국가에 쓰던 글' });
    expect(readDraft('notice:edit:w1:1', null)).toBe('고치던 공지');
  });

  it('연결로 받은 ready 하나는 화면 query 전체 무효화를 정확히 한 번 부른다', () => {
    const client = new QueryClient();
    seed(client);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const c = connect((event) => applyWorldEvent(client, trpc, WORLD, event));
    c.last().open();
    c.last().emit('ready', '{"kind":"ready"}');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();
    c.connection.stop();
  });
});

describe('SSE 연결', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('열리면 연결됨이 되고 알림을 넘긴다', () => {
    const c = connect();
    expect(c.last().url).toBe('/sse?worldId=w1');
    c.last().open();
    c.last().emit('message.new', '{"scope":"PRIVATE"}');
    expect(c.statuses).toEqual(['open']);
    expect(c.events).toEqual([{ kind: 'message.new', scope: 'PRIVATE' }]);
  });

  it('3초 안에 다시 이어지는 끊김은 표시를 바꾸지 않는다', () => {
    const c = connect();
    c.last().open();
    c.last().fail(0);
    vi.advanceTimersByTime(DOWN_NOTICE_MS - 1_000);
    c.last().open();
    vi.advanceTimersByTime(DOWN_NOTICE_MS * 2);
    expect(c.statuses).toEqual(['open']);
  });

  it('3초 넘게 끊기면 다시 잇는 중이 되고 이어지면 돌아온다', () => {
    const c = connect();
    c.last().open();
    c.last().fail(0);
    vi.advanceTimersByTime(DOWN_NOTICE_MS + 1);
    expect(c.statuses).toEqual(['open', 'reconnecting']);
    c.last().open();
    expect(c.statuses).toEqual(['open', 'reconnecting', 'open']);
  });

  it('오류 뒤 readyState가 CONNECTING이면 새 연결을 만들지 않고 브라우저 재시도를 기다린다', () => {
    const c = connect();
    c.last().open();
    c.last().fail(0);
    vi.advanceTimersByTime(60_000);
    expect(c.sources).toHaveLength(1);
    expect(c.sources[0]!.closed).toBe(false);
    expect(c.statuses).toEqual(['open', 'reconnecting']);
  });

  it('첫 연결이 3초 안에 열리지 않아도 다시 잇는 중을 띄운다', () => {
    const c = connect();
    vi.advanceTimersByTime(DOWN_NOTICE_MS + 1);
    expect(c.statuses).toEqual(['reconnecting']);
  });

  it('서버가 닫으면 간격을 늘려 새로 열고 옛 연결의 알림은 버린다', () => {
    const c = connect();
    const first = c.last();
    first.fail(2);
    expect(c.sources).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(c.sources).toHaveLength(2);
    c.last().fail(2);
    vi.advanceTimersByTime(1_000);
    expect(c.sources).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(c.sources).toHaveLength(3);
    first.emit('ready');
    expect(c.events).toEqual([]);
    c.last().open();
    c.last().emit('ready');
    expect(c.events).toEqual([{ kind: 'ready' }]);
  });

  it('멈추면 연결을 닫고 다시 열지 않는다', () => {
    const c = connect();
    c.last().fail(2);
    c.connection.stop();
    vi.advanceTimersByTime(60_000);
    expect(c.sources).toHaveLength(1);
    expect(c.sources[0]!.closed).toBe(true);
    expect(c.statuses).toEqual([]);
  });
});
