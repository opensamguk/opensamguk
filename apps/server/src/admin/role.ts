import { TRPCError } from '@trpc/server';
import { verifiedProcedure } from '../trpc';

export const adminProcedure = verifiedProcedure.use(async ({ ctx, next }) => {
  const user = await ctx.db.user.findUnique({ where: { id: ctx.user.id }, select: { role: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (user.role !== 'ADMIN') throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' });
  return next();
});
