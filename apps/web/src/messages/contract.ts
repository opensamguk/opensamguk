import { trpcClient } from '../trpc';

// T2-09(Codex)의 메시지·공지·SSE 계약 초안을 옮긴 임시 타입과 호출이다.
// 기준: docs/plans/T2-09.md "API 계약"과 "SSE 이벤트" 절 (검토 R63-1·R63-3R·R63-4 반영본).
// Codex API가 main에 들어오면 이 파일을 지우고 AppRouter 타입(useTRPC의 message·notice)으로 바꾼다.
// 쿼리 키는 @trpc/tanstack-react-query 키 모양으로 맞춰 두어, 바꾼 뒤에도 무효화 키가 같다.

export type MessageScope = 'PRIVATE' | 'NATION' | 'DIPLOMACY' | 'WORLD';
export const MESSAGE_SCOPES: readonly MessageScope[] = ['PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD'];

export type GameDate = { year: number; month: number };
export type NationTag = { id: number; name: string; color: string };
export type Party = { generalId: number | null; name: string; nation: NationTag | null };

export type MessageItem = {
  id: string;
  scope: MessageScope;
  direction: 'sent' | 'received';
  from: Party;
  to: Party | null;
  body: string;
  sentAt: string;
  gameDate: GameDate;
  read: boolean;
};
export type MessageListResponse = { items: MessageItem[]; next: string | null };
// 볼 권한이 없는 범위는 null이다. 화면은 null인 탭을 숨긴다.
export type UnreadResponse = Record<MessageScope, number | null>;
export type RecipientsResponse = {
  generals: { id: number; name: string; nation: NationTag | null }[];
  nations: NationTag[];
};
export type NationNotice = {
  nationId: number;
  revision: number;
  body: string;
  updatedAt: string | null;
  updatedBy: string | null;
  unseen: boolean;
  canEdit: boolean;
};
export type NationNoticeResponse = NationNotice | null;
export type WorldNoticeResponse = { items: { id: string; body: string; pinned: boolean; publishedAt: string }[] };

export type SendInput = {
  worldId: string;
  scope: MessageScope;
  toGeneralId?: number;
  toNationId?: number;
  body: string;
};

// SSE 이벤트 (GET /sse?worldId=). 이벤트 이름이 kind이고 data는 같은 JSON이다. 본문·수치는 싣지 않는다.
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

interface Query<I, O> {
  query(input: I): Promise<O>;
}
interface Mutation<I, O> {
  mutate(input: I): Promise<O>;
}
interface PendingClient {
  message: {
    list: Query<{ worldId: string; scope: MessageScope; cursor?: string }, MessageListResponse>;
    send: Mutation<SendInput, { item: MessageItem }>;
    markRead: Mutation<{ worldId: string; ids: string[] }, { updated: number; unread: UnreadResponse }>;
    unread: Query<{ worldId: string }, UnreadResponse>;
    recipients: Query<{ worldId: string }, RecipientsResponse>;
  };
  notice: {
    nation: {
      get: Query<{ worldId: string }, NationNoticeResponse>;
      set: Mutation<{ worldId: string; body: string }, NationNoticeResponse>;
      markSeen: Mutation<{ worldId: string; nationId: number; revision: number }, NationNoticeResponse>;
    };
    world: { list: Query<{ worldId: string }, WorldNoticeResponse> };
  };
}

// tRPC 프록시는 타입에 없는 경로도 /trpc/<path>로 보낸다. 캐스트는 이 한 곳에만 둔다.
export const api = trpcClient as unknown as PendingClient;

type Path = readonly string[];
const key = (path: Path, input?: unknown, type: 'query' | 'infinite' = 'query') =>
  input === undefined ? [path] : [path, { input, type }];

export const messageKeys = {
  all: [['message']] as const,
  list: (worldId: string, scope: MessageScope) => key(['message', 'list'], { worldId, scope }, 'infinite'),
  listAll: [['message', 'list']] as const,
  unread: (worldId: string) => key(['message', 'unread'], { worldId }),
  recipients: (worldId: string) => key(['message', 'recipients'], { worldId }),
};

export const noticeKeys = {
  nation: (worldId: string) => key(['notice', 'nation', 'get'], { worldId }),
  world: (worldId: string) => key(['notice', 'world', 'list'], { worldId }),
};
