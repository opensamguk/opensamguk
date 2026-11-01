// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it } from 'vitest';
import { TRPCProvider } from '../trpc';
import { AdminEntry } from './AdminEntry';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

type Whoami = 'admin' | 'forbidden' | 'offline';

// 일반 화면 운영 입구 (INT-20, AC-INT-20). 실제 서버 권한 검사는 e2e/admin-read.spec.ts에서 본다.
async function mount(user: string | null, whoami: Whoami) {
  const calls: string[] = [];
  const unbatched: string[] = [];
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path);
        if (op.context.skipBatch === true) unbatched.push(op.path);
        const reply = (data: unknown) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        };
        if (op.path === 'auth.me')
          reply({
            user: user ? { id: user, email: 'unit@example.test', emailVerified: true, consentRequired: [] } : null,
          });
        else if (op.path === 'admin.whoami' && whoami === 'admin') reply({ admin: true });
        else if (op.path === 'admin.whoami' && whoami === 'forbidden')
          observer.error(
            TRPCClientError.from({
              error: { message: '관리자 권한이 필요합니다.', code: -32003, data: { code: 'FORBIDDEN' } },
            }),
          );
        else observer.error(TRPCClientError.from(new Error('연결 실패')));
      });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const server = createTRPCClient<AppRouter>({ links: [link] });
  const root = createRootRoute({
    component: () => (
      <header>
        <AdminEntry className="account" />
        <span>내 계정</span>
      </header>
    ),
  });
  const router: AnyRouter = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/lobby'] }),
  });
  render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={server} queryClient={client}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('내 계정');
  return { calls, unbatched, client };
}

describe('운영 입구', () => {
  it('관리자에게는 /admin으로 가는 운영 링크를 접근성 이름과 함께 보인다', async () => {
    const { unbatched } = await mount('10000000-0000-4000-8000-000000000001', 'admin');
    const entry = await screen.findByRole('link', { name: '운영 화면' });
    expect(entry.getAttribute('href')).toBe('/admin');
    expect(entry.textContent).toBe('운영');
    expect(entry.className).toBe('account');
    // 화면 요청의 취소를 막지 않게 관리자 확인만 묶지 않고 보낸다.
    expect(unbatched).toEqual(['admin.whoami']);
  });

  it('관리자가 아니면 링크도 빈 자리도 그리지 않고 다시 묻지 않는다', async () => {
    const { calls, client } = await mount('10000000-0000-4000-8000-000000000002', 'forbidden');
    await waitFor(() =>
      expect(client.getQueryState(['adminEntry', '10000000-0000-4000-8000-000000000002'])?.status).toBe('error'),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('banner').textContent).toBe('내 계정');
    expect(calls.filter((path) => path === 'admin.whoami')).toHaveLength(1);
  });

  it('연결 실패도 조용히 숨긴다', async () => {
    const { client } = await mount('10000000-0000-4000-8000-000000000003', 'offline');
    await waitFor(() =>
      expect(client.getQueryState(['adminEntry', '10000000-0000-4000-8000-000000000003'])?.status).toBe('error'),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('banner').textContent).toBe('내 계정');
  });

  it('로그인하지 않으면 관리자 확인을 요청하지 않는다', async () => {
    const { calls } = await mount(null, 'admin');
    await waitFor(() => expect(calls).toContain('auth.me'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).not.toContain('admin.whoami');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
