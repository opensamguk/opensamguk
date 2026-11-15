import { z } from 'zod';
import { battleCouncilInputSchema, battlePlanInputSchema, battleTurnInputSchema } from '@opensamguk/shared';
import { protectedProcedure, worldVerifiedProcedure, router } from '../trpc';
import {
  tacticalIdentity,
  readTactical,
  submitTactical,
  heartbeatTactical,
  tacticalReceipt,
} from '../game/tacticalApi';

export const battleRouter = router({
  council: router({
    get: protectedProcedure.input(tacticalIdentity).query(({ ctx, input }) => readTactical(ctx, input)),
    set: worldVerifiedProcedure
      .input(battleCouncilInputSchema)
      .mutation(({ ctx, input }) => submitTactical(ctx, 'battle.council', input)),
  }),
  plan: router({
    set: worldVerifiedProcedure
      .input(battlePlanInputSchema)
      .mutation(({ ctx, input }) => submitTactical(ctx, 'battle.plan', input)),
  }),
  presence: router({
    heartbeat: worldVerifiedProcedure
      .input(tacticalIdentity)
      .mutation(({ ctx, input }) => heartbeatTactical(ctx, input)),
  }),
  turn: router({
    get: protectedProcedure.input(tacticalIdentity).query(({ ctx, input }) => readTactical(ctx, input)),
    submit: worldVerifiedProcedure
      .input(battleTurnInputSchema)
      .mutation(({ ctx, input }) => submitTactical(ctx, 'battle.turn', input)),
  }),
  receipt: router({
    get: protectedProcedure
      .input(
        z.strictObject({
          worldId: z.string().min(1).max(64),
          receiptId: z
            .string()
            .regex(/^\d{1,20}$/)
            .refine((v) => BigInt(v) <= 9223372036854775807n),
        }),
      )
      .query(({ ctx, input }) => tacticalReceipt(ctx, input)),
  }),
  replay: router({
    get: protectedProcedure
      .input(
        tacticalIdentity.extend({
          afterTurn: z.number().int().min(-1).max(30).optional(),
          limit: z.number().int().min(1).max(5).optional(),
        }),
      )
      .query(({ ctx, input }) => readTactical(ctx, input, true)),
  }),
});
