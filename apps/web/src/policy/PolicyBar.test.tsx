// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TRPCProvider } from '../trpc';
import type { PolicyResponse, SetPolicyOutcome } from './contract';
import { PolicyBar } from './PolicyBar';

afterEach(cleanup);

// T2-13 계약 모양의 가짜 응답. general.policy·general.setPolicy만 답한다.
const base: PolicyResponse = {
  current: 'farm',
  pending: null,
  lastRejected: null,
  options: [
    { key: 'farm', name: '권농', emptyCommand: { key: 'farm', name: '농지 개간' }, thenCommand: null },
    {
      key: 'drill',
      name: '훈련',
      emptyCommand: { key: 'train', name: '훈련' },
      thenCommand: { key: 'boost', name: '사기진작' },
    },
    { key: 'none', name: '없음', emptyCommand: { key: 'rest', name: '휴식' }, thenCommand: null },
  ],
  inactiveAfterDays: 14,
};

function fakeServer(handlers: {
  policy: () => PolicyResponse;
  setPolicy?: (policy: string) => SetPolicyOutcome | Error;
}) {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        let result: unknown;
        if (op.path === 'general.policy') result = handlers.policy();
        else if (op.path === 'general.setPolicy')
          result = handlers.setPolicy?.((op.input as { policy: string }).policy) ?? { status: 'pending' };
        else result = new Error(`unexpected ${op.path}`);
        if (result instanceof Error) observer.error(TRPCClientError.from(result));
        else {
          observer.next({ result: { type: 'data', data: result } });
          observer.complete();
        }
      });
  return createTRPCClient<AppRouter>({ links: [link] });
}

function conflict(): Error {
  return new TRPCClientError('x', { result: { error: { data: { code: 'CONFLICT' } } } } as never);
}

async function renderBar(client: ReturnType<typeof fakeServer>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <PolicyBar worldId="w1" />
        </TRPCProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory() });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return queryClient;
}

describe('기본 방침 고르기', () => {
  it('지금 방침과 빈 칸이 할 일을 보여 준다', async () => {
    await renderBar(fakeServer({ policy: () => base }));
    expect(await screen.findByLabelText('기본 방침')).toHaveProperty('value', 'farm');
    expect(screen.getByTestId('policy-sentence').textContent).toBe('빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다.');
  });

  it('applied를 받으면 바로 확정한다', async () => {
    let state = base;
    await renderBar(
      fakeServer({
        policy: () => state,
        setPolicy: (policy) => {
          state = { ...base, current: policy as PolicyResponse['current'] };
          return { status: 'applied', policy: state };
        },
      }),
    );
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'drill' } }));
    expect(await screen.findByText('바꿨습니다')).toBeTruthy();
    expect(screen.getByTestId('policy-sentence').textContent).toBe(
      '빈 칸은 훈련을 합니다. 이미 최대면 사기진작을 합니다. 실패하면 휴식합니다.',
    );
  });

  it('pending이면 처리 중으로 두고 고르기를 막는다. 빈 칸은 확정 전까지 옛 방침을 따른다', async () => {
    let state = base;
    await renderBar(
      fakeServer({
        policy: () => state,
        setPolicy: (policy) => {
          state = { ...base, pending: policy as PolicyResponse['current'] };
          return { status: 'pending' };
        },
      }),
    );
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'drill' } }));
    expect(await screen.findByText('처리 중')).toBeTruthy();
    expect(select).toHaveProperty('value', 'drill');
    expect(select).toHaveProperty('disabled', true);
    expect(screen.getByTestId('policy-sentence').textContent).toBe(
      '빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다. 엔진이 처리하면 훈련으로 바뀝니다.',
    );
  });

  it('거절되면 이유를 보이고 고르기 칸을 지금 방침으로 되돌린다', async () => {
    await renderBar(
      fakeServer({ policy: () => ({ ...base, lastRejected: { policy: 'drill', reason: '제재 중인 계정입니다.' } }) }),
    );
    expect(await screen.findByLabelText('기본 방침')).toHaveProperty('value', 'farm');
    expect(screen.getByTestId('policy-rejected').textContent).toBe('훈련으로 바꾸지 못했습니다. 제재 중인 계정입니다.');
  });

  it('다른 방침을 처리 중이라 CONFLICT가 오면 안내한다', async () => {
    await renderBar(fakeServer({ policy: () => base, setPolicy: () => conflict() }));
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'none' } }));
    expect((await screen.findByRole('alert')).textContent).toContain('처리된 뒤에 다시 고르세요');
    expect(select).toHaveProperty('value', 'farm');
  });
});
