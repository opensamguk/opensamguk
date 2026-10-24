// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import {
  PersonnelApiContext,
  type PersonnelApi,
  type PersonnelRecord,
  type RequestState,
  type PersonnelResult,
} from './contract';
import { announcedKey, readAnnounced } from './request';
import { usePersonnelAction } from './usePersonnelAction';

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => router.navigate, useRouterState: () => '/w/w1' }));
vi.mock('../trpc', () => {
  const trpc = {
    auth: {
      me: {
        queryOptions: () => ({
          queryKey: ['auth', 'me'],
          queryFn: () => ({ user: { id: 'u1' } }),
          staleTime: Infinity,
        }),
      },
    },
    home: { get: { queryKey: ({ worldId }: { worldId: string }) => ['home', worldId] } },
  };
  return { useTRPC: () => trpc, trpcClient: {} };
});

const error = (code: string) =>
  new TRPCClientError(code, { result: { error: { code: -32000, message: code, data: { code } } } });
const network = () => new TRPCClientError('fetch failed');
const accept = { kind: 'offer.respond', offerId: 'offer-1', accept: true } as const;
const pending = (requestId: string): RequestState<PersonnelResult> => ({ status: 'pending', requestId });
const applied = (requestId: string): RequestState<PersonnelResult> => ({
  status: 'applied',
  requestId,
  result: { offerStatus: 'ACCEPTED', city: { cityKey: 3, name: '북평' }, dedicationLost: 0 },
});
const record = (state: RequestState<PersonnelResult>): PersonnelRecord => ({ kind: 'offer.respond', state });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const clients: QueryClient[] = [];
function setup(overrides: Partial<PersonnelApi> = {}, existing?: QueryClient) {
  const client = existing ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!existing) {
    clients.push(client);
    client.setQueryData(['auth', 'me'], { user: { id: 'u1' } });
  }
  const api: PersonnelApi = {
    officers: vi.fn(),
    offers: vi.fn(),
    nationTurns: vi.fn(),
    setNationTurns: vi.fn(),
    nationCommands: vi.fn(),
    precheckNation: vi.fn(),
    act: vi.fn(),
    request: vi.fn().mockRejectedValue(error('NOT_FOUND')),
    recent: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const hook = renderHook(({ worldId }) => usePersonnelAction({ worldId, kinds: ['offer.respond'] }), {
    initialProps: { worldId: 'w1' },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <PersonnelApiContext value={api}>{children}</PersonnelApiContext>
      </QueryClientProvider>
    ),
  });
  return { ...hook, api, client };
}
async function tick(ms = 5) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function send(hook: ReturnType<typeof setup>) {
  await act(async () => {
    void hook.result.current.submit(accept, 'accept');
  });
  await tick();
}
beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  localStorage.clear();
  router.navigate.mockClear();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('인사 전송과 서버 접수', () => {
  it('버튼은 즉시 잠그고 commit 전 NOT_FOUND는 기다리며 longpoll 응답 전에 실제 pending을 확인한다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    let admitted = false;
    const request = vi.fn<PersonnelApi['request']>().mockImplementation(async ({ requestId }) => {
      if (!admitted) throw error('NOT_FOUND');
      return record(pending(requestId));
    });
    const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
    const hook = setup({ act: actRequest, request });
    await tick();
    await send(hook);
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.busyLabel).toBe('보내는 중');
    expect(hook.result.current.notices).toEqual([]);
    await send(hook);
    expect(actRequest).toHaveBeenCalledTimes(1);
    admitted = true;
    await tick(1_000);
    expect(hook.result.current.busyLabel).toBe('처리 중');
    expect(hook.result.current.state.phase).toBe('busy');
    expect(request.mock.calls.every(([input]) => input.requestId === actRequest.mock.calls[0]![0].requestId)).toBe(
      true,
    );
  });

  it('mutation의 pending도 접수 증거이고 늦은 NOT_FOUND로 전송 중에 돌아가지 않는다', async () => {
    const hook = setup({
      act: vi.fn<PersonnelApi['act']>().mockImplementation(async ({ requestId }) => pending(requestId)),
    });
    await tick();
    await send(hook);
    await tick(1_000);
    expect(hook.result.current.busyLabel).toBe('처리 중');
    expect(hook.result.current.notices).toEqual([]);
  });

  for (const late of ['pending', 'applied'] as const)
    it('조회 완료 뒤 늦은 mutation ' + late + '는 상태나 완료 안내를 되돌리지 않는다', async () => {
      const mutation = deferred<RequestState<PersonnelResult>>();
      const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
      const hook = setup({
        act: actRequest,
        request: vi
          .fn<PersonnelApi['request']>()
          .mockImplementation(async ({ requestId }) => record(applied(requestId))),
      });
      const refresh = vi.spyOn(hook.client, 'invalidateQueries');
      await tick();
      await send(hook);
      expect(hook.result.current.busy).toBe(false);
      expect(hook.result.current.notices).toEqual([{ tone: 'ok', text: '발령을 수락해 북평으로 옮겼습니다.' }]);
      expect(refresh).toHaveBeenCalledTimes(4);
      act(() => hook.result.current.dismissNotices());
      const requestId = actRequest.mock.calls[0]![0].requestId;
      await act(async () => mutation.resolve(late === 'pending' ? pending(requestId) : applied(requestId)));
      await tick();
      expect(hook.result.current.busy).toBe(false);
      expect(hook.result.current.notices).toEqual([]);
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([requestId]);
    });

  it('전송 응답을 모두 잃어도 조회만 이어 가고 늦게 접수된 같은 ID를 확인한다', async () => {
    let admitted = false;
    const actRequest = vi.fn<PersonnelApi['act']>().mockRejectedValue(network());
    const request = vi.fn<PersonnelApi['request']>().mockImplementation(async ({ requestId }) => {
      if (!admitted) throw error('NOT_FOUND');
      return record(pending(requestId));
    });
    const hook = setup({ act: actRequest, request });
    await tick();
    await send(hook);
    await tick(2_000);
    expect(actRequest).toHaveBeenCalledTimes(2);
    expect(hook.result.current.busyLabel).toBe('보내는 중');
    admitted = true;
    await tick(1_000);
    expect(hook.result.current.busyLabel).toBe('처리 중');
    expect(actRequest).toHaveBeenCalledTimes(2);
    const requestId = actRequest.mock.calls[0]![0].requestId;
    expect(actRequest.mock.calls.every(([input]) => input.requestId === requestId && input.action === accept)).toBe(
      true,
    );
    expect(request.mock.calls.every(([input]) => input.requestId === requestId && input.worldId === 'w1')).toBe(true);
  });

  it('확정 서버 거부는 잠금을 풀고 다시 누를 때 새 접수를 만든다', async () => {
    const actRequest = vi.fn<PersonnelApi['act']>().mockRejectedValue(error('FORBIDDEN'));
    const hook = setup({ act: actRequest });
    await tick();
    await send(hook);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.notices).toEqual([{ tone: 'error', text: 'FORBIDDEN' }]);
    await send(hook);
    expect(actRequest).toHaveBeenCalledTimes(2);
    expect(actRequest.mock.calls[1]![0].requestId).not.toBe(actRequest.mock.calls[0]![0].requestId);
  });

  it('조회 중 인증이 끝나면 로그인으로 한 번 보내고 잠금을 푼다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const hook = setup({
      act: vi.fn().mockReturnValue(mutation.promise),
      request: vi.fn().mockRejectedValue(error('UNAUTHORIZED')),
    });
    await tick();
    await send(hook);
    await tick(1_000);
    expect(hook.result.current.busy).toBe(false);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith({ to: '/login', search: { next: '/w/w1' } });
  });
});

