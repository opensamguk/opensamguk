import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTRPCClient } from '../trpc';

// 일반 화면의 운영 입구 (INT-20, AC-INT-20). admin.whoami가 성공한 계정에만 링크를 그린다.
// 거절·연결 실패는 다시 묻지 않고 아무것도 그리지 않는다. 권한은 /admin 가드가 들어갈 때 다시 확인한다.
// 화면 요청과 한 묶음이 되면 그 요청의 취소를 막으므로 따로 보낸다 (trpc.ts skipBatch).
export function AdminLink({ userId, className }: { userId: string; className?: string | undefined }) {
  const client = useTRPCClient();
  const admin = useQuery({
    queryKey: ['adminEntry', userId],
    queryFn: ({ signal }) => client.admin.whoami.query(undefined, { signal, context: { skipBatch: true } }),
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  if (admin.status !== 'success' || !admin.data.admin) return null;
  return (
    <Link to="/admin" className={className} aria-label="운영 화면">
      운영
    </Link>
  );
}
