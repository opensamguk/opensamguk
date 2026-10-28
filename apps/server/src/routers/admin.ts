import { z } from 'zod';
import { adminProcedure } from '../admin/role';
import { router } from '../trpc';
import { notifySessionClosed } from '@opensamguk/db';
import { createSanction, createSanctionInput, liftSanction, liftSanctionInput } from '../admin/sanctionStore';

export const adminRouter = router({
  whoami: adminProcedure.input(z.void()).query(() => ({ admin: true as const })),
  sanction: router({
    create: adminProcedure.input(createSanctionInput).mutation(async ({ ctx, input }) => {
      const result = await createSanction(ctx.db, ctx.user.id, input, ctx.now);
      for (const sessionId of result.closedSessionIds) {
        ctx.closeSession?.(sessionId);
        await notifySessionClosed(ctx.db, sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
      }
      return { sanctionId: result.sanctionId };
    }),
    lift: adminProcedure
      .input(liftSanctionInput)
      .mutation(({ ctx, input }) => liftSanction(ctx.db, ctx.user.id, input, ctx.now)),
  }),
});
