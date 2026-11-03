// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LineagePanel } from './LineagePanel';
import type { LineageBoard, LineageMine, LineageSex } from './lineageModel';
import { lineageStorageKey, readLineagePending, writeLineagePending } from './lineageRequestState';
import { OLD_REQUEST_CLEARED, OLD_REQUEST_KEPT } from './useLineageBoard';

// 화면의 요청 수명과 신원 전환(계승) 경계만 본다. 실제 API/PG·브라우저 인수는 별도다. 인물·수치는 시험 값이다.
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  enabled: true,
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
              ? { lineageEnabled: true, startYear: 190, msPerTick: 6, turnTermMinutes: 1 }
              : { startYear: 190, msPerTick: 6, turnTermMinutes: 1 },
        }),
      },
    },
  };
  const api = {
    auth: { me: { query: mocks.me } },
    lineage: { get: { query: mocks.get }, submit: { mutate: mocks.submit }, request: { query: mocks.request } },
  };
  return { useTRPC: () => options, useTRPCClient: () => api };
});

const WORLD = 'world-one';
const requestId = '12345678-1234-4234-8234-123456789abc';
const preview = {
  heirId: 11,
  officerLevel: 12,
  gold: 300,
  rice: 200,
  crew: 0,
  unitIds: [],
  keptRetinue: [],
  releasedRetinue: [],
  cancelledOrders: [],
  cancelledOffers: [],
  governance: { throne: false, courtOffice: null, vassalIds: [] },
};
const person = (id: number, name: string, sex: LineageSex, parents: number[] = []) => ({
  id,
  name,
  portraitId: null,
  nationId: 1,
  cityKey: 7,
  sex,
  isHuman: id === 10,
  activeFromYear: 170,
  age: 20,
  active: true,
  officerLevel: id === 10 ? 12 : 1,
  parents,
  bornTick: parents.length ? 0 : null,
  successorId: null,
  exit: null,
});
function board(actorId: number, mine: Partial<LineageMine> = {}): LineageBoard {
  return {
    userId: ACCOUNT,
    worldId: WORLD,
    status: 'RUNNING',
    tick: 0,
    settling: false,
    canSubmit: true,
    view: {
      actorId,
      focusId: actorId,
      year: 190,
      startYear: 190,
      cities: [{ cityKey: 7, name: '낙양' }],
      people: [
        person(10, '서윤', 'FEMALE'),
        person(11, '후계', 'MALE', [10, 12]),
        person(12, '도겸', 'MALE'),
        person(13, '무명', 'UNKNOWN'),
      ],
      nations: [{ id: 1, name: '담국', color: '#336699', vacant: false }],
      marriages: [],
      mine: {
        generalId: actorId,
        active: true,
        heirId: null,
        marriageCandidates: [
          { generalId: 12, failure: null },
          {
            generalId: 13,
            failure: { ok: false, code: 'SEX_UNKNOWN', message: '성별 자료가 확인된 장수끼리 혼인할 수 있습니다.' },
          },
        ],
        heirCandidates: [],
        offers: [],
        preview: null,
        previewFailure: null,
        claim: null,
        ...mine,
      },
    },
  };
}
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <LineagePanel worldId={WORLD} />
    </QueryClientProvider>,
  );
  return client;
}
const key = () => lineageStorageKey(ACCOUNT, WORLD);
async function openProposal() {
  fireEvent.click(await screen.findByRole('tab', { name: '혼인' }));
  fireEvent.click(screen.getByRole('button', { name: '혼인 제안' }));
  return screen.getByRole('dialog', { name: '혼인 제안' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.me.mockImplementation(async () => ({ user: { id: ACCOUNT } }));
  mocks.get.mockImplementation(async () => board(10));
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  sessionStorage.clear();
});

it('T4-95 AC-P2-32 가문 기능을 끈 월드는 조회하지 않고 칸도 그리지 않는다', async () => {
  mocks.enabled = false;
  const client = mount();
  await waitFor(() => expect(client.getQueryData(['summary'])).toBeDefined());
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '가문' })).toBeNull();
});

it('T4-95 AC-P2-32 혼인 제안 확인창은 가주 문구를 보이고 Escape로 닫으면 보내지 않는다', async () => {
  mount();
  const dialog = await openProposal();
  expect(dialog.textContent).toContain('자녀는 출생 때 가주(제안한 장수 서윤)의 국가·도시를 따르고');
  // 상대가 NPC면 사람 동의 문구 없이 즉시 판정만 적는다(people[].isHuman).
  expect(dialog.textContent).toContain('도겸은(는) NPC입니다.');
  expect(dialog.textContent).not.toContain('직접 수락해야');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
  // 성별 미상 후보는 화면이 거르지 않고 서버 사유와 함께 남는다.
  expect(screen.getByText('성별 자료가 확인된 장수끼리 혼인할 수 있습니다.')).toBeTruthy();
});

