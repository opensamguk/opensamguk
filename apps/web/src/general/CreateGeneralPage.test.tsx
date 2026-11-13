// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateGeneralPage } from './CreateGeneralPage';

// 생성 화면의 성별 칸(T4-95)과 유산 칸(T4-96)만 본다. 판정은 서버 general.create가 하며 실제 HTTP·브라우저 인수는 별도다.
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const mocks = vi.hoisted(() => ({
  lineage: true,
  heritageBalance: null as number | null,
  userId: '',
  create: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ worldId: 'world-one' }),
  useNavigate: () => () => undefined,
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('../trpc', () => ({
  useTRPC: () => ({
    general: {
      mine: {
        queryKey: () => ['mine'],
        queryOptions: () => ({
          queryKey: ['mine'],
          queryFn: async () => ({
            general: null,
            creation: null,
            creationRules: {
              total: 165,
              min: 15,
              max: 80,
              count: 3,
              campaignEnabled: false,
              ...(mocks.lineage ? { lineageEnabled: true } : {}),
              ...(mocks.heritageBalance === null
                ? {}
                : {
                    heritage: {
                      version: 1,
                      userId: mocks.userId,
                      balance: mocks.heritageBalance,
                      perStat: 3,
                      perGeneral: 6,
                    },
                  }),
            },
          }),
        }),
      },
      create: { mutationOptions: () => ({ mutationFn: mocks.create }) },
    },
    account: {
      get: {
        queryOptions: () => ({
          queryKey: ['account'],
          queryFn: async () => ({ userId: mocks.userId, portraitId: null }),
        }),
      },
      setPortrait: { mutationOptions: () => ({}) },
    },
    home: { get: { queryKey: () => ['home'] } },
    // 머리의 서버 정보 한 줄 (INT-25 단계 3).
    world: {
      summary: {
        queryOptions: () => ({
          queryKey: ['summary'],
          queryFn: async () => ({ status: 'RUNNING', gameDate: { year: 190, month: 3 }, turnTermMinutes: 10 }),
        }),
      },
    },
    lobby: {
      worlds: {
        queryOptions: () => ({
          queryKey: ['worlds'],
          queryFn: async () => [
            { id: 'world-two', humanGenerals: 9 },
            { id: 'world-one', humanGenerals: 4 },
          ],
        }),
      },
    },
  }),
}));

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CreateGeneralPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lineage = true;
  mocks.heritageBalance = null;
  mocks.userId = USER_A;
  // 결과는 보지 않는다. 보낸 입력만 확인한다.
  mocks.create.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});

it('INT-25 AC-INT-25 머리에 재야 시작 안내와 이 월드의 연월·턴 간격·사람 장수 수를 보이고 지도는 접어 둔다', async () => {
  mount();
  expect(await screen.findByTestId('create-world-status')).toHaveProperty(
    'textContent',
    '지금 190년 3월 · 턴 10분 · 사람 장수 4명',
  );
  expect(screen.getByText('무작위 도시에서 재야로 시작합니다. 임관과 건국은 들어간 뒤 명령으로 합니다.')).toBeTruthy();
  const glance = screen.getByText('지금 세력 지도').closest('details');
  expect(glance?.open).toBe(false);
  // 접어 둔 동안은 world.map을 받지 않는다(모의 클라이언트에 world.map이 없다).
  expect(screen.queryByTestId('world-map')).toBeNull();
});

it('T4-95 AC-P2-32 가문 월드는 기본 선택 없는 성별 칸을 보이고 고르기 전에는 보내지 않는다', async () => {
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  const group = screen.getByRole('group', { name: '성별 (필수)' });
  const [male, female] = screen.getAllByRole<HTMLInputElement>('radio', { name: /^(남|여)$/ });
  expect(group.contains(male!)).toBe(true);
  expect([male!.checked, female!.checked]).toEqual([false, false]);
  expect(screen.queryByRole('radio', { name: '미상' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ }));
  expect(screen.getAllByText('성별을 선택하세요.').length).toBeGreaterThan(0);
  expect(mocks.create).not.toHaveBeenCalled();

  fireEvent.click(female!);
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({ worldId: 'world-one', name: '서윤', sex: 'FEMALE' });
});

