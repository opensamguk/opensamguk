// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NationInfo } from '../main/NationInfo';
import { GovernancePanel } from './GovernancePanel';
import { governanceStorageKey, readGovernancePending, writeGovernancePending } from './governanceRequestState';
import { testBoard, testView } from './testView';

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
// 재야 NationInfo는 공지 칸을 그리지 않는다. 공지 모듈은 실제 tRPC 클라이언트를 읽으므로 빈 칸으로 바꾼다.
vi.mock('../messages/NationNotice', () => ({ NationNoticeBox: () => null }));

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
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit.mock.calls[0]![0]).toEqual({
    worldId: WORLD,
    expectedUserId: mocks.user,
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

it('T4-94 AC-P2-31 재야 장수도 재야 안내 아래에서 공개 황실 칸을 보고, 기능을 끈 월드면 묻지 않는다', async () => {
  const neutral = () =>
    testBoard(mocks.user, WORLD, testView({ viewerGeneralId: 30, ownNationId: null, realmNationId: null }));
  mocks.get.mockImplementation(async () => neutral());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <NationInfo worldId={WORLD} nation={null} cities={[]} onSelectCity={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.getByText('재야입니다')).toBeTruthy();
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
      <NationInfo worldId={WORLD} nation={null} cities={[]} onSelectCity={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.getByText('재야입니다')).toBeTruthy();
  await waitFor(() => expect(off.getQueryData(['summary'])).toBeDefined());
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '황실' })).toBeNull();
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
