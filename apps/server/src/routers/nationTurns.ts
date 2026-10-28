import { editArray, type ArrayEdit } from '@opensamguk/shared';
import type { QueuedTurn } from '@opensamguk/rules';
import { z } from 'zod';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { commandInput, slotInput } from '../game/slots';
import { personnelIdentity, withPersonnel } from '../game/personnelApi';
import { requirePersonnelSession } from '../game/personnelAdmission';
import {
  emptyOfficeTurn,
  parseOfficeTurn,
  readNationOfficeTabs,
  saveNationOfficeTurns,
} from '../game/nationOfficeSlots';
import type { Context } from '../context';

const index = z.number().int().min(0).max(11);
const range = { from: index, to: index };
const editInput = z.union([
  z.strictObject({ put: z.strictObject({ ...range, ...commandInput }).refine((v) => v.from <= v.to) }),
  z.strictObject({
    shift: z
      .number()
      .int()
      .min(-11)
      .max(11)
      .refine((n) => n !== 0),
  }),
  z.strictObject({
    repeat: z
      .strictObject({ ...range, to: index.max(10), times: z.number().int().min(1).max(11) })
      .refine((v) => v.from <= v.to),
  }),
]);
const saveInput = worldInput.extend({
  office: z.strictObject({
    nationId: z.number().int().positive().max(2_147_483_647),
    officerLevel: z.number().int().min(5).max(12),
    tenure: z.number().int().min(0).max(2_147_483_647),
  }),
  revision: z.number().int().min(0).max(2_147_483_646),
});
type ActorContext = Context & { user: NonNullable<Context['user']> };
function save(
  ctx: ActorContext,
  input: z.infer<typeof saveInput>,
  change: Parameters<typeof saveNationOfficeTurns>[2],
) {
  const started = performance.now();
  return ctx.db.$transaction(async (tx) => {
    await requirePersonnelSession(tx, personnelIdentity(ctx, started));
    return saveNationOfficeTurns(tx, { ...input, userId: ctx.user.id }, change);
  });
}
export const nationTurnsRouter = router({
  get: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx) => readNationOfficeTabs(tx, input.worldId, ctx.user.id)),
    ),
  set: worldVerifiedProcedure
    .input(saveInput.extend({ slots: z.array(slotInput).length(12) }))
    .mutation(({ ctx, input }) =>
      save(ctx, input, (_old, world, level) => input.slots.map((slot) => parseOfficeTurn(world, level, slot))),
    ),
  edit: worldVerifiedProcedure.input(saveInput.extend({ op: editInput })).mutation(({ ctx, input }) =>
    save(ctx, input, (old, world, level) => {
      const op: ArrayEdit<QueuedTurn> =
        'put' in input.op
          ? {
              put: { from: input.op.put.from, to: input.op.put.to, value: parseOfficeTurn(world, level, input.op.put) },
            }
          : input.op;
      return editArray(old, op, emptyOfficeTurn);
    }),
  ),
});