describe('인사 재마운트와 권한 격리', () => {
  it('접수 확인 뒤 빠르게 재마운트해도 fresh recent로 대기를 잇고 완료는 다시 안내하지 않는다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
    let latest: PersonnelRecord | null = null;
    const recent = vi.fn<PersonnelApi['recent']>().mockImplementation(async () => (latest ? [latest] : []));
    const request = vi
      .fn<PersonnelApi['request']>()
      .mockImplementation(async ({ requestId }) => record(pending(requestId)));
    const first = setup({ act: actRequest, request, recent });
    await tick();
    await send(first);
    const requestId = actRequest.mock.calls[0]![0].requestId;
    expect(first.result.current.busyLabel).toBe('처리 중');
    latest = record(pending(requestId));
    first.unmount();
    const second = setup(first.api, first.client);
    await tick(20);
    expect(second.result.current.busy).toBe(true);
    expect(second.result.current.busyLabel).toBe('처리 중');
    expect(recent).toHaveBeenCalledTimes(2);
    latest = record(applied(requestId));
    request.mockResolvedValue(latest);
    await tick(1_000);
    expect(second.result.current.notices).toHaveLength(1);
    second.unmount();
    const third = setup(second.api, second.client);
    await tick(20);
    expect(third.result.current.busy).toBe(false);
    expect(third.result.current.notices).toEqual([]);
    expect(actRequest).toHaveBeenCalledTimes(1);
  });

  it('사라진 mount의 늦은 완료가 안내 이력을 미리 소비하지 않는다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
    const first = setup({ act: actRequest });
    await tick();
    await send(first);
    const requestId = actRequest.mock.calls[0]![0].requestId;
    first.unmount();
    await act(async () => mutation.resolve(applied(requestId)));
    await tick();
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
    const again = setup({ recent: vi.fn().mockResolvedValue([record(applied(requestId))]) });
    await tick();
    expect(again.result.current.notices).toHaveLength(1);
  });

  for (const change of ['account', 'world'] as const)
    it(change + '를 바꾸면 이전 응답과 캐시가 새 화면에 섞이지 않는다', async () => {
      const mutation = deferred<RequestState<PersonnelResult>>();
      const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
      const hook = setup({ act: actRequest });
      await tick();
      await send(hook);
      const requestId = actRequest.mock.calls[0]![0].requestId;
      if (change === 'account') act(() => hook.client.setQueryData(['auth', 'me'], { user: { id: 'u2' } }));
      else hook.rerender({ worldId: 'w2' });
      await tick();
      expect(hook.result.current.busy).toBe(false);
      await act(async () => mutation.resolve(applied(requestId)));
      await tick();
      expect(hook.result.current.notices).toEqual([]);
      expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
    });

  it('여러 완료 접수는 오래된 순서로 모두 안내하고 다른 계정의 안내 이력과 분리한다', async () => {
    const hook = setup({ recent: vi.fn().mockResolvedValue([record(applied('new')), record(applied('old'))]) });
    await tick();
    expect(hook.result.current.notices).toHaveLength(2);
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual(['old', 'new']);
    expect(readAnnounced(localStorage, announcedKey('u2', 'w1'))).toEqual([]);
  });
});

