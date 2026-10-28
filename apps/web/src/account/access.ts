import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { publicFailure, safeNext } from '../auth/credentials';

type Account = inferRouterOutputs<AppRouter>['account']['get'];
export function needsEmailVerification(account: Pick<Account, 'emailVerificationRequired' | 'emailVerified'>) {
  return account.emailVerificationRequired && !account.emailVerified;
}

export function accountNext(next: unknown): string | null {
  const path = safeNext(next);
  if (!path) return null;
  // URL 해석 기준이며 네트워크 요청을 보내는 주소가 아니다.
  const url = new URL(path, 'http://localhost');
  const normalized = safeNext(url.pathname + url.search);
  if (url.origin !== 'http://localhost' || !normalized) return null;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (['/login', '/signup', '/verify-email', '/reset-password', '/forgot-password'].includes(pathname)) return null;
  return normalized;
}

export function isVerificationDenied(error: unknown): boolean {
  const data = publicFailure(error);
  return data?.code === 'FORBIDDEN' && data.reason === 'EMAIL_NOT_VERIFIED';
}
