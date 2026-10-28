import { RULESET_ID } from '@opensamguk/rules';
import { router, publicProcedure } from './trpc';
import { authRouter } from './routers/auth';
import { accountRouter } from './routers/account';
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
import { messageRouter } from './routers/message';
import { noticeRouter } from './routers/notice';
import { lobbyRouter } from './routers/lobby';
import { operationRouter } from './routers/operation';
import { inspectionRouter } from './routers/inspection';
import { treatyRouter } from './routers/treaty';
import { personnelRouter } from './routers/personnel';
import { offersRouter } from './routers/offers';
import { nationTurnsRouter } from './routers/nationTurns';
import { nationCommandsRouter } from './routers/nationCommands';
import { campaignRouter } from './routers/campaign';

export const appRouter = router({
  auth: authRouter,
  account: accountRouter,
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
  message: messageRouter,
  notice: noticeRouter,
  lobby: lobbyRouter,
  operation: operationRouter,
  inspection: inspectionRouter,
  treaty: treatyRouter,
  personnel: personnelRouter,
  offers: offersRouter,
  nationTurns: nationTurnsRouter,
  nationCommands: nationCommandsRouter,
  campaign: campaignRouter,
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
