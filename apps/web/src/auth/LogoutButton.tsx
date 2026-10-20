import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTRPC } from '../trpc';

export function LogoutButton({ className }: { className?: string | undefined }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    ...trpc.auth.logout.mutationOptions(),
    onSuccess: async () => {
      queryClient.clear();
      queryClient.setQueryData(trpc.auth.me.queryKey(), { user: null });
      await navigate({ to: '/login', replace: true });
    },
  });

  return (
    <button
      type="button"
      className={className}
      disabled={logout.isPending}
      onClick={() => logout.mutate()}
      title={logout.isError ? '로그아웃하지 못했습니다. 다시 누르세요' : undefined}
    >
      {logout.isError ? '로그아웃 다시 시도' : '로그아웃'}
    </button>
  );
}
