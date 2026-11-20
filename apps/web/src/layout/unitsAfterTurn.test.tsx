// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TRPCProvider, trpc, trpcClient } from '../trpc';
import { useUnitsAfterTurn } from './unitsAfterTurn';

afterEach(cleanup);

// 실시간이 끊긴 채 턴이 실행될 때: home.get이 새 다음 턴 시각을 받은 뒤에야 부곡 목록을 무효화한다(PR #674 Codex 리뷰).
it('다음 턴 시각이 바뀌면 이 월드의 내 부곡과 국가 부곡 조회만 다시 받는다', () => {
  const queryClient = new QueryClient();
  const own = trpc.campaign.get.queryKey({ worldId: 'w1' });
  const nation = trpc.campaign.nationUnits.queryKey({ worldId: 'w1' });
  const other = trpc.campaign.get.queryKey({ worldId: 'w2' });
  for (const key of [own, nation, other]) queryClient.setQueryData(key, []);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
  const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false;
  const { rerender } = renderHook(({ at }: { at: string | null }) => useUnitsAfterTurn('w1', at), {
    wrapper,
    initialProps: { at: '2026-11-20T10:00:00.000Z' },
  });
  // 첫 값은 턴 진행이 아니다. 같은 값으로 다시 그려도 그대로다.
  rerender({ at: '2026-11-20T10:00:00.000Z' });
  expect([own, nation, other].map(invalidated)).toEqual([false, false, false]);
  rerender({ at: '2026-11-20T10:02:00.000Z' });
  expect([own, nation, other].map(invalidated)).toEqual([true, true, false]);
  queryClient.clear();
});
