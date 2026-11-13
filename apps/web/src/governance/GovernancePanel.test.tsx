// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GovernancePanel } from './GovernancePanel';
import { governanceStorageKey, readGovernancePending, writeGovernancePending } from './governanceRequestState';
import { testBoard, testView } from './testView';
import { OLD_REQUEST_CLEARED, OLD_REQUEST_KEPT } from './useGovernanceBoard';

// 화면의 요청 수명·기능 꺼짐 경계만 본다. 실제 API/PG·브라우저 인수는 별도다.
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const mocks = vi.hoisted(() => ({
  enabled: true,
  user: '11111111-1111-4111-8111-111111111111',
  me: vi.fn(),
  get: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../trpc', () => {
  const options = {
    world: {
      summary: {
        queryOptions: () => ({
          queryKey: ['summary'],
          queryFn: async () =>
            mocks.enabled
              ? { governanceEnabled: true, startYear: 190, msPerTick: 6, turnTermMinutes: 1 }
              : { startYear: 190, msPerTick: 6, turnTermMinutes: 1 },
        }),
      },
      map: {
        queryOptions: () => ({ queryKey: ['map'], queryFn: async () => ({ cities: [{ key: 7, name: '낙양' }] }) }),
      },
    },
  };
  const api = {
    auth: { me: { query: mocks.me } },
    governance: { get: { query: mocks.get }, submit: { mutate: mocks.submit }, request: { query: mocks.request } },
  };
  return { useTRPC: () => options, useTRPCClient: () => api };
});

const WORLD = 'world-one';
const requestId = '12345678-1234-4234-8234-123456789abc';
const roles = { monarch: true, emperor: false, chancellor: false, grandMarshal: false, minister: false };
const ascendable = () =>
  testBoard(
    mocks.user,
    WORLD,
    testView({
      roles,
      ownNationId: 1,
      throne: { emperorGeneralId: null, emperorNationId: null, sinceTick: 0 },
      ascend: { allowed: true },
    }),
  );
const refused = (code: string) =>
  TRPCClientError.from(
    { error: { message: `거부 ${code}`, code: -32000, data: { code } } },
    { meta: { response: new Response(null) } },
  );
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <GovernancePanel worldId={WORLD} />
    </QueryClientProvider>,
  );
  return client;
}
const key = () => governanceStorageKey(mocks.user, WORLD);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.user = ACCOUNT;
  mocks.me.mockImplementation(async () => ({ user: { id: mocks.user } }));
  mocks.get.mockImplementation(async () => ascendable());
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  sessionStorage.clear();
});

it('T4-94 AC-P2-31 기능을 끈 월드는 황실 조회를 하지 않고 칸도 그리지 않는다', async () => {
  mocks.enabled = false;
  const client = mount();
  await waitFor(() => expect(client.getQueryData(['summary'])).toBeDefined());
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '황실' })).toBeNull();
});

it('T4-94 AC-P2-31 서버가 기능 꺼짐(412)을 알리면 칸을 지우고 focus에도 다시 묻지 않는다', async () => {
  mocks.get.mockRejectedValue(refused('PRECONDITION_FAILED'));
  mount();
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole('region', { name: '황실' })).toBeNull());
  act(() => void window.dispatchEvent(new Event('focus')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/거부/)).toBeNull();
});

it('T4-94 AC-P2-31 확인 대화상자는 Escape로 닫고 연 단추로 초점을 돌리며 요청을 보내지 않는다', async () => {
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  const dialog = screen.getByRole('dialog', { name: '즉위 요청' });
  expect(dialog.textContent).toContain('사람 군주는 자동으로 즉위하지 않습니다');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readGovernancePending(sessionStorage, key())).toBeNull();
});

it('T4-94 AC-P2-31 창을 떠나 보기가 지워진 뒤 다른 계정으로 다시 읽어도 이전 확인 대화상자는 돌아오지 않고 보내지 않는다', async () => {
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  expect(screen.getByRole('dialog', { name: '즉위 요청' })).toBeTruthy();

  act(() => void window.dispatchEvent(new Event('blur')));
  expect(screen.queryByRole('dialog')).toBeNull();

  const reads = mocks.get.mock.calls.length;
  mocks.user = OTHER;
  act(() => void window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(reads + 1));
  // 새 계정의 보기로 다시 그려져 요청 단추가 열려도 이전 계정의 대화상자는 없다.
  await screen.findAllByRole('button', { name: '즉위 요청' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '즉위 요청 보내기' })).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readGovernancePending(sessionStorage, governanceStorageKey(ACCOUNT, WORLD))).toBeNull();
  expect(readGovernancePending(sessionStorage, governanceStorageKey(OTHER, WORLD))).toBeNull();
});