it('T4-95 AC-P2-32 가문을 끈 월드에는 성별 칸이 없고 sex 키도 보내지 않는다', async () => {
  mocks.lineage = false;
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  expect(screen.queryByRole('group', { name: '성별 (필수)' })).toBeNull();
  expect(screen.queryByRole('group', { name: '유산 능력치 (선택)' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('sex');
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('heritage');
  // 유산을 끈 월드는 예전 payload 그대로다.
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('expectedUserId');
});

it('T4-96 AC-P2-33 유산 월드는 0으로 시작하고 쓰지 않으면 heritage 키를 보내지 않는다', async () => {
  mocks.lineage = false;
  mocks.heritageBalance = 4;
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  expect(screen.getByRole('group', { name: '유산 능력치 (선택)' })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '통솔 유산 줄이기' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('heritage');
});

it('T4-96 AC-P2-33 유산 배분은 0이 아닌 키만 보내고 기본 능력치는 그대로 보낸다', async () => {
  mocks.lineage = false;
  mocks.heritageBalance = 4;
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  const up = screen.getByRole('button', { name: '통솔 유산 늘리기' });
  fireEvent.click(up);
  fireEvent.click(up);
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기 (유산 2점 사용)' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  const sent = mocks.create.mock.calls[0]![0];
  expect(sent).toMatchObject({ leadership: 55, strength: 55, intel: 55, expectedUserId: USER_A });
  expect(sent.heritage).toEqual({ leadership: 2 });
});

it('T4-96 AC-P2-33 다시 읽은 계정이 바뀌면 이전 계정의 입력·배분을 지우고 새 계정으로 다시 시작하며 보내지 않는다', async () => {
  mocks.lineage = false;
  mocks.heritageBalance = 4;
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));
  expect(screen.getByRole('button', { name: '장수 만들기 (유산 2점 사용)' })).toBeTruthy();

  // 다른 탭에서 계정을 바꾼 뒤 창으로 돌아와 general.mine을 다시 읽은 상황이다.
  mocks.userId = USER_B;
  mocks.heritageBalance = 6;
  await act(async () => {
    await clients[0]!.refetchQueries({ queryKey: ['mine'] });
  });

  const notice = await screen.findByRole('alert');
  expect(notice.textContent).toContain('계정이 바뀌어 이전 계정에서 넣은 입력과 유산 배분을 지웠습니다.');
  await waitFor(() => expect(document.activeElement).toBe(notice));
  expect(screen.getByLabelText<HTMLInputElement>('이름').value).toBe('');
  expect(screen.queryByText('+2')).toBeNull();
  expect(screen.queryByRole('button', { name: /유산 2점 사용/ })).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();

  // 새 계정으로 다시 넣으면 새 계정 UUID로 보내고 이전 배분은 따라오지 않는다.
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '서윤' } });
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  const sent = mocks.create.mock.calls[0]![0];
  expect(sent.expectedUserId).toBe(USER_B);
  expect(sent).not.toHaveProperty('heritage');
});

it('T4-96 AC-P2-33 다시 읽기 전에 누른 이전 입력은 처음 계정 UUID로만 보내고 계정 변경 거절 뒤 다시 보내지 않는다', async () => {
  mocks.lineage = false;
  mocks.heritageBalance = 4;
  mocks.create.mockRejectedValueOnce(
    new TRPCClientError('계정이 바뀌었습니다. 현재 계정으로 다시 확인하세요.', {
      result: { error: { data: { code: 'CONFLICT' } } },
    } as never),
  );
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));

  // 세션은 이미 B인데 화면은 아직 A의 creationRules를 들고 있다.
  mocks.userId = USER_B;
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기 (유산 2점 사용)' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({ expectedUserId: USER_A, heritage: { leadership: 2 } });

  // 거절 뒤 다시 읽어 B가 오면 A의 입력은 B에 옮기지 않고 지운다.
  // 다시 읽기 전에는 서버 거절 문구도 alert로 보이므로 안내 문장으로 찾는다.
  await screen.findByText(/^계정이 바뀌어 이전 계정에서 넣은 입력과 유산 배분을 지웠습니다\./);
  expect(screen.queryByText('계정이 바뀌었습니다. 현재 계정으로 다시 확인하세요.')).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>('이름').value).toBe('');
  expect(screen.queryByText('+2')).toBeNull();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it('T4-96 AC-P2-33 잔액 부족 거절은 배분을 두고 다시 보내지 않으며 잔액을 직접 다시 확인해야 제출 판단을 연다', async () => {
  mocks.lineage = false;
  mocks.heritageBalance = 4;
  mocks.create.mockRejectedValueOnce(
    new TRPCClientError('유산 포인트가 부족합니다.', { result: { error: { data: { code: 'CONFLICT' } } } } as never),
  );
  mount();
  fireEvent.change(await screen.findByLabelText('이름'), { target: { value: '서윤' } });
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));
  fireEvent.click(screen.getByRole('button', { name: '통솔 유산 늘리기' }));
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기 (유산 2점 사용)' }));

  const refresh = await screen.findByRole('button', { name: '잔액 다시 확인' });
  expect(screen.getByRole('alert').textContent).toContain('유산 포인트가 부족합니다.');
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect(screen.getByRole('button', { name: /^장수 만들기 \(유산 2점 사용\)\s*\(사용 불가\)$/ })).toBeTruthy();
  expect(screen.getByText('+2')).toBeTruthy();

  mocks.heritageBalance = 1;
  fireEvent.click(refresh);
  await screen.findByText('잔액을 다시 확인했습니다. 보유 1점.');
  // 배분을 줄이지 않고 문제로만 막는다.
  expect(screen.getByText('+2')).toBeTruthy();
  expect(screen.getAllByText('유산 배분은 2점이고 보유는 1점입니다. 1점 줄이세요.').length).toBeGreaterThan(0);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
