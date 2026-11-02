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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyWorldEvent } from '../realtime/useWorldEvents';
import { trpc, TRPCProvider } from '../trpc';
import { AdminEntry } from './AdminEntry';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

type Whoami = 'admin' | 'forbidden' | 'offline';
const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';

// 서버 쪽 세션. 화면 auth.me와 운영 입구 확인은 응답하는 그때의 값을 읽는다.
// server는 운영 입구 확인 응답이 본 계정이다. 다른 탭에서 계정을 바꾼 경우처럼 화면 캐시의 계정과 다를 수 있다.
// hold가 있으면 그 요청의 응답을 hold가 풀릴 때까지 늦춘다.
interface Session {
  user: string | null;
  whoami: Whoami;
  server?: string | null;
  hold?: Promise<void>;
}

const identityOf = (user: string | null) => ({
  user: user ? { id: user, email: 'unit@example.test', emailVerified: true, consentRequired: [] } : null,
});

// 일반 화면 운영 입구 (INT-20, AC-INT-20). 실제 서버 권한 검사는 e2e/admin-read.spec.ts에서 본다.
// 화면 auth.me는 Provider 클라이언트로, 운영 입구 확인은 따로 둔 묶음 클라이언트의 fetch로 받는다.
async function mount(user: string | null, whoami: Whoami, extra: Omit<Session, 'user' | 'whoami'> = {}) {
  const session: Session = { user, whoami, ...extra };
  const calls: string[] = [];
  const entryRequests: string[] = [];
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path);
        if (op.path === 'auth.me') {
          observer.next({ result: { type: 'data', data: identityOf(session.user) } });
          observer.complete();
        } else observer.error(TRPCClientError.from(new Error('운영 입구는 화면 클라이언트로 묻지 않는다')));
      });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://unit.test').pathname;
      entryRequests.push(path);
      await session.hold;
      const { whoami } = session;
      const identity = identityOf(session.server === undefined ? session.user : session.server);
      if (whoami === 'offline') throw new TypeError('연결 실패');
      const permission =
        whoami === 'admin'
          ? { result: { data: { admin: true } } }
          : {
              error: {
                message: '관리자 권한이 필요합니다.',
                code: -32003,
                data: { code: 'FORBIDDEN', httpStatus: 403 },
              },
            };
      return new Response(JSON.stringify([{ result: { data: identity } }, permission]), {
        status: whoami === 'admin' ? 200 : 207,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
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
  // 계정을 바꾸면 화면 auth.me를 다시 받는다. 로그인·로그아웃 화면이 하는 일과 같다.
  const switchTo = async (next: string | null, nextWhoami: Whoami) => {
    session.user = next;
    session.whoami = nextWhoami;
    delete session.server;
    await client.invalidateQueries({ queryKey: trpc.auth.me.queryKey() });
  };
  return { calls, entryRequests, client, session, switchTo };
}

const entryState = (client: QueryClient, user: string) => client.getQueryState(['adminEntry', user]);

describe('운영 입구', () => {
  it('관리자에게는 /admin으로 가는 운영 링크를 접근성 이름과 함께 보인다', async () => {
    const { calls, entryRequests } = await mount('10000000-0000-4000-8000-000000000001', 'admin');
    const entry = await screen.findByRole('link', { name: '운영 화면' });
    expect(entry.getAttribute('href')).toBe('/admin');
    expect(entry.textContent).toBe('운영');
    expect(entry.className).toBe('account');
    // 화면 요청과 묶지 않고 auth.me와 한 묶음으로 따로 보낸다.
    expect(entryRequests).toEqual(['/trpc/auth.me,admin.whoami']);
    expect(calls).not.toContain('admin.whoami');
  });

  it('관리자가 아니면 링크도 빈 자리도 그리지 않고 다시 묻지 않는다', async () => {
    const { entryRequests, client } = await mount('10000000-0000-4000-8000-000000000002', 'forbidden');
    await waitFor(() =>
      expect(client.getQueryState(['adminEntry', '10000000-0000-4000-8000-000000000002'])?.status).toBe('error'),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('banner').textContent).toBe('내 계정');
    expect(entryRequests).toEqual(['/trpc/auth.me,admin.whoami']);
  });

  it('연결 실패도 조용히 숨긴다', async () => {
    const { client } = await mount('10000000-0000-4000-8000-000000000003', 'offline');
    await waitFor(() =>
      expect(client.getQueryState(['adminEntry', '10000000-0000-4000-8000-000000000003'])?.status).toBe('error'),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('banner').textContent).toBe('내 계정');
  });

  it('계정을 바꾸면 그 계정의 권한으로 다시 가르고 앞 계정의 결과를 옮기지 않는다', async () => {
    const { client, entryRequests, switchTo } = await mount(A, 'forbidden');
    await waitFor(() => expect(entryState(client, A)?.status).toBe('error'));
    await switchTo(B, 'admin');
    expect((await screen.findByRole('link', { name: '운영 화면' })).getAttribute('href')).toBe('/admin');
    await switchTo(A, 'forbidden');
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
    expect(entryState(client, A)?.status).toBe('error');
    expect(entryState(client, A)?.data).toBeUndefined();
    expect(entryRequests).toHaveLength(2);
  });

  it('늦게 온 응답이 다른 계정의 것이면 관리자 결과라도 저장하지 않고 숨긴다', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client, entryRequests, session } = await mount(A, 'admin', { hold });
    await waitFor(() => expect(entryRequests).toHaveLength(1));
    // 응답이 오기 전에 다른 탭에서 관리자 B로 바꿨다. 이 탭의 화면 캐시는 아직 A다.
    session.server = B;
    release();
    await waitFor(() => expect(entryState(client, A)?.status).toBe('error'));
    expect(entryState(client, A)?.data).toBeUndefined();
    expect(screen.queryByRole('link')).toBeNull();
    expect(entryRequests).toHaveLength(1);
  });

  it.each(['forbidden', 'offline'] as const)('%s 뒤 SSE ready가 거듭 와도 다시 묻지 않는다', async (whoami) => {
    const { calls, client, entryRequests } = await mount(A, whoami);
    await waitFor(() => expect(entryState(client, A)?.status).toBe('error'));
    const before = calls.filter((path) => path === 'auth.me').length;
    applyWorldEvent(client, trpc, 'w1', { kind: 'ready' });
    applyWorldEvent(client, trpc, 'w1', { kind: 'ready' });
    // ready는 화면 auth.me를 다시 받는다. 운영 입구 확인만 빠진다.
    await waitFor(() => expect(calls.filter((path) => path === 'auth.me').length).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entryRequests).toHaveLength(1);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('로그인하지 않으면 관리자 확인을 요청하지 않는다', async () => {
    const { calls, entryRequests } = await mount(null, 'admin');
    await waitFor(() => expect(calls).toContain('auth.me'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entryRequests).toEqual([]);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