it('T4-94 AC-P2-31 로그아웃으로 보기가 지워지면 열린 확인 대화상자도 버리고, 같은 계정으로 다시 확인해도 돌아오지 않는다', async () => {
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  expect(screen.getByRole('dialog', { name: '즉위 요청' })).toBeTruthy();

  mocks.me.mockImplementation(async () => ({ user: null }));
  act(() => void window.dispatchEvent(new Event('focus')));
  await screen.findByText('계정이 바뀌었습니다. 다시 확인하세요.');
  expect(screen.queryByRole('dialog')).toBeNull();

  mocks.me.mockImplementation(async () => ({ user: { id: mocks.user } }));
  fireEvent.click(await screen.findByRole('button', { name: '다시 확인' }));
  await screen.findAllByRole('button', { name: '즉위 요청' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readGovernancePending(sessionStorage, key())).toBeNull();
});

it('T4-94 AC-P2-31 응답을 잃은 요청은 다시 보내지 않고, 기록을 못 찾은 뒤에만 같은 번호·내용으로 손으로 다시 접수한다', async () => {
  mocks.submit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  fireEvent.click(screen.getByRole('button', { name: '즉위 요청 보내기' }));
  await screen.findByText(/응답을 받지 못했습니다/);
  const saved = readGovernancePending(sessionStorage, key());
  expect(saved?.payload).toEqual({ type: 'throne.ascend' });
  // 처음 기록을 만들 때의 장수(10)를 함께 두고, 같은 값을 expectedGeneralId로 보낸다.
  expect(saved?.generalId).toBe(10);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit.mock.calls[0]![0]).toEqual({
    worldId: WORLD,
    expectedUserId: mocks.user,
    expectedGeneralId: 10,
    requestId: saved!.requestId,
    payload: { type: 'throne.ascend' },
  });
  // 결과 전에는 새 요청 단추가 막힌다. DisabledReason은 '즉위 요청'과 숨은 ' (사용 불가)'를 이어 이름을 만들며,
  // 환경마다 사이 공백 처리가 달라 그 공백만 허용한다. 막힌 단추를 눌러도 이유만 보이고 새 요청은 없다.
  expect(screen.queryByRole('button', { name: '즉위 요청' })).toBeNull();
  const locked = screen.getAllByRole('button', { name: /^즉위 요청\s*\(사용 불가\)$/ });
  expect(locked.length).toBeGreaterThan(0);
  fireEvent.click(locked[0]!);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    screen.getAllByRole('note').some((note) => note.textContent?.includes('앞 황실 요청의 결과를 기다리는 중입니다')),
  ).toBe(true);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '같은 요청 다시 접수' })).toBeNull();

  // 상태 확인에서 기록이 없으면(404) 그때만 같은 번호로 다시 접수할 수 있다.
  mocks.request.mockRejectedValueOnce(refused('NOT_FOUND'));
  fireEvent.click(screen.getByRole('button', { name: '같은 요청 상태 확인' }));
  const resubmit = await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(readGovernancePending(sessionStorage, key())).toEqual(saved);

  mocks.submit.mockResolvedValueOnce({ userId: mocks.user, requestId: saved!.requestId, status: 'pending' });
  mocks.request.mockResolvedValueOnce({
    userId: mocks.user,
    requestId: saved!.requestId,
    status: 'applied',
    result: { action: 'throne.ascend', revision: 2, tick: 10 },
  });
  fireEvent.click(resubmit);
  await screen.findByText('즉위했습니다.');
  expect(mocks.submit).toHaveBeenCalledTimes(2);
  expect(mocks.submit.mock.calls[1]![0]).toEqual(mocks.submit.mock.calls[0]![0]);
  expect(readGovernancePending(sessionStorage, key())).toBeNull();
});