describe('유실과 확정 결과의 경계', () => {
  it('접수 조회가 이미 pending이면 두 전송 응답을 잃어도 세 번째 접수를 만들지 않는다', async () => {
    const actRequest = vi.fn<PersonnelApi['act']>().mockRejectedValue(network());
    const hook = setup({
      act: actRequest,
      request: vi.fn<PersonnelApi['request']>().mockImplementation(async ({ requestId }) => record(pending(requestId))),
    });
    await tick();
    await send(hook);
    await tick(1_000);
    expect(actRequest).toHaveBeenCalledTimes(2);
    expect(hook.result.current.busyLabel).toBe('처리 중');
    expect(hook.result.current.notices).toEqual([]);
  });

  it('언마운트 뒤에 연결 오류가 와도 다른 세션으로 재전송하지 않는다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const actRequest = vi
      .fn<PersonnelApi['act']>()
      .mockReturnValueOnce(mutation.promise)
      .mockImplementation(async ({ requestId }) => pending(requestId));
    const hook = setup({ act: actRequest });
    await tick();
    await send(hook);
    hook.unmount();
    await act(async () => mutation.reject(network()));
    await tick();
    expect(actRequest).toHaveBeenCalledTimes(1);
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
  });

  it('접수 뒤 엔진이 거절하면 그 이유를 한 번 안내하고 버튼을 다시 연다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
    const request = vi
      .fn<PersonnelApi['request']>()
      .mockImplementation(async ({ requestId }) => record(pending(requestId)));
    const hook = setup({ act: actRequest, request });
    await tick();
    await send(hook);
    const requestId = actRequest.mock.calls[0]![0].requestId;
    expect(hook.result.current.busyLabel).toBe('처리 중');
    request.mockResolvedValue(
      record({ status: 'rejected', requestId, code: 'OFFER_CLOSED', message: '이미 끝난 발령입니다.' }),
    );
    await tick(1_000);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.notices).toEqual([{ tone: 'error', text: '이미 끝난 발령입니다.' }]);
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([requestId]);
    await act(async () => mutation.resolve(pending(requestId)));
    await tick();
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.notices).toHaveLength(1);
  });
});

