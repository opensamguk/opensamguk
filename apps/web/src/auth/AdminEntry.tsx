import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { AdminLink as AdminLinkType } from '../admin/AdminLink';
import { useTRPC } from '../trpc';

// 관리자 확인 코드는 첫 번들에 넣지 않는다 (e2e/public-assets.spec.ts). 로그인한 뒤에만 불러온다.
// 조각을 받지 못해도 화면을 깨뜨리지 않고 링크만 숨긴다.
const Hidden: typeof AdminLinkType = () => null;
const AdminLink = lazy(() =>
  import('../admin/AdminLink').then(
    (module) => ({ default: module.AdminLink }),
    () => ({ default: Hidden }),
  ),
);

export function AdminEntry({ className }: { className?: string | undefined }) {
  const trpc = useTRPC();
  const me = useQuery(trpc.auth.me.queryOptions());
  const user = me.data?.user;
  if (!user || user.consentRequired.length > 0) return null;
  const { id: userId, emailVerified } = user;
  // 계정이나 이메일 인증 상태가 바뀌면 권한 확인을 새로 시작한다.
  return (
    <Suspense fallback={null}>
      <AdminLink
        key={`${userId}:${emailVerified}`}
        userId={userId}
        emailVerified={emailVerified}
        className={className}
      />
    </Suspense>
  );
}