it('T4-94 AC-P2-31 다시 열면 저장된 요청의 상태만 확인하고 새로 보내지 않는다', async () => {
  writeGovernancePending(sessionStorage, key(), { requestId, payload: { type: 'court.resign' } });
  mocks.request.mockResolvedValue({ userId: mocks.user, requestId, status: 'pending' });
  mount();
  await screen.findByText(/요청 처리 대기/);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ worldId: WORLD, requestId }, expect.anything()));
  expect(screen.getByText(/직위 사임/)).toBeTruthy();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-94 AC-P2-31 이탈 확인은 서버가 준 정통성 감소량을 그대로 보이고 확인 전에는 보내지 않는다', async () => {
  mocks.get.mockImplementation(async () =>
    testBoard(
      mocks.user,
      WORLD,
      testView({
        roles,
        viewerGeneralId: 20,
        ownNationId: 2,
        realmNationId: 1,
        vassals: [
          {
            id: 1,
            overlordNationId: 1,
            vassalNationId: 2,
            sinceTick: 0,
            goldBp: 500,
            riceBp: 0,
            renouncePending: false,
          },
        ],
      }),
    ),
  );
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: '봉신' }));
  fireEvent.click(screen.getByRole('button', { name: '이탈' }));
  const dialog = screen.getByRole('dialog', { name: '봉신 이탈' });
  expect(dialog.textContent).toContain('관계가 끝날 때 국2의 정통성이 8 내려갑니다.');
  fireEvent.click(screen.getByRole('button', { name: '그만두기' }));
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-94 AC-P2-31 봉신 탭은 내 계열과 제안 보내기를 먼저 보이고, 전체 계열도는 접힌 칸에서 열고 닫아도 입력을 지우지 않는다', async () => {
  mocks.get.mockImplementation(async () =>
    testBoard(mocks.user, WORLD, testView({ roles, viewerGeneralId: 40, ownNationId: 4 })),
  );
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: '봉신' }));
  const own = screen.getByRole('list', { name: '내 계열' });
  expect(own.textContent).toContain('국4');
  expect(own.textContent).not.toContain('국1');
  const form = screen.getByRole('form', { name: '봉신 제안' });
  const summary = screen.getByText('전체 계열도 (공개) · 5개국 · 관계 2건');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  // 제안 입력이 전체 계열도보다 앞에 있다.
  expect(form.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.change(within(form).getByRole('combobox'), { target: { value: '5' } });
  const [gold, rice] = within(form).getAllByRole('spinbutton') as HTMLInputElement[];
  fireEvent.change(gold!, { target: { value: '2.5' } });
  fireEvent.change(rice!, { target: { value: '0' } });
  expect(screen.getByRole('button', { name: '제안 보내기' })).toBeTruthy();

  fireEvent.click(summary);
  expect(details.open).toBe(true);
  const all = screen.getByRole('list', { name: '전체 봉신 계열도' });
  for (const id of [1, 2, 3, 4, 5]) expect(all.textContent).toContain(`국${id}`);
  fireEvent.click(summary);
  expect(details.open).toBe(false);
  // 열고 닫아도 같은 입력 칸이 값을 그대로 지닌다.
  expect(screen.getByRole('form', { name: '봉신 제안' })).toBe(form);
  const target = within(form).getByRole<HTMLSelectElement>('combobox');
  expect([target.value, gold!.value, rice!.value]).toEqual(['5', '2.5', '0']);
  expect(screen.getByRole('button', { name: '제안 보내기' })).toBeTruthy();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-94 AC-P2-31 재야 장수도 통치 화면에서 공개 황실 칸을 보고, 기능을 끈 월드면 묻지 않는다', async () => {
  const neutral = () =>
    testBoard(mocks.user, WORLD, testView({ viewerGeneralId: 30, ownNationId: null, realmNationId: null }));
  mocks.get.mockImplementation(async () => neutral());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <GovernancePanel worldId={WORLD} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: '황실' });
  expect(screen.getByText('소속 국가가 없습니다.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '즉위 요청' })).toBeNull();
  view.unmount();
  client.clear();

  mocks.get.mockClear();
  mocks.enabled = false;
  const off = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(off);
  render(
    <QueryClientProvider client={off}>
      <GovernancePanel worldId={WORLD} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(off.getQueryData(['summary'])).toBeDefined());
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '황실' })).toBeNull();
});

// 가문 계승(T4-95)은 같은 계정의 장수만 바꾼다. 계정 확인만으로는 막지 못하는 경계다.
const successor = () =>
  testBoard(
    mocks.user,
    WORLD,
    testView({
      roles,
      viewerGeneralId: 11,
      ownNationId: 1,
      throne: { emperorGeneralId: null, emperorNationId: null, sinceTick: 0 },
      ascend: { allowed: true },
    }),
  );

it('T4-95 AC-P2-32 다시 읽은 장수가 바뀌면 같은 계정이어도 열린 확인 대화상자를 버리고 보내지 않는다', async () => {
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  expect(screen.getByRole('dialog', { name: '즉위 요청' })).toBeTruthy();
  const reads = mocks.get.mock.calls.length;
  mocks.get.mockImplementation(async () => successor());
  act(() => void window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(reads + 1));
  await screen.findByText('장수가 바뀌었습니다. 화면을 다시 확인하세요.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 보내기 직전 다시 읽은 장수가 대화상자를 연 장수와 다르면 요청·탭 기록을 만들지 않는다', async () => {
  mount();
  const [opener] = await screen.findAllByRole('button', { name: '즉위 요청' });
  fireEvent.click(opener!);
  mocks.get.mockImplementation(async () => successor());
  fireEvent.click(screen.getByRole('button', { name: '즉위 요청 보내기' }));
  await screen.findByText('장수가 바뀌었습니다. 화면을 다시 확인하세요. 요청을 보내지 않았습니다.');
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readGovernancePending(sessionStorage, key())).toBeNull();
});

// 이전 장수(10) 명의로 저장한 미확인 요청. 지금 board의 장수는 successor()의 11이다.
const oldRequest = { requestId, generalId: 10, payload: { type: 'court.resign' as const } };

it('T4-95 AC-P2-32 같은 장수의 미확인(404) 요청은 지우기 없이 같은 번호·장수로만 다시 접수한다', async () => {
  writeGovernancePending(sessionStorage, key(), oldRequest);
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  const resubmit = await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull();
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);

  mocks.submit.mockResolvedValueOnce({ userId: mocks.user, requestId, status: 'pending' });
  fireEvent.click(resubmit);
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  expect(mocks.submit.mock.calls[0]![0]).toEqual({
    worldId: WORLD,
    expectedUserId: mocks.user,
    expectedGeneralId: 10,
    requestId,
    payload: { type: 'court.resign' },
  });
  // 재접수 뒤에도 기록의 장수·번호는 바뀌지 않는다.
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);
});

