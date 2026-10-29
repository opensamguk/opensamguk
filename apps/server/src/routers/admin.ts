import { z } from 'zod';
import { adminProcedure } from '../admin/role';
import { router } from '../trpc';
import { notifySessionClosed } from '@opensamguk/db';
import { createAdminSanction, createSanctionInput, liftAdminSanction, liftSanctionInput } from '../admin/sanctionStore';
import { auditListInput, getUser, getUserInput, listAudit, searchUsers, searchUsersInput } from '../admin/read';
import { listAdminWorlds } from '../admin/worlds';
import { requestWorldCreateInput, worldCreateStatusInput } from '@opensamguk/rules';
import { requestWorldCreate, getWorldCreateRequest } from '../admin/worldCreate';
import { creationOptionsInput, getWorldCreationOptions } from '../admin/worldCreateOptions';

import { requestWorldEnd, requestWorldEndInput, getWorldEndRequest, worldEndRequestInput } from '../admin/worldEnd';
import {
  requestWorldClock,
  requestWorldClockInput,
  getWorldClockRequest,
  worldClockRequestInput,
} from '../admin/worldActions';
import {
  listAdminNotices,
  changeAdminNotice,
  noticeListInput,
  noticeCreateInput,
  noticeUpdateInput,
  noticeHideInput,
} from '../admin/notices';

export const adminRouter = router({
  whoami: adminProcedure.input(z.void()).query(() => ({ admin: true as const })),
  world: router({
    creationOptions: adminProcedure
      .input(creationOptionsInput)
      .query(({ ctx, input }) => getWorldCreationOptions(ctx, input)),
    create: adminProcedure.input(requestWorldCreateInput).mutation(({ ctx, input }) => requestWorldCreate(ctx, input)),
    createStatus: adminProcedure
      .input(worldCreateStatusInput)
      .query(({ ctx, input }) => getWorldCreateRequest(ctx, input)),
    list: adminProcedure.input(z.void()).query(({ ctx }) => listAdminWorlds(ctx)),
    requestEnd: adminProcedure.input(requestWorldEndInput).mutation(({ ctx, input }) => requestWorldEnd(ctx, input)),
    endRequest: adminProcedure.input(worldEndRequestInput).query(({ ctx, input }) => getWorldEndRequest(ctx, input)),
    requestClock: adminProcedure
      .input(requestWorldClockInput)
      .mutation(({ ctx, input }) => requestWorldClock(ctx, input)),
    clockRequest: adminProcedure
      .input(worldClockRequestInput)
      .query(({ ctx, input }) => getWorldClockRequest(ctx, input)),
  }),
  notice: router({
    list: adminProcedure.input(noticeListInput).query(({ ctx, input }) => listAdminNotices(ctx, input)),
    create: adminProcedure
      .input(noticeCreateInput)
      .mutation(({ ctx, input }) => changeAdminNotice(ctx, { kind: 'create', input })),
    update: adminProcedure
      .input(noticeUpdateInput)
      .mutation(({ ctx, input }) => changeAdminNotice(ctx, { kind: 'update', input })),
    hide: adminProcedure
      .input(noticeHideInput)
      .mutation(({ ctx, input }) => changeAdminNotice(ctx, { kind: 'hide', input })),
  }),
  user: router({
    get: adminProcedure.input(getUserInput).query(({ ctx, input }) => getUser(ctx.db, ctx.user.id, input, ctx.now)),
    search: adminProcedure
      .input(searchUsersInput)
      .query(({ ctx, input }) => searchUsers(ctx.db, ctx.user.id, input, ctx.now)),
  }),
  audit: router({
    list: adminProcedure.input(auditListInput).query(({ ctx, input }) => listAudit(ctx.db, ctx.user.id, input)),
  }),
  sanction: router({
    create: adminProcedure.input(createSanctionInput).mutation(async ({ ctx, input }) => {
      const result = await createAdminSanction(ctx, input);
      for (const sessionId of result.closedSessionIds) {
        ctx.closeSession?.(sessionId);
        await notifySessionClosed(ctx.db, sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
      }
      return { sanctionId: result.sanctionId };
    }),
    lift: adminProcedure.input(liftSanctionInput).mutation(({ ctx, input }) => liftAdminSanction(ctx, input)),
  }),
});
