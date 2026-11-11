import type { Prisma } from '@opensamguk/db';
import { intelRecordSchema, nowTick, unitSetSchema } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { activeSanctionWhere } from '../auth/sanction';
import type { Context } from '../context';
import { requirePersonnelSession } from './personnelAdmission';
import { personnelIdentity } from './personnelApi';
import { requireVerifiedAccount } from '../trpc';
import { intelPolicy } from '../intelPolicy';
import { worldClock } from '../queries';
import { intelRecordInfo } from '../visibility';

export async function requireIntelReader(
  tx: Prisma.TransactionClient,
  ctx: Context & { user: { id: string } },
  worldId: string,
  started: number,
) {
  await requirePersonnelSession(tx, personnelIdentity(ctx, started));
  await requireVerifiedAccount(tx, ctx);
  const sanction = await tx.sanction.findFirst({
    where: {
      userId: ctx.user.id,
      ...activeSanctionWhere(ctx.now),
      AND: [{ OR: [{ worldId: null }, { worldId }] }],
    },
    select: { id: true },
  });
  if (sanction) throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
}

export async function readCityIntel(
  tx: Prisma.TransactionClient,
  world: Parameters<typeof worldClock>[0] & { id: string; startYear: number },
  nationId: number,
  cityKey: number,
  ctx: Context & { user: { id: string } },
) {
  try {
    await requireIntelReader(tx, ctx, world.id, performance.now());
  } catch (error) {
    if (error instanceof TRPCError) return null;
    throw error;
  }
  const [row] = await tx.$queryRaw<
    { ledgerType: string; nationType: string | null; recordType: string | null; record: unknown }[]
  >`
    SELECT jsonb_typeof("value") AS "ledgerType",
           jsonb_typeof("value" -> ${String(nationId)}::text) AS "nationType",
           jsonb_typeof("value" -> ${String(nationId)}::text -> ${String(cityKey)}::text) AS "recordType",
           "value" -> ${String(nationId)}::text -> ${String(cityKey)}::text AS "record"
    FROM "WorldExtSlice" WHERE "worldId" = ${world.id} AND "key" = 'intel'
  `;
  if (row?.ledgerType !== 'object' || (row.nationType !== null && row.nationType !== 'object'))
    throw new Error('첩보 기록을 읽을 수 없습니다.');
  if (row.recordType === null) return null;
  const record = intelRecordSchema.safeParse(row.record);
  if (!record.success) throw new Error('첩보 기록을 읽을 수 없습니다.');
  const { unitSet } = await tx.world.findUniqueOrThrow({ where: { id: world.id }, select: { unitSet: true } });
  return intelRecordInfo(
    cityKey,
    record.data,
    { startYear: world.startYear, tick: nowTick(worldClock(world), ctx.now), unitSet: unitSetSchema.parse(unitSet) },
    intelPolicy,
  );
}