// 다른 국가 장수처럼 서버가 세부 칸(나이·도시·직책·사람 여부·등장 연도·초상)을 주지 않은 인물.
const hidden = (id: number, name: string, sex: LineageSex) => ({
  id,
  name,
  nationId: 2,
  sex,
  active: true,
  parents: [],
  bornTick: null,
  successorId: null,
  exit: null,
});

it('T4-95 AC-P2-32 사람 여부·나이가 빠진 상대는 NPC로 짐작하지 않고 두 경우 문구를 보이며 나이를 그리지 않는다', async () => {
  mocks.get.mockImplementation(async () => {
    const value = board(10);
    value.view.people = value.view.people.map((row) => (row.id === 12 ? hidden(12, '도겸', 'MALE') : row));
    return value;
  });
  mount();
  const dialog = await openProposal();
  expect(dialog.textContent).toContain('처리할 때 도겸이(가) 사람 장수면 제안이 가고 직접 수락해야 혼인합니다.');
  expect(dialog.textContent).toContain('NPC면 소속·친화 조건으로 바로 판정합니다.');
  expect(dialog.textContent).not.toContain('도겸은(는) NPC입니다.');
  expect(dialog.textContent).not.toContain('도겸은(는) 사람 장수입니다.');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  const card = screen.getByRole('heading', { name: /도겸/ }).closest('article')!;
  expect(card.textContent).not.toMatch(/\d+세/);
  expect(card.textContent).not.toContain('undefined');
});

it('T4-95 AC-P2-32 받은 혼인 제안의 수락 확인창은 당사자 전용 가주 도시를 보인다', async () => {
  mocks.get.mockImplementation(async () => {
    const value = board(10, {
      offers: [{ id: 5, fromId: 12, toId: 10, expiresTick: 30, householdGeneralId: 12, householdCityKey: 7 }],
    });
    // 제안한 장수가 다른 국가라 공개 인물 칸에는 도시가 없다. 가주 도시는 offers 값에서만 온다.
    value.view.people = value.view.people.map((row) => (row.id === 12 ? hidden(12, '도겸', 'MALE') : row));
    return value;
  });
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: /제안/ }));
  expect(screen.getByText('낙양 (지금 기준, 출생 때 다시 정함)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '수락' }));
  const dialog = screen.getByRole('dialog', { name: '혼인 제안 수락' });
  expect(dialog.textContent).toContain('가주의 지금 도시: 낙양');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 다시 읽은 장수가 바뀌면(계승) 같은 계정이어도 열린 확인창을 버리고 보내지 않는다', async () => {
  mount();
  await openProposal();
  const reads = mocks.get.mock.calls.length;
  mocks.get.mockImplementation(async () => board(11));
  act(() => void window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(reads + 1));
  await screen.findByText('장수가 바뀌었습니다. 화면을 다시 확인하세요.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 보내기 직전 다시 읽기에서 장수가 바뀌었으면 요청·탭 기록을 만들지 않는다', async () => {
  mount();
  await openProposal();
  mocks.get.mockImplementation(async () => board(11));
  fireEvent.click(screen.getByRole('button', { name: '혼인 요청 보내기' }));
  await screen.findByText('장수가 바뀌었습니다. 화면을 다시 확인하세요. 요청을 보내지 않았습니다.');
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readLineagePending(sessionStorage, key())).toBeNull();
});

it('T4-95 AC-P2-32 계승 확정은 동의 체크 뒤 본 미리보기 그대로와 연 장수 id를 한 번 보내고 결과로 기록을 끝낸다', async () => {
  const designated = { heirId: 11, heirCandidates: [{ generalId: 11, failure: null }], preview };
  mocks.get.mockImplementation(async () => board(10, designated));
  mocks.submit.mockImplementation(async (input: { requestId: string }) => ({
    userId: ACCOUNT,
    requestId: input.requestId,
    status: 'pending',
  }));
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: '계승' }));
  fireEvent.click(screen.getByRole('button', { name: '계승 확정…' }));
  const send = screen.getByRole<HTMLButtonElement>('button', { name: '계승 확정 보내기' });
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '서윤은(는) 은퇴하고 되돌릴 수 없음을 확인했습니다.' }));
  mocks.request.mockImplementation(async (input: { requestId: string }) => {
    mocks.get.mockImplementation(async () => board(11));
    return {
      userId: ACCOUNT,
      requestId: input.requestId,
      status: 'applied',
      result: { action: 'succession.confirm', revision: 2, tick: 0, successorId: 11 },
    };
  });
  fireEvent.click(send);
  await screen.findByText(/계승했습니다/);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  const input = mocks.submit.mock.calls[0]![0];
  expect(input).toEqual({
    worldId: WORLD,
    expectedUserId: ACCOUNT,
    expectedGeneralId: 10,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    payload: { type: 'succession.confirm', heirGeneralId: 11, expected: preview },
  });
  expect(readLineagePending(sessionStorage, key())).toBeNull();
});

