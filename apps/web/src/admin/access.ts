import { notFound, redirect } from '@tanstack/react-router';
import { accountNext } from '../account/access';
import { publicFailure } from '../auth/credentials';
import { trpcClient } from '../trpc';

// 이 모듈은 관리자 경로 진입 때만 불러온다. 두 응답은 같은 HTTP batch의 세션을 쓴다.
export async function requireAdmin(next: string) {
  const results = await Promise.allSettled([trpcClient.auth.me.query(), trpcClient.admin.whoami.query()]);
  const destination = accountNext(next) ?? '/admin';
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    const failure = publicFailure(result.reason);
    if (failure?.code === 'UNAUTHORIZED') throw redirect({ to: '/login', search: { next: destination } });
    if (failure?.code === 'FORBIDDEN' && failure.reason === 'EMAIL_NOT_VERIFIED')
      throw redirect({ to: '/verify-email', search: { next: destination } });
    if (failure?.code === 'FORBIDDEN') throw notFound();
    throw new Error('접근 권한을 확인하지 못했습니다.');
  }
  const identity = results[0];
  if (identity.status !== 'fulfilled' || !identity.value.user)
    throw redirect({ to: '/login', search: { next: destination } });
  return { adminViewerId: identity.value.user.id };
}
