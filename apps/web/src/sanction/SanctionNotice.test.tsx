// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SanctionNotice } from './SanctionNotice';

// 서버 세션의 현재 계정. 제재는 u1에게만 있다.
const server = vi.hoisted(() => ({ user: 'u1' as string | null, router: { invalidate: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => server.router }));
vi.mock('../trpc', () => {
  const client = {
    auth: { me: { query: async () => ({ user: server.user ? { id: server.user } : null }) } },
    sanction: {
      mine: {
        query: async () => (server.user === 'u1' ? [{ worldId: 'w1', reason: '반역 모의', expiresAt: null }] : []),
      },
    },
  };
  const trpc = { auth: { me: { queryKey: () => ['auth', 'me'] } } };
  return { useTRPC: () => trpc, useTRPCClient: () => client };
});

const authKey = ['auth', 'me'];
const reason = '반역 모의';

// 계정 메뉴·턴 편집기처럼 렌더 중에 공유 auth.me 쿼리를 만드는 다른 소비자다.
// 가드가 확인한 값을 들고 만들어 뒤따르는 갱신이 없다. 이 안내를 깨우는 것은 added 알림뿐이다.
function Consumer() {
  useQuery({
    queryKey: authKey,
    queryFn: async () => ({ user: server.user ? { id: server.user } : null }),
    initialData: { user: { id: 'u1' } },
    staleTime: Infinity,
  });
  return null;
}
// 자기 상태로만 소비자를 띄워 이 안내는 다시 렌더하지 않는다.
function Later() {
  const [shown, setShown] = useState(false);
  return shown ? (
    <Consumer />
  ) : (
    <button type="button" onClick={() => setShown(true)}>
      다른 화면 열기
    </button>
  );
}
function Shell({ notice = true, consumer = false }: { notice?: boolean; consumer?: boolean }) {
  return (
    <>
      {notice && <SanctionNotice worldId="w1" />}
      {consumer && <Consumer />}
      <Later />
    </>
  );
}

const clients: QueryClient[] = [];
// guard가 있으면 라우터 가드가 이미 확인한 계정을 캐시에 둔다.
function mount(guard?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  if (guard) client.setQueryData(authKey, { user: { id: guard } });
  const view = render(<Shell />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, rerender: (props: Parameters<typeof Shell>[0]) => view.rerender(<Shell {...props} />) };
}
const viewerSettled = (client: QueryClient) =>
  waitFor(() => expect(client.getQueryState(['sanction-viewer'])?.status).toBe('success'));

let errors: MockInstance<typeof console.error>;
const renderPhaseWarnings = () =>
  errors.mock.calls.filter(([message]) => String(message).includes('while rendering a different component'));
beforeEach(() => {
  server.user = 'u1';
  errors = vi.spyOn(console, 'error');
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  errors.mockRestore();
});

describe('가드 쿼리 캐시 구독', () => {
  it('다른 화면이 렌더 중에 가드 쿼리를 만들어도 그 렌더 안에서 갱신하지 않고 렌더가 끝난 뒤 사유를 보인다', async () => {
    const { client } = mount();
    await viewerSettled(client);
    expect(client.getQueryCache().find({ queryKey: authKey })).toBeUndefined();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '다른 화면 열기' })));
    expect(renderPhaseWarnings()).toEqual([]);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(renderPhaseWarnings()).toEqual([]);
  });

  it('렌더 중에 온 added를 알리기 전에 언마운트되면 그 알림을 버린다', async () => {
    const { client, rerender } = mount();
    await viewerSettled(client);
    const reads = vi.spyOn(client, 'getQueryState');
    // 이 안내를 내리는 같은 렌더에서 다른 화면이 가드 쿼리를 만든다.
    await act(async () => rerender({ notice: false, consumer: true }));
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: authKey })?.state.status).toBe('success'));
    // 버린 알림을 React가 받았다면 스냅숏을 다시 읽었을 것이다.
    expect(reads.mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(authKey))).toEqual([]);
    expect(client.getQueryCache().hasListeners()).toBe(false);
    expect(renderPhaseWarnings()).toEqual([]);
  });

  for (const [change, user] of [
    ['다른 계정', 'u2'],
    ['로그아웃', null],
  ] as const)
    it(change + '으로 바뀐 가드 응답은 같은 틱에 이전 계정의 사유를 숨긴다', async () => {
      const { client } = mount('u1');
      expect(await screen.findByText(reason)).toBeTruthy();
      const identity = { user: user ? { id: user } : null };
      server.user = user;
      act(() => client.setQueryData(authKey, identity));
      expect(screen.queryByText(reason)).toBeNull();
      await waitFor(() => expect(client.getQueryData(['sanction-viewer'])).toEqual(identity));
      expect(screen.queryByText(reason)).toBeNull();
    });

  it('가드가 계정을 다시 묻는 동안 숨기고 같은 계정이면 다시 보인다', async () => {
    const { client } = mount('u1');
    expect(await screen.findByText(reason)).toBeTruthy();
    let answer!: (value: { user: { id: string } }) => void;
    act(() => {
      void client.fetchQuery({
        queryKey: authKey,
        queryFn: () =>
          new Promise<{ user: { id: string } }>((resolve) => {
            answer = resolve;
          }),
        staleTime: 0,
      });
    });
    expect(screen.queryByText(reason)).toBeNull();
    await act(async () => answer({ user: { id: 'u1' } }));
    expect(await screen.findByText(reason)).toBeTruthy();
  });
});
