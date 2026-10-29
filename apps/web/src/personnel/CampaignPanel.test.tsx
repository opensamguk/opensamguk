// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { TRPCProvider } from '../trpc';
import { CampaignPanel } from './CampaignPanel';

type Board = inferRouterOutputs<AppRouter>['campaign']['get'];
const userId = '58abf143-1d86-4563-92a5-4673302f4c96';
const worldId = '06580bef-fc70-4faa-984d-d37c274d706a';
const base: Board = {
  revision: 1,
  status: 'RUNNING',
  actorId: 1,
  cityKey: 1,
  resources: { gold: 1000, rice: 1000 },
  renownCapacity: 100,
  renownUsed: 0,
  armyTypes: [{ id: 1100, name: '보병' }],
  npcPledge: { cost: 500, chance: 50, month: 0, attempts: [] },
  people: [
    {
      id: 2,
      name: '대상',
      portraitId: null,
      isHuman: false,
      nationId: 1,
      cityKey: 1,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
      renownCost: 10,
    },
  ],
  candidates: [2],
  links: [],
  offers: [],
  units: [],
  commanders: [{ id: 1, capacity: 5500, commanded: 0 }],
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  sessionStorage.clear();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const conflict = () =>
  TRPCClientError.from({
    error: { message: '휘하 현황을 다시 불러오세요.', code: -32000, data: { code: 'CONFLICT' } },
  });

// 실제 API 증거가 아닌 컴포넌트 단위 검사다. 실제 세션 전환 거부는 int06 HTTP 검사에 둔다.
function mount(
  answer: (read: number) => Board | Promise<Board>,
  options: { rejectMutation?: boolean; lostRequest?: boolean } = {},
) {
  let reads = 0;
  const mutations: Array<{ path: string; input: Record<string, unknown> }> = [];
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        const reply = (data: unknown) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        };
        const fail = (error: unknown) =>
          observer.error(error instanceof TRPCClientError ? error : TRPCClientError.from(error as Error));
        const input = op.input as Record<string, unknown>;
        if (op.path === 'auth.me') reply({ user: { id: userId, email: 'unit@example.test', role: 'USER' } });
        else if (op.path === 'campaign.get') {
          try {
            Promise.resolve(answer(++reads)).then(reply, fail);
          } catch (error) {
            fail(error);
          }
        } else if (op.path === 'campaign.relationship' || op.path === 'campaign.unit') {
          mutations.push({ path: op.path, input });
          if (options.rejectMutation) fail(conflict());
          else reply({ requestId: input.requestId, kind: op.path, status: 'pending' });
        } else if (op.path === 'campaign.request') {
          if (options.lostRequest) fail(new Error('request unavailable'));
          else reply({ requestId: input.requestId, kind: 'campaign.relationship', status: 'pending' });
        } else fail(new Error(`unexpected ${op.path}`));
      });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const server = createTRPCClient<AppRouter>({ links: [link] });
  const optionsProxy = createTRPCOptionsProxy<AppRouter>({ client: server, queryClient: client });
  const tree = (id: string) => (
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={server} queryClient={client}>
        <CampaignPanel worldId={id} />
      </TRPCProvider>
    </QueryClientProvider>
  );
  const view = render(tree(worldId));
  return {
    ...view,
    mutations,
    reads: () => reads,
    changeWorld: (id: string) => view.rerender(tree(id)),
    changeAccount: (id: string) => {
      const key = optionsProxy.auth.me.queryKey();
      const current = client.getQueryData(key)!;
      if (!current.user) throw new Error('Expected authenticated fixture');
      client.setQueryData(key, { ...current, user: { ...current.user, id } });
    },
  };
}

