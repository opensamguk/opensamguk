import type { Prisma, PrismaClient } from '@opensamguk/db';
import { newAccountToken, type AccountTokenPurpose } from './accountToken';
import { hashPassword, passwordSchema } from './password';
import { hashToken } from './session';

function moment(now: number) {
  const value = new Date(now);
  if (!Number.isSafeInteger(now) || !Number.isFinite(value.getTime())) {
    throw new Error('계정 토큰 처리 시각을 확인하세요.');
  }
  return value;
}

async function lockActiveUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
  return user?.status === 'ACTIVE';
}

export async function issueAccountToken(db: PrismaClient, userId: string, purpose: AccountTokenPurpose, now: number) {
  const issued = newAccountToken(purpose, now);
  const at = moment(now);
  return db.$transaction(async (tx) => {
    if (!(await lockActiveUser(tx, userId))) return null;
    await tx.accountToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: at } });
    await tx.accountToken.create({ data: { id: issued.id, userId, purpose, expiresAt: issued.expiresAt } });
    return { token: issued.token, expiresAt: issued.expiresAt };
  });
}

async function consumeAccountToken(
  db: PrismaClient,
  token: string,
  purpose: AccountTokenPurpose,
  now: number,
  apply: (tx: Prisma.TransactionClient, userId: string, at: Date) => Promise<void>,
) {
  const at = moment(now);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const id = hashToken(token);
  return db.$transaction(async (tx) => {
    const candidate = await tx.accountToken.findUnique({ where: { id }, select: { userId: true, purpose: true } });
    if (!candidate || candidate.purpose !== purpose || !(await lockActiveUser(tx, candidate.userId))) return false;
    const consumed = await tx.accountToken.updateMany({
      where: { id, userId: candidate.userId, purpose, usedAt: null, expiresAt: { gt: at } },
      data: { usedAt: at },
    });
    if (consumed.count !== 1) return false;
    await apply(tx, candidate.userId, at);
    await tx.accountToken.updateMany({
      where: { userId: candidate.userId, purpose, usedAt: null },
      data: { usedAt: at },
    });
    return true;
  });
}

export function verifyEmailToken(db: PrismaClient, token: string, now: number) {
  return consumeAccountToken(db, token, 'VERIFY_EMAIL', now, async (tx, userId, at) => {
    await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: at } });
  });
}

export async function resetPasswordAndSessions(db: PrismaClient, token: string, password: string, now: number) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { changed: false, sessionIds: [] as string[] };
  moment(now);
  if (!passwordSchema.safeParse(password).success) throw new Error('새 비밀번호 길이를 확인하세요.');
  const candidate = await db.accountToken.findUnique({
    where: { id: hashToken(token) },
    select: { purpose: true, usedAt: true, expiresAt: true, user: { select: { status: true } } },
  });
  if (
    !candidate ||
    candidate.purpose !== 'RESET_PASSWORD' ||
    candidate.usedAt !== null ||
    candidate.expiresAt.getTime() <= now ||
    candidate.user.status !== 'ACTIVE'
  )
    return { changed: false, sessionIds: [] as string[] };
  // 비싼 해시는 행 잠금 전에 계산하며 토큰 소비와 계정·세션 변경은 함께 commit한다.
  const passwordHash = await hashPassword(password);
  let sessionIds: string[] = [];
  const changed = await consumeAccountToken(db, token, 'RESET_PASSWORD', now, async (tx, userId) => {
    sessionIds = (await tx.session.findMany({ where: { userId }, select: { id: true } })).map((session) => session.id);
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId } });
  });
  return { changed, sessionIds: changed ? sessionIds : [] };
}

export async function resetPasswordToken(db: PrismaClient, token: string, password: string, now: number) {
  return (await resetPasswordAndSessions(db, token, password, now)).changed;
}
