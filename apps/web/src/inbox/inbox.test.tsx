// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreatyItem, TreatyListPage } from '../diplomacy/contract';
import type { AssignmentOfferView } from '../personnel/contract';
import type { CampaignBoard } from './count';

// 받은 제안함 화면 시험 (INT-20). 화면은 실제 AppRouter 타입의 tRPC 클라이언트로 부르고 마지막 link만 바꿔
// path별 처리기의 값을 돌려준다. 처리기 값은 손 데이터다. 서버·엔진을 실행한 증거가 아니다.
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

// 라우터 없이 그린다. 링크는 주소 대신 이동할 곳을 data 속성으로 남긴다.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ children, to, hash, search }: { children?: ReactNode; to: string; hash?: string; search?: object }) => (
    <a data-to={to} data-hash={hash} data-search={search ? JSON.stringify(search) : undefined}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: () => '/w/w1/inbox',
  useParams: () => ({ worldId: 'w1' }),
}));

const { TRPCProvider, trpcClient } = await import('../trpc');
const { InboxPage } = await import('./InboxPage');
const { countInbox } = await import('./count');

const ok = { ok: true } as const;
const offer: AssignmentOfferView = {
  id: '10-1-2',
  issuer: { generalId: 1, name: '공손찬' },
  targetCity: { cityKey: 3, name: '북평' },
  expires: { year: 191, month: 3, monthsLeft: 1 },
  rejectCost: { dedicationPercent: 10, dedication: 45 },
  respond: ok,
};
const board = {
  actorId: 1,
  people: [
    { id: 1, name: '유비' },
    { id: 2, name: '하후돈' },
    { id: 3, name: '관우' },
  ],
  offers: [
    { id: 'o1', masterId: 2, personId: 1, relation: 'STAFF', status: 'PENDING' },
    { id: 'o2', masterId: 2, personId: 1, relation: 'GUEST', status: 'REJECTED' },
    { id: 'o3', masterId: 1, personId: 3, relation: 'LIEUTENANT', status: 'PENDING' },
  ],
} as unknown as CampaignBoard;
const nation = (id: number, name: string) => ({ id, name, color: '#336699' });
const treaty = (patch: Partial<TreatyItem>) =>
  ({
    id: '9',
    fromNationId: 2,
    toNationId: 1,
    incoming: true,
    status: 'PROPOSED',
    from: nation(2, '원소'),
    to: nation(1, '조조'),
    respondBy: { year: 191, month: 9 },
    ...patch,
  }) as TreatyItem;
const listPage = (items: TreatyItem[]) =>
  ({ canPropose: ok, targets: [], items, nextCursor: null, pending: [], myRecent: [] }) as unknown as TreatyListPage;

const on = (path: string, handler: (input: unknown) => unknown) => wire.handlers.set(path, handler);
const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } });

let client: QueryClient;
function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <InboxPage />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wire.calls.length = 0;
  wire.handlers.clear();
  on('auth.me', () => ({ user: { id: 'u1' } }));
  on('home.get', () => ({ nation: null }));
  on('general.mine', () => ({ general: null, creationRules: { campaignEnabled: false } }));
  on('offers.mine', () => []);
  on('personnel.recent', () => []);
});
afterEach(cleanup);

describe('받은 제안함', () => {
  it('받은 제안이 없으면 빈 상태를 보이고 외교·휘하는 묻지 않는다', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '받은 제안함' })).toBeTruthy();
    expect(await screen.findByText('받은 제안이 없습니다')).toBeTruthy();
    expect(wire.calls.some((call) => call.path === 'treaty.list' || call.path === 'campaign.get')).toBe(false);
  });

  it('발령·휘하·외교 제안을 모아 보이고 답하는 화면으로 잇는다', async () => {
    on('home.get', () => ({ nation: { id: 1 } }));
    on('general.mine', () => ({ general: { id: 1 }, creationRules: { campaignEnabled: true } }));
    on('offers.mine', () => [offer]);
    on('campaign.get', () => board);
    on('treaty.list', () =>
      listPage([treaty({}), treaty({ id: '8', incoming: false }), treaty({ id: '7', status: 'ACTIVE' })]),
    );
    renderPage();

    const assignment = await screen.findByRole('region', { name: '발령 제안' });
    expect(within(assignment).getByText('공손찬이 북평으로 발령했습니다 · 남은 기한 1개월, 넘기면 수락')).toBeTruthy();
    expect(within(assignment).getByRole('button', { name: '수락' })).toBeTruthy();

    const retinue = await screen.findByRole('region', { name: '휘하 제안 1' });
    expect(within(retinue).getByText('하후돈의 가신 제안')).toBeTruthy();
    expect(within(retinue).getByText('휘하·부곡에서 답하기').getAttribute('data-hash')).toBe('campaign-title');

    const treaties = await screen.findByRole('region', { name: '외교 제안 1' });
    expect(within(treaties).getByText('원소의 조약 제안 · 응답 기한 191년 9월')).toBeTruthy();
    const link = within(treaties).getByText('외교실에서 답하기');
    expect(link.getAttribute('data-to')).toBe('/w/$worldId/diplomacy');
    expect(link.getAttribute('data-search')).toBe(JSON.stringify({ tab: 'incoming' }));

    expect(screen.queryByText('받은 제안이 없습니다')).toBeNull();
  });

  it('조약을 볼 수 없는 월드는 오류 없이 빈 상태로 둔다', async () => {
    on('home.get', () => ({ nation: { id: 1 } }));
    on('treaty.list', () => {
      throw serverError('PRECONDITION_FAILED', '이 월드에서는 조약을 볼 수 없습니다.');
    });
    renderPage();
    expect(await screen.findByText('받은 제안이 없습니다')).toBeTruthy();
    expect(screen.queryByText('외교 제안을 불러오지 못했습니다.')).toBeNull();
  });

  it('이 월드에 장수가 없으면 장수 생성으로 안내한다', async () => {
    on('home.get', () => {
      throw serverError('NOT_FOUND', '장수가 없습니다');
    });
    renderPage();
    expect(await screen.findByText('이 월드에 내 장수가 없습니다')).toBeTruthy();
  });
});

describe('메뉴의 제안함 수', () => {
  it('받은 대기 제안만 센다', () => {
    expect(countInbox({ offers: undefined, board: undefined, treaties: undefined })).toBe(0);
    expect(
      countInbox({
        offers: [offer],
        board,
        treaties: { pages: [listPage([treaty({}), treaty({ id: '8', incoming: false })])], pageParams: [null] },
      }),
    ).toBe(3);
  });
});
