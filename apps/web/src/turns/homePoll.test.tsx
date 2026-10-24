// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Home, WorldSummary } from '../game/types';
import { TRPCProvider } from '../trpc';
import { TurnEditor } from './TurnEditor';
import { TurnsPage } from './TurnsPage';

// 예턴 편집기와 예턴 화면 최근 결과의 home.get 주기 (T1-27 갱신 규칙의 가속 중·멈춤).
// 실제 화면을 띄우고 가짜 tRPC link에서 home.get 요청 수를 센다. 주기는 각 화면의 QueryObserver가 정한다.

const notFound = () =>
  new TRPCClientError('NOT_FOUND', { result: { error: { data: { code: 'NOT_FOUND' } } } } as never);

const summary = (status: WorldSummary['status'], clockMode: WorldSummary['clockMode']): WorldSummary => ({
  name: '시험 월드',
  status,
  startYear: 190,
  gameDate: { year: 190, month: 1 },
  clockMode,
  endYear: 300,
  result: null,
  nowTick: 0,
  msPerTick: 1_000,
  turnTermMinutes: 1,
});

// 화면이 읽는 필드만 채운 장수 있는 계정의 home.get.
const home = { recentLogs: [], nextTurnAt: null, general: { nextTurnTick: 60, crewType: null } } as unknown as Home;

interface Server {
  summary: WorldSummary;
  home: () => Home | Error;
}

const calls = new Map<string, number>();
const homeCalls = () => calls.get('home.get') ?? 0;

function fakeClient(server: Server) {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.set(op.path, (calls.get(op.path) ?? 0) + 1);
        let result: unknown;
        if (op.path === 'auth.me') result = { user: { id: 'u1', username: 'tester' } };
        else if (op.path === 'world.summary') result = server.summary;
        else if (op.path === 'home.get') result = server.home();
        else result = notFound();
        if (result instanceof Error) observer.error(TRPCClientError.from(result));
        else {
          observer.next({ result: { type: 'data', data: result } });
          observer.complete();
        }
      });
  return createTRPCClient<AppRouter>({ links: [link] });
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function open(Screen: ComponentType, server: Server) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = fakeClient(server);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Outlet />
        </TRPCProvider>
      </QueryClientProvider>
    ),
  });
  const world = createRoute({ getParentRoute: () => root, path: 'w/$worldId', component: () => <Screen /> });
  const router = createRouter({
    routeTree: root.addChildren([world]),
    history: createMemoryHistory({ initialEntries: ['/w/w1'] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await flush();
  await flush();
  return queryClient;
}

// GameLayout이 상태·모드 전환 때 home.get에 하는 것과 같은 1회 무효화.
const transition = (queryClient: QueryClient) =>
  act(async () => {
    await queryClient.invalidateQueries({ queryKey: [['home', 'get']] });
  });

const MainEditor = () => <TurnEditor worldId="w1" selectedCityKey={null} />;
const screens: Array<[string, ComponentType]> = [
  ['예턴 화면(편집기와 최근 결과)', TurnsPage],
  ['메인 명령 칸 편집기', MainEditor],
];

beforeEach(() => {
  calls.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('예턴 편집 화면의 home.get 주기 (T1-27)', () => {
  it.each(screens)('%s: 장수가 없어 NOT_FOUND면 가속 중에도 주기 조회를 하지 않는다', async (_, Screen) => {
    await open(Screen, { summary: summary('RUNNING', 'ACCELERATED'), home: notFound });
    const first = homeCalls();
    expect(first).toBeGreaterThan(0);
    await wait(60_000);
    expect(homeCalls()).toBe(first);
  });

  it.each(screens)('%s: 실시간 진행 중 NOT_FOUND도 주기 조회를 하지 않는다', async (_, Screen) => {
    await open(Screen, { summary: summary('RUNNING', 'REALTIME'), home: notFound });
    const first = homeCalls();
    await wait(60_000);
    expect(homeCalls()).toBe(first);
  });

  it('NOT_FOUND 뒤에도 전환 때의 무효화는 한 번 받고 그 뒤 다시 멈춘다', async () => {
    const queryClient = await open(TurnsPage, { summary: summary('RUNNING', 'ACCELERATED'), home: notFound });
    const first = homeCalls();
    await transition(queryClient);
    expect(homeCalls()).toBe(first + 1);
    await wait(60_000);
    expect(homeCalls()).toBe(first + 1);
  });

  it('전환 때 받은 home.get이 성공하면(장수를 만든 뒤) 15초 주기를 다시 켠다', async () => {
    const server: Server = { summary: summary('RUNNING', 'ACCELERATED'), home: notFound };
    const queryClient = await open(TurnsPage, server);
    const first = homeCalls();
    server.home = () => home;
    await transition(queryClient);
    expect(homeCalls()).toBe(first + 1);
    await wait(15_000);
    expect(homeCalls()).toBeGreaterThan(first + 1);
  });

  it('장수가 있으면 진행 중 15초 주기를 그대로 둔다', async () => {
    await open(TurnsPage, { summary: summary('RUNNING', 'REALTIME'), home: () => home });
    const first = homeCalls();
    await wait(15_000);
    expect(homeCalls()).toBeGreaterThan(first);
  });

  it('끝난 판은 장수가 있어도 주기 조회를 멈춘다', async () => {
    await open(TurnsPage, { summary: summary('ENDED', 'ACCELERATED'), home: () => home });
    const first = homeCalls();
    await wait(60_000);
    expect(homeCalls()).toBe(first);
  });
});
