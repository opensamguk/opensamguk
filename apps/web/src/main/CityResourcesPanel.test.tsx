// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CityResourcesPanel } from './CityResourcesPanel';
import { allocationStorageKey } from './cityResourceRequest';
import { TRPCClientError } from '@trpc/client';

// UI의 요청 세대·재접수 경계만 검증한다. 실제 API/PG·공개 Chromium 인수는 별도다.
const mocks = vi.hoisted(() => ({
  enabled: true,
  user: '11111111-1111-4111-8111-111111111111',
  me: vi.fn(),
  get: vi.fn(),
  allocate: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../trpc', () => {
  const options = {
    world: {
      summary: {
        queryOptions: () => ({
          queryKey: ['summary'],
          queryFn: async () => (mocks.enabled ? { cityResourcesEnabled: true } : {}),
        }),
      },
    },
    campaign: { get: { queryKey: () => ['campaign'] } },
    home: { get: { queryKey: () => ['home'] } },
  };
  const api = {
    auth: { me: { query: mocks.me } },
    cityResources: {
      get: { query: mocks.get },
      allocate: { mutate: mocks.allocate },
      request: { query: mocks.request },
    },
  };
  return { useTRPC: () => options, useTRPCClient: () => api };
});
const board = (gold = 123) => ({
  userId: mocks.user,
  cityKey: 2,
  visible: true,
  status: 'RUNNING',
  canAllocate: true,
  resources: { gold, rice: 500, garrison: [{ crewType: 1100, troops: 200, train: 20, atmos: 30 }] },
  armyTypes: [{ id: 1100, name: '보병' }],
  targets: [
    {
      id: 7,
      ownerId: 3,
      commanderId: 3,
      ownerName: '소유자',
      commanderName: '지휘관',
      crewType: 1100,
      troops: 0,
      train: 0,
      atmos: 0,
      capacity: 1000,
      commanded: 900,
    },
  ],
});
const clients: QueryClient[] = [];
const refused = (code: string, seconds?: string) =>
  TRPCClientError.from(
    { error: { message: '접근을 거부했습니다.', code: -32000, data: { code } } },
    { meta: { response: new Response(null, { headers: seconds ? { 'Retry-After': seconds } : {} }) } },
  );
const pendingRequest = () => ({
  requestId: '12345678-1234-4234-8234-123456789abc',
  payload: { cityKey: 2, unitId: 7, crewType: 1100, amount: 50 },
});
function enterAllocation() {
  fireEvent.change(screen.getByRole('combobox', { name: '배속할 부곡' }), { target: { value: '7' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '배속 인원' }), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: '도시 수비병을 부곡에 배속' }));
}
function expectNoCityData() {
  expect(screen.queryByText('금 123')).toBeNull();
  expect(screen.queryByRole('combobox', { name: '배속할 부곡' })).toBeNull();
  expect(screen.queryByRole('spinbutton', { name: '배속 인원' })).toBeNull();
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CityResourcesPanel worldId="world-one" cityKey={2} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.user = '11111111-1111-4111-8111-111111111111';
  mocks.me.mockImplementation(async () => ({ user: { id: mocks.user } }));
  mocks.get.mockResolvedValue(board());
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  sessionStorage.clear();
});
it('INT-18C AC-INT-18C 구판은 도시 자원 조회를 추가하지 않는다', async () => {
  mocks.enabled = false;
  const client = mount();
  await waitFor(() => expect(client.getQueryData(['summary'])).toEqual({}));
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '도시 금·쌀·수비병' })).toBeNull();
});
it('INT-18C AC-INT-18C focus 신원 교체 뒤 늦은 이전 도시 자료를 표시하지 않는다', async () => {
  let release!: (value: ReturnType<typeof board>) => void;
  mocks.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async () => board(222));
  mount();
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  act(() => {
    window.dispatchEvent(new Event('blur'));
    mocks.user = '22222222-2222-4222-8222-222222222222';
    window.dispatchEvent(new Event('focus'));
  });
  await screen.findByText('금 222');
  await act(async () => {
    release(board(999));
  });
  expect(screen.queryByText('금 999')).toBeNull();
  expect(mocks.allocate).not.toHaveBeenCalled();
});
it('INT-18C AC-INT-18C A→B→A 조회의 B 자료는 전후 me가 같아도 표시하지 않는다', async () => {
  mocks.get.mockResolvedValue({ ...board(999), userId: '22222222-2222-4222-8222-222222222222' });
  mount();
  await screen.findByText('계정이 바뀌었습니다. 다시 확인하세요.');
  expect(screen.queryByText('금 999')).toBeNull();
  expect(screen.queryByRole('combobox', { name: '배속할 부곡' })).toBeNull();
  expect(mocks.allocate).not.toHaveBeenCalled();
});
it('INT-18C AC-INT-18C 재진입 pending은 같은 UUID의 조회만 복구한다', async () => {
  const pending = {
    requestId: '12345678-1234-4234-8234-123456789abc',
    payload: { cityKey: 2, unitId: 7, crewType: 1100, amount: 50 },
  };
  sessionStorage.setItem(allocationStorageKey(mocks.user, 'world-one'), JSON.stringify(pending));
  mocks.request.mockResolvedValue({
    userId: mocks.user,
    requestId: pending.requestId,
    status: 'rejected',
    result: { code: 'BAD_STATE', message: '잔여 수량이 바뀌었습니다.' },
  });
  mount();
  await screen.findByText('잔여 수량이 바뀌었습니다.');
  expect(mocks.request).toHaveBeenCalledWith({ worldId: 'world-one', requestId: pending.requestId }, expect.anything());
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).toBeNull();
});
it('INT-18C AC-INT-18C 같은 UUID를 가진 다른 계정의 terminal 응답은 완료로 처리하지 않는다', async () => {
  const pending = {
    requestId: '12345678-1234-4234-8234-123456789abc',
    payload: { cityKey: 2, unitId: 7, crewType: 1100, amount: 50 },
  };
  sessionStorage.setItem(allocationStorageKey(mocks.user, 'world-one'), JSON.stringify(pending));
  mocks.request.mockResolvedValue({
    userId: '22222222-2222-4222-8222-222222222222',
    requestId: pending.requestId,
    status: 'rejected',
    result: { code: 'BAD_STATE', message: '다른 계정 결과' },
  });
  mount();
  await screen.findByText('계정이나 요청이 바뀌었습니다. 다시 확인하세요.');
  expect(screen.queryByText('다른 계정 결과')).toBeNull();
  expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).not.toBeNull();
  expect(mocks.allocate).not.toHaveBeenCalled();
});
it('INT-18C AC-INT-18C 비공개 도시는 자원과 배속 대상을 표시하지 않는다', async () => {
  mocks.get.mockResolvedValue({ userId: mocks.user, cityKey: 2, visible: false });
  mount();
  await screen.findByText('금·쌀·수비병은 자기 국가 도시나 내 장수가 있는 도시에서만 보입니다.');
  expect(screen.queryByText('금 123')).toBeNull();
  expect(screen.queryByRole('combobox', { name: '배속할 부곡' })).toBeNull();
});
it('INT-18C AC-INT-18C 원장 재조회는 편집 중인 배속 입력을 보존한다', async () => {
  let refresh: (() => void) | undefined;
  const original = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay, ...args) => {
    if (delay === 15_000 && typeof handler === 'function') refresh = () => handler();
    return original(handler, delay, ...args);
  });
  try {
    mount();
    await screen.findByText('금 123');
    fireEvent.change(screen.getByRole('combobox', { name: '배속할 부곡' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '배속 인원' }), { target: { value: '50' } });
    mocks.get.mockResolvedValue(board(222));
    act(() => refresh?.());
    await screen.findByText('금 222');
    expect((screen.getByRole('spinbutton', { name: '배속 인원' }) as HTMLInputElement).value).toBe('50');
    expect(mocks.allocate).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});
