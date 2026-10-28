import { randomBytes } from 'node:crypto';
import { hashToken } from './session';

export type AccountTokenPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD';

export function newAccountToken(purpose: AccountTokenPurpose, now: number) {
  const lifetime = purpose === 'VERIFY_EMAIL' ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
  if (!['VERIFY_EMAIL', 'RESET_PASSWORD'].includes(purpose) || !Number.isSafeInteger(now)) {
    throw new Error('계정 토큰 생성값을 확인하세요.');
  }
  const expiresAt = new Date(now + lifetime);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('계정 토큰 만료 시각을 확인하세요.');
  const token = randomBytes(32).toString('base64url');
  return { token, id: hashToken(token), expiresAt };
}
