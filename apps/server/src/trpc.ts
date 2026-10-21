import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const { stack, ...data } = shape.data;
    void stack;
    return {
      ...shape,
      data,
      message: error.code === 'INTERNAL_SERVER_ERROR' ? '요청을 처리하지 못했습니다.' : shape.message,
    };
  },
});
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
