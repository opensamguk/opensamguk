import { createHmac, randomBytes } from 'node:crypto';
import type { Prisma } from '@opensamguk/db';

export type LoginAuditOptions = { key: string; version: number };
export type LoginAuditConfig = Readonly<{ key: Buffer; version: number }>;
export type LoginAuditRequest = Readonly<{
  ipHash: string;
  deviceHash: string;
  hashKeyVersion: number;
  setDeviceCookie: () => void;
}>;
const invalid = () => new Error('로그인 조사 키 설정을 확인하세요.');

// 운영 키는 필수다. 미승인 공개 정책의 수집 여부는 buildServer가 별도로 막는다.
export function resolveLoginAudit(
  env: Record<string, string | undefined>,
  production: boolean,
  supplied?: LoginAuditOptions | null,
): LoginAuditConfig | null {
  const candidate =
    supplied === undefined
      ? env.AUDIT_HASH_KEY === undefined && env.AUDIT_HASH_KEY_VERSION === undefined
        ? null
        : { key: env.AUDIT_HASH_KEY, version: Number(env.AUDIT_HASH_KEY_VERSION) }
      : supplied;
  if (candidate === null) {
    if (production) throw invalid();
    return null;
  }
  if (
    typeof candidate.key !== 'string' ||
    Buffer.byteLength(candidate.key, 'utf8') < 32 ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1 ||
    candidate.version > 2_147_483_647
  )
    throw invalid();
  return Object.freeze({ key: Buffer.from(candidate.key, 'utf8'), version: candidate.version });
}

export function deviceCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: 365 * 24 * 60 * 60 };
}

export function prepareLoginAudit(config: LoginAuditConfig, ip: string, device: string | undefined) {
  const token = typeof device === 'string' && /^[0-9a-f]{32}$/.test(device) ? device : randomBytes(16).toString('hex');
  const digest = (value: string) => createHmac('sha256', config.key).update(value, 'utf8').digest('hex');
  // token은 응답 쿠키를 쓰는 서버 클로저에서만 쓴다. DB에는 두 해시만 전달한다.
  return { token, ipHash: digest(ip), deviceHash: digest(token), hashKeyVersion: config.version };
}

export async function writeLoginAudit(
  tx: Prisma.TransactionClient,
  input: { userId: string; email: string; success: boolean; at: number },
  audit: LoginAuditRequest,
) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${input.userId} FOR SHARE`;
  const current = await tx.user.findUnique({
    where: { id: input.userId },
    select: { status: true, email: true },
  });
  // 탈퇴가 먼저 확정되거나 이메일이 달라졌으면 원래 계정에 새 기록을 쓰지 않는다.
  if (!current || current.status !== 'ACTIVE' || current.email !== input.email) return false;
  await tx.$executeRaw`
    INSERT INTO "LoginRecord" ("userId",at,success,"ipHash","deviceHash","hashKeyVersion")
    VALUES (${input.userId},${new Date(input.at)},${input.success},${audit.ipHash},${audit.deviceHash},${audit.hashKeyVersion})`;
  return true;
}
