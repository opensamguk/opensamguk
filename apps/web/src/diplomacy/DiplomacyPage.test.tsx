// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Allowed, Quote, RequestState, TreatyItem, TreatyListPage } from './contract';

// 첫 세 조항 외교실 화면 시험 (T2-07 F1, AC-M2-06). 화면은 실제 AppRouter 타입의 tRPC 클라이언트로 부르고
// 여기서는 마지막 link만 바꿔 실제로 나가는 path·input을 기록하고 path별 처리기의 값을 돌려준다.
// 처리기 값은 실제 출력 타입으로 만든 손 데이터다. 서버·엔진·PG를 실행한 증거가 아니다.
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

// 라우터 없이 그린다. 탭 이동은 tab 값을 바꿔 다시 그리는 것으로 대신한다.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useRouterState: () => '/w/w1/diplomacy',
  useParams: () => ({ worldId: 'w1' }),
}));

const { TRPCProvider, trpcClient } = await import('../trpc');
const { DiplomacyPage } = await import('./DiplomacyPage');

const ok: Allowed = { ok: true };
const nation = (id: number, name: string) => ({ id, name, color: '#336699' });
const treaty = (patch: Partial<TreatyItem>): TreatyItem => ({
  id: '9',
  fromNationId: 2,
  toNationId: 1,
  incoming: true,
  clauses: [{ kind: 'nonAggression', months: 12 }],
  status: 'PROPOSED',
  proposedTick: 100,
  respondByTick: 700,
  startTick: null,
  endTick: null,
  cost: null,
  from: nation(2, '원소'),
  to: nation(1, '조조'),
  proposedAt: { year: 191, month: 3 },
  respondBy: { year: 191, month: 9 },
  startAt: null,
  endAt: null,
  estimate: { mine: 1200, theirs: 900 },
  canAccept: ok,
  canReject: ok,
  ...patch,
});
const listPage = (patch: Partial<TreatyListPage>): TreatyListPage => ({
  canPropose: ok,
  targets: [
    { nation: nation(2, '원소'), relation: 'NONE', relationEndAt: null },
    { nation: nation(3, '유표'), relation: 'WAR', relationEndAt: null },
  ],
  items: [],
  nextCursor: null,
  pending: [],
  myRecent: [],
  ...patch,
});

const on = (path: string, handler: (input: unknown) => unknown) => wire.handlers.set(path, handler);
const callsTo = (path: string) => wire.calls.filter((call) => call.path === path);
const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } });

let client: QueryClient;
function renderPage(tab: Parameters<typeof DiplomacyPage>[0]['tab']) {
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <DiplomacyPage tab={tab} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sessionStorage.clear();
  wire.calls.length = 0;
  wire.handlers.clear();
  on('auth.me', () => ({ user: { id: 'u1' } }));
  on('home.get', () => ({ nation: { id: 1 } }));
  on('world.map', () => ({ cities: [], nations: [nation(1, '조조'), nation(2, '원소'), nation(3, '유표')] }));
});
afterEach(cleanup);

