import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import type { Context } from '../context';
import { activeSanctionWhere } from '../auth/sanction';
import { missingConsents } from '../legal/policy';
import { PublicReasonError } from '../trpc';
import { databaseTime } from '../messaging';

export async function requireCurrentAdmin(tx: Prisma.TransactionClient, ctx: Context, write: boolean) {
  if (!ctx.user || !ctx.sessionId) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (write) await tx.$queryRaw`SELECT id FROM "User" WHERE id=${ctx.user.id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "User" WHERE id=${ctx.user.id} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${ctx.sessionId} AND "userId"=${ctx.user.id} FOR SHARE`;
  const now = await databaseTime(tx);
  const session = await tx.session.findFirst({
    where: { id: ctx.sessionId, userId: ctx.user.id, expiresAt: { gt: now } },
    select: {
      user: {
        select: {
          status: true,
          role: true,
          emailVerifiedAt: true,
          consents: { select: { docType: true, version: true } },
        },
      },
    },
  });
  if (
    !session ||
    session.user.status !== 'ACTIVE' ||
    (await tx.sanction.findFirst({
      where: { userId: ctx.user.id, worldId: null, ...activeSanctionWhere(now.getTime()) },
      select: { id: true },
    }))
  )
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (session.user.role !== 'ADMIN') throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' });
  if (ctx.legalPolicyRequired && !ctx.legalPolicy)
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '약관을 준비하고 있습니다.' });
  if (ctx.emailVerificationRequired && session.user.emailVerifiedAt === null)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '이메일 인증이 필요합니다.',
      cause: new PublicReasonError('EMAIL_NOT_VERIFIED'),
    });
  if (missingConsents(ctx.legalPolicy, session.user.consents).length)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '약관 동의가 필요합니다.',
      cause: new PublicReasonError('CONSENT_REQUIRED'),
    });
  return ctx.user.id;
}
