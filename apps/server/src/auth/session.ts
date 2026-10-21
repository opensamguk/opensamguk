import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@opensamguk/db';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_RENEW_MS = 15 * 24 * 60 * 60 * 1000;
export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
export function newSession(now: number) {
  const token = randomBytes(32).toString('base64url');
  return { token, id: hashToken(token), expiresAt: new Date(now + SESSION_SECONDS * 1000) };
}
export async function authenticate(db: PrismaClient, token: string | undefined, now: number, renew = true) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = hashToken(token);
  const session = await db.session.findUnique({ where: { id }, include: { user: true } });
  if (!session || session.expiresAt.getTime() <= now || session.user.status !== 'ACTIVE') return null;
  const identity = { sessionId: id, user: { id: session.user.id, email: session.user.email } };
  if (!renew || session.expiresAt.getTime() - now > SESSION_RENEW_MS) return { ...identity, renewed: false };
  const updated = await db.session.updateMany({
    where: { id, expiresAt: { gt: new Date(now), lte: new Date(now + SESSION_RENEW_MS) }, user: { status: 'ACTIVE' } },
    data: { expiresAt: new Date(now + SESSION_SECONDS * 1000) },
  });
  if (updated.count === 1) return { ...identity, renewed: true };
  // 다른 요청이 먼저 연장한 경우와 만료·제재를 구분한다.
  const latest = await db.session.findUnique({ where: { id }, include: { user: true } });
  if (!latest || latest.expiresAt.getTime() <= now || latest.user.status !== 'ACTIVE') return null;
  return { sessionId: id, user: { id: latest.user.id, email: latest.user.email }, renewed: false };
}
