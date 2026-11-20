// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TRPCLink } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 예턴 편집기의 국가 명령 제안 칸 (D-100). 실제 AppRouter 타입의 tRPC 클라이언트에서 마지막 link만 바꾼다.
// 처리기 값은 손 데이터다. 서버를 실행한 증거가 아니다.
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; input: unknown }>,
  handlers: new Map<string, (input: unknown) => unknown>(),
}));

vi.mock('../trpc', async (importOriginal) => {
  const { createTRPCClient, TRPCClientError: ClientError } = await import('@trpc/client');
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        wire.calls.push({ path: op.path, input: op.input });
        const handler = wire.handlers.get(op.path);
        void Promise.resolve()
          .then(() => {
            if (!handler) throw new Error(`처리기가 없습니다: ${op.path}`);
            return handler(op.input);
          })
          .then(
            (data) => {
              observer.next({ result: { data } });
              observer.complete();
            },
            (error: unknown) => observer.error(ClientError.from<AppRouter>(error as Error)),
          );
      });
  return { ...(await importOriginal<object>()), trpcClient: createTRPCClient<AppRouter>({ links: [link] }) };
});

const { TRPCProvider, trpcClient } = await import('../trpc');
const { NationProposal } = await import('./TurnEditor');

const declare = {
  key: 'nation_declare',
  name: '선전포고',
  category: 'nation',
  argsSchema: { type: 'object', properties: { nationId: { type: 'integer' } }, required: ['nationId'] },
};

function renderBox() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <NationProposal
          worldId="w1"
          render={(commands, propose, units) => (
            <>
              <p>부곡 선택지 {(units ?? []).map((unit) => `${unit.id}:${unit.ownerName}`).join(',')}</p>
              <button
                type="button"
                onClick={() =>
                  propose.onPropose(
                    { commandKey: commands[0]!.key, args: { nationId: 2 }, explicit: true },
                    '먼저 칩시다',
                  )
                }
              >
                {propose.to}에게 {commands[0]!.name} 제안
              </button>
            </>
          )}
        />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.handlers.clear();
});
afterEach(cleanup);

describe('D-100 국가 명령 제안 칸', () => {
  it('제안할 국가 명령이 없으면 그리지 않는다', async () => {
    wire.handlers.set('proposals.commands', () => []);
    renderBox();
    await waitFor(() => expect(wire.calls.some((call) => call.path === 'proposals.commands')).toBe(true));
    expect(screen.queryByTestId('nation-proposal')).toBeNull();
  });

  it('펼쳤을 때만 명령 고르기를 그리고, 제안하면 proposals.create로 보내고 올렸다고 알린다', async () => {
    wire.handlers.set('proposals.commands', () => [declare]);
    wire.handlers.set('proposals.create', () => ({ proposalId: '00000000-0000-4000-8000-000000000001' }));
    // 같은 국가의 다른 장수 부곡. 펼친 뒤에만 받아 명령 고르기의 부곡 칸 선택지로 넘긴다.
    wire.handlers.set('campaign.nationUnits', () => [
      {
        id: 7,
        crewType: 1100,
        troops: 500,
        train: 60,
        atmos: 70,
        ownerId: 3,
        ownerName: '관우',
        ownerCityKey: 1,
        commanderId: 3,
        commanderName: '관우',
        commanderCityKey: 1,
        supply: false,
      },
    ]);
    renderBox();
    const box = await screen.findByTestId('nation-proposal');
    expect(box.textContent).toContain('국가 명령 제안 1');
    expect(screen.queryByRole('button', { name: /제안$/ })).toBeNull();
    expect(wire.calls.some((call) => call.path === 'campaign.nationUnits')).toBe(false);
    (box as HTMLDetailsElement).open = true;
    fireEvent(box, new Event('toggle'));
    expect(await screen.findByText('부곡 선택지 7:관우')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '군주와 수뇌에게 선전포고 제안' }));
    await waitFor(() =>
      expect(wire.calls).toContainEqual({
        path: 'proposals.create',
        input: { worldId: 'w1', commandKey: 'nation_declare', args: { nationId: 2 }, note: '먼저 칩시다' },
      }),
    );
    expect(await screen.findByText('선전포고 제안을 올렸습니다. 제안함에서 진행을 볼 수 있습니다.')).toBeTruthy();
  });
});
