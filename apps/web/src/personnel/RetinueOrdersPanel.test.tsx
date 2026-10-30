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
import { RetinueOrdersPanel } from './RetinueOrdersPanel';

type Board = inferRouterOutputs<AppRouter>['campaign']['orders'];
const userId = '58abf143-1d86-4563-92a5-4673302f4c96';
const otherId = 'd9b24316-80cf-4bb7-b3c0-ea6f48184fc5';
const worldId = '06580bef-fc70-4faa-984d-d37c274d706a';
const base: Board = {
  userId,
  actorId: 1,
  revision: 1,
  status: 'RUNNING',
  recipients: [{ id: 2, name: '휘하 장수', isHuman: false }],
  npcSuperior: { id: 3, name: 'NPC 군주' },
  orders: [
    {
      id: 7,
      issuerId: 3,
      issuerName: 'NPC 군주',
      recipientId: 1,
      recipientName: '나',
      command: { commandKey: 'farm', args: {} },
      status: 'PENDING',
      createdTick: 0,
    },
  ],
  next: { turnRevision: 5, firstSlot: { commandKey: 'rest', args: {}, explicit: true } },
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  sessionStorage.clear();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

// 컴포넌트 경합 검사다. 실제 PG·HTTP·엔진 실행 증거는 INT-19B/C에서 별도로 확인한다.
function mount() {
  let board = structuredClone(base),
    currentUser = userId;
  let hold: Promise<Board> | undefined;
  let heldReads = 0;
  let failRequest = false,
    failMutation = false;
  let deniedCode: string | null = null;
  let deniedMutation = false;
  const mutations: Array<Record<string, unknown>> = [];
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        const reply = (data: unknown) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        };
        const fail = () => observer.error(TRPCClientError.from(new Error('결과 조회 연결 실패')));
        const input = op.input as Record<string, unknown>;
        if (op.path === 'auth.me') reply({ user: { id: currentUser, email: 'unit@example.test', role: 'USER' } });
        else if (op.path === 'campaign.orders') {
          if (deniedCode) {
            observer.error(
              TRPCClientError.from({
                error: { message: '접근이 제한됐습니다.', code: -32000, data: { code: deniedCode } },
              }),
            );
            return;
          }
          if (hold) heldReads++;
          void Promise.resolve(hold ?? board).then(reply);
        } else if (op.path === 'campaign.order') {
          mutations.push(input);
          if (deniedMutation)
            observer.error(
              TRPCClientError.from({
                error: { message: '접근이 제한됐습니다.', code: -32000, data: { code: 'FORBIDDEN' } },
              }),
            );
          else if (failMutation) fail();
          else reply({ requestId: input.requestId, userId: currentUser, status: 'pending' });
        } else if (op.path === 'campaign.request') {
          if (failRequest) fail();
          else reply({ requestId: input.requestId, kind: 'campaign.order', status: 'pending' });
        } else if (op.path === 'commands.list')
          reply([
            {
              key: 'farm',
              name: '농지 개간',
              category: 'domestic',
              argsSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ]);
        else if (op.path === 'world.map')
          reply({ cities: [{ key: 1, name: '허창' }], nations: [{ id: 1, name: '조조' }] });
        else if (op.path === 'world.summary') reply({ cityResourcesEnabled: true });
        else if (op.path === 'home.get') reply({ general: { crewType: 1100 } });
        else if (op.path === 'campaign.get') reply({});
        else fail();
      });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const server = createTRPCClient<AppRouter>({ links: [link] });
  const proxy = createTRPCOptionsProxy<AppRouter>({ client: server, queryClient: client });
  const tree = (id: string) => (
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={server} queryClient={client}>
        <RetinueOrdersPanel worldId={id} />
      </TRPCProvider>
    </QueryClientProvider>
  );
  const view = render(tree(worldId));
  return {
    ...view,
    mutations,
    heldReads: () => heldReads,
    denyReads: (code: string) => {
      deniedCode = code;
      void client.invalidateQueries({ queryKey: proxy.campaign.orders.queryKey({ worldId }) });
    },
    denyRetry: () => {
      deniedMutation = true;
    },
    setBoard: (value: Board) => {
      board = value;
    },
    holdBoard: (value: Promise<Board> | undefined) => {
      hold = value;
    },
    loseTransport: () => {
      failRequest = true;
      failMutation = true;
    },
    changeAccount: (id: string) => {
      currentUser = id;
      board = { ...board, userId: id, orders: [], recipients: [] };
      const key = proxy.auth.me.queryKey();
      const previous = client.getQueryData(key)!;
      client.setQueryData(key, { ...previous, user: { ...previous.user!, id } });
    },
    changeWorld: (id: string) => view.rerender(tree(id)),
  };
}