describe('독립 리뷰 반례', () => {
  it('R1 여러 조회에서 계속 NOT_FOUND여도 전송은 최초와 동일 ID 재시도 두 번으로 끝난다', async () => {
    const actRequest = vi.fn<PersonnelApi['act']>().mockRejectedValue(network());
    const request = vi.fn<PersonnelApi['request']>().mockRejectedValue(error('NOT_FOUND'));
    const hook = setup({ act: actRequest, request });
    await tick();
    await send(hook);
    await tick(5_000);
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(actRequest).toHaveBeenCalledTimes(2);
    expect(new Set(actRequest.mock.calls.map(([input]) => input.requestId)).size).toBe(1);
    expect(actRequest.mock.calls.every(([input]) => input.action === accept)).toBe(true);
    expect(hook.result.current.busyLabel).toBe('보내는 중');
    expect(hook.result.current.notices).toEqual([]);
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
  });

  it('R2 mutation 오류가 먼저 온 엔진 거절도 조회로 확인해 한 번 안내하고 재마운트에서는 안내하지 않는다', async () => {
    const mutation = deferred<RequestState<PersonnelResult>>();
    const initialLookup = deferred<PersonnelRecord>();
    const actRequest = vi.fn<PersonnelApi['act']>().mockReturnValue(mutation.promise);
    const request = vi
      .fn<PersonnelApi['request']>()
      .mockReturnValueOnce(initialLookup.promise)
      .mockImplementation(async () => rejected);
    const first = setup({ act: actRequest, request });
    await tick();
    await send(first);
    const requestId = actRequest.mock.calls[0]![0].requestId;
    const rejected = record({ status: 'rejected', requestId, code: 'OFFER_CLOSED', message: '이미 끝난 발령입니다.' });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => mutation.reject(error('CONFLICT')));
    await tick(20);
    expect(first.result.current.busy).toBe(false);
    expect(first.result.current.notices).toEqual([{ tone: 'error', text: '이미 끝난 발령입니다.' }]);
    expect(request).toHaveBeenCalledTimes(2);
    first.unmount();
    const again = setup({ recent: vi.fn().mockResolvedValue([rejected]) });
    await tick(20);
    expect(again.result.current.notices).toEqual([]);
    expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([requestId]);
  });
});

it('R2 오류 뒤 조회도 유실되면 완료로 표시하지 않고 미접수 거부가 확인된 때만 잠금을 푼다', async () => {
  const actRequest = vi.fn<PersonnelApi['act']>().mockRejectedValue(error('CONFLICT'));
  const request = vi.fn<PersonnelApi['request']>().mockRejectedValue(network());
  const hook = setup({ act: actRequest, request });
  await tick();
  await send(hook);
  await tick(2_000);
  expect(hook.result.current.busyLabel).toBe('보내는 중');
  expect(hook.result.current.notices).toEqual([]);
  expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
  request.mockRejectedValue(error('NOT_FOUND'));
  await tick(1_000);
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.notices).toEqual([{ tone: 'error', text: 'CONFLICT' }]);
  expect(readAnnounced(localStorage, announcedKey('u1', 'w1'))).toEqual([]);
  expect(actRequest).toHaveBeenCalledTimes(1);
});
