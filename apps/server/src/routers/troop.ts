import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { nextTurnAt } from '../queries';
import { TRPCError } from '@trpc/server';
import {
  changeTroop,
  readTroops,
  TROOP_ACTION_KIND,
  TROOP_FEATURE,
  troopActionSchema,
  troopOf,
} from '@opensamguk/rules';
import { requireGeneral, requireRuleFeature, requireWorld, readView, worldInput } from '../game/queries';
import { router, worldVerifiedProcedure } from '../trpc';

export const troopRouter = router({
  list: worldVerifiedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const actor = await requireGeneral(tx, world.id, ctx.user.id);
        if (!world.ruleFeatures.includes(TROOP_FEATURE))
          return { enabled: false as const, myTroop: null, troops: [], latest: null };
        const view = await readView(tx, world.id);
        const troops = readTroops(view)!;
        const myTroop = troopOf(troops, actor.id);
        const latest = await tx.inputEvent.findFirst({
          where: { worldId: world.id, generalId: actor.id, kind: TROOP_ACTION_KIND, userId: ctx.user.id },
          orderBy: { id: 'desc' },
          select: { id: true, status: true, result: true },
        });
        const identity = (id: number) => {
          const general = view.generals[id]!;
          return {
            id,
            name: general.name,
            portraitId: general.portraitId,
            cityKey: general.cityKey,
            cityName: view.cities[general.cityKey]?.name ?? null,
          };
        };
        const visible = Object.values(troops.troops)
          .filter((troop) => troop.nationId === actor.nationId)
          .sort((a, b) => a.leaderId - b.leaderId);
        const leaders = visible.map((troop) => troop.leaderId);
        const turns = leaders.length
          ? await tx.generalTurn.findMany({
              where: { worldId: world.id, generalId: { in: leaders }, slot: { lt: 5 } },
              orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
              select: { generalId: true, slot: true, commandKey: true },
            })
          : [];
        const canChange = world.status === 'RUNNING' && actor.nationId !== null && actor.removedAt === null;
        return {
          enabled: true as const,
          actorId: actor.id,
          canChange,
          canCreate: canChange && !myTroop,
          myTroop: myTroop?.leaderId ?? null,
          latest: latest
            ? {
                id: String(latest.id),
                status: latest.status,
                message:
                  latest.result &&
                  typeof latest.result === 'object' &&
                  !Array.isArray(latest.result) &&
                  typeof latest.result.message === 'string'
                    ? latest.result.message
                    : null,
              }
            : null,
          troops: visible.map((troop) => ({
            ...troop,
            leader: identity(troop.leaderId),
            nextTurnAt: nextTurnAt(world, view.generals[troop.leaderId]!.nextTurnTick),
            nextTurnTick: view.generals[troop.leaderId]!.nextTurnTick,
            gatherSlots: Array.from({ length: 5 }, (_, slot) =>
              turns.some(
                (turn) => turn.generalId === troop.leaderId && turn.slot === slot && turn.commandKey === 'troop_gather',
              ),
            ),
            members: troop.members.map(identity),
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
  update: worldVerifiedProcedure
    .input(worldInput.extend({ expectedGeneralId: z.number().int().positive(), change: troopActionSchema }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const world = await requireWorld(tx, input.worldId, true);
        requireRuleFeature(world, TROOP_FEATURE);
        if (world.status !== 'RUNNING')
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
        const actor = await requireGeneral(tx, world.id, ctx.user.id, true);
        if (actor.id !== input.expectedGeneralId)
          throw new TRPCError({ code: 'CONFLICT', message: '내 장수가 바뀌었습니다.' });
        const pending = await tx.inputEvent.findFirst({
          where: { worldId: world.id, generalId: actor.id, kind: TROOP_ACTION_KIND, status: 'PENDING' },
          select: { id: true, payload: true, userId: true },
        });
        if (pending) {
          if (
            pending.userId !== ctx.user.id ||
            !isDeepStrictEqual(troopActionSchema.parse(pending.payload), input.change)
          )
            throw new TRPCError({ code: 'CONFLICT', message: '다른 부대 변경을 처리하고 있습니다.' });
          return { status: 'pending' as const, id: String(pending.id) };
        }
        const view = await readView(tx, world.id);
        const changed = changeTroop(view, readTroops(view)!, actor.id, input.change);
        if (!changed.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: changed.message });
        const event = await tx.inputEvent.create({
          data: {
            worldId: world.id,
            userId: ctx.user.id,
            generalId: actor.id,
            kind: TROOP_ACTION_KIND,
            idempotencyKey: `${TROOP_ACTION_KIND}:${randomUUID()}`,
            payload: input.change,
          },
          select: { id: true },
        });
        return { status: 'pending' as const, id: String(event.id) };
      }),
    ),
});
