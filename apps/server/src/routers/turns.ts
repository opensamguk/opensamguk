import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { nextActionSequence, type Prisma } from '@opensamguk/db';
import { commandRegistry, emptyTurn, unitSetSchema, type QueuedTurn } from '@opensamguk/rules';
import { editArray, type ArrayEdit } from '@opensamguk/shared';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { requireWorld, requireGeneral, readView, worldInput } from '../game/queries';
import { commandInput, slotInput, parseSlot, readSlots, displaySlots } from '../game/slots';
import type { Context } from '../context';
import { requirePolicyReady } from '../game/policy';

const revision = z.number().int().min(0).max(2_147_483_646);
const index = z.number().int().min(0).max(29);
const range = { from: index, to: index };
const opSchema = z.union([
  z.strictObject({ put: z.strictObject({ ...range, ...commandInput }).refine((r) => r.from <= r.to) }),
  z.strictObject({
    shift: z
      .number()
      .int()
      .min(-29)
      .max(29)
      .refine((n) => n !== 0),
  }),
  z.strictObject({
    repeat: z
      .strictObject({ ...range, to: index.max(28), times: z.number().int().min(1).max(29) })
      .refine((r) => r.from <= r.to),
  }),
]);
async function save(
  ctx: Context & { user: NonNullable<Context['user']> },
  input: { worldId: string; revision: number },
  change: (old: QueuedTurn[]) => QueuedTurn[],
) {
  const key = `turns.set:${randomUUID()}`;
  return ctx.db.$transaction(async (tx) => {
    const world = await requireWorld(tx, input.worldId, true);
    if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
    requirePolicyReady(world);
    // 키 재검사는 장수 잠금·revision 비교보다 먼저 한다 (§5).
    const previous = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: input.worldId, userId: ctx.user.id, idempotencyKey: key } },
    });
    if (previous) throw new TRPCError({ code: 'CONFLICT', message: '이미 처리한 요청입니다.' });
    const actor = await requireGeneral(tx, input.worldId, ctx.user.id, true);
    const old = await readSlots(tx, input.worldId, actor.id);
    if (actor.turnRevision !== input.revision)
      return { ok: false as const, reason: 'STALE' as const, revision: actor.turnRevision, slots: displaySlots(old) };
    const turns = change(old);
    await tx.generalTurn.deleteMany({ where: { worldId: input.worldId, generalId: actor.id } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({
        worldId: input.worldId,
        generalId: actor.id,
        slot,
        commandKey: turn.commandKey,
        explicit: turn.explicit ?? true,
        args: turn.args as Prisma.InputJsonValue,
      })),
    });
    await tx.general.update({
      where: { worldId_id: { worldId: input.worldId, id: actor.id } },
      data: { turnRevision: { increment: 1 } },
    });
    const nextRevision = actor.turnRevision + 1;
    const event = await tx.inputEvent.create({
      data: {
        worldId: input.worldId,
        userId: ctx.user.id,
        generalId: actor.id,
        kind: 'turns.set',
        idempotencyKey: key,
        status: 'APPLIED',
        sequence: await nextActionSequence(tx, input.worldId),
        payload: { turns, revision: actor.turnRevision } as unknown as Prisma.InputJsonValue,
        result: { revision: nextRevision, activeTick: world.clockTick },
      },
    });
    await tx.general.update({
      where: { worldId_id: { worldId: input.worldId, id: actor.id } },
      data: {
        lastActiveTick: Math.max(actor.lastActiveTick ?? 0, world.clockTick),
        lastActiveAt: event.createdAt,
      },
    });
    return { ok: true as const, revision: nextRevision, slots: displaySlots(turns) };
  });
}
export const turnsRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        await requireWorld(tx, input.worldId);
        const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
        return { revision: actor.turnRevision, slots: displaySlots(await readSlots(tx, input.worldId, actor.id)) };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
  set: protectedProcedure
    .input(worldInput.extend({ revision, slots: z.array(slotInput).length(30) }))
    .mutation(({ ctx, input }) => {
      const turns = input.slots.map(parseSlot);
      return save(ctx, input, () => turns);
    }),
  edit: protectedProcedure.input(worldInput.extend({ revision, op: opSchema })).mutation(({ ctx, input }) => {
    const op: ArrayEdit<QueuedTurn> =
      'put' in input.op
        ? { put: { from: input.op.put.from, to: input.op.put.to, value: parseSlot(input.op.put) } }
        : input.op;
    return save(ctx, input, (old) => editArray(old, op, emptyTurn));
  }),
  precheck: protectedProcedure.input(worldInput.extend(commandInput)).query(({ ctx, input }) => {
    const turn = parseSlot(input);
    return ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
        const view = await readView(tx, input.worldId);
        const def = commandRegistry.get(turn.commandKey)!;
        const failure = def.precheck(
          view,
          { generalId: actor.id, tick: actor.nextTurnTick, unitSet: unitSetSchema.parse(world.unitSet) },
          turn.args,
        );
        return failure ? { ok: false as const, ...failure } : { ok: true as const };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
});
