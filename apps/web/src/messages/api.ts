import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { trpc, trpcClient } from '../trpc';

// 메시지·공지 응답 모양과 호출. AppRouter 타입에서만 꺼낸다 (T2-09 message·notice 라우터, 패키지 경계).
type Outputs = inferRouterOutputs<AppRouter>;
type Inputs = inferRouterInputs<AppRouter>;

export type MessageListResponse = Outputs['message']['list'];
export type MessageItem = MessageListResponse['items'][number];
export type MessageScope = MessageItem['scope'];
export type Party = MessageItem['from'];
export type NationTag = NonNullable<Party['nation']>;
// 볼 권한이 없는 범위는 null이다. 화면은 null인 탭을 숨긴다.
export type UnreadResponse = Outputs['message']['unread'];
export type RecipientsResponse = Outputs['message']['recipients'];
export type NationNoticeResponse = Outputs['notice']['nation']['get'];
export type NationNotice = NonNullable<NationNoticeResponse>;
export type WorldNoticeResponse = Outputs['notice']['world']['list'];
export type SendInput = Inputs['message']['send'];
export type SendScope = SendInput['scope'];

export const MESSAGE_SCOPES = ['PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD'] as const satisfies readonly MessageScope[];

// SSE 이벤트 (GET /sse?worldId=, apps/server/src/realtime). tRPC 밖이라 AppRouter에 없어 서버의 signalSchema를 따라 적는다.
// 이벤트 이름이 kind이고 data는 { kind, scope? } JSON이다. 본문·수치는 싣지 않는다.
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

export const api = trpcClient;

// 키는 tRPC 프록시가 만든다. useTRPC 화면과 SSE 무효화가 같은 키를 본다.
export const messageKeys = {
  all: trpc.message.pathKey(),
  list: (worldId: string, scope: MessageScope) => trpc.message.list.infiniteQueryKey({ worldId, scope }),
  listAll: trpc.message.list.pathKey(),
  unread: (worldId: string) => trpc.message.unread.queryKey({ worldId }),
  recipients: (worldId: string) => trpc.message.recipients.queryKey({ worldId }),
};

export const noticeKeys = {
  nation: (worldId: string) => trpc.notice.nation.get.queryKey({ worldId }),
  world: (worldId: string) => trpc.notice.world.list.queryKey({ worldId }),
};

// 메시지·국가 공지 본문 한도. 서버 bodyLimit(apps/server/src/messaging.ts)과 같이 유니코드 코드포인트로 센다.
export const BODY_MAX = 1_000;
export const BODY_TOO_LONG = '본문은 1,000자까지 쓸 수 있습니다.';
export const bodyLength = (value: string) => [...value].length;
