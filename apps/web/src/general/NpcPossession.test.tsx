// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { TRPCLink } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NPC 무장 맡기 후보 줄 (INT-26, p8-personnel-3). 마지막 tRPC link만 바꿔 entry.roles의 손 데이터를 돌려준다.
// 서버·엔진을 실행한 증거가 아니다.
const wire = vi.hoisted(() => ({ handlers: new Map<string, (input: unknown) => unknown>() }));

vi.mock('../trpc', async (importOriginal) => {
  const { createTRPCClient } = await import('@trpc/client');
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
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
            (error: unknown) => observer.error(error as never),
          );
      });
  return { ...(await importOriginal<object>()), trpcClient: createTRPCClient<AppRouter>({ links: [link] }) };
});

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => () => Promise.resolve(),
}));

const { TRPCProvider, trpcClient } = await import('../trpc');
const { NpcPossession } = await import('./NpcPossession');

const candidate = (generalId: number, name: string, stats: number[], portraitId: number | null = null) => ({
  generalId,
  name,
  portraitId,
  nation: { id: 1, name: '위', color: '#336699' },
  city: { key: 11, name: '허창' },
  leadership: stats[0]!,
  strength: stats[1]!,
  intel: stats[2]!,
  ...(stats.length === 5 ? { politics: stats[3]!, charm: stats[4]! } : {}),
  officerLevel: 1,
  recommendedNation: null,
});

const roles = <T extends ReturnType<typeof candidate>>(ruler: T[]) => ({
  gameDate: { year: 191, month: 3 },
  quota: { humans: 1, max: null },
  mine: null,
  roles: { ruler, core: [], retainer: [], free: [] },
  canPossess: true,
  blockedReason: null,
});

let client: QueryClient;
function renderEntry() {
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <NpcPossession worldId="w1" enabled onPendingChange={() => {}} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sessionStorage.clear();
  wire.handlers.clear();
  wire.handlers.set('auth.me', () => ({ user: { id: 'u1' } }));
});
afterEach(cleanup);

describe('NPC 무장 맡기 후보 줄', () => {
  it('5능력치 월드는 다섯 칸과 합을 붙이고 합이 큰 순으로 둔다. 이름은 괄호를 빼고 얼굴은 원형 icon이다', async () => {
    wire.handlers.set('entry.roles', () =>
      roles([
        candidate(4, '하후돈(夏侯惇)', [80, 90, 50, 40, 60]),
        candidate(2, '조조(曹操)', [95, 70, 90, 90, 95], 10001),
        candidate(7, '조인', [80, 80, 50, 50, 60]),
      ]),
    );
    renderEntry();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 무장 맡기' }));
    const group = await screen.findByRole('group', { name: '군주 무장' });
    expect(within(group).getByText('능력치 합이 큰 순입니다.')).toBeTruthy();
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')!.textContent)).toEqual([
      '조조 · 위 · 허창통솔 95 · 무력 70 · 지력 90 · 정치 90 · 매력 95 · 합 440',
      '하후돈 · 위 · 허창통솔 80 · 무력 90 · 지력 50 · 정치 40 · 매력 60 · 합 320',
      '조인 · 위 · 허창통솔 80 · 무력 80 · 지력 50 · 정치 50 · 매력 60 · 합 320',
    ]);
    const face = radios[0]!.closest('label')!.querySelector('[data-variant="icon"]')!;
    expect(face.getAttribute('data-state')).toBe('image');
    fireEvent.click(radios[0]!);
    expect(screen.getByRole('button', { name: '조조(으)로 시작' })).toBeTruthy();
  });

  it('후보가 가진 내정과 전투 특기의 효과를 표시한다', async () => {
    wire.handlers.set('entry.roles', () =>
      roles([
        {
          ...candidate(2, '장수2', [80, 80, 70]),
          special: '경작',
          domesticSpecialty: { name: '경작', commands: ['farm'], score: 1.1, cost: 0.8, successBonus: 0.1 },
        },
        {
          ...candidate(3, '장수3', [70, 60, 50]),
          special: '공성',
          combatSpecialty: { name: '공성', description: '성벽에 가하는 피해 100% 증가' },
        },
      ]),
    );
    renderEntry();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 무장 맡기' }));
    expect(await screen.findByTitle(/농지 개간.*효과 \+10%/)).toBeTruthy();
    expect(screen.getByTitle('성벽에 가하는 피해 100% 증가')).toBeTruthy();
  });

  it('3능력치 월드는 통솔·무력·지력 세 칸만 쓴다', async () => {
    wire.handlers.set('entry.roles', () => roles([candidate(3, '장수3', [70, 60, 50])]));
    renderEntry();
    fireEvent.click(await screen.findByRole('button', { name: 'NPC 무장 맡기' }));
    expect((await screen.findByTestId('npc-stats')).textContent).toBe('통솔 70 · 무력 60 · 지력 50 · 합 180');
  });
});
