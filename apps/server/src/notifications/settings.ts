import type { Prisma, PrismaClient } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { hasGlobalSanction } from '../auth/sanction';
import { normalizeDiscordWebhookUrl, sendDiscordWebhook, type DiscordWebhookTransport } from './discordWebhook';

export const notificationEvents = ['turn.failed', 'attacked', 'diplomacy.offer', 'turns.low'] as const;
export type NotificationEvent = (typeof notificationEvents)[number];
const names = ['예턴 실패', '공격받음', '외교 제안', '예턴 3칸 이하'] as const;
type Identity = { userId: string; sessionId: string | null };
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
const denied = () => new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
const conflict = () =>
  new TRPCError({ code: 'CONFLICT', message: '다른 곳에서 알림 설정이 바뀌었습니다. 다시 확인해 주세요.' });
const orderedEvents = (events: readonly string[]): NotificationEvent[] =>
  notificationEvents.filter((event) => events.includes(event));

async function checkIdentity(tx: Prisma.TransactionClient, identity: Identity, generation?: number) {
  if (!identity.sessionId) throw denied();
  const user = await tx.user.findUnique({
    where: { id: identity.userId },
    select: { status: true, notificationGeneration: true },
  });
  const session = await tx.session.findUnique({
    where: { id: identity.sessionId },
    select: { userId: true, expiresAt: true },
  });
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (
    !clock ||
    !user ||
    user.status !== 'ACTIVE' ||
    !session ||
    session.userId !== identity.userId ||
    session.expiresAt.getTime() <= clock.now.getTime() ||
    (await hasGlobalSanction(tx, identity.userId, clock.now.getTime()))
  )
    throw denied();
  if (generation !== undefined && (generation !== user.notificationGeneration || generation === 2147483647))
    throw conflict();
  return { generation: user.notificationGeneration, now: clock.now };
}
async function lockIdentity(tx: Prisma.TransactionClient, identity: Identity, generation: number) {
  if (!identity.sessionId) throw denied();
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${identity.sessionId} FOR UPDATE`;
  return checkIdentity(tx, identity, generation);
}
async function response(
  tx: Prisma.TransactionClient,
  userId: string,
  generation: number,
): Promise<NotificationResponse> {
  const target = await tx.notificationTarget.findUnique({
    where: { userId },
    select: { last4: true, status: true, verifiedAt: true, events: true },
  });
  return {
    discord: target
      ? {
          last4: target.last4,
          status: target.status === 'ACTIVE' ? 'active' : 'disabled',
          disabledReason: target.status === 'ACTIVE' ? null : 'DISCORD_GONE',
          verifiedAt: target.verifiedAt.toISOString(),
          events: orderedEvents(target.events),
        }
      : null,
    generation,
    eventOptions: notificationEvents.map((key, index) => ({ key, name: names[index]! })),
  };
}
export function getNotificationSettings(db: PrismaClient, identity: Identity) {
  return db.$transaction(
    async (tx) => {
      const current = await checkIdentity(tx, identity);
      return response(tx, identity.userId, current.generation);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function setDiscord(
  db: PrismaClient,
  identity: Identity,
  input: { url: string; events: NotificationEvent[]; generation: number },
  transport?: DiscordWebhookTransport,
) {
  const endpoint = normalizeDiscordWebhookUrl(input.url);
  if (!endpoint) throw new TRPCError({ code: 'BAD_REQUEST', message: '디스코드 웹훅 주소가 아닙니다.' });
  await db.$transaction((tx) => lockIdentity(tx, identity, input.generation));
  const result = await sendDiscordWebhook(
    { url: endpoint.endpoint, content: '[오픈삼국] 디스코드 알림 연결을 확인했습니다.' },
    transport ? { transport } : undefined,
  );
  if (result.kind !== 'HTTP_OBSERVED' || result.status < 200 || result.status >= 300) {
    const status = result.kind === 'HTTP_OBSERVED' ? result.status : 0;
    const message =
      status === 401 || status === 404
        ? '웹훅을 찾을 수 없습니다. 디스코드에서 웹훅 주소를 다시 복사해 주세요.'
        : status === 429
          ? '디스코드가 요청을 잠시 막았습니다. 조금 뒤 다시 시도해 주세요.'
          : status === 0 || status >= 500
            ? '디스코드가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.'
            : '디스코드가 메시지를 받지 않았습니다. 웹훅 설정을 확인해 주세요.';
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }
  return db.$transaction(async (tx) => {
    const current = await lockIdentity(tx, identity, input.generation);
    await tx.notificationTarget.deleteMany({ where: { userId: identity.userId } });
    await tx.notificationTarget.create({
      data: {
        userId: identity.userId,
        endpoint: endpoint.endpoint,
        last4: endpoint.last4,
        events: orderedEvents(input.events),
        verifiedAt: current.now,
      },
    });
    await tx.user.update({ where: { id: identity.userId }, data: { notificationGeneration: { increment: 1 } } });
    return response(tx, identity.userId, current.generation + 1);
  });
}
export function changeNotificationSettings(
  db: PrismaClient,
  identity: Identity,
  input: { generation: number; events?: NotificationEvent[] },
) {
  return db.$transaction(async (tx) => {
    const current = await lockIdentity(tx, identity, input.generation);
    if (input.events !== undefined) {
      const updated = await tx.notificationTarget.updateMany({
        where: { userId: identity.userId },
        data: { events: orderedEvents(input.events) },
      });
      if (updated.count !== 1)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '먼저 디스코드 웹훅을 등록해 주세요.' });
    } else await tx.notificationTarget.deleteMany({ where: { userId: identity.userId } });
    await tx.user.update({ where: { id: identity.userId }, data: { notificationGeneration: { increment: 1 } } });
    return response(tx, identity.userId, current.generation + 1);
  });
}
