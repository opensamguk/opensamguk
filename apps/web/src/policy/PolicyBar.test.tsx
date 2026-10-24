// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createRootRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TRPCProvider, useTRPC } from '../trpc';
import type { HomePolicy, PolicyResponse, SetPolicyOutcome } from './types';
import { PolicyBar } from './PolicyBar';

afterEach(cleanup);

// AppRouter 출력 모양의 가짜 응답. 가짜 링크라 실제 API 증거가 아니다.
const base = {
  current: 'farm',
  pending: null,
  lastRejected: null,
  options: [
    { key: 'farm', name: '권농', emptyCommand: { key: 'farm', name: '농지 개간' }, thenCommand: null },
    {
      key: 'drill',
      name: '훈련',
      emptyCommand: { key: 'train', name: '훈련' },
      thenCommand: { key: 'morale', name: '사기진작' },
    },
    { key: 'none', name: '없음', emptyCommand: { key: 'rest', name: '휴식' }, thenCommand: null },
  ],
  inactiveAfterDays: 14,
} satisfies PolicyResponse;

type Calls = Record<string, number>;

// home.get은 장수 정보 칸의 방침 이름만 쓰는 시험이라 그 칸만 돌려준다. turns.get은 부르면 안 되는 경로로 센다.
function fakeServer(handlers: {
  policy: () => PolicyResponse;
  setPolicy?: (policy: string) => SetPolicyOutcome | Error;
  homePolicy?: () => HomePolicy;
}) {
  const calls: Calls = {};
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls[op.path] = (calls[op.path] ?? 0) + 1;
        let result: unknown;
        if (op.path === 'general.policy') result = handlers.policy();
        else if (op.path === 'general.setPolicy')
          result = handlers.setPolicy?.((op.input as { policy: string }).policy) ?? { status: 'pending' };
        else if (op.path === 'home.get' && handlers.homePolicy) result = { general: { policy: handlers.homePolicy() } };
        else result = new Error(`unexpected ${op.path}`);
        if (result instanceof Error) observer.error(TRPCClientError.from(result));
        else {
          observer.next({ result: { type: 'data', data: result } });
          observer.complete();
        }
      });
  return { client: createTRPCClient<AppRouter>({ links: [link] }), calls };
}

function conflict(): Error {
  return new TRPCClientError('x', { result: { error: { data: { code: 'CONFLICT' } } } } as never);
}