describe('외교실 첫 세 조항 화면', () => {
  it('교역 기능이 있는 월드의 조항 작성은 실제 견적·제안 입력에 교역 기간을 넣는다', async () => {
    on('treaty.list', () => listPage({ tradeEnabled: true }));
    on('treaty.quote', () => ({ cost: { mine: 100, theirs: 100 }, problem: null }));
    on(
      'treaty.propose',
      (input) =>
        ({
          status: 'applied',
          requestId: (input as { requestId: string }).requestId,
          kind: 'treaty.propose',
          outcome: 'PROPOSED',
          treatyId: '12',
          treaty: null,
        }) satisfies RequestState,
    );
    renderPage('write');
    const form = await screen.findByRole('form', { name: '조약서 쓰기' });
    fireEvent.change(within(form).getByLabelText('상대'), { target: { value: '2' } });
    fireEvent.click(within(form).getByLabelText('교역 허용'));
    fireEvent.change(within(form).getByLabelText('교역 기간(개월)'), { target: { value: '6' } });
    await waitFor(() =>
      expect(callsTo('treaty.quote').at(-1)?.input).toEqual({
        worldId: 'w1',
        toNationId: 2,
        clauses: [{ kind: 'trade', months: 6 }],
      }),
    );
    fireEvent.click(within(form).getByRole('button', { name: '제안 보내기' }));
    await screen.findByText(/제안을 보냈습니다/);
    expect(callsTo('treaty.propose').at(-1)?.input).toMatchObject({
      toNationId: 2,
      clauses: [{ kind: 'trade', months: 6 }],
    });
  });
  it('목록은 쪽으로 받고 탭 수는 불러온 쪽 기준이라고 적는다. 다음 쪽은 cursor만 더해 묻는다', async () => {
    const closed = { estimate: null, canAccept: null, canReject: null };
    const outgoing = treaty({ id: '8', incoming: false, fromNationId: 1, toNationId: 3 });
    const pages: Record<string, TreatyListPage> = {
      first: listPage({
        items: [
          treaty({ id: '9' }),
          { ...outgoing, from: nation(1, '조조'), to: nation(3, '유표'), canAccept: null, canReject: null },
          treaty({ id: '5', status: 'ACTIVE', ...closed, cost: { from: 300, to: 300 } }),
        ],
        nextCursor: '5',
      }),
      '5': listPage({ items: [treaty({ id: '2', status: 'EXPIRED', ...closed })] }),
    };
    on('treaty.list', (input) => pages[(input as { cursor?: string }).cursor ?? 'first']);
    renderPage('incoming');
    const note = await screen.findByTestId('treaty-page-note');
    expect(note.textContent).toBe('탭의 수는 지금까지 불러온 조약 3개만 셉니다. 더 오래된 조약이 남아 있습니다.');
    expect(screen.getAllByTestId('treaty-card').map((card) => card.getAttribute('data-treaty-id'))).toEqual(['9']);

    fireEvent.click(screen.getByRole('button', { name: '이전 조약 더 불러오기' }));
    await waitFor(() =>
      expect(screen.getByTestId('treaty-page-note').textContent).toBe('탭의 수는 불러온 조약 4개를 모두 셉니다.'),
    );
    expect(screen.queryByRole('button', { name: '이전 조약 더 불러오기' })).toBeNull();
    const inputs = callsTo('treaty.list').map((call) => call.input);
    expect(inputs).toContainEqual({ worldId: 'w1' });
    expect(inputs).toContainEqual({ worldId: 'w1', cursor: '5' });
    // infiniteQueryOptions가 붙이는 direction 같은 칸은 strict 입력이 거부하므로 보내지 않는다.
    const keys = new Set(inputs.flatMap((input) => Object.keys(input as object)));
    expect([...keys].sort()).toEqual(['cursor', 'worldId']);
  });

  it('형식 1 월드의 PRECONDITION_FAILED는 빈 목록이 아니라 서버 문장으로 보인다', async () => {
    on('treaty.list', () => {
      throw serverError('PRECONDITION_FAILED', '조약 기능을 쓰지 않는 월드입니다.');
    });
    renderPage('incoming');
    const blocked = await screen.findByTestId('treaty-unavailable');
    expect(within(blocked).getByRole('alert').textContent).toContain('조약 기능을 쓰지 않는 월드입니다.');
    expect(screen.queryByText('받은 제안 조약이 없습니다')).toBeNull();
    expect(screen.queryByTestId('treaty-page-note')).toBeNull();
    expect(callsTo('treaty.list')).toHaveLength(1);
  });

  it('남은 당사국이 없는 카드, 다른 장수의 처리 중 응답, 최근 결과(응답 DECLINED·제안 DECLINED·REJECTED)를 서버 값 그대로 그린다', async () => {
    const inProgress: Allowed = { ok: false, code: 'IN_PROGRESS', reason: '요청을 처리하는 중입니다.' };
    const page = listPage({
      items: [
        treaty({ id: '9' }),
        treaty({ id: '6', from: null, fromNationId: 7, estimate: null, canAccept: inProgress, canReject: inProgress }),
      ],
      pending: [
        {
          requestId: null,
          kind: 'treaty.respond',
          treatyId: '6',
          toNation: null,
          accept: true,
          requestedBy: { name: '순욱' },
        },
      ],
      myRecent: [
        {
          requestId: '11111111-1111-4111-8111-111111111111',
          kind: 'treaty.respond',
          treatyId: '4',
          result: 'APPLIED',
          outcome: 'DECLINED',
          reason: null,
        },
        {
          requestId: '33333333-3333-4333-8333-333333333333',
          kind: 'treaty.propose',
          treatyId: '5',
          result: 'APPLIED',
          outcome: 'DECLINED',
          reason: null,
        },
        {
          requestId: '22222222-2222-4222-8222-222222222222',
          kind: 'treaty.propose',
          treatyId: null,
          result: 'REJECTED',
          outcome: null,
          reason: '이미 맺은 관계라 이 조항을 제안할 수 없습니다.',
        },
      ],
    });
    on('treaty.list', () => page);
    renderPage('incoming');
    const missing = await screen.findByRole('article', { name: '없는 국가 (ID 7)와 조조의 조약' });
    expect(within(missing).getByTestId('treaty-estimate').textContent).toBe('당사국이 없어 계산하지 않습니다.');
    expect(within(missing).getByRole('status').textContent).toBe('순욱의 요청을 처리하는 중입니다.');
    expect(within(missing).getByRole('button', { name: /^수락\s*\(사용 불가\)$/ })).toBeTruthy();

    const own = screen.getByRole('article', { name: '원소와 조조의 조약' });
    expect(within(own).getByTestId('treaty-estimate').textContent).toBe(
      '우리 금 1,200 · 상대 금 900 (지금 도시 수 기준, 수락 때 다시 계산)',
    );

    const recent = screen.getByRole('region', { name: '최근 처리된 내 요청' });
    expect(
      within(recent)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      '응답 · 받은 제안을 거절함',
      '제안 · 상대가 거절함',
      '제안 · 받아들여지지 않음 (이미 맺은 관계라 이 조항을 제안할 수 없습니다.)',
    ]);
    expect(screen.queryByText(/신의|파기/)).toBeNull();
  });

  it('받은 제안을 거절하면 APPLIED DECLINED를 거절로 보이고 목록을 다시 받는다', async () => {
    on('treaty.list', () => listPage({ items: [treaty({ id: '9' })] }));
    on('treaty.respond', (input) => {
      const { requestId } = input as { requestId: string };
      return {
        status: 'applied',
        requestId,
        kind: 'treaty.respond',
        outcome: 'DECLINED',
        treatyId: '9',
        treaty: {
          id: '9',
          fromNationId: 2,
          toNationId: 1,
          incoming: true,
          clauses: [{ kind: 'nonAggression', months: 12 }],
          status: 'REJECTED',
          proposedTick: 100,
          respondByTick: null,
          startTick: null,
          endTick: null,
          cost: null,
        },
      } satisfies RequestState;
    });
    renderPage('incoming');
    const card = await screen.findByRole('article', { name: '원소와 조조의 조약' });
    const before = callsTo('treaty.list').length;
    fireEvent.click(within(card).getByRole('button', { name: '거절' }));

    const done = await screen.findByText('제안을 거절했습니다.', { exact: false });
    expect(done.closest('[data-result]')?.getAttribute('data-result')).toBe('applied');
    expect(done.closest('[data-outcome]')?.getAttribute('data-outcome')).toBe('DECLINED');
    expect(done.textContent).toContain('원소·조조, 조항 1개');
    const [respond] = callsTo('treaty.respond');
    expect(respond?.input).toMatchObject({ worldId: 'w1', treatyId: '9', accept: false });
    await waitFor(() => expect(callsTo('treaty.list').length).toBeGreaterThan(before));
  });

  it('INTERNAL_SERVER_ERROR 뒤에는 같은 requestId로 다시 보내 HTTP 200 rejected를 엔진 거절로 보인다', async () => {
    on('treaty.list', () => listPage({ items: [treaty({ id: '9' })] }));
    let first = true;
    on('treaty.respond', (input) => {
      if (first) {
        first = false;
        throw serverError('INTERNAL_SERVER_ERROR', '조약 요청 기록을 확인하지 못했습니다.');
      }
      return {
        status: 'rejected',
        requestId: (input as { requestId: string }).requestId,
        kind: 'treaty.respond',
        code: 'INSUFFICIENT_GOLD',
        reason: '국고가 모자랍니다.',
      } satisfies RequestState;
    });
    renderPage('incoming');
    const card = await screen.findByRole('article', { name: '원소와 조조의 조약' });
    fireEvent.click(within(card).getByRole('button', { name: '수락' }));

    fireEvent.click(await screen.findByRole('button', { name: '같은 요청 다시 보내기' }));
    const rejected = await screen.findByText('수락 요청이 거절되었습니다. 국고가 모자랍니다.', { exact: false });
    expect(rejected.closest('[data-result]')?.getAttribute('data-result')).toBe('rejected');
    const ids = callsTo('treaty.respond').map((call) => (call.input as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(screen.queryByText('조약을 맺었습니다.')).toBeNull();
  });

  it('조약서는 첫 세 조항만 고르고 뒤 네 조항은 지원하지 않는다고 보인다. 제안에는 기한 칸을 보내지 않는다', async () => {
    const quote: Quote = { cost: { mine: 600, theirs: 400 }, problem: null };
    on('treaty.list', () => listPage({}));
    on('treaty.quote', () => quote);
    on('treaty.propose', (input) => {
      const { requestId } = input as { requestId: string };
      return {
        status: 'applied',
        requestId,
        kind: 'treaty.propose',
        outcome: 'PROPOSED',
        treatyId: '12',
        treaty: null,
      } satisfies RequestState;
    });
    renderPage('write');
    const form = await screen.findByRole('form', { name: '조약서 쓰기' });
    for (const label of ['통행 허용', '정기 원조', '교역 허용', '도시 이양']) {
      const box = within(form).getByLabelText(label) as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.closest('[data-unsupported]')?.textContent).toContain('아직 지원하지 않는 조항입니다.');
    }
    expect(within(form).queryByText(/신의/)).toBeNull();

    fireEvent.change(within(form).getByLabelText('상대'), { target: { value: '2' } });
    fireEvent.click(within(form).getByLabelText('불가침'));
    await waitFor(() =>
      expect(screen.getByTestId('treaty-cost').textContent).toBe(
        '예상 비용 우리 금 600 · 상대 금 400 (지금 도시 수 기준, 수락되면 양쪽이 냅니다)',
      ),
    );
    expect(callsTo('treaty.quote').at(-1)?.input).toEqual({
      worldId: 'w1',
      toNationId: 2,
      clauses: [{ kind: 'nonAggression', months: 24 }],
    });

    fireEvent.click(within(form).getByRole('button', { name: '제안 보내기' }));
    const sent = await screen.findByText(/제안을 보냈습니다/);
    expect(sent.closest('[data-result]')?.getAttribute('data-outcome')).toBe('PROPOSED');
    const [propose] = callsTo('treaty.propose');
    expect(Object.keys(propose?.input as object).sort()).toEqual(['clauses', 'requestId', 'toNationId', 'worldId']);
    expect(propose?.input).toMatchObject({ toNationId: 2, clauses: [{ kind: 'nonAggression', months: 24 }] });
  });

  it('견적의 단일 problem은 폼 단위로 서버 문장을 보이고 보내기를 막는다', async () => {
    const quote: Quote = {
      cost: null,
      problem: { code: 'TREATY_RELATION', reason: '지금 관계에서는 이 조항을 제안할 수 없습니다.' },
    };
    on('treaty.list', () => listPage({}));
    on('treaty.quote', () => quote);
    renderPage('write');
    const form = await screen.findByRole('form', { name: '조약서 쓰기' });
    fireEvent.change(within(form).getByLabelText('상대'), { target: { value: '3' } });
    fireEvent.click(within(form).getByLabelText('불가침'));
    const problem = await screen.findByTestId('treaty-quote-problem');
    expect(problem.textContent).toBe('지금 관계에서는 이 조항을 제안할 수 없습니다.');
    expect(screen.getByTestId('treaty-cost').textContent).toBe('서버가 비용을 계산하지 않았습니다.');
    expect(within(form).getByRole('button', { name: /^제안 보내기\s*\(사용 불가\)$/ })).toBeTruthy();
    expect(callsTo('treaty.propose')).toHaveLength(0);
  });

  it('권한이 없으면 조약서 대신 이유와 관계 표만 보이고 신의 칸은 없다', async () => {
    const canPropose: Allowed = { ok: false, code: 'NO_PERMISSION', reason: '조약을 처리할 권한이 없습니다.' };
    on('treaty.list', () => listPage({ canPropose }));
    renderPage('write');
    expect((await screen.findByRole('note')).textContent).toBe(
      '조약을 처리할 권한이 없습니다. 이 직책은 외교 문서를 읽기만 합니다.',
    );
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['국가', '우리와의 관계']);
    expect(
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['원소관계 없음', '유표교전']);
    expect(screen.queryByRole('button', { name: /제안 보내기/ })).toBeNull();
  });
});

describe('외교실 국가 탭 (INT-20)', () => {
  it('이미 받은 상대 목록으로 관계와 이어 볼 곳을 한 줄씩 보이고 새 조회를 하지 않는다', async () => {
    on('treaty.list', () => listPage({ items: [treaty({})] }));
    renderPage('nations');
    const table = await screen.findByTestId('nation-relations');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['국가', '우리와의 관계', '이어 보기']);
    // 시험의 Link 대역은 aria-label을 넘기지 않으므로 줄 글자로 본다.
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['원소관계 없음받은 제안 보기', '유표교전조약서 쓰기']);
    expect(within(table).getByText('교전').dataset.tone).toBe('danger');
    expect(callsTo('treaty.trust')).toHaveLength(0);
  });
});
