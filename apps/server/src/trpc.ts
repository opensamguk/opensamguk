import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';
export const PUBLIC_ERROR_REASONS = ['EMAIL_NOT_VERIFIED', 'CONSENT_REQUIRED', 'TOKEN_INVALID'] as const;
export type PublicErrorReason = (typeof PUBLIC_ERROR_REASONS)[number];
export class PublicReasonError extends Error {
  constructor(readonly reason: PublicErrorReason) {
    super(reason);
  }
}
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const { stack, ...data } = shape.data;
    void stack;
    const reason: PublicErrorReason | null =
      error.cause instanceof PublicReasonError && PUBLIC_ERROR_REASONS.includes(error.cause.reason)
        ? error.cause.reason
        : null;
    return {
      ...shape,
      data: { ...data, reason },
      message: error.code === 'INTERNAL_SERVER_ERROR' ? '요청을 처리하지 못했습니다.' : shape.message,
    };
  },
});
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = publicProcedure.use(({ ctx, next, type }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (type === 'mutation') {
    const decision = ctx.rateLimiter.consume([
      { namespace: 'mutation.user', key: ctx.user.id, limit: 120, windowMs: 60_000 },
    ]);
    if (!decision.allowed) {
      ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
    }
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
