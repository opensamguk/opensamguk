// @vitest-environment jsdom
import { TRPCClientError } from '@trpc/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logisticsStorageKey, readLogisticsPending, writeLogisticsPending } from '../hooks/logisticsRequestState';
import { LogisticsPanel } from './LogisticsPanel';

// 화면의 요청 수명 중 보낸 장수(계승) 경계만 본다 (T4-95, AC-P2-32). 실제 API/PG·브라우저 인수는 별도다.
const mocks = vi.hoisted(() => ({
  user: '11111111-1111-4111-8111-111111111111',
  me: vi.fn(),
  get: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../trpc', () => {
  const api = {
    auth: { me: { query: mocks.me } },
    logistics: { get: { query: mocks.get }, submit: { mutate: mocks.submit }, request: { query: mocks.request } },
  };
  return { useTRPC: () => ({}), useTRPCClient: () => api };
});
// 연월·거점 이름은 이 시험의 대상이 아니다. 비어 있으면 화면은 '—'·'거점 n'으로 그린다.
vi.mock('../game/queries', () => ({
  useWorldSummary: () => ({ data: undefined }),
  useWorldMap: () => ({ data: undefined }),
}));

const WORLD = 'world-one';
const CITY = 30;
const requestId = '12345678-1234-4234-8234-123456789abc';
// 시험용 자국 거점 board. 숫자는 시험 설정일 뿐이다. actorId만 바꿔 계승을 흉내 낸다.
const board = (actorId = 10) => ({
  userId: mocks.user,
  actorId,
  cityKey: CITY,
  visible: true,
  own: true,
  status: 'RUNNING',
  canManage: true,
  settling: false,
  tick: 0,
  revision: 1,
  specialty: null,
  resources: { level: 1, iron: 0, wood: 500, horses: 0 },
  capacity: 1000,
  used: 500,
  gold: 1000,
  recruitUnits: [],
  costs: {
    upgrade: { gold: 100, wood: 100 },
    capacity: { base: 1000, perLevel: 500, maxLevel: 5 },
    trade: { iron: { buy: 2, sell: 1 }, wood: { buy: 2, sell: 1 }, horses: { buy: 2, sell: 1 } },
    recruitPer100: {},
    build: { wall: { iron: 0, wood: 0, horses: 0 }, defence: { iron: 0, wood: 0, horses: 0 } },
    transport: { maxHops: 5, hopsPerMonth: 1, lossBpPerHop: 100, maxPerOrder: 1000, maxActivePerNation: 5 },
  },
  destinations: [],
  convoys: [],
  movements: [],
});
const upgrade = { type: 'upgrade' as const, cityKey: CITY };
// 이전 장수(10) 명의로 저장한 미확인 요청.
const oldRequest = { requestId, generalId: 10, payload: upgrade };
const refused = (code: string) =>
  TRPCClientError.from(
    { error: { message: `거부 ${code}`, code: -32000, data: { code } } },
    { meta: { response: new Response(null) } },
  );
const key = () => logisticsStorageKey(mocks.user, WORLD);
const mount = () => render(<LogisticsPanel worldId={WORLD} cityKey={CITY} />);
async function sendUpgrade() {
  fireEvent.click(await screen.findByRole('tab', { name: '창고 증축' }));
  fireEvent.click(screen.getByRole('button', { name: '증축 요청' }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.me.mockImplementation(async () => ({ user: { id: mocks.user } }));
  mocks.get.mockImplementation(async () => board());
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

it('T4-95 AC-P2-32 보내기 직전 다시 읽은 장수가 양식을 그린 장수와 다르면 요청·탭 기록을 만들지 않는다', async () => {
  mount();
  await screen.findByRole('tab', { name: '창고 증축' });
  mocks.get.mockImplementation(async () => board(11));
  await sendUpgrade();
  await screen.findByText('장수가 바뀌었습니다. 요청을 보내지 않았습니다. 화면을 다시 확인하세요.');
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readLogisticsPending(sessionStorage, key())).toBeNull();
});

it('T4-95 AC-P2-32 새 기록은 처음 장수 id를 두고 expectedGeneralId로 보내며, 같은 장수의 404 재접수도 그 값 그대로 보낸다', async () => {
  mocks.submit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  mount();
  await sendUpgrade();
  await screen.findByText(/응답을 받지 못했습니다/);
  const saved = readLogisticsPending(sessionStorage, key());
  expect(saved).toEqual({ requestId: saved!.requestId, generalId: 10, payload: upgrade });
  expect(mocks.submit.mock.calls[0]![0]).toEqual({
    worldId: WORLD,
    expectedUserId: mocks.user,
    expectedGeneralId: 10,
    requestId: saved!.requestId,
    payload: upgrade,
  });

  mocks.request.mockRejectedValueOnce(refused('NOT_FOUND'));
  fireEvent.click(screen.getByRole('button', { name: '같은 요청 상태 확인' }));
  const resubmit = await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull();
  expect(readLogisticsPending(sessionStorage, key())).toEqual(saved);

  mocks.submit.mockResolvedValueOnce({ userId: mocks.user, requestId: saved!.requestId, status: 'pending' });
  mocks.request.mockResolvedValueOnce({
    userId: mocks.user,
    requestId: saved!.requestId,
    status: 'applied',
    result: { action: 'upgrade', movements: [] },
  });
  fireEvent.click(resubmit);
  await screen.findByText('창고를 증축했습니다.');
  expect(mocks.submit).toHaveBeenCalledTimes(2);
  expect(mocks.submit.mock.calls[1]![0]).toEqual(mocks.submit.mock.calls[0]![0]);
  expect(readLogisticsPending(sessionStorage, key())).toBeNull();
});

it('T4-95 AC-P2-32 같은 장수의 미확인(404) 요청은 지우기 없이 막힌 채 같은 요청 재접수만 연다', async () => {
  writeLogisticsPending(sessionStorage, key(), oldRequest);
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull();
  // 결과를 받기 전에는 새 요청 단추가 막혀 있다.
  fireEvent.click(screen.getByRole('tab', { name: '창고 증축' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '증축 요청' }).disabled).toBe(true);
  expect(readLogisticsPending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 장수가 바뀐 뒤 404인 이전 장수 요청은 다시 접수하지 않고, 새 board·새 접수 조회를 거쳐 손으로만 지운다', async () => {
  writeLogisticsPending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValue(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  expect(screen.queryByRole('button', { name: '같은 요청 다시 접수' })).toBeNull();
  expect(readLogisticsPending(sessionStorage, key())).toEqual(oldRequest);

  const reads = mocks.get.mock.calls.length,
    receipts = mocks.request.mock.calls.length;
  fireEvent.click(clear);
  await screen.findByText(/접수되지 않았고 앞으로도 처리되지 않음을 확인해 이 탭의 기록을 지웠습니다/);
  expect(mocks.get).toHaveBeenCalledTimes(reads + 1);
  expect(mocks.request).toHaveBeenCalledTimes(receipts + 1);
  expect(mocks.request.mock.calls.at(-1)![0]).toEqual({ worldId: WORLD, requestId });
  expect(readLogisticsPending(sessionStorage, key())).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기 확인 중 연결 오류나 접수 기록이 보이면 기록을 그대로 둔다', async () => {
  writeLogisticsPending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValueOnce(refused('NOT_FOUND'));
  mount();
  const clear = await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' });
  mocks.request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  fireEvent.click(clear);
  await screen.findByText('이전 장수 명의 요청을 확인하지 못해 기록을 그대로 두었습니다. 다시 확인하세요.');
  expect(readLogisticsPending(sessionStorage, key())).toEqual(oldRequest);

  // 접수 기록이 있으면 지우지 않고 결과 확인을 이어 간다.
  mocks.request.mockResolvedValue({ userId: mocks.user, requestId, status: 'pending' });
  fireEvent.click(await screen.findByRole('button', { name: '이전 장수 요청 기록 지우기' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '이전 장수 요청 기록 지우기' })).toBeNull());
  expect(screen.queryByText(/이 탭의 기록을 지웠습니다/)).toBeNull();
  expect(readLogisticsPending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});
