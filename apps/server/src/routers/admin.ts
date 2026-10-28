import { z } from 'zod';
import { adminProcedure } from '../admin/role';
import { router } from '../trpc';
import { notifySessionClosed } from '@opensamguk/db';
import { createSanction, createSanctionInput, liftSanction, liftSanctionInput } from '../admin/sanctionStore';
import { auditListInput, listAudit, searchUsers, searchUsersInput } from '../admin/read';
import { listAdminWorlds } from '../admin/worlds';
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
  world: router({ list: adminProcedure.input(z.void()).query(({ ctx }) => listAdminWorlds(ctx)) }),
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
    search: adminProcedure
      .input(searchUsersInput)
      .query(({ ctx, input }) => searchUsers(ctx.db, ctx.user.id, input, ctx.now)),
  }),
  audit: router({
    list: adminProcedure.input(auditListInput).query(({ ctx, input }) => listAudit(ctx.db, ctx.user.id, input)),
  }),
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
