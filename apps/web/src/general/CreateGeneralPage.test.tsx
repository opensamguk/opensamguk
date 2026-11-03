// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateGeneralPage } from './CreateGeneralPage';

// 생성 화면의 성별 칸만 본다(T4-95). 판정은 서버 general.create가 하며 실제 HTTP·브라우저 인수는 별도다.
const mocks = vi.hoisted(() => ({ lineage: true, create: vi.fn() }));
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
            },
          }),
        }),
      },
      create: { mutationOptions: () => ({ mutationFn: mocks.create }) },
    },
    home: { get: { queryKey: () => ['home'] } },
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
  // 결과는 보지 않는다. 보낸 입력만 확인한다.
  mocks.create.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
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
  fireEvent.click(screen.getByRole('button', { name: '장수 만들기' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('sex');
});
