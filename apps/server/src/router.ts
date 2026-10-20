import { RULESET_ID } from '@opensamguk/rules';
import { initTRPC } from '@trpc/server';
import type { Context } from './context';

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
  // 화면이 서버와 DB 연결을 확인하는 데 쓴다 (AC-M1-02).
  health: t.procedure.query(async ({ ctx }) => {
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