describe('명시적인 새 휘하 제안 준비', () => {
  it('캐시가 신선해도 클릭 뒤 조회하고 선택을 보존해 기대 UUID·최신 revision으로 한 번만 보낸다', async () => {
    const fresh = deferred<Board>();
    const view = mount((read) => (read === 1 ? base : fresh.promise));
    const button = await screen.findByRole('button', { name: '대상에게 제안' });
    fireEvent.change(screen.getByLabelText('제안할 관계'), { target: { value: 'LIEUTENANT' } });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(view.reads()).toBe(2));
    expect(view.mutations).toHaveLength(0);
    expect((screen.getByLabelText('제안할 관계') as HTMLSelectElement).disabled).toBe(true);
    await act(async () => {
      fresh.resolve({ ...base, revision: 9 });
    });
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.mutations[0]).toMatchObject({
      path: 'campaign.relationship',
      input: {
        worldId,
        expectedUserId: userId,
        payload: { type: 'offer', targetId: 2, relation: 'LIEUTENANT', revision: 9 },
      },
    });
    const stored = JSON.parse(sessionStorage.getItem(`campaign.pending:${userId}:${worldId}`)!);
    expect(stored).toEqual({
      kind: 'campaign.relationship',
      requestId: view.mutations[0]!.input.requestId,
      payload: view.mutations[0]!.input.payload,
    });
  });

  it.each([
    ['다른 장수', { actorId: 99 }],
    ['대상 이탈', { candidates: [] }],
    ['금 부족', { resources: { gold: 499, rice: 1000 } }],
    ['명망 부족', { renownUsed: 100 }],
    ['월드 정지', { status: 'PAUSED' }],
  ] satisfies Array<[string, Partial<Board>]>)(
    '%s가 최신 조회에 나타나면 과거 현황으로 보내지 않는다',
    async (_name, patch) => {
      const view = mount((read) => (read === 1 ? base : { ...base, ...patch, revision: 5 }));
      fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
      await screen.findByText(/바뀌었습니다/);
      expect(view.mutations).toHaveLength(0);
      expect(sessionStorage.getItem(`campaign.pending:${userId}:${worldId}`)).toBeNull();
    },
  );

  it('최신 조회가 실패하면 남아 있는 과거 data로 보내지 않는다', async () => {
    const view = mount((read) => {
      if (read === 1) return base;
      throw new Error('fresh unavailable');
    });
    fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
    await screen.findByText('현황을 확인하지 못했습니다. 다시 제안하려면 눌러주세요.');
    expect(view.reads()).toBe(2);
    expect(view.mutations).toHaveLength(0);
  });

  it('느린 준비 조회 중 2초 폴링은 읽기를 취소하거나 추가 제안하지 않는다', async () => {
    const fresh = deferred<Board>();
    const view = mount((read) => (read === 1 ? base : fresh.promise));
    fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
    await waitFor(() => expect(view.reads()).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2200));
    });
    expect(view.reads()).toBe(2);
    expect(view.mutations).toHaveLength(0);
    await act(async () => {
      fresh.resolve({ ...base, revision: 8 });
    });
    await waitFor(() => expect(view.mutations).toHaveLength(1));
  });

  it('준비 중 UI 계정이 바뀌면 이전 계정의 늦은 응답으로 제안하지 않는다', async () => {
    const fresh = deferred<Board>();
    const view = mount((read) => (read === 2 ? fresh.promise : base));
    fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
    await waitFor(() => expect(view.reads()).toBe(2));
    act(() => view.changeAccount('2bf38c50-cc52-4b07-9878-f746f4fbd9e0'));
    await act(async () => {
      fresh.resolve({ ...base, revision: 5 });
    });
    expect(view.mutations).toHaveLength(0);
  });

  it('준비 중 월드가 바뀌어 이전 응답이 늦게 와도 제안하지 않는다', async () => {
    const fresh = deferred<Board>();
    const view = mount((read) => (read === 2 ? fresh.promise : base));
    fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
    await waitFor(() => expect(view.reads()).toBe(2));
    view.changeWorld('f752b2c2-9a87-41f9-9730-c948b6bf5dc2');
    await act(async () => {
      fresh.resolve({ ...base, revision: 5 });
    });
    expect(view.mutations).toHaveLength(0);
  });

  it('준비 조회 뒤 CAS가 거부해도 새 요청을 자동 제출하지 않는다', async () => {
    const view = mount((read) => ({ ...base, revision: read }), { rejectMutation: true });
    fireEvent.click(await screen.findByRole('button', { name: '대상에게 제안' }));
    await screen.findByText('휘하 현황을 다시 불러오세요.');
    await waitFor(() => expect(view.reads()).toBeGreaterThanOrEqual(3));
    expect(view.mutations).toHaveLength(1);
    expect(sessionStorage.getItem(`campaign.pending:${userId}:${worldId}`)).toBeNull();
  });

  it('기존 pending offer 재전송은 같은 UUID·payload에 최상위 기대 UUID만 붙이고 새로 조회하지 않는다', async () => {
    const old = {
      kind: 'campaign.relationship',
      requestId: '154eb720-a267-423b-b77e-4162872eb075',
      payload: { type: 'offer', targetId: 2, relation: 'STAFF', revision: 1 },
    };
    sessionStorage.setItem(`campaign.pending:${userId}:${worldId}`, JSON.stringify(old));
    const view = mount(() => ({ ...base, revision: 7 }), { lostRequest: true });
    fireEvent.click(await screen.findByRole('button', { name: '같은 요청 다시 보내기' }));
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.reads()).toBe(1);
    expect(view.mutations[0]!.input).toEqual({
      worldId,
      requestId: old.requestId,
      payload: old.payload,
      expectedUserId: userId,
    });
    expect(JSON.parse(sessionStorage.getItem(`campaign.pending:${userId}:${worldId}`)!)).toEqual(old);
  });

  it.each([
    ['응답', 'campaign.relationship', { type: 'respond', offerId: 3, accept: true, revision: 1 }],
    ['해제', 'campaign.relationship', { type: 'release', personId: 2, revision: 1 }],
    ['부곡', 'campaign.unit', { type: 'form', commanderId: 1, crewType: 1100, revision: 1 }],
  ])('기존 pending %s 재전송에는 기대 UUID나 새로운 조회를 추가하지 않는다', async (_name, kind, payload) => {
    const old = { kind, requestId: '154eb720-a267-423b-b77e-4162872eb075', payload };
    sessionStorage.setItem(`campaign.pending:${userId}:${worldId}`, JSON.stringify(old));
    const view = mount(() => ({ ...base, revision: 7 }), { lostRequest: true });
    fireEvent.click(await screen.findByRole('button', { name: '같은 요청 다시 보내기' }));
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.reads()).toBe(1);
    expect(view.mutations[0]).toEqual({
      path: kind,
      input: { worldId, requestId: old.requestId, payload: old.payload },
    });
    expect(JSON.parse(sessionStorage.getItem(`campaign.pending:${userId}:${worldId}`)!)).toEqual(old);
  });
});