describe('AC-INT-19C 장수 지시 화면', () => {
  it('수신 지시는 본인 명시 동의 전에는 접수하지 않고 최신 한 칸·번호로 한 번만 수락한다', async () => {
    const view = mount();
    const accept = await screen.findByRole('button', { name: '다음 한 칸으로 수락' });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(accept);
    expect(view.mutations).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(accept);
    fireEvent.click(accept);
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.mutations[0]).toMatchObject({
      expectedUserId: userId,
      worldId,
      payload: {
        type: 'respond',
        orderId: 7,
        accept: true,
        revision: 1,
        expectedTurnRevision: 5,
        expectedFirstSlot: base.next.firstSlot,
      },
    });
    expect(view.mutations[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('동의 뒤 예약이 바뀌면 지시 수락을 보내지 않는다', async () => {
    const view = mount();
    const accept = await screen.findByRole('button', { name: '다음 한 칸으로 수락' });
    fireEvent.click(screen.getByRole('checkbox'));
    view.setBoard({ ...base, next: { ...base.next, turnRevision: 6 } });
    fireEvent.click(accept);
    await screen.findByText('다음 예약이 바뀌었습니다. 확인한 뒤 다시 수락하세요.');
    expect(view.mutations).toHaveLength(0);
  });
  it('무료 거절과 NPC 지시 요청은 서로 다른 명시 payload로 접수한다', async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: '지시 거절' }));
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.mutations[0]!.payload).toMatchObject({ type: 'respond', accept: false, orderId: 7 });
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    sessionStorage.clear();
    const next = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 군주에게 지시 요청' }));
    await waitFor(() => expect(next.mutations).toHaveLength(1));
    expect(next.mutations[0]!.payload).toEqual({ type: 'request', revision: 1 });
    expect(next.mutations[0]!.payload).not.toHaveProperty('issuerId');
  });
  it('기존 명령 선택기를 사용하고 발송 직전 최신 관계·revision을 읽는다', async () => {
    const view = mount();
    fireEvent.change(await screen.findByLabelText('받을 장수'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('radio', { name: '농지 개간' }));
    fireEvent.click(screen.getByRole('button', { name: '보낼 지시에 넣기' }));
    view.setBoard({ ...base, revision: 9 });
    fireEvent.click(screen.getByRole('button', { name: '지시 보내기' }));
    await waitFor(() => expect(view.mutations).toHaveLength(1));
    expect(view.mutations[0]!.payload).toEqual({
      type: 'issue',
      revision: 9,
      recipientId: 2,
      command: { commandKey: 'farm', args: {} },
    });
  });
  it('오래된 계정의 준비 조회가 늦게 끝나도 새 계정에 POST·개인 지시를 넘기지 않는다', async () => {
    const view = mount();
    const button = await screen.findByRole('button', { name: 'NPC 군주에게 지시 요청' });
    const wait = deferred<Board>();
    view.holdBoard(wait.promise);
    fireEvent.click(button);
    await waitFor(() => expect(view.heldReads()).toBeGreaterThan(0));
    view.holdBoard(undefined);
    await act(async () => {
      view.changeAccount(otherId);
    });
    await act(async () => {
      wait.resolve(base);
    });
    await screen.findByText('로그인한 계정이 바뀌었습니다. 화면을 다시 확인하세요.');
    expect(view.mutations).toHaveLength(0);
    expect(screen.queryByText(/NPC 군주 → 나/)).toBeNull();
  });
  it('연결이 끊겨도 자동 재전송하지 않고 수동 재접수에서 같은 UUID·payload를 보존한다', async () => {
    const view = mount();
    view.loseTransport();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 군주에게 지시 요청' }));
    const retry = await screen.findByRole('button', { name: '같은 요청 다시 확인·접수' });
    expect(view.mutations).toHaveLength(1);
    fireEvent.click(retry);
    await waitFor(() => expect(view.mutations).toHaveLength(2));
    expect(view.mutations[1]).toEqual(view.mutations[0]);
  });
  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('성공한 개인 조회 뒤 %s가 오면 이전 비공개 내용을 가린다', async (code) => {
    const view = mount();
    await screen.findByText(/NPC 군주 → 나/);
    view.denyReads(code);
    await screen.findByText('지시 현황을 불러오지 못했습니다');
    expect(screen.queryByText(/NPC 군주 → 나/)).toBeNull();
    expect(screen.queryByRole('button', { name: '지시 보내기' })).toBeNull();
    expect(view.mutations).toHaveLength(0);
  });
  it('결과 미확인 요청의 같은UUID 복구가403으로 막혀도 원래 키와 내용을 보존한다', async () => {
    const view = mount();
    view.loseTransport();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 군주에게 지시 요청' }));
    const retry = await screen.findByRole('button', { name: '같은 요청 다시 확인·접수' });
    const key = `campaign.order.pending:${userId}:${worldId}`;
    const before = sessionStorage.getItem(key);
    expect(before).not.toBeNull();
    view.denyRetry();
    fireEvent.click(retry);
    await screen.findByText('접근이 제한됐습니다.');
    expect(sessionStorage.getItem(key)).toBe(before);
    expect(view.mutations).toHaveLength(2);
    expect(view.mutations[1]).toEqual(view.mutations[0]);
    expect((screen.getByRole('button', { name: '지시 보내기' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
