// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { TRPCLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cities, enabled, levelOne, levelThree } from './test/records';
import type { IntelRecordsResponse } from './types';

// 탭을 다시 열 때 캐시에 남은 기록을 그리지 않는지 본다(T4-13 AC-P2-07 독립 검토).
// 네트워크 대신 tRPC의 마지막 link만 바꿔 path별 처리기의 값을 돌려준다(messages/messages.test.tsx와 같은 방식).
const wire = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  // IntelRecordsPanel이 그린 data마다 기록 도시 키를 적는다. 한 번이라도 그려졌는지 보려는 것이다.
  painted: [] as number[][],
  records: 0,
}));

vi.mock('../trpc', async (importOriginal) => {
  const { createTRPCClient, TRPCClientError: ClientError } = await import('@trpc/client');
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.path === 'intel.records') wire.records += 1;
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

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => vi.fn(),
}));

vi.mock('./IntelRecordList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./IntelRecordList')>();
  return {
    ...actual,
    IntelRecordsPanel: (props: Parameters<typeof actual.IntelRecordsPanel>[0]) => {
      wire.painted.push(props.data.items.map((item) => item.cityKey));
      return <actual.IntelRecordsPanel {...props} />;
    },
  };
});

const { TRPCProvider, trpcClient } = await import('../trpc');
const { useAuthorityWatch } = await import('../messages/authority');
const { IntelRecordsTab } = await import('./IntelRecordsTab');

const WORLD = 'w1';
const OLD = enabled([levelOne()]); // 허창(10)
const NEW = enabled([levelThree()]); // 완(20)

let client: QueryClient;
let home: { nationId: number | null; officerLevel: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const on = (path: string, handler: (input: unknown) => unknown) => wire.handlers.set(path, handler);
const settle = () => act(async () => {});
const ever = (cityKey: number) => wire.painted.some((keys) => keys.includes(cityKey));
const rowName = (name: string) => new RegExp(`^${name} 첩보 기록`);
const row = (name: string) => screen.queryByRole('row', { name: rowName(name) });
const findRow = (name: string) => screen.findByRole('row', { name: rowName(name) });

// GameLayout에서는 메시지 단추가 권한 감시를 돌리고 탭과 따로 붙어 있다. 탭만 내렸다 올릴 수 있게 나눈다.
function Watch() {
  useAuthorityWatch(WORLD);
  return null;
}

function Screen({ tab }: { tab: boolean }): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <Watch />
        {tab ? <IntelRecordsTab worldId={WORLD} cities={cities} /> : null}
      </TRPCProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wire.handlers.clear();
  wire.painted.length = 0;
  wire.records = 0;
  home = { nationId: 2, officerLevel: 1 };
  on('home.get', () => ({ general: { ...home } }));
});

afterEach(cleanup);

// 응답을 붙잡아 둔 채로 다음 기록 요청이 실제로 나갈 때까지 기다린다.
function holdNext() {
  const held = deferred<IntelRecordsResponse>();
  const before = wire.records;
  on('intel.records', () => held.promise);
  wire.painted.length = 0;
  return { held, sent: () => waitFor(() => expect(wire.records).toBeGreaterThan(before)) };
}

describe('T4-13 AC-P2-07 기록 탭 다시 열기', () => {
  it('다시 연 탭은 이번 마운트의 응답이 오기 전까지 캐시의 예전 기록을 그리지 않는다', async () => {
    on('intel.records', () => OLD);
    const view = render(<Screen tab />);
    expect(await findRow('허창')).toBeTruthy();

    view.rerender(<Screen tab={false} />);
    await settle();
    // 캐시에는 예전 기록이 남아 있다. 그래서 다시 열면 isPending이 false다.
    expect(client.getQueryCache().findAll({ queryKey: [['intel', 'records']] })[0]?.state.data).toEqual(OLD);

    const { held, sent } = holdNext();
    view.rerender(<Screen tab />);
    await sent();
    await settle();
    expect(screen.getByRole('status').textContent).toContain('불러오는 중');
    expect(row('허창')).toBeNull();
    expect(wire.painted).toEqual([]);

    await act(async () => held.resolve(NEW));
    expect(await findRow('완')).toBeTruthy();
    expect(row('허창')).toBeNull();
    expect(ever(10)).toBe(false);
  });

  it('탭을 닫을 때 진행 중이던 예전 조회의 답은 다시 연 탭에 그려지지 않는다', async () => {
    on('intel.records', () => OLD);
    const view = render(<Screen tab />);
    expect(await findRow('허창')).toBeTruthy();

    // 탭이 열린 채 새로고침을 보내고 답을 붙잡아 둔다.
    const old = holdNext();
    act(() => void client.refetchQueries({ queryKey: [['intel', 'records']] }));
    await old.sent();

    // 그 조회가 끝나기 전에 탭을 닫았다가 다시 연다. 다시 연 탭은 예전 조회에 합류하지 않고 새 요청을 보내야 한다.
    view.rerender(<Screen tab={false} />);
    await settle();
    const fresh = holdNext();
    view.rerender(<Screen tab />);
    await settle();

    // 예전 조회의 답이 이제야 도착해도 이번 마운트의 답이 아니므로 그리지 않는다.
    await act(async () => old.held.resolve(OLD));
    await settle();
    expect(screen.getByRole('status').textContent).toContain('불러오는 중');
    expect(row('허창')).toBeNull();
    expect(wire.painted).toEqual([]);

    await fresh.sent();
    await act(async () => fresh.held.resolve(NEW));
    expect(await findRow('완')).toBeTruthy();
    expect(row('허창')).toBeNull();
    expect(ever(10)).toBe(false);
  });

  it('탭이 열린 채 소속이 바뀌면 권한 경계가 비운 키를 새로 받아 새 기록만 그린다', async () => {
    on('intel.records', () => OLD);
    render(<Screen tab />);
    expect(await findRow('허창')).toBeTruthy();

    const { held, sent } = holdNext();
    home = { nationId: 3, officerLevel: 1 };
    await act(() => client.invalidateQueries({ queryKey: [['home', 'get']] }));
    await sent();
    await settle();
    expect(screen.getByRole('status').textContent).toContain('불러오는 중');
    expect(row('허창')).toBeNull();

    // 비운 키는 dataUpdateCount를 0부터 다시 센다. 마운트 때 횟수와 비교했다면 이 응답도 막혔을 것이다.
    await act(async () => held.resolve(NEW));
    expect(await findRow('완')).toBeTruthy();
    expect(ever(10)).toBe(false);
  });
});
