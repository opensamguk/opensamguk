import { RULESET_ID } from '@opensamguk/rules';
import { router, publicProcedure } from './trpc';
import { authRouter } from './routers/auth';
import { accountRouter } from './routers/account';
import { legalRouter } from './routers/legal';
import { adminRouter } from './routers/admin';
import { sanctionRouter } from './routers/sanction';
import { worldRouter } from './routers/world';
import { resourcesRouter } from './routers/resources';
import { generalRouter } from './routers/general';
import { entryRouter } from './routers/entry';
import { adviceRouter } from './routers/advice';
import { turnsRouter } from './routers/turns';
import { commandsRouter } from './routers/commands';
import { homeRouter } from './routers/home';
import { cityRouter } from './routers/city';
import { nationRouter } from './routers/nation';
import { recordsRouter } from './routers/records';
import { reviewRouter } from './routers/review';
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
import { cityResourcesRouter } from './routers/cityResources';
import { logisticsRouter } from './routers/logistics';
import { equipmentRouter } from './routers/equipment';
import { governanceRouter } from './routers/governance';
import { lineageRouter } from './routers/lineage';
import { stratagemCardsRouter } from './routers/stratagemCards';
import { heritageRouter } from './routers/heritage';
import { notificationRouter } from './routers/notification';

export const appRouter = router({
  auth: authRouter,
  account: accountRouter,
  legal: legalRouter,
  admin: adminRouter,
  sanction: sanctionRouter,
  world: worldRouter,
  resources: resourcesRouter,
  general: generalRouter,
  entry: entryRouter,
  advice: adviceRouter,
  turns: turnsRouter,
  commands: commandsRouter,
  home: homeRouter,
  city: cityRouter,
  nation: nationRouter,
  records: recordsRouter,
  review: reviewRouter,
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
  cityResources: cityResourcesRouter,
  logistics: logisticsRouter,
  equipment: equipmentRouter,
  governance: governanceRouter,
  lineage: lineageRouter,
  stratagemCards: stratagemCardsRouter,
  heritage: heritageRouter,
  notification: notificationRouter,
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
