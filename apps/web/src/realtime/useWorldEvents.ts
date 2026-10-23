import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { MessageScope } from '../messages/contract';
import { useTRPC, type Trpc } from '../trpc';

// 월드 SSE(T2-09)를 받아 알림 종류별로 해당 query만 다시 조회한다 (계획 docs/plans/T2-10.md "결정").
// 알림은 무효화 신호뿐이다. 같은 알림이 두 번 오거나 순서가 바뀌어도 재조회는 늘 최신을 읽으므로 결과가 같다.
// 재조회는 서버 데이터만 바꾼다. 예턴 초안(sessionStorage), 지도 선택(주소의 ?city), 메시지 작성 칸과 공지 고치기 초안
// (messages/drafts.ts)은 query 캐시 밖에 있어 ready 전체 재조회에도 지워지지 않는다.

// SSE는 tRPC 밖의 HTTP 계약이라 AppRouter 타입이 없다. 기준은 apps/server/src/realtime/index.ts다.
// GET /sse?worldId=, 이벤트 이름이 kind이고 data는 {kind, scope?}뿐이다. 본문·ID·수치는 싣지 않는다.
// 연결마다 ready가 먼저 오고 서버의 LISTEN 연결이 되살아나면 모든 연결에 다시 온다. ': hb' 줄은 주석이라 브라우저가 버린다.
export type WorldEvent =
  | { kind: 'ready' }
  | { kind: 'turn.result' }
  | { kind: 'message.new'; scope: MessageScope }
  | { kind: 'monthly.done' }
  | { kind: 'offer.new' }
  | { kind: 'treaty.new' }
  | { kind: 'notice.updated'; scope: 'nation' | 'world' };
export const WORLD_EVENT_KINDS = [
  'ready',
  'turn.result',
  'message.new',
  'monthly.done',
  'offer.new',
  'treaty.new',
  'notice.updated',
] as const satisfies readonly WorldEvent['kind'][];

export const sseUrl = (worldId: string) => `/sse?worldId=${encodeURIComponent(worldId)}`;

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
      return [
        trpc.message.list.infiniteQueryKey({ worldId, scope: event.scope }),
        trpc.message.unread.queryKey({ worldId }),
      ];
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
      return [
        event.scope === 'nation'
          ? trpc.notice.nation.get.queryKey({ worldId })
          : trpc.notice.world.list.queryKey({ worldId }),
      ];
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
const OPEN = 1;
const CLOSED = 2;

interface ConnectionOptions {
  url: string;
  onEvent: (event: WorldEvent) => void;
  onStatus: (status: RealtimeStatus) => void;
  createSource?: (url: string) => EventSourceLike;
}

// 연결 하나와 그 재연결. 오류가 나면 서버 응답 상태(400·401·403·404·503 등)로 짐작하지 않고 실제 readyState만 본다.
// 브라우저가 스스로 다시 잇는 동안(CONNECTING)은 기다리고, 닫혔으면(CLOSED) 간격을 늘려 가며 새로 연다.
//
// 브라우저의 online·offline 사건은 연결이 바뀌었을 수 있다는 힌트로만 쓴다. navigator 값으로 상태나 기능을 정하지 않는다.
// 쉬고 있는 기존 stream은 네트워크가 바뀌어도 오류를 바로 알리지 않을 수 있어서, 힌트가 오면 지금 연결을 새 요청 하나로 바꾸고
// 그 요청의 실제 open·error·ready를 따른다(HTML 표준 SSE 처리 모델). 힌트가 틀려 서버에 닿으면 새 요청이 열려 그대로 쓴다.
// online 힌트는 지금 연결이 열려 있으면 무시하고, 아니면 기다리던 간격 재연결을 취소하고 바로 한 번 새로 연다.
export class WorldEventConnection {
  private source: EventSourceLike | null = null;
  private status: RealtimeStatus = 'connecting';
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  private listening = false;

  constructor(private readonly options: ConnectionOptions) {}

  start() {
    this.stopped = false;
    if (!this.listening && typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
      this.listening = true;
    }
    this.watchDown();
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.listening) {
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('online', this.onOnline);
      this.listening = false;
    }
    this.source?.close();
    this.source = null;
    this.clear();
  }

  private readonly onOffline = () => {
    if (!this.stopped) this.replace();
  };

  private readonly onOnline = () => {
    if (this.stopped || this.source?.readyState === OPEN) return;
    this.replace();
  };

  // 지금 연결을 닫고 새 요청 하나로 바꾼다. 상태는 바꾸지 않고, 새 요청이 3초 안에 열리지 않을 때만 다시 잇는 중이 된다.
  private replace() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
    this.watchDown();
    this.open();
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
      // 닫힌 연결은 지금 연결에서 뺀다. 같은 연결의 오류가 또 와도 간격 재연결 타이머는 하나뿐이다.
      source.close();
      this.source = null;
      if (this.retryTimer) clearTimeout(this.retryTimer);
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
