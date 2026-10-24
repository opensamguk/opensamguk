import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { messageKeys, noticeKeys, sseUrl, WORLD_EVENT_KINDS, type WorldEvent } from '../messages/api';
import { useTRPC, type Trpc } from '../trpc';

// 월드 SSE(T2-09)를 받아 알림 종류별로 해당 query만 다시 조회한다 (계획 docs/plans/T2-10.md "결정").
// 알림은 무효화 신호뿐이다. 같은 알림이 두 번 오거나 순서가 바뀌어도 재조회는 늘 최신을 읽으므로 결과가 같다.
// 재조회는 서버 데이터만 바꾼다. 예턴 초안(sessionStorage), 지도 선택(주소의 ?city), 메시지 작성 칸과 공지 고치기 초안
// (messages/drafts.ts)은 query 캐시 밖에 있어 ready 전체 재조회에도 지워지지 않는다.

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting';

// 끊김이 이보다 길어야 "다시 잇는 중"을 띄운다. 첫 재시도에서 바로 이어지는 짧은 끊김에는 표시가 깜빡이지 않는다.
export const DOWN_NOTICE_MS = 3_000;
// 서버가 연결을 닫아 브라우저가 스스로 다시 잇지 않을 때(readyState CLOSED) 직접 다시 잇는 간격.
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

// 알림 하나가 다시 조회할 query. 'all'은 지금 화면의 query 전부다.
export function invalidationTargets(event: WorldEvent, worldId: string, trpc: Trpc): QueryKey[] | 'all' {
  switch (event.kind) {
    case 'ready':
      return 'all';
    case 'turn.result':
      return [
        trpc.home.get.queryKey({ worldId }),
        trpc.turns.get.queryKey({ worldId }),
        trpc.records.general.pathKey(),
      ];
    case 'message.new':
      return [messageKeys.list(worldId, event.scope), messageKeys.unread(worldId)];
    case 'monthly.done':
      return [
        trpc.world.summary.queryKey({ worldId }),
        trpc.home.get.queryKey({ worldId }),
        trpc.world.map.queryKey({ worldId }),
      ];
    // 발령 상자(T2-06 offers·personnel)와 외교실(T2-08 treaty)의 경로 키다. 그 라우터가 없으면 맞는 query가 없어 아무 일도 없다.
    case 'offer.new':
      return [[['offers']], [['personnel']]];
    case 'treaty.new':
      return [[['treaty']]];
    case 'notice.updated':
      return [event.scope === 'nation' ? noticeKeys.nation(worldId) : noticeKeys.world(worldId)];
  }
}

export function applyWorldEvent(queryClient: QueryClient, trpc: Trpc, worldId: string, event: WorldEvent) {
  const targets = invalidationTargets(event, worldId, trpc);
  if (targets === 'all') {
    void queryClient.invalidateQueries();
    return;
  }
  for (const queryKey of targets) void queryClient.invalidateQueries({ queryKey });
}

// data는 서버가 보낸 JSON이다. 모르는 모양은 버린다.
export function parseWorldEvent(kind: string, data: string): WorldEvent | null {
  if (!(WORLD_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  let parsed: unknown;
  try {
    parsed = data ? JSON.parse(data) : {};
  } catch {
    return null;
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (kind === 'message.new') {
    const scope = body.scope;
    return scope === 'PRIVATE' || scope === 'NATION' || scope === 'DIPLOMACY' || scope === 'WORLD'
      ? { kind, scope }
      : null;
  }
  if (kind === 'notice.updated') {
    const scope = body.scope;
    return scope === 'nation' || scope === 'world' ? { kind, scope } : null;
  }
  return { kind } as WorldEvent;
}

// 브라우저 EventSource에서 쓰는 부분만. 시험은 가짜를 넣는다.
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
const CLOSED = 2;

interface ConnectionOptions {
  url: string;
  onEvent: (event: WorldEvent) => void;
  onStatus: (status: RealtimeStatus) => void;
  createSource?: (url: string) => EventSourceLike;
}

// 연결 하나와 그 재연결. 브라우저가 스스로 다시 잇는 동안(CONNECTING)은 기다리고, 닫혔으면(CLOSED) 간격을 늘려 가며 새로 연다.
export class WorldEventConnection {
  private source: EventSourceLike | null = null;
  private status: RealtimeStatus = 'connecting';
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;

  constructor(private readonly options: ConnectionOptions) {}

  start() {
    this.stopped = false;
    this.watchDown();
    this.open();
  }

  stop() {
    this.stopped = true;
    this.source?.close();
    this.source = null;
    this.clear();
  }

  private open() {
    const create = this.options.createSource ?? ((url: string) => new EventSource(url) as EventSourceLike);
    const source = create(this.options.url);
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.failures = 0;
      if (this.downTimer) clearTimeout(this.downTimer);
      this.downTimer = null;
      this.setStatus('open');
    };
    source.onerror = () => {
      if (this.source !== source || this.stopped) return;
      this.watchDown();
      if (source.readyState !== CLOSED) return;
      source.close();
      const delay = RECONNECT_DELAYS_MS[Math.min(this.failures, RECONNECT_DELAYS_MS.length - 1)];
      this.failures += 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) this.open();
      }, delay);
    };
    for (const kind of WORLD_EVENT_KINDS) {
      source.addEventListener(kind, (message) => {
        if (this.source !== source) return;
        const event = parseWorldEvent(kind, message.data);
        if (event) this.options.onEvent(event);
      });
    }
  }

  // 끊긴 뒤 DOWN_NOTICE_MS 안에 다시 열리지 않을 때만 상태를 바꾼다.
  private watchDown() {
    if (this.downTimer) return;
    this.downTimer = setTimeout(() => {
      this.downTimer = null;
      if (!this.stopped) this.setStatus('reconnecting');
    }, DOWN_NOTICE_MS);
  }

  private setStatus(status: RealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private clear() {
    if (this.downTimer) clearTimeout(this.downTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.downTimer = null;
    this.retryTimer = null;
  }
}

// 게임 화면 한 탭에 연결 하나. GameLayout이 부른다.
export function useWorldEvents(worldId: string): { status: RealtimeStatus } {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    setStatus('connecting');
    const connection = new WorldEventConnection({
      url: sseUrl(worldId),
      onStatus: setStatus,
      onEvent: (event) => applyWorldEvent(queryClient, trpc, worldId, event),
    });
    connection.start();
    return () => connection.stop();
  }, [queryClient, trpc, worldId]);

  return { status };
}
