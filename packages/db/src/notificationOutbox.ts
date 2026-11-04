import {
  notificationEvents,
  notificationPayloadSchema,
  type NotificationEvent,
  type NotificationPayload,
} from '@opensamguk/shared/notifications';
import type { Prisma } from './generated/prisma/client';

export type NotificationEntry = {
  worldId: string;
  userId: string;
  event: NotificationEvent;
  payload: NotificationPayload;
  dedupeKey: string;
};

// 호출한 게임 트랜잭션에서만 쓴다. 사건·수신자 선택은 엔진이 맡는다.
export async function enqueueNotifications(tx: Prisma.TransactionClient, entries: readonly NotificationEntry[]) {
  if (!entries.length) return 0;
  const values = entries.map((entry) => {
    const payload = notificationPayloadSchema.parse(entry.payload);
    if (
      payload.worldId !== entry.worldId ||
      !notificationEvents.includes(entry.event) ||
      !entry.dedupeKey ||
      entry.dedupeKey.length > 255
    )
      throw Error('알림 사건 형식을 확인하세요.');
    return { ...entry, payload };
  });
  const userIds = [...new Set(values.map((entry) => entry.userId))].sort();
  const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id,status FROM "User" WHERE id=ANY(${userIds}::text[]) ORDER BY id FOR SHARE`;
  const active = users.filter((user) => user.status === 'ACTIVE').map((user) => user.id);
  const targets = await tx.notificationTarget.findMany({
    where: { userId: { in: active }, status: 'ACTIVE' },
    select: { userId: true, events: true },
  });
  const allowed = new Map(targets.map((target) => [target.userId, target.events]));
  const data = values.filter((entry) => allowed.get(entry.userId)?.includes(entry.event));
  if (!data.length) return 0;
  return (await tx.notificationOutbox.createMany({ data, skipDuplicates: true })).count;
}
