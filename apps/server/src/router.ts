import { RULESET_ID } from '@opensamguk/rules';
import { router, publicProcedure } from './trpc';
import { authRouter } from './routers/auth';

export const appRouter = router({
  auth: authRouter,
  // 화면이 서버와 DB 연결을 확인하는 데 쓴다 (AC-M1-02).
  health: publicProcedure.query(async ({ ctx }) => {
    let db: 'ok' | 'down' = 'ok';
    try {
      await ctx.db.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    return { server: 'ok' as const, db, ruleset: RULESET_ID };
  }),
});

export type AppRouter = typeof appRouter;
