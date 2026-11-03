import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { PgHeritageReadStore } from '../heritage/pgStore';
import { HeritageReadError, readHeritageMine } from '../heritage/service';

export const heritageRouter = router({
  mine: protectedProcedure.input(z.undefined()).query(async ({ ctx }) => {
    try {
      return await readHeritageMine(new PgHeritageReadStore(ctx.db), {
        userId: ctx.user.id,
        sessionId: ctx.sessionId,
        now: ctx.now,
      });
    } catch (error) {
      if (error instanceof HeritageReadError) throw new TRPCError({ code: error.code, message: error.message });
      throw error;
    }
  }),
});