// 메인처럼 장수 정보 칸이 home.get을 관찰한다. 주기 조회는 끈다.
function HomePolicyName({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const home = useQuery({ ...trpc.home.get.queryOptions({ worldId }), staleTime: Infinity });
  return <p data-testid="home-policy">{home.data?.general.policy.name ?? ''}</p>;
}

async function renderBar(client: ReturnType<typeof fakeServer>['client'], withHome = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <PolicyBar worldId="w1" />
          {withHome ? <HomePolicyName worldId="w1" /> : null}
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
  it('지금 방침과 빈 칸이 할 일, 응답 날 수의 미접속 안내를 보여 준다', async () => {
    await renderBar(fakeServer({ policy: () => base }).client);
    expect(await screen.findByLabelText('기본 방침')).toHaveProperty('value', 'farm');
    expect(screen.getByTestId('policy-sentence').textContent).toBe('빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다.');
    expect(screen.getByTestId('policy-inactive').textContent).toBe(
      '정지한 시간을 빼고 월드 시간으로 14일 넘게 들어오지 않아도 직접 넣은 명령과 휴식은 그대로 하고 빈 칸만 기본 방침대로 합니다.',
    );
  });

  it('applied를 받으면 바로 확정한다', async () => {
    let state: PolicyResponse = base;
    await renderBar(
      fakeServer({
        policy: () => state,
        setPolicy: (policy) => {
          const option = base.options.find((entry) => entry.key === policy)!;
          state = { ...base, current: option.key };
          return { status: 'applied', policy: state };
        },
      }).client,
    );
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'drill' } }));
    expect(await screen.findByText('바꿨습니다')).toBeTruthy();
    expect(screen.getByTestId('policy-sentence').textContent).toBe(
      '빈 칸은 훈련을 합니다. 이미 최대면 사기진작을 합니다. 실패하면 휴식합니다.',
    );
  });

  it('pending이면 처리 중으로 두고 고르기를 막는다. 빈 칸은 확정 전까지 옛 방침을 따른다', async () => {
    let state: PolicyResponse = base;
    await renderBar(
      fakeServer({
        policy: () => state,
        setPolicy: (policy) => {
          state = { ...base, pending: base.options.find((entry) => entry.key === policy)!.key };
          return { status: 'pending' };
        },
      }).client,
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

  it('엔진이 거절하면 엔진 문장을 보이고 고르기 칸을 지금 방침으로 되돌린다', async () => {
    await renderBar(
      fakeServer({ policy: () => ({ ...base, lastRejected: { policy: 'drill', reason: 'WORLD_CLOSED' } }) }).client,
    );
    expect(await screen.findByLabelText('기본 방침')).toHaveProperty('value', 'farm');
    expect(screen.getByTestId('policy-rejected').textContent).toBe('훈련으로 바꾸지 못했습니다. 종료된 월드입니다.');
    expect(screen.getByTestId('policy-rejected').textContent).not.toContain('WORLD_CLOSED');
  });

  it('고른 방침이 current와 같아도 가장 최근 입력이 거절됐으면 거절 문장만 보이고 성공 문구는 없다', async () => {
    let state: PolicyResponse = base;
    const server = fakeServer({
      policy: () => state,
      setPolicy: () => {
        state = { ...base, pending: 'drill' };
        return { status: 'pending' };
      },
    });
    const queryClient = await renderBar(server.client);
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'drill' } }));
    expect(await screen.findByText('처리 중')).toBeTruthy();

    // 다시 읽은 응답의 current는 고른 값과 같지만 가장 최근 입력은 거절됐다.
    state = { ...base, current: 'drill', lastRejected: { policy: 'drill', reason: 'WORLD_CLOSED' } };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: [['general', 'policy']] });
    });
    expect((await screen.findByTestId('policy-rejected')).textContent).toBe(
      '훈련으로 바꾸지 못했습니다. 종료된 월드입니다.',
    );
    expect(screen.getByTestId('policy-state').textContent).toBe('');
    expect(screen.queryByText('바꿨습니다')).toBeNull();
    expect(select).toHaveProperty('value', 'drill');
  });

  it('모르는 거절 코드는 일반 실패 문장만 보인다', async () => {
    await renderBar(
      fakeServer({ policy: () => ({ ...base, lastRejected: { policy: 'drill', reason: 'NEW_CODE' } }) }).client,
    );
    expect((await screen.findByTestId('policy-rejected')).textContent).toBe('방침을 바꾸지 못했습니다.');
  });

  it('다른 방침을 처리 중이라 CONFLICT가 오면 안내한다', async () => {
    await renderBar(fakeServer({ policy: () => base, setPolicy: () => conflict() }).client);
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'none' } }));
    expect((await screen.findByRole('alert')).textContent).toContain('처리된 뒤에 다시 고르세요');
    expect(select).toHaveProperty('value', 'farm');
  });

  it('서버가 주지 않은 값은 보내지 않는다', async () => {
    const server = fakeServer({ policy: () => base });
    await renderBar(server.client);
    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'security' } }));
    expect(server.calls['general.setPolicy']).toBeUndefined();
  });
});

describe('장수 정보 칸의 방침 이름', () => {
  it('pending 뒤 다시 읽은 current가 바뀐 그때 home.get을 한 번만 다시 읽고 예턴 캐시는 건드리지 않는다', async () => {
    let state: PolicyResponse = base;
    let home: HomePolicy = { key: 'farm', name: '권농' };
    const server = fakeServer({
      policy: () => state,
      setPolicy: () => {
        state = { ...base, pending: 'drill' };
        return { status: 'pending' };
      },
      homePolicy: () => home,
    });
    const queryClient = await renderBar(server.client, true);
    const turnsKey = ['turns-cache-sentinel'];
    queryClient.setQueryData(turnsKey, { revision: 7 });
    expect((await screen.findByTestId('home-policy')).textContent).toBe('권농');
    expect(server.calls['home.get']).toBe(1);

    const select = await screen.findByLabelText('기본 방침');
    await act(async () => fireEvent.change(select, { target: { value: 'drill' } }));
    expect(await screen.findByText('처리 중')).toBeTruthy();
    // 접수만 됐을 때는 확정된 방침이 그대로라 home.get을 다시 읽지 않는다.
    expect(server.calls['home.get']).toBe(1);

    // 엔진이 나중에 적용했다. 다시 읽기(주기 조회와 같은 경로)가 바뀐 current를 받는다.
    state = { ...base, current: 'drill' };
    home = { key: 'drill', name: '훈련' };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: [['general', 'policy']] });
    });
    expect(await screen.findByText('바꿨습니다')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-policy').textContent).toBe('훈련'));
    expect(server.calls['home.get']).toBe(2);

    // current가 그대로인 다시 읽기는 home.get을 부르지 않는다.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: [['general', 'policy']] });
    });
    expect(server.calls['home.get']).toBe(2);
    expect(server.calls['turns.get']).toBeUndefined();
    expect(queryClient.getQueryState(turnsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(turnsKey)).toEqual({ revision: 7 });
  });
});
