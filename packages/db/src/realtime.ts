import type { PrismaClient } from './generated/prisma/client';

export type RealtimeTarget =
  'world' | { generalId: number } | { nationId: number } | { nationIds: number[]; leadersOnly?: boolean | undefined };
export interface RealtimeSignal {
  kind: 'turn.result' | 'message.new' | 'monthly.done' | 'offer.new' | 'treaty.new' | 'notice.updated';
  scope?: 'PRIVATE' | 'NATION' | 'DIPLOMACY' | 'WORLD' | 'nation' | 'world' | undefined;
  target: RealtimeTarget;
}
export function worldChannel(worldId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(worldId))
    throw new Error('월드 ID가 올바르지 않습니다.');
  return `world_${worldId}`;
}

// 저장 트랜잭션이 성공한 뒤 별도 autocommit SQL에서만 호출한다.
async function notify(db: PrismaClient, channel: string, payload: string, warn: () => void) {
  try {
    await db.$queryRaw`SELECT pg_notify(${channel}, ${payload})::text`;
    return true;
  } catch {
    warn();
    return false;
  }
}
export async function notifyWorld(
  db: PrismaClient,
  worldId: string,
  signal: RealtimeSignal,
  warn: () => void = () => {},
) {
  let channel: string, payload: string;
  try {
    channel = worldChannel(worldId);
    payload = JSON.stringify(signal);
  } catch {
    warn();
    return false;
  }
  return notify(db, channel, payload, warn);
}
export function notifySessionClosed(db: PrismaClient, sessionId: string, warn: () => void = () => {}) {
  return notify(db, 'sessions_closed', sessionId, warn);
}
