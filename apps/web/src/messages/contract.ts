import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

// 메시지·공지 화면이 쓰는 타입. 모두 AppRouter(T2-09 message·notice)의 실제 입력·출력에서 꺼낸다.
// 쿼리 키와 호출은 useTRPC()가 만든 것을 쓴다 (queries.ts). 손으로 쓴 DTO와 키는 두지 않는다.

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;

export type MessageScope = Inputs['message']['list']['scope'];
export const MESSAGE_SCOPES = ['PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD'] as const satisfies readonly MessageScope[];

export type MessageListResponse = Outputs['message']['list'];
export type MessageItem = MessageListResponse['items'][number];
export type Party = MessageItem['from'];
// 볼 권한이 없는 범위는 null이다. 화면은 null인 탭을 숨긴다.
export type UnreadResponse = Outputs['message']['unread'];
// 보내기 범위는 서버 입력 그대로 PRIVATE·NATION·DIPLOMACY다. 전체 메시지는 운영자만 보낸다.
export type SendInput = Inputs['message']['send'];
export type SendScope = SendInput['scope'];
export type NationNoticeResponse = Outputs['notice']['nation']['get'];
export type NationNotice = NonNullable<NationNoticeResponse>;
export type WorldNoticeResponse = Outputs['notice']['world']['list'];

// 메시지·국가 공지 본문 한도. 서버 bodyLimit(apps/server/src/messaging.ts)과 같이 유니코드 코드포인트로 센다.
export const BODY_MAX = 1_000;
export const BODY_TOO_LONG = '본문은 1,000자까지 쓸 수 있습니다.';
export const bodyLength = (value: string) => [...value].length;
