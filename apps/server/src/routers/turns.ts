import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { nextActionSequence, type Prisma } from '@opensamguk/db';
import { emptyTurn, unitSetSchema, type QueuedTurn } from '@opensamguk/rules';
import { editArray, type ArrayEdit } from '@opensamguk/shared';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { requireWorld, requireGeneral, readView, worldInput } from '../game/queries';
import {
  commandInput,
  slotInput,
  parseSlot,
  readSlots,
  displaySlots,
  assertEnabledSlots,
  hasExtensionSlot,
  invalidSlot,
} from '../game/slots';
import type { Context } from '../context';
import { requirePolicyReady } from '../game/policy';
import { worldResolver } from '../game/resolver';

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
async function submittedWorld(
  tx: Prisma.TransactionClient,
  worldId: string,
  lock: boolean,
  submitted: readonly QueuedTurn[],
) {
  try {
    return await requireWorld(tx, worldId, lock);
  } catch (error) {
    // 끈 월드와 없는 월드의 확장 key는 예전 입력 오류를 보존한다.
    if (hasExtensionSlot(submitted) && error instanceof TRPCError && error.code === 'NOT_FOUND') invalidSlot();
    throw error;
  }
}
async function save(
  ctx: Context & { user: NonNullable<Context['user']> },
  input: { worldId: string; revision: number },
  change: (old: QueuedTurn[]) => QueuedTurn[],
  submitted: readonly QueuedTurn[] = [],
) {
  const key = `turns.set:${randomUUID()}`;
  return ctx.db.$transaction(async (tx) => {
    const world = await submittedWorld(tx, input.worldId, true, submitted);
    assertEnabledSlots(world, submitted);
    if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
    const policyEnabled = world.replayFormat === 3 ? world.ruleFeatures.includes('policy') : true;
    if (policyEnabled) requirePolicyReady(world);
    // 키 재검사는 장수 잠금·revision 비교보다 먼저 한다 (§5).
    const previous = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: input.worldId, userId: ctx.user.id, idempotencyKey: key } },
    });
    if (previous) throw new TRPCError({ code: 'CONFLICT', message: '이미 처리한 요청입니다.' });
    const actor = await requireGeneral(tx, input.worldId, ctx.user.id, true);
    const old = await readSlots(tx, input.worldId, actor.id);
    if (actor.turnRevision !== input.revision)
      return {
        ok: false as const,
        reason: 'STALE' as const,
        revision: actor.turnRevision,
        slots: displaySlots(old, worldResolver(world).resolver),
      };
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
        payload: {
          turns: policyEnabled ? turns : turns.map(({ commandKey, args }) => ({ commandKey, args })),
          revision: actor.turnRevision,
        } as unknown as Prisma.InputJsonValue,
        result: { revision: nextRevision, ...(policyEnabled ? { activeTick: world.clockTick } : {}) },
      },
    });
    if (policyEnabled)
      await tx.general.update({
        where: { worldId_id: { worldId: input.worldId, id: actor.id } },
        data: {
          lastActiveTick: Math.max(actor.lastActiveTick ?? 0, world.clockTick),
          lastActiveAt: event.createdAt,
        },
      });
    return { ok: true as const, revision: nextRevision, slots: displaySlots(turns, worldResolver(world).resolver) };
  });
}
export const turnsRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
        return {
          revision: actor.turnRevision,
          slots: displaySlots(await readSlots(tx, input.worldId, actor.id), worldResolver(world).resolver),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
  set: protectedProcedure
    .input(worldInput.extend({ revision, slots: z.array(slotInput).length(30) }))
    .mutation(({ ctx, input }) => {
      const turns = input.slots.map((slot) => parseSlot(slot, true));
      return save(ctx, input, () => turns, turns);
    }),
  edit: protectedProcedure.input(worldInput.extend({ revision, op: opSchema })).mutation(({ ctx, input }) => {
    const op: ArrayEdit<QueuedTurn> =
      'put' in input.op
        ? { put: { from: input.op.put.from, to: input.op.put.to, value: parseSlot(input.op.put, true) } }
        : input.op;
    return save(ctx, input, (old) => editArray(old, op, emptyTurn), 'put' in op ? [op.put.value] : []);
  }),
  precheck: protectedProcedure.input(worldInput.extend(commandInput)).query(({ ctx, input }) => {
    const turn = parseSlot(input, true);
    return ctx.db.$transaction(
      async (tx) => {
        const world = await submittedWorld(tx, input.worldId, false, [turn]);
        const extended = hasExtensionSlot([turn]) ? worldResolver(world) : undefined;
        if (extended?.commands === null && !extended.resolver.get(turn.commandKey)) invalidSlot();
        const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
        const view = await readView(tx, input.worldId);
        const def = (extended ?? worldResolver(world)).resolver.get(turn.commandKey);
        if (!def)
          return { ok: false as const, code: 'COMMAND_DISABLED' as const, message: '이 월드에서 꺼진 명령입니다.' };
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
