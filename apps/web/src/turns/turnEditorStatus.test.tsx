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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldSummary } from '../game/types';
import { TRPCProvider } from '../trpc';
import type { CommandInfo } from './CommandPicker';
import type { Check, TurnList, TurnSourceFactory } from './source';
import { TurnEditor, type TurnEditorStatus } from './TurnEditor';

// T4-97 U2: 편집기가 바깥 띠에 알리는 저장 상태. 가짜 tRPC와 가짜 칸 연결로 실제 편집기를 띄운다.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const notFound = () =>
  new TRPCClientError('NOT_FOUND', { result: { error: { data: { code: 'NOT_FOUND' } } } } as never);

const summary = (status: WorldSummary['status']): WorldSummary => ({
  name: '시험 월드',
  status,
  startYear: 190,
  gameDate: { year: 190, month: 1 },
  clockMode: 'REALTIME',
  endYear: 300,
  result: null,
  nowTick: 0,
  msPerTick: 1_000,
  turnTermMinutes: 60,
  truce: null,
  quota: { humans: 0, max: null },
});

function fakeClient(status: WorldSummary['status']) {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        const result: unknown =
          op.path === 'auth.me'
            ? { user: { id: 'u1', username: 'tester' } }
            : op.path === 'world.summary'
              ? summary(status)
              : notFound();
        if (result instanceof Error) observer.error(TRPCClientError.from(result));
        else {
          observer.next({ result: { type: 'data', data: result } });
          observer.complete();
        }
      });
  return createTRPCClient<AppRouter>({ links: [link] });
}

const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {}, name: '휴식' }));
const commands: CommandInfo[] = [
  { key: 'farm', name: '농지 개간', category: 'domestic', argsSchema: { type: 'object', properties: {} } },
];

const makeSource =
  (readOnly: string | null): TurnSourceFactory =>
  ({ userId, worldId }) => ({
    slotCount: 30,
    storageKey: `test:${userId}:${worldId}:${readOnly ?? 'edit'}`,
    gridLabel: '예턴 30칸',
    list: { queryKey: ['list', readOnly], queryFn: async () => ({ revision: 1, slots }), select: (d) => d as TurnList },
    writeList: () => undefined,
    save: async () => ({ ok: true as const, revision: 2, slots }),
    commands: { queryKey: ['commands'], queryFn: async () => commands, select: (d) => d as CommandInfo[] },
    precheck: (turn) => ({
      queryKey: ['pre', turn.commandKey],
      queryFn: async () => ({ ok: true }),
      select: (d) => d as Check,
    }),
    precheckRoot: ['pre'],
    timed: false,
    readOnly,
  });

async function open(
  source: TurnSourceFactory,
  status: WorldSummary['status'],
  onStatus: (s: TurnEditorStatus | null) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = fakeClient(status);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Outlet />
        </TRPCProvider>
      </QueryClientProvider>
    ),
  });
  const world = createRoute({
    getParentRoute: () => root,
    path: 'w/$worldId',
    component: () => <TurnEditor worldId="w1" selectedCityKey={null} source={source} onStatus={onStatus} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([world]),
    history: createMemoryHistory({ initialEntries: ['/w/w1'] }),
  });
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
  });
  return view!;
}

// 같은 값을 거듭 알리지 않는다. 값이 바뀔 때는 앞 값을 지우는 null이 사이에 온다.
function expectNoRepeat(onStatus: ReturnType<typeof vi.fn>) {
  const values = onStatus.mock.calls.map(([value]) => value as TurnEditorStatus | null).filter((v) => v !== null);
  for (let i = 1; i < values.length; i++) expect(values[i]).not.toEqual(values[i - 1]);
}

it('T4-97 AC-P2-34 최초 조회·저장된 목록·미저장 편집을 구분해 바뀔 때만 알리고 사라지면 null을 넘긴다', async () => {
  const onStatus = vi.fn();
  const view = await open(makeSource(null), 'RUNNING', onStatus);
  expect(onStatus.mock.calls[0]![0]).toEqual({ kind: 'loading' });
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith({ kind: 'saved', behind: false, selection: 0 }));

  fireEvent.click(document.querySelector('tr[data-slot="1"]')!);
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith({ kind: 'saved', behind: false, selection: 1 }));
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  await waitFor(() =>
    expect(onStatus).toHaveBeenLastCalledWith({ kind: 'unsaved', edits: 1, behind: false, selection: 1 }),
  );
  fireEvent.click(screen.getByRole('button', { name: '편집 취소' }));
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith({ kind: 'saved', behind: false, selection: 1 }));
  expectNoRepeat(onStatus);

  view.unmount();
  expect(onStatus).toHaveBeenLastCalledWith(null);
});

it('읽기 전용 칸과 끝난 판은 저장된 목록과 다른 상태로 알린다', async () => {
  const readOnly = vi.fn();
  await open(makeSource('국가 직책이 없습니다.'), 'RUNNING', readOnly);
  await waitFor(() => expect(readOnly).toHaveBeenLastCalledWith({ kind: 'readOnly' }));
  cleanup();

  const ended = vi.fn();
  await open(makeSource(null), 'ENDED', ended);
  await waitFor(() => expect(ended).toHaveBeenLastCalledWith({ kind: 'ended' }));
  expectNoRepeat(ended);
});

it('T4-86 AC-P2-26 병종표 조회가 실패해도 표는 병종 번호로 적고 병종 없는 명령을 넣어 저장한다', async () => {
  // 가짜 tRPC는 resources.worldRules에 NOT_FOUND를 답한다.
  const stored = [{ commandKey: 'recruit', args: { amount: 100, crewType: 1300 }, name: '징병' }, ...slots.slice(1)];
  const save = vi.fn(async () => ({ ok: true as const, revision: 2, slots: stored }));
  const source: TurnSourceFactory = (input) => ({
    ...makeSource(null)(input),
    list: {
      queryKey: ['list', 't486'],
      queryFn: async () => ({ revision: 1, slots: stored }),
      select: (d) => d as TurnList,
    },
    save,
  });
  const onStatus = vi.fn();
  await open(source, 'RUNNING', onStatus);
  await waitFor(() => expect(document.querySelector('tr[data-slot="1"]')?.textContent).toContain('병종 1300'));
  fireEvent.click(document.querySelector('tr[data-slot="2"]')!);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: '2번 칸에 넣기' }));
  await waitFor(() =>
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unsaved', edits: 1 })),
  );
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});
