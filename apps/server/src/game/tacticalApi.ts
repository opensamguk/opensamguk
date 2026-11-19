import { readTransactionOptions } from '../readTransaction';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  tacticalBattleSchema,
  tacticalView,
  battleParticipant,
  canCommandBattleUnit,
  applyBattleInput,
} from '@opensamguk/rules';
import { battleTurnInputSchema, battleCouncilInputSchema, battlePlanInputSchema } from '@opensamguk/shared';
import { requireGeneral, requireWorld, readView } from './queries';
import { requirePersonnelSession } from './personnelAdmission';
import type { PersonnelActorContext } from './personnelApi';

export const tacticalIdentity = z.strictObject({
  worldId: z.string().min(1).max(64),
  battleId: z.string().min(1).max(200),
});
function fail(
  code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'BAD_REQUEST' | 'PRECONDITION_FAILED',
  message: string,
): never {
  throw new TRPCError({ code, message });
}
async function now(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return row!.now;
}
async function context(
  tx: Prisma.TransactionClient,
  ctx: PersonnelActorContext,
  input: z.infer<typeof tacticalIdentity>,
  write: boolean,
) {
  const world = await requireWorld(tx, input.worldId, write),
    time = await now(tx);
  await requirePersonnelSession(tx, { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: time });
  if (
    await tx.sanction.findFirst({
      where: {
        userId: ctx.user.id,
        liftedAt: null,
        AND: [
          { OR: [{ worldId: null }, { worldId: world.id }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: time } }] },
        ],
      },
    })
  )
    fail('FORBIDDEN', '이 월드의 이용이 제한됐습니다.');
  const actor = await requireGeneral(tx, world.id, ctx.user.id);
  const row = await tx.battle.findUnique({ where: { worldId_id: { worldId: world.id, id: input.battleId } } });
  if (!row || actor.removedAt !== null) fail('NOT_FOUND', '전투가 없습니다.');
  const b = tacticalBattleSchema.parse(row.state),
    side = battleParticipant(b, actor.id);
  if (!side) fail('NOT_FOUND', '전투가 없습니다.');
  if (write && world.status !== 'RUNNING') fail('PRECONDITION_FAILED', '실행 중인 월드가 아닙니다.');
  return { world, time, actor, b, side };
}
export async function readTactical(
  ctx: PersonnelActorContext,
  input: z.infer<typeof tacticalIdentity> & { afterTurn?: number | undefined; limit?: number | undefined },
  replay = false,
) {
  return ctx.db.$transaction(
    async (tx) => {
      const { time, actor, b, side, world } = await context(tx, ctx, input, false),
        view = await readView(tx, input.worldId);
      const battle = tacticalView(
        b,
        side,
        replay ? (input.afterTurn ?? -1) : b.turn - 1,
        replay ? (input.limit ?? 5) : 1,
      );
      const canCommandUnitIds = b.units.filter((u) => canCommandBattleUnit(b, actor.id, u.id, view)).map((u) => u.id);
      const editable = world.status === 'RUNNING' && !b.fault && b.pausedAt === null && !b.settled;
      const canCouncil = editable && b.phase === 'council';
      const orderRows = await tx.inputEvent.findMany({
        where: {
          worldId: input.worldId,
          kind: 'battle.turn',
          AND: [
            { payload: { path: ['input', 'battleId'], equals: b.id } },
            { payload: { path: ['input', 'windowNo'], equals: b.windowNo } },
          ],
        },
        orderBy: { id: 'asc' },
      });
      const ownOrders = canCommandUnitIds.map((unitId) => {
        const orders = orderRows.filter((r) => (r.payload as { input: { unitId: number } }).input.unitId === unitId);
        const latest = orders.at(-1);
        return {
          unitId,
          orderRevision: orders.length,
          action: latest ? (latest.payload as { input: { action: unknown } }).input.action : null,
        };
      });
      if (editable && canCommandUnitIds.length && b.mode === 'LIVE' && b.phase !== 'ended')
        battle.liveUntil = new Date(b.deadlineAt).toISOString();
      return {
        ...battle,
        battleId: b.id,
        revision: b.revision,
        windowNo: b.windowNo,
        turnNo: b.turn + 1,
        mode: b.mode,
        status: b.fault ? 'FAULTED' : b.settled ? 'FINISHED' : b.phase === 'council' ? 'COUNCIL' : 'ACTIVE',
        mapHash: b.mapHash,
        serverNow: time.toISOString(),
        deadlineAt: new Date(b.deadlineAt).toISOString(),
        ownSide: side,
        ownOrders,
        ownPlans: b.units.filter((u) => canCommandUnitIds.includes(u.id)).map((u) => ({ unitId: u.id, plan: u.plan })),
        blockedCells: b.cells.flatMap((cell, index) =>
          cell.sourceTileId ? [] : [{ x: index % b.board.width, y: Math.floor(index / b.board.width) }],
        ),
        routeChoices: ['front', 'left', 'right', 'encircle'],
        defenceChoices: b.siege ? ['intercept', 'ambush', 'hold'] : ['intercept', 'ambush'],
        traps: side === 'defend' ? b.traps : b.traps.filter((trap) => trap.revealed),
        schemes: b.schemes.filter((s) => s.side === side),
        supplyPreview: b.units
          .filter((u) => canCommandUnitIds.includes(u.id))
          .map((u) => ({
            unitId: u.id,
            spUnit: 'SP' as const,
            loadedSp: u.loadedSp,
            remainingSp: u.sp,
            ricePerTurnEstimate: Math.ceil(u.troops * 0.01),
          })),
        permissions: {
          canCommandUnitIds: editable ? canCommandUnitIds : [],
          canSetRoute: canCouncil && side === 'attack' && b.sides[side].commanderId === actor.id,
          canSetDefence: canCouncil && side === 'defend' && b.sides[side].commanderId === actor.id,
          canSetTraps: canCouncil && side === 'defend' && b.sides[side].advisorId === actor.id,
          canSetStratagems: canCouncil && b.sides[side].advisorId === actor.id,
          canWithdraw: editable && b.phase !== 'council' && b.sides[side].commanderId === actor.id,
        },
        nextCursor: replay ? (battle.frames.at(-1)?.turn ?? null) : null,
      };
    },
    { ...readTransactionOptions },
  );
}
export async function submitTactical(
  ctx: PersonnelActorContext,
  kind: 'battle.plan' | 'battle.council' | 'battle.turn',
  input:
    | z.infer<typeof battlePlanInputSchema>
    | z.infer<typeof battleCouncilInputSchema>
    | z.infer<typeof battleTurnInputSchema>,
) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536) fail('BAD_REQUEST', 'BAD_INPUT');
  return ctx.db.$transaction(async (tx) => {
    const c = await context(tx, ctx, input, true),
      key = `battle:${input.idempotencyKey}`;
    const previous = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: input.worldId, userId: ctx.user.id, idempotencyKey: key } },
    });
    if (previous) {
      if (previous.kind !== kind || !isDeepStrictEqual((previous.payload as { input: unknown }).input, input))
        fail('CONFLICT', 'IDEMPOTENCY_CONFLICT');
      return {
        receiptId: previous.id.toString(),
        status:
          kind === 'battle.turn' && previous.status === 'APPLIED'
            ? (c.b.receipts.find((r) => r.id === previous.id.toString())?.status ?? 'PENDING')
            : previous.status,
        acceptedAt: previous.createdAt.toISOString(),
      };
    }
    if (!c.b.deadlineAt || c.time.getTime() >= c.b.deadlineAt) fail('CONFLICT', 'WINDOW_CLOSED');
    const view = await readView(tx, input.worldId),
      check = applyBattleInput(view, kind, input, c.actor.id);
    if (!check.ok) fail(check.code === 'NOT_ALLOWED' ? 'FORBIDDEN' : 'CONFLICT', check.code);
    let orderRevision: number | null = null;
    if (kind === 'battle.turn') {
      const direct = battleTurnInputSchema.parse(input);
      const count = await tx.inputEvent.count({
        where: {
          worldId: input.worldId,
          kind: 'battle.turn',
          AND: [
            { payload: { path: ['input', 'battleId'], equals: input.battleId } },
            { payload: { path: ['input', 'windowNo'], equals: input.windowNo } },
            { payload: { path: ['input', 'unitId'], equals: direct.unitId } },
          ],
        },
      });
      if (direct.expectedUnitOrderRevision !== count) fail('CONFLICT', 'STALE_ORDER');
      orderRevision = count + 1;
    }
    const row = await tx.inputEvent.create({
      data: {
        worldId: input.worldId,
        userId: ctx.user.id,
        generalId: c.actor.id,
        kind,
        idempotencyKey: key,
        payload: JSON.parse(
          JSON.stringify({ input, sessionId: ctx.sessionId, receivedAt: c.time.getTime() }),
        ) as Prisma.InputJsonValue,
        createdAt: c.time,
      },
    });
    return {
      receiptId: row.id.toString(),
      status: 'PENDING' as const,
      acceptedAt: c.time.toISOString(),
      orderRevision,
    };
  });
}
export async function heartbeatTactical(ctx: PersonnelActorContext, input: z.infer<typeof tacticalIdentity>) {
  return ctx.db.$transaction(async (tx) => {
    const c = await context(tx, ctx, input, true);
    if (c.b.phase === 'ended') fail('CONFLICT', 'WINDOW_CLOSED');
    await tx.battlePresence.upsert({
      where: {
        worldId_battleId_generalId: { worldId: input.worldId, battleId: input.battleId, generalId: c.actor.id },
      },
      create: {
        worldId: input.worldId,
        battleId: input.battleId,
        generalId: c.actor.id,
        sessionId: ctx.sessionId!,
        receivedAt: c.time,
      },
      update: { sessionId: ctx.sessionId!, receivedAt: c.time },
    });
    return { serverNow: c.time.toISOString(), expiresAt: new Date(c.time.getTime() + 45000).toISOString() };
  });
}
export async function tacticalReceipt(ctx: PersonnelActorContext, input: { worldId: string; receiptId: string }) {
  return ctx.db.$transaction(async (tx) => {
    const row = await tx.inputEvent.findFirst({
      where: {
        id: BigInt(input.receiptId),
        worldId: input.worldId,
        userId: ctx.user.id,
        kind: { in: ['battle.plan', 'battle.council', 'battle.turn'] },
      },
    });
    if (!row) fail('NOT_FOUND', '요청이 없습니다.');
    const envelope = row.payload as { input: { battleId: string } };
    const c = await context(tx, ctx, { worldId: input.worldId, battleId: envelope.input.battleId }, false);
    const receipt = row.kind === 'battle.turn' ? c.b.receipts.find((r) => r.id === row.id.toString()) : null;
    const status = row.kind === 'battle.turn' && row.status === 'APPLIED' ? (receipt?.status ?? 'PENDING') : row.status;
    return {
      receiptId: row.id.toString(),
      status,
      result: receipt ?? row.result,
      appliedSequence: status === 'PENDING' ? null : row.sequence,
    };
  });
}
