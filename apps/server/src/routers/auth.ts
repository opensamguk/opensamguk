import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { hashPassword, verifyPassword } from '../auth/password';
import { newSession, SESSION_SECONDS } from '../auth/session';
import { publicProcedure, router } from '../trpc';

const credentials = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(128),
});
const loginFailure = () => new TRPCError({ code: 'UNAUTHORIZED', message: '이메일 또는 비밀번호가 맞지 않습니다' });
function setCookie(ctx: Context, token: string) {
  ctx.reply.setCookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.secureCookies,
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export const authRouter = router({
  signup: publicProcedure.input(credentials).mutation(async ({ ctx, input }) => {
    const passwordHash = await hashPassword(input.password);
    const session = newSession(ctx.now);
    try {
      const user = await ctx.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, passwordHash },
          select: { id: true, email: true },
        });
        if (ctx.sessionId) await tx.session.deleteMany({ where: { id: ctx.sessionId } });
        await tx.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
        return user;
      });
      setCookie(ctx, session.token);
      return { user };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new TRPCError({ code: 'CONFLICT', message: '이미 등록된 이메일입니다.' });
      }
      throw error;
    }
  }),
  login: publicProcedure.input(credentials).mutation(async ({ ctx, input }) => {
    const user = await ctx.db.user.findUnique({ where: { email: input.email } });
    const correct = await verifyPassword(user?.passwordHash ?? ctx.dummyPasswordHash, input.password);
    if (!user || !correct || user.status !== 'ACTIVE') throw loginFailure();
    const session = newSession(ctx.now);
    await ctx.db.$transaction(async (tx) => {
      if (ctx.sessionId) await tx.session.deleteMany({ where: { id: ctx.sessionId } });
      await tx.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    });
    setCookie(ctx, session.token);
    return { user: { id: user.id, email: user.email } };
  }),
  logout: publicProcedure.input(z.void()).mutation(async ({ ctx }) => {
    if (ctx.sessionId) await ctx.db.session.deleteMany({ where: { id: ctx.sessionId } });
    ctx.reply.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.secureCookies });
    return { ok: true as const };
  }),
  me: publicProcedure.input(z.void()).query(({ ctx }) => ({ user: ctx.user })),
});
