import { TRPCError } from '@trpc/server';
import { verifiedProcedure } from '../trpc';
import type { Context } from '../context';

export async function requireAdminRole(db: Context['db'], userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (user.role !== 'ADMIN') throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' });
}
export const adminProcedure = verifiedProcedure.use(async ({ ctx, next }) => {
  await requireAdminRole(ctx.db, ctx.user.id);
  return next();
});
