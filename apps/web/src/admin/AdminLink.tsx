import type { AppRouter } from '@opensamguk/server/router';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

// 운영 입구 확인만 쓰는 클라이언트. 화면 요청과 한 묶음이 되면 그 요청의 취소를 막으므로 묶음을 따로 둔다.
// auth.me와 admin.whoami를 한 묶음으로 보내면 관리자가 아닐 때 응답이 207이라 브라우저 콘솔에 403 오류가 남지 않는다.
const entryClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: '/trpc' })] });

// 일반 화면의 운영 입구 (INT-20, AC-INT-20). admin.whoami가 성공한 계정에만 링크를 그린다.
// 거절·연결 실패는 다시 묻지 않고 아무것도 그리지 않는다. 권한은 /admin 가드가 들어갈 때 다시 확인한다.
export function AdminLink({
  userId,
  emailVerified,
  className,
}: {
  userId: string;
  emailVerified: boolean;
  className?: string | undefined;
}) {
  const admin = useQuery({
    queryKey: ['adminEntry', userId, emailVerified],
    queryFn: async ({ signal }) => {
      const [identity, permission] = await Promise.all([
        entryClient.auth.me.query(undefined, { signal }),
        entryClient.admin.whoami.query(undefined, { signal }),
      ]);
      // 다른 탭에서 계정을 바꿨거나 응답이 늦게 오면 서버가 본 계정이 이 키의 계정과 다를 수 있다. 그 결과는 저장하지 않는다.
      if (identity.user?.id !== userId) throw new Error('운영 입구 확인 응답의 계정이 다릅니다.');
      return permission;
    },
    // SSE ready마다 화면 전체를 다시 받을 때도 이 확인은 다시 묻지 않는다 (useWorldEvents.ts).
    meta: { readyRefetch: false },
    retry: false,
    retryOnMount: false,
    staleTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (admin.status !== 'success' || !admin.data.admin) return null;
  return (
    <Link to="/admin" className={className} aria-label="운영 화면">
      운영
    </Link>
  );
}
