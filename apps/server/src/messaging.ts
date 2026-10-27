import { TRPCError } from '@trpc/server';
import { notifyWorld, type Prisma, type RealtimeSignal } from '@opensamguk/db';
import { z } from 'zod';
import type { Context } from './context';
import { requireGeneral } from './queries';

export const messageScope = z.enum(['PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD']);
export type MessageScope = z.infer<typeof messageScope>;
export const bodyLimit = z.string().refine((value) => [...value].length <= 1000, '본문은 1,000자까지 쓸 수 있습니다.');
export const messageBody = bodyLimit.refine((value) => value.trim().length > 0, '본문을 입력하세요.');
export const nationTagSelect = { id: true, name: true, color: true } as const;
export const isLeader = (general: { nationId: number | null; officerLevel: number }) =>
  general.nationId !== null && [11, 12].includes(general.officerLevel);
export async function databaseTime(tx: Prisma.TransactionClient) {
  return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
}

export async function messagingActor(
  tx: Prisma.TransactionClient,
  ctx: Pick<Context, 'user' | 'sessionId'>,
  worldId: string,
  lock = false,
) {
  if (!ctx.user || !ctx.sessionId) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (lock) {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ctx.user.id} FOR SHARE`;
    await tx.$queryRaw`SELECT s.id FROM "Session" s JOIN "User" u ON u.id = s."userId" WHERE s.id = ${ctx.sessionId} FOR SHARE OF s, u`;
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND "userId" = ${ctx.user.id} FOR UPDATE`;
  }
  const now = await databaseTime(tx);
  const session = await tx.session.findFirst({
    where: { id: ctx.sessionId, userId: ctx.user.id, expiresAt: { gt: now }, user: { status: 'ACTIVE' } },
  });
  if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  return requireGeneral(tx, worldId, ctx.user.id);
}
type General = Awaited<ReturnType<typeof messagingActor>>;
export function visibleMessages(general: General, scope: MessageScope): Prisma.MessageWhereInput {
  if (scope === 'PRIVATE') return { scope, OR: [{ senderId: general.id }, { recipientId: general.id }] };
  if (scope === 'WORLD') return { scope };
  if (general.nationId === null || (scope === 'DIPLOMACY' && !isLeader(general)))
    throw new TRPCError({ code: 'FORBIDDEN', message: '이 범위의 메시지를 읽을 수 없습니다.' });
  return scope === 'NATION'
    ? { scope, recipientNationId: general.nationId }
    : { scope, OR: [{ senderNationId: general.nationId }, { recipientNationId: general.nationId }] };
}
export async function unreadMessages(tx: Prisma.TransactionClient, worldId: string, general: General) {
  const result = {} as Record<MessageScope, number | null>;
  for (const scope of messageScope.options) {
    if ((scope === 'NATION' && general.nationId === null) || (scope === 'DIPLOMACY' && !isLeader(general))) {
      result[scope] = null;
      continue;
    }
    result[scope] = await tx.message.count({
      where: {
        AND: [
          visibleMessages(general, scope),
          {
            worldId,
            OR: [{ senderId: null }, { senderId: { not: general.id } }],
            reads: { none: { generalId: general.id } },
          },
        ],
      },
    });
  }
  return result;
}
const nationTag = z.strictObject({ id: z.number().int(), name: z.string(), color: z.string() });
const party = z.strictObject({
  generalId: z.number().int().nullable(),
  name: z.string(),
  nation: nationTag.nullable(),
});
export type Party = z.infer<typeof party>;
export function messageItem(row: Prisma.MessageGetPayload<{ include: { reads: true } }>, generalId: number) {
  const sent = row.senderId === generalId;
  return {
    id: row.id,
    scope: row.scope,
    direction: sent ? ('sent' as const) : ('received' as const),
    from: party.parse(row.fromParty),
    to: row.toParty === null ? null : party.parse(row.toParty),
    body: row.body,
    sentAt: row.sentAt.toISOString(),
    gameDate: { year: row.year, month: row.month },
    read: sent || row.reads.some((read) => read.generalId === generalId),
  };
}

export function encodeMessageCursor(row: { sentAt: Date; id: string }) {
  return Buffer.from(JSON.stringify([row.sentAt.toISOString(), row.id])).toString('base64url');
}
export function decodeMessageCursor(value: string): { sentAt: Date; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    const tuple = z.tuple([z.string(), z.uuid()]).parse(raw);
    const date = new Date(tuple[0]);
    if (date.toISOString() !== tuple[0] || JSON.stringify(tuple) !== bytes.toString('utf8')) throw new Error();
    return { sentAt: date, id: tuple[1] };
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '메시지 커서가 올바르지 않습니다.' });
  }
}

export async function writeMessaging<T>(
  ctx: Context,
  work: (tx: Prisma.TransactionClient, notify: (worldId: string, signal: RealtimeSignal) => void) => Promise<T>,
) {
  const signals: Array<{ worldId: string; signal: RealtimeSignal }> = [];
  const result = await ctx.db.$transaction((tx) =>
    work(tx, (worldId, signal) => {
      signals.push({ worldId, signal });
    }),
  );
  for (const entry of signals)
    await notifyWorld(ctx.db, entry.worldId, entry.signal, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
  return result;
}