it('T4-95 AC-P2-32 계승 뒤에도 이전 장수 명의의 대기 요청은 같은 번호로 결과만 확인하고 새로 보내지 않는다', async () => {
  writeLineagePending(sessionStorage, key(), {
    requestId,
    generalId: 10,
    payload: { type: 'heir.designate', heirGeneralId: 11 },
  });
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockResolvedValue({ userId: ACCOUNT, requestId, status: 'pending' });
  mount();
  await screen.findByText(/요청 처리 대기/);
  expect(screen.getByText(/이전 장수\(서윤\) 명의로 보냈습니다/)).toBeTruthy();
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ worldId: WORLD, requestId }, expect.anything()));
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readLineagePending(sessionStorage, key())?.generalId).toBe(10);
});

// 접수 기록 없음(404)의 수동 복구. 장수가 바뀐 경우에만, 새 보기와 새 접수 조회를 모두 확인한 뒤 지운다.
const notFound = () =>
  new TRPCClientError('요청 기록이 없습니다.', {
    result: { error: { message: '요청 기록이 없습니다.', code: -32004, data: { code: 'NOT_FOUND' } } },
  });
const oldRequest = { requestId, generalId: 10, payload: { type: 'heir.designate' as const, heirGeneralId: 11 } };
const CLEAR = '이전 장수 요청 기록 지우기';
// 앞선 상태 확인이 끝나 단추가 풀린 뒤에 누른다.
async function enabled(name: string) {
  const button = await screen.findByRole<HTMLButtonElement>('button', { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

it('T4-95 AC-P2-32 장수가 바뀐 뒤 접수 기록이 없는(404) 이전 장수 요청은 다시 확인한 뒤에만 수동으로 지운다', async () => {
  writeLineagePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValue(notFound());
  mount();
  const clear = await enabled(CLEAR);
  // 지우기 전에는 기록이 그대로이고 같은 요청 다시 접수는 열지 않는다.
  expect(readLineagePending(sessionStorage, key())).toEqual(oldRequest);
  expect(screen.queryByRole('button', { name: '같은 요청 다시 접수' })).toBeNull();
  const reads = mocks.get.mock.calls.length,
    lookups = mocks.request.mock.calls.length;
  fireEvent.click(clear);
  await screen.findByText(OLD_REQUEST_CLEARED);
  expect(readLineagePending(sessionStorage, key())).toBeNull();
  // 새 보기와 새 접수 조회를 각각 한 번 더 했고, 같은 번호만 물었다.
  expect(mocks.get).toHaveBeenCalledTimes(reads + 1);
  expect(mocks.request).toHaveBeenCalledTimes(lookups + 1);
  expect(mocks.request.mock.calls.every(([input]) => input.requestId === requestId)).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(screen.queryByText(/요청 처리 대기/)).toBeNull();
});

it('T4-95 AC-P2-32 같은 장수의 접수 기록 없는(404) 요청은 지우기를 열지 않고 같은 번호를 그대로 둔다', async () => {
  writeLineagePending(sessionStorage, key(), oldRequest);
  mocks.request.mockRejectedValue(notFound());
  mount();
  await screen.findByRole('button', { name: '같은 요청 다시 접수' });
  expect(screen.queryByRole('button', { name: CLEAR })).toBeNull();
  expect(screen.getByText(/접수 기록을 아직 찾지 못했습니다/)).toBeTruthy();
  expect(readLineagePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기를 누른 뒤 새로 읽은 장수가 요청의 장수면 지우지 않고 접수 조회도 하지 않는다', async () => {
  writeLineagePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValue(notFound());
  mount();
  const clear = await enabled(CLEAR);
  const lookups = mocks.request.mock.calls.length;
  mocks.get.mockImplementation(async () => board(10));
  fireEvent.click(clear);
  await screen.findByText(/달라졌음을 확인하지 못해 기록을 지우지 않았습니다/);
  expect(mocks.request).toHaveBeenCalledTimes(lookups);
  expect(readLineagePending(sessionStorage, key())).toEqual(oldRequest);
});

it('T4-95 AC-P2-32 지우기 확인 중 연결이 끊기면 기록을 지우지 않고 다시 보내지 않는다', async () => {
  writeLineagePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValue(notFound());
  mount();
  const clear = await enabled(CLEAR);
  mocks.request.mockRejectedValue(new TRPCClientError('fetch failed'));
  fireEvent.click(clear);
  await screen.findByText(OLD_REQUEST_KEPT);
  expect(readLineagePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('T4-95 AC-P2-32 지우기 확인에서 접수 기록이 보이면 지우지 않고 그 결과를 계속 확인한다', async () => {
  writeLineagePending(sessionStorage, key(), oldRequest);
  mocks.get.mockImplementation(async () => board(11));
  mocks.request.mockRejectedValue(notFound());
  mount();
  const clear = await enabled(CLEAR);
  mocks.request.mockResolvedValue({ userId: ACCOUNT, requestId, status: 'pending' });
  fireEvent.click(clear);
  await waitFor(() => expect(screen.queryByRole('button', { name: CLEAR })).toBeNull());
  expect(screen.queryByText(OLD_REQUEST_CLEARED)).toBeNull();
  expect(readLineagePending(sessionStorage, key())).toEqual(oldRequest);
  expect(mocks.submit).not.toHaveBeenCalled();
});
