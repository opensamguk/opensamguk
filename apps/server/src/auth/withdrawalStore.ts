import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@opensamguk/db';
import { hashPassword, verifyPassword } from './password';
import { hasGlobalSanction } from './sanction';

const denied = () => new TRPCError({ code: 'UNAUTHORIZED', message: '현재 계정과 비밀번호를 다시 확인하세요.' });
const collision = () => new TRPCError({ code: 'CONFLICT', message: '계정 상태를 확인한 뒤 다시 요청하세요.' });

export async function withdrawAccount(
  db: PrismaClient,
  identity: { userId: string; sessionId: string; password: string; dummyPasswordHash: string },
) {
  const candidate = await db.user.findUnique({
    where: { id: identity.userId },
    select: { passwordHash: true, status: true },
  });
  const correct = await verifyPassword(candidate?.passwordHash ?? identity.dummyPasswordHash, identity.password);
  if (!candidate || !correct || candidate.status !== 'ACTIVE') throw denied();
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const email = `withdrawn+${identity.userId}@invalid`;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.userId} FOR UPDATE`;
      const current = await tx.user.findUnique({
        where: { id: identity.userId },
        select: { passwordHash: true, status: true },
      });
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${identity.sessionId} FOR UPDATE`;
      const session = await tx.session.findUnique({ where: { id: identity.sessionId } });
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
      if (!clock) throw new Error('계정 처리 시각을 확인하세요.');
      if (
        !current ||
        current.status !== 'ACTIVE' ||
        current.passwordHash !== candidate.passwordHash ||
        !session ||
        session.userId !== identity.userId ||
        session.expiresAt.getTime() <= clock.now.getTime() ||
        (await hasGlobalSanction(tx, identity.userId, clock.now.getTime()))
      )
        throw denied();
      const reserved = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (reserved && reserved.id !== identity.userId) throw collision();
      const sessionIds = (await tx.session.findMany({ where: { userId: identity.userId }, select: { id: true } })).map(
        (value) => value.id,
      );
      await tx.user.update({
        where: { id: identity.userId },
        data: { status: 'WITHDRAWN', email, passwordHash, emailVerifiedAt: null },
      });
      await tx.session.deleteMany({ where: { userId: identity.userId } });
      await tx.accountToken.deleteMany({ where: { userId: identity.userId } });
      await tx.$executeRaw`DELETE FROM "LoginRecord" WHERE "userId"=${identity.userId}`;
      // 현재 schema에는 알림 대상·발송 대기열이 없다.
      // 모델을 추가하는 작업은 이 트랜잭션의 삭제와 경합 검증도 함께 확장한다.
      return { sessionIds };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw collision();
    throw error;
  }
}
