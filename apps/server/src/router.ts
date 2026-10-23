import { RULESET_ID } from '@opensamguk/rules';
import { router, publicProcedure } from './trpc';
import { authRouter } from './routers/auth';
import { worldRouter } from './routers/world';
import { generalRouter } from './routers/general';
import { turnsRouter } from './routers/turns';
import { commandsRouter } from './routers/commands';
import { homeRouter } from './routers/home';
import { cityRouter } from './routers/city';
import { nationRouter } from './routers/nation';
import { recordsRouter } from './routers/records';
import { rankingRouter } from './routers/ranking';
import { timelapseRouter } from './routers/timelapse';

export const appRouter = router({
  auth: authRouter,
  world: worldRouter,
  general: generalRouter,
  turns: turnsRouter,
  commands: commandsRouter,
  home: homeRouter,
  city: cityRouter,
  nation: nationRouter,
  records: recordsRouter,
  ranking: rankingRouter,
  timelapse: timelapseRouter,
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