it('INT-18C AC-INT-18C 연속 클릭과 네트워크 실패는 새 배속을 자동 재접수하지 않는다', async () => {
  mocks.allocate.mockRejectedValue(new Error('network'));
  mount();
  await screen.findByText('금 123');
  fireEvent.change(screen.getByRole('combobox', { name: '배속할 부곡' }), { target: { value: '7' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '배속 인원' }), { target: { value: '50' } });
  const submit = screen.getByRole('button', { name: '도시 수비병을 부곡에 배속' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await screen.findByText('접수 상태를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  expect(mocks.allocate).toHaveBeenCalledTimes(1);
  expect(mocks.allocate.mock.calls[0]![0].expectedUserId).toBe(mocks.user);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).not.toBeNull();
});
it.each(['network', 'identity'])(
  'INT-18C AC-INT-18C 마지막 신원 조회 %s 실패는 미접수 UUID를 남기지 않고 수동 복구한다',
  async (kind) => {
    let calls = 0;
    mocks.me.mockImplementation(async () => {
      if (++calls === 5) {
        if (kind === 'network') throw new Error('network');
        return { user: { id: '22222222-2222-4222-8222-222222222222' } };
      }
      return { user: { id: mocks.user } };
    });
    mount();
    await screen.findByText('금 123');
    enterAllocation();
    await screen.findByText(
      kind === 'network'
        ? '배속을 보내지 않았습니다. 신원과 도시를 다시 확인하세요.'
        : '계정이 바뀌었습니다. 다시 확인하세요.',
    );
    expect(mocks.allocate).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).toBeNull();
    expectNoCityData();
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
    await screen.findByRole('combobox', { name: '배속할 부곡' });
    expect(mocks.allocate).not.toHaveBeenCalled();
  },
);
it('INT-18C AC-INT-18C 마지막 me 대기 중 blur 뒤 늦은 응답은 다른 새 요청 기록을 지우지 않는다', async () => {
  let release!: (value: { user: { id: string } }) => void,
    calls = 0;
  mocks.me.mockImplementation(() =>
    ++calls === 5
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ user: { id: mocks.user } }),
  );
  mount();
  await screen.findByText('금 123');
  enterAllocation();
  await waitFor(() => expect(calls).toBe(5));
  act(() => window.dispatchEvent(new Event('blur')));
  expectNoCityData();
  const next = { ...pendingRequest(), requestId: '22345678-1234-4234-8234-123456789abc' };
  sessionStorage.setItem(allocationStorageKey(mocks.user, 'world-one'), JSON.stringify(next));
  await act(async () => release({ user: { id: mocks.user } }));
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))!)).toEqual(next);
});
it.each(['restore', 'manual'])(
  'INT-18C AC-INT-18C %s poll 403은 원장·대상·입력을 지우고 미확정 UUID를 보존한다',
  async (mode) => {
    const pending = pendingRequest();
    sessionStorage.setItem(allocationStorageKey(mocks.user, 'world-one'), JSON.stringify(pending));
    if (mode === 'manual') mocks.request.mockRejectedValueOnce(new Error('network'));
    mocks.request.mockRejectedValue(refused('FORBIDDEN'));
    mount();
    if (mode === 'manual') {
      await screen.findByText('도시 자원을 확인하지 못했습니다. 다시 확인하세요.');
      fireEvent.click(screen.getByRole('button', { name: '같은 요청 상태 확인' }));
    }
    await screen.findByText('접근을 거부했습니다.');
    expectNoCityData();
    expect(mocks.allocate).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))!)).toEqual(pending);
  },
);
it('INT-18C AC-INT-18C 접수 후 poll 403도 이미 보낸 UUID를 미접수로 지우지 않는다', async () => {
  mocks.allocate.mockResolvedValue({ status: 'pending' });
  mocks.request.mockRejectedValue(refused('FORBIDDEN'));
  mount();
  await screen.findByText('금 123');
  enterAllocation();
  await screen.findByText('접근을 거부했습니다.');
  expectNoCityData();
  expect(mocks.allocate).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).not.toBeNull();
});
it('INT-18C AC-INT-18C mutation401은 commit 뒤 세션 만료일 수 있어 UUID를 보존한다', async () => {
  mocks.allocate.mockRejectedValue(refused('UNAUTHORIZED'));
  mount();
  await screen.findByText('금 123');
  enterAllocation();
  await screen.findByText('접근을 거부했습니다.');
  expectNoCityData();
  expect(mocks.allocate).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).not.toBeNull();
});
it('INT-18C AC-INT-18C 미접수 429는 UUID를 지우고 Retry-After 뒤 수동 조회만 허용한다', async () => {
  let tick: (() => void) | undefined;
  const original = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay, ...args) => {
    if (delay === 1000 && typeof handler === 'function') tick = () => handler();
    return original(handler, delay, ...args);
  });
  const clock = vi.spyOn(Date, 'now');
  try {
    mocks.allocate.mockRejectedValue(refused('TOO_MANY_REQUESTS', '45'));
    mount();
    await screen.findByText('금 123');
    enterAllocation();
    await screen.findByText('45초 뒤에 다시 확인하세요.');
    expect(sessionStorage.getItem(allocationStorageKey(mocks.user, 'world-one'))).toBeNull();
    expect((screen.getByRole('button', { name: '다시 확인' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.allocate).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(Date.now() + 46_000);
    act(() => tick?.());
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
    await screen.findByRole('combobox', { name: '배속할 부곡' });
    expect(mocks.allocate).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
    timer.mockRestore();
  }
});
