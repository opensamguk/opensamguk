import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { issueAccountToken, resetPasswordAndSessions, verifyEmailToken } from '../auth/accountTokenStore';
import { notifySessionClosed } from '@opensamguk/db';
import { passwordSchema } from '../auth/password';
import type { Context } from '../context';
import { accountMail } from '../mail/templates';
import { protectedProcedure, publicProcedure, PublicReasonError, router } from '../trpc';
import { missingConsents } from '../legal/policy';
import { withdrawAccount } from '../auth/withdrawalStore';

const tokenInput = z.strictObject({ token: z.string().max(256) });
const ok = { ok: true as const };
function invalidToken() {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: '링크를 확인하거나 새로 요청하세요.',
    cause: new PublicReasonError('TOKEN_INVALID'),
  });
}
async function send(ctx: Context, email: string, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD', token: string) {
  if (!ctx.accountMail) throw new Error('계정 메일 설정을 확인하세요.');
  await ctx.accountMail.transport.send(accountMail(email, purpose, ctx.accountMail.origin, token));
}
function limitTokenAttempts(ctx: Context) {
  const decision = ctx.rateLimiter.consume([
    { namespace: 'account.token.ip', key: ctx.ip, limit: 30, windowMs: 900_000 },
  ]);
  if (decision.allowed) return;
  ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
}
export const accountRouter = router({
  get: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.user.id },
      select: {
        email: true,
        emailVerifiedAt: true,
        consents: {
          orderBy: [{ docType: 'asc' }, { agreedAt: 'asc' }],
          select: { docType: true, version: true, agreedAt: true },
        },
      },
    });
    return {
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      emailVerificationRequired: ctx.emailVerificationRequired ?? false,
      legalPolicyApproved: Boolean(ctx.legalPolicy),
      withdrawalAvailable: Boolean(ctx.withdrawalPolicy),
      consentRequired: missingConsents(ctx.legalPolicy, user.consents),
      consents: user.consents.map((consent) => ({ ...consent, agreedAt: consent.agreedAt.toISOString() })),
    };
  }),
  withdraw: protectedProcedure
    .meta({ accountAccess: 'recovery' })
    .input(z.strictObject({ expectedUserId: z.uuid(), password: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.id !== input.expectedUserId || !ctx.sessionId)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: '현재 계정을 다시 확인하세요.' });
      if (!ctx.withdrawalPolicy)
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '탈퇴 처리 기준을 준비하고 있습니다.' });
      const decision = ctx.rateLimiter.consume([
        { namespace: 'account.withdraw.user', key: ctx.user.id, limit: 5, windowMs: 900_000 },
        { namespace: 'account.withdraw.ip', key: ctx.ip, limit: 15, windowMs: 900_000 },
      ]);
      if (!decision.allowed) {
        ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
      }
      const result = await withdrawAccount(ctx.db, {
        userId: ctx.user.id,
        sessionId: ctx.sessionId,
        password: input.password,
        dummyPasswordHash: ctx.dummyPasswordHash,
      });
      ctx.reply.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.secureCookies });
      ctx.reply.clearCookie('did', { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.secureCookies });
      for (const id of result.sessionIds) {
        ctx.closeSession?.(id);
        await notifySessionClosed(ctx.db, id, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
      }
      return ok;
    }),
  resendVerification: protectedProcedure
    .meta({ accountAccess: 'recovery' })
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.user.id },
        select: { email: true, emailVerifiedAt: true },
      });
      if (user.emailVerifiedAt !== null) return ok;
      if (!ctx.accountMail) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const decision = ctx.rateLimiter.consume([
        { namespace: 'mail.verify.resend', key: ctx.user.id, limit: 1, windowMs: 60_000 },
        { namespace: 'mail.verify.resend', key: ctx.user.id, limit: 5, windowMs: 86_400_000 },
      ]);
      if (!decision.allowed) {
        ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
      }
      const issued = await issueAccountToken(ctx.db, ctx.user.id, 'VERIFY_EMAIL', ctx.now);
      if (!issued) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
      try {
        await send(ctx, user.email, 'VERIFY_EMAIL', issued.token);
      } catch {
        ctx.reply.log.warn('인증 메일 발송 실패');
      }
      return ok;
    }),
  verifyEmail: publicProcedure
    .meta({ accountAccess: 'recovery' })
    .input(tokenInput)
    .mutation(async ({ ctx, input }) => {
      limitTokenAttempts(ctx);
      if (!(await verifyEmailToken(ctx.db, input.token, ctx.now))) invalidToken();
      return ok;
    }),
  requestPasswordReset: publicProcedure
    .meta({ accountAccess: 'recovery' })
    .input(z.strictObject({ email: z.string().trim().toLowerCase().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const decision = ctx.rateLimiter.consume([
        { namespace: 'mail.password.reset', key: input.email, limit: 3, windowMs: 3_600_000 },
      ]);
      if (!decision.allowed || !ctx.accountMail) return ok;
      try {
        const user = await ctx.db.user.findUnique({ where: { email: input.email }, select: { id: true } });
        if (!user) return ok;
        const issued = await issueAccountToken(ctx.db, user.id, 'RESET_PASSWORD', ctx.now);
        if (issued) await send(ctx, input.email, 'RESET_PASSWORD', issued.token);
      } catch {
        ctx.reply.log.warn('재설정 메일 발송 실패');
      }
      return ok;
    }),
  resetPassword: publicProcedure
    .meta({ accountAccess: 'recovery' })
    .input(tokenInput.extend({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      limitTokenAttempts(ctx);
      const result = await resetPasswordAndSessions(ctx.db, input.token, input.password, ctx.now);
      if (!result.changed) invalidToken();
      for (const sessionId of result.sessionIds) {
        ctx.closeSession?.(sessionId);
        await notifySessionClosed(ctx.db, sessionId, () => ctx.reply.log.warn('실시간 알림 전송 실패'));
      }
      return ok;
    }),
});