it('T4-95 AC-P2-32 장수가 바뀐 뒤 404인 이전 장수 요청은 다시 접수하지 않고, 새 보기·새 접수 조회를 거쳐 손으로만 지운다', async () => {
  writeGovernancePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => successor());
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  expect(screen.queryByRole('button', { name: '같은 요청 다시 접수' })).toBeNull();
  expect(screen.getByText(/이전 장수\(황제\) 명의로 보냈습니다/)).toBeTruthy();
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);

  const reads = mocks.get.mock.calls.length,
    receipts = mocks.request.mock.calls.length;
  fireEvent.click(clear);
  await screen.findByText(OLD_REQUEST_CLEARED);
  expect(mocks.get).toHaveBeenCalledTimes(reads + 1);
  expect(mocks.request).toHaveBeenCalledTimes(receipts + 1);
  expect(mocks.request.mock.calls.at(-1)![0]).toEqual({ worldId: WORLD, requestId });
  expect(readGovernancePending(sessionStorage, key())).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기를 누른 뒤 새 보기의 장수가 요청 장수와 같으면 지우지 않고 접수 조회도 하지 않는다', async () => {
  writeGovernancePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => successor());
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  const receipts = mocks.request.mock.calls.length;
  mocks.get.mockImplementation(async () => ascendable());
  fireEvent.click(clear);
  await screen.findByText(/달라졌음을 확인하지 못해 기록을 지우지 않았습니다/);
  expect(mocks.request).toHaveBeenCalledTimes(receipts);
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기 확인 중 연결·인증 오류면 기록을 그대로 둔다', async () => {
  writeGovernancePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => successor());
  mocks.request.mockRejectedValueOnce(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  mocks.request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  fireEvent.click(clear);
  await screen.findByText(OLD_REQUEST_KEPT);
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);

  mocks.request.mockRejectedValueOnce(refused('UNAUTHORIZED'));
  fireEvent.click(await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' }));
  await screen.findByText('거부 UNAUTHORIZED');
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기 확인에서 접수 기록이 보이면 지우지 않고 그 결과를 끝까지 확인한다', async () => {
  writeGovernancePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => successor());
  mocks.request.mockRejectedValueOnce(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  mocks.request.mockResolvedValue({ userId: mocks.user, requestId, status: 'pending' });
  fireEvent.click(clear);
  await waitFor(() => expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull());
  expect(screen.queryByText(OLD_REQUEST_CLEARED)).toBeNull();
  expect(readGovernancePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 장수 id가 없는 예전 기록은 장수 비교 없이 예전처럼 같은 번호로만 다시 접수한다', async () => {
  writeGovernancePending(sessionStorage, key(), { requestId, payload: { type: 'court.resign' } });
  mocks.get.mockImplementation(async () => successor());
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  const resubmit = await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull();
  mocks.submit.mockResolvedValueOnce({ userId: mocks.user, requestId, status: 'pending' });
  fireEvent.click(resubmit);
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  expect(mocks.submit.mock.calls[0]![0]).toEqual({
    worldId: WORLD,
    expectedUserId: mocks.user,
    requestId,
    payload: { type: 'court.resign' },
  });
  expect(Object.hasOwn(mocks.submit.mock.calls[0]![0] as object, 'expectedGeneralId')).toBe(false);
});

it('T4-94 AC-P2-31 다른 계정의 저장 요청은 읽지 않는다', async () => {
  writeGovernancePending(sessionStorage, governanceStorageKey('22222222-2222-4222-8222-222222222222', WORLD), {
    requestId,
    payload: { type: 'court.resign' },
  });
  mount();
  await screen.findAllByRole('button', { name: '즉위 요청' });
  expect(screen.queryByText(/요청 처리 대기/)).toBeNull();
  expect(mocks.request).not.toHaveBeenCalled();
});
