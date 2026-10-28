import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { hashPassword, passwordSchema, verifyPassword } from '../auth/password';
import { newSession, SESSION_SECONDS } from '../auth/session';
import { publicProcedure, router } from '../trpc';
import type { LimitRule, RateLimitDecision } from '../security/rateLimit';
import { notifySessionClosed } from '@opensamguk/db';
import { queueLoginActivity } from '../game/policy';
import { newAccountToken } from '../auth/accountToken';
import { accountMail } from '../mail/templates';

function enforce(ctx: Context, decision: RateLimitDecision) {
  if (decision.allowed) return;
  ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
}

const credentials = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
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
    enforce(
      ctx,
      ctx.rateLimiter.consume([{ namespace: 'auth.signup.ip', key: ctx.ip, limit: 10, windowMs: 3_600_000 }]),
    );
    const passwordHash = await hashPassword(input.password);
    const session = newSession(ctx.now);
    const verification = ctx.accountMail ? newAccountToken('VERIFY_EMAIL', ctx.now) : null;
    try {
      const user = await ctx.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, passwordHash },
          select: { id: true, email: true },
        });
        if (ctx.sessionId) {
          await tx.session.deleteMany({ where: { id: ctx.sessionId } });
        }
        await tx.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
        if (verification) {
          await tx.accountToken.create({
            data: {
              id: verification.id,
              userId: user.id,
              purpose: 'VERIFY_EMAIL',
              expiresAt: verification.expiresAt,
            },
          });
        }
        return user;
      });
      setCookie(ctx, session.token);
      if (ctx.sessionId) {
        ctx.closeSession?.(ctx.sessionId);
        await notifySessionClosed(ctx.db, ctx.sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
      }
      if (verification && ctx.accountMail) {
        try {
          await ctx.accountMail.transport.send(
            accountMail(user.email, 'VERIFY_EMAIL', ctx.accountMail.origin, verification.token),
          );
        } catch {
          ctx.reply.log.warn('가입 인증 메일 발송 실패');
        }
      }
      return { user };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new TRPCError({ code: 'CONFLICT', message: '이미 등록된 이메일입니다.' });
      }
      throw error;
    }
  }),
  login: publicProcedure.input(credentials).mutation(async ({ ctx, input }) => {
    enforce(ctx, ctx.rateLimiter.consume([{ namespace: 'auth.login.ip', key: ctx.ip, limit: 30, windowMs: 900_000 }]));
    const failures: LimitRule[] = [
      { namespace: 'auth.login.failure', key: JSON.stringify([input.email, ctx.ip]), limit: 5, windowMs: 900_000 },
    ];
    enforce(ctx, ctx.rateLimiter.check(failures));
    const user = await ctx.db.user.findUnique({ where: { email: input.email } });
    const correct = await verifyPassword(user?.passwordHash ?? ctx.dummyPasswordHash, input.password);
    if (!user || !correct || user.status !== 'ACTIVE') {
      ctx.rateLimiter.consume(failures);
      throw loginFailure();
    }
    const session = newSession(ctx.now);
    await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR SHARE`;
      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: { status: true, passwordHash: true, email: true },
      });
      if (
        !current ||
        current.status !== 'ACTIVE' ||
        current.passwordHash !== user.passwordHash ||
        current.email !== user.email
      ) {
        ctx.rateLimiter.consume(failures);
        throw loginFailure();
      }
      if (ctx.sessionId) {
        await tx.session.deleteMany({ where: { id: ctx.sessionId } });
      }
      await tx.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
      await queueLoginActivity(tx, user.id);
    });
    setCookie(ctx, session.token);
    if (ctx.sessionId) {
      ctx.closeSession?.(ctx.sessionId);
      await notifySessionClosed(ctx.db, ctx.sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
    }
    return { user: { id: user.id, email: user.email } };
  }),
  logout: publicProcedure.input(z.void()).mutation(async ({ ctx }) => {
    if (ctx.sessionId) {
      await ctx.db.$transaction(async (tx) => {
        await tx.session.deleteMany({ where: { id: ctx.sessionId! } });
      });
      ctx.closeSession?.(ctx.sessionId);
      await notifySessionClosed(ctx.db, ctx.sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
    }
    ctx.reply.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.secureCookies });
    return { ok: true as const };
  }),
  me: publicProcedure.input(z.void()).query(({ ctx }) => ({ user: ctx.user })),
});
