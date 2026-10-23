import { trpcClient } from '../trpc';

// T2-20(Codex)의 알림 설정 계약 초안을 옮긴 임시 타입과 호출이다.
// 기준: docs/plans/T2-20.md "API 계약"과 "화면(T2-21)이 기대하는 응답 모양" 절 (검토 R63-11R 반영본).
// Codex API가 main에 들어오면 이 파일을 지우고 AppRouter 타입(useTRPC의 notification)으로 바꾼다.

export type NotificationEvent = 'turn.failed' | 'attacked' | 'diplomacy.offer' | 'turns.low';

export type NotificationResponse = {
  discord: {
    last4: string;
    status: 'active' | 'disabled';
    disabledReason: 'DISCORD_GONE' | null;
    verifiedAt: string;
    events: NotificationEvent[];
  } | null;
  generation: number;
  eventOptions: { key: NotificationEvent; name: string }[];
};

interface PendingClient {
  notification: {
    get: { query(): Promise<NotificationResponse> };
    setDiscord: {
      mutate(input: { url: string; events: NotificationEvent[]; generation: number }): Promise<NotificationResponse>;
    };
    setEvents: { mutate(input: { events: NotificationEvent[]; generation: number }): Promise<NotificationResponse> };
    removeDiscord: { mutate(input: { generation: number }): Promise<NotificationResponse> };
  };
}

// tRPC 프록시는 타입에 없는 경로도 /trpc/<path>로 보낸다. 캐스트는 이 한 곳에만 둔다.
export const api = trpcClient as unknown as PendingClient;

// @trpc/tanstack-react-query의 입력 없는 query 키 모양이다.
export const notificationKey = [['notification', 'get'], { type: 'query' }] as const;
