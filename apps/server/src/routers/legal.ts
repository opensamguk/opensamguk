import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasGlobalSanction } from '../auth/sanction';
import { protectedProcedure, publicProcedure, router } from '../trpc';

export const legalRouter = router({
  current: publicProcedure
    .input(z.void())
    .query(({ ctx }) =>
      ctx.legalPolicy
        ? { status: 'current' as const, ...ctx.legalPolicy }
        : { status: 'pending' as const, terms: null, privacy: null },
    ),
  agree: protectedProcedure
    .meta({ accountAccess: 'recovery' })
    .input(z.strictObject({ docType: z.enum(['TERMS', 'PRIVACY']), version: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const policy = ctx.legalPolicy;
      if (!policy) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '약관을 준비하고 있습니다.' });
      if (input.version !== policy[input.docType === 'TERMS' ? 'terms' : 'privacy'].version)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '현재 약관 판을 확인하세요.' });
      await ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ctx.user.id} FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { id: ctx.user.id }, select: { status: true } });
        if (!user || user.status !== 'ACTIVE' || (await hasGlobalSanction(tx, ctx.user.id, ctx.now)))
          throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
        await tx.consentRecord.createMany({
          data: { userId: ctx.user.id, docType: input.docType, version: input.version, agreedAt: new Date(ctx.now) },
          skipDuplicates: true,
        });
      });
      return { ok: true as const };
    }),
});
