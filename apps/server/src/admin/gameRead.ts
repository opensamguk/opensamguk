import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { z } from 'zod';
import type { Context } from '../context';
import { worldInput, entityKey } from '../queries';
import { logInfo, logSelect } from '../visibility';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor, recordId, recordTick } from '../recordCursor';
import { requireCurrentAdmin } from './access';

export const adminGeneralInput = worldInput.extend({ generalId: entityKey }).strict();
const filters = worldInput.extend({
  fromTick: recordTick.optional(),
  toTick: recordTick.optional(),
  cursor: z.string().min(1).max(256).optional(),
});
const ordered = (input: { fromTick?: number | undefined; toTick?: number | undefined }) =>
  input.fromTick === undefined || input.toTick === undefined || input.fromTick <= input.toTick;
export const adminGeneralRecordsInput = filters.extend({ generalId: entityKey }).strict().refine(ordered);
export const adminNationRecordsInput = filters.extend({ nationId: entityKey.optional() }).strict().refine(ordered);
export const adminBattlesInput = filters.extend({ generalId: entityKey.optional() }).strict().refine(ordered);
const tickRange = (input: { fromTick?: number | undefined; toTick?: number | undefined }) => ({
  ...(input.fromTick === undefined ? {} : { gte: input.fromTick }),
  ...(input.toTick === undefined ? {} : { lte: input.toTick }),
});
function page<T>(rows: T[], cursor: (row: T) => unknown) {
  const items = rows.slice(0, 100);
  return { items, nextCursor: rows.length > 100 ? encodeRecordCursor(cursor(items.at(-1)!)) : null };
}
async function read<T>(
  ctx: Context,
  worldId: string,
  kind: string,
  targetId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  try {
    return await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR SHARE`;
      const actorUserId = await requireCurrentAdmin(tx, ctx, false);
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId,
          action: 'admin.game.read',
          worldId,
          targetType: targetId === worldId ? 'World' : kind === 'nationLogs' ? 'Nation' : 'General',
          targetId,
          payload: { kind },
        },
      });
      return work(tx);
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '운영 기록을 확인하지 못했습니다.' });
  }
}
export async function readAdminGeneral(ctx: Context, input: z.infer<typeof adminGeneralInput>) {
  const general = await read(ctx, input.worldId, 'general', String(input.generalId), async (tx) => {
    const row = await tx.general.findUnique({ where: { worldId_id: { worldId: input.worldId, id: input.generalId } } });
    return row ? { ...row, lastActiveAt: row.lastActiveAt?.toISOString() ?? null } : null;
  });
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '장수를 찾을 수 없습니다.' });
  return general;
}
export function readAdminGeneralLogs(ctx: Context, input: z.infer<typeof adminGeneralRecordsInput>) {
  const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, generalLogCursor);
  return read(ctx, input.worldId, 'generalLogs', String(input.generalId), async (tx) => {
    const rows = await tx.generalLog.findMany({
      where: {
        worldId: input.worldId,
        generalId: input.generalId,
        tick: tickRange(input),
        ...(cursor ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], id: { lt: BigInt(cursor[1]) } }] } : {}),
      },
      orderBy: [{ tick: 'desc' }, { id: 'desc' }],
      take: 101,
      select: logSelect,
    });
    return page(rows.map(logInfo), (row) => [row.tick, row.id]);
  });
}
export function readAdminGeneralInputs(ctx: Context, input: z.infer<typeof adminGeneralRecordsInput>) {
  const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, z.tuple([recordId]));
  return read(ctx, input.worldId, 'generalInputs', String(input.generalId), async (tx) => {
    const rows = await tx.inputEvent.findMany({
      where: {
        worldId: input.worldId,
        OR: [
          { generalId: input.generalId },
          { kind: { startsWith: 'admin.' }, payload: { path: ['action', 'generalId'], equals: input.generalId } },
        ],
        ...(input.fromTick !== undefined || input.toTick !== undefined ? { tick: tickRange(input) } : {}),
        ...(cursor ? { id: { lt: BigInt(cursor[0]) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 101,
      select: {
        id: true,
        generalId: true,
        kind: true,
        status: true,
        sequence: true,
        tick: true,
        payload: true,
        result: true,
        createdAt: true,
      },
    });
    return page(
      rows.map((row) => ({ ...row, id: String(row.id), createdAt: row.createdAt.toISOString() })),
      (row) => [row.id],
    );
  });
}
export function readAdminNationLogs(ctx: Context, input: z.infer<typeof adminNationRecordsInput>) {
  const cursor = input.cursor === undefined ? null : decodeRecordCursor(input.cursor, z.tuple([recordTick, entityKey]));
  return read(ctx, input.worldId, 'nationLogs', String(input.nationId ?? input.worldId), async (tx) => {
    const rows = await tx.nationHistory.findMany({
      where: {
        worldId: input.worldId,
        ...(input.nationId === undefined ? {} : { nationId: input.nationId }),
        tick: tickRange(input),
        ...(cursor ? { OR: [{ tick: { lt: cursor[0] } }, { tick: cursor[0], nationId: { lt: cursor[1] } }] } : {}),
      },
      orderBy: [{ tick: 'desc' }, { nationId: 'desc' }],
      take: 101,
      select: { tick: true, nationId: true, data: true },
    });
    return page(rows, (row) => [row.tick, row.nationId]);
  });
}
export function readAdminBattles(ctx: Context, input: z.infer<typeof adminBattlesInput>) {
  const cursor =
    input.cursor === undefined ? null : decodeRecordCursor(input.cursor, z.tuple([recordTick, entityKey, entityKey]));
  return read(ctx, input.worldId, 'battles', String(input.generalId ?? input.worldId), async (tx) => {
    const rows = await tx.battleLog.findMany({
      where: {
        worldId: input.worldId,
        tick: tickRange(input),
        AND: [
          ...(input.generalId === undefined
            ? []
            : [{ OR: [{ generalId: input.generalId }, { attackerId: input.generalId }] }]),
          ...(cursor
            ? [
                {
                  OR: [
                    { tick: { lt: cursor[0] } },
                    { tick: cursor[0], attackerId: { lt: cursor[1] } },
                    { tick: cursor[0], attackerId: cursor[1], generalId: { lt: cursor[2] } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ tick: 'desc' }, { attackerId: 'desc' }, { generalId: 'desc' }],
      take: 101,
      select: { tick: true, attackerId: true, generalId: true, text: true },
    });
    return page(rows, (row) => [row.tick, row.attackerId, row.generalId]);
  });
}
