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
import type { Check, TurnList, TurnSource, TurnSourceFactory } from './source';
import { TurnEditor, type TurnEditorStatus } from './TurnEditor';

// T4-97 U2: 편집기가 바깥 띠에 알리는 저장 상태. 가짜 tRPC와 가짜 칸 연결로 실제 편집기를 띄운다.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
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
  quota: { humans: 0, max: 500 },
  npcCount: 0,
  scenarioType: null,
  serverTime: '2026-01-01T00:00:00.000Z',
  engine: null,
  engineStale: null,
  protection: { war: null, founding: null },
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

it('AC-M1-08 선택한 칸에 한 번에 저장하고 충돌하면 방금 넣은 명령을 보존한다', async () => {
  const save = vi.fn<TurnSource['save']>().mockResolvedValue({ ok: false, reason: 'STALE', revision: 2, slots });
  await open((input) => ({ ...makeSource(null)(input), save }), 'RUNNING', vi.fn());
  await screen.findByRole('grid', { name: '예턴 30칸' });
  fireEvent.click(document.querySelector('tr[data-slot="1"]')!);
  fireEvent.click(await screen.findByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 저장' }));
  await waitFor(() =>
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      revision: 1,
      slots: [{ commandKey: 'farm', args: {} }, ...Array.from({ length: 29 }, () => null)],
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '내 편집 다시 적용' }));
  expect(document.querySelector('tr[data-slot="1"]')?.textContent).toContain('농지 개간');
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

it('INT-25 넣은 명령은 최근 넣은 명령 줄에 남고 누르면 고른 칸에 같은 넣기 경로로 넣는다', async () => {
  const onStatus = vi.fn();
  const view = await open(makeSource(null), 'RUNNING', onStatus);
  await waitFor(() => expect(document.querySelector('tr[data-slot="1"]')).not.toBeNull());
  // 아직 넣은 명령이 없으면 줄을 그리지 않는다.
  expect(screen.queryByRole('group', { name: '최근 넣은 명령' })).toBeNull();
  fireEvent.click(document.querySelector('tr[data-slot="1"]')!);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  const recent = await screen.findByRole('group', { name: '최근 넣은 명령' });
  expect(recent.textContent).toContain('농지 개간');
  expect(JSON.parse(localStorage.getItem('opensamguk.recentCommands.v1:u1:w1')!)).toEqual([
    { commandKey: 'farm', args: {} },
  ]);

  // 1번을 풀고 2번만 고른 뒤 최근 명령을 누른다.
  fireEvent.click(document.querySelector('tr[data-slot="1"]')!);
  fireEvent.click(document.querySelector('tr[data-slot="2"]')!);
  fireEvent.click(screen.getByRole('button', { name: '농지 개간 다시 넣기' }));
  await waitFor(() => expect(document.querySelector('tr[data-slot="2"]')?.textContent).toContain('농지 개간'));
  await waitFor(() =>
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unsaved', edits: 2 })),
  );

  // 다시 열어도 계정·월드의 localStorage에서 읽는다.
  view.unmount();
  sessionStorage.clear();
  await open(makeSource(null), 'RUNNING', vi.fn());
  expect((await screen.findByRole('group', { name: '최근 넣은 명령' })).textContent).toContain('농지 개간');
});

it('INT-25 칸을 고르기 전에는 최근 명령도 넣지 않고 이유를 보인다', async () => {
  localStorage.setItem('opensamguk.recentCommands.v1:u1:w1', JSON.stringify([{ commandKey: 'farm', args: {} }]));
  const onStatus = vi.fn();
  await open(makeSource(null), 'RUNNING', onStatus);
  const recent = await screen.findByRole('group', { name: '최근 넣은 명령' });
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith({ kind: 'saved', behind: false, selection: 0 }));
  fireEvent.click(screen.getByRole('button', { name: /^농지 개간\s*\(사용 불가\)$/ }));
  expect(recent.querySelector('[role="note"]')?.textContent).toBe('칸을 먼저 고르세요.');
  expect(onStatus).toHaveBeenLastCalledWith({ kind: 'saved', behind: false, selection: 0 });
});

it('INT-25 예턴 표 머리에 지금 시각을 시:분:초로 둔다', async () => {
  await open(makeSource(null), 'RUNNING', vi.fn());
  const clock = await screen.findByTestId('turn-clock');
  expect(clock.textContent).toMatch(/^현재 \d{2}:\d{2}:\d{2}$/);
});

it('INT-25 남의 직책 칸은 넘겨받은 다음 턴 시각에 칸마다 턴 간격을 더해 시:분을 적는다', async () => {
  const at = new Date(Date.now() + 5 * 60_000);
  at.setSeconds(0, 0);
  const source: TurnSourceFactory = (input) => ({
    ...makeSource('내 직책 칸이 아닙니다')(input),
    nextTurnAt: at.toISOString(),
  });
  await open(source, 'RUNNING', vi.fn());
  await waitFor(() => expect(document.querySelector('tr[data-slot="3"] time')).not.toBeNull());
  // 가짜 월드의 턴 간격은 60분이다.
  expect(document.querySelector('tr[data-slot="1"] time')?.getAttribute('datetime')).toBe(at.toISOString());
  expect(document.querySelector('tr[data-slot="3"] time')?.getAttribute('datetime')).toBe(
    new Date(at.getTime() + 2 * 60 * 60_000).toISOString(),
  );
});

it('INT-26 AC-INT-26 예턴 표는 서버 칸이 실은 대상 이름을 번호 대신 적고 칸을 밀어도 같은 이름을 쓴다', async () => {
  const stored = [
    { commandKey: 'invite', args: { generalId: 21 }, name: '등용', targets: { general: '서서(徐庶)' } },
    { commandKey: 'move', args: { cityKey: 99 }, name: '이동', targets: { city: '신야' } },
    // 서버가 이름을 주지 않은 장수(안개)는 번호로 적는다.
    { commandKey: 'invite', args: { generalId: 30 }, name: '등용', targets: { general: null } },
    ...slots.slice(3),
  ];
  const source: TurnSourceFactory = (input) => ({
    ...makeSource(null)(input),
    list: {
      queryKey: ['list', 'targets'],
      queryFn: async () => ({ revision: 1, slots: stored }),
      select: (d) => d as TurnList,
    },
  });
  await open(source, 'RUNNING', vi.fn());
  const row = (n: number) => document.querySelector(`tr[data-slot="${n}"]`)?.textContent ?? '';
  await waitFor(() => expect(row(1)).toContain('서서'));
  expect(row(1)).not.toContain('徐庶');
  expect(row(1)).not.toContain('21');
  expect(row(2)).toContain('신야');
  expect(row(2)).not.toContain('도시 99');
  expect(row(3)).toContain('장수 30');
  // 1번 칸을 골라 한 칸 밀면 등용이 2번 칸으로 가도 이름이 따라간다.
  fireEvent.click(document.querySelector('tr[data-slot="1"]')!);
  fireEvent.click(screen.getByRole('button', { name: '밀기' }));
  await waitFor(() => expect(row(2)).toContain('서서'));
  expect(row(3)).toContain('신야');
});
