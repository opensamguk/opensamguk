// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldSummary } from '../game/types';
import { fiveTigers, SeasonResult } from './SeasonResult';

// records.season 응답 모양의 시험 값. 기준(by)마다 같은 장수를 그 기준으로 줄 세운다.
const season = vi.hoisted(() => ({
  rows: [] as Array<{
    generalId: number;
    name: string;
    nation: { id: number; name: string; color: string } | null;
    dedication: number;
    experience: number;
    wins: number;
    captures: number;
  }>,
  calls: [] as string[],
}));
vi.mock('../game/queries', () => ({ useWorldId: () => 'world-one' }));
vi.mock('../trpc', () => ({
  useTRPC: () => ({
    records: {
      season: {
        queryOptions: ({ by }: { by: 'dedication' | 'experience' | 'merit' }) => ({
          queryKey: ['season', by],
          queryFn: async () => {
            season.calls.push(by);
            const value = (row: (typeof season.rows)[number]) => (by === 'merit' ? row.wins + row.captures : row[by]);
            return {
              result: null,
              statistics: {
                final: { nations: 2, generals: 7 },
                peak: { nations: 5, affiliatedGenerals: 12 },
                nationNames: ['위', '촉'],
              },
              generals: [...season.rows]
                .sort((a, b) => value(b) - value(a))
                .map((row, index) => ({ ...row, merit: row.wins + row.captures, rank: index + 1 })),
            };
          },
        }),
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  season.rows = [];
  season.calls = [];
});

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Result = NonNullable<WorldSummary['result']>;
const result = (extra: Partial<Result>): Result => ({
  reason: 'END_YEAR',
  year: 191,
  month: 12,
  winner: null,
  remainingNations: 3,
  endedAt: '2026-10-23T00:00:00.000Z',
  ...extra,
});

describe('기수 결과 칸 (T1-27)', () => {
  it('천하통일은 승자 국가 이름과 국가색 이름표, 종료 연월, 남은 국가 수를 쓴다', () => {
    render(
      <SeasonResult
        result={result({
          reason: 'UNIFIED',
          year: 192,
          month: 3,
          winner: { nationId: 4, name: '조조', color: '#000080' },
          remainingNations: 1,
        })}
      />,
    );
    const region = screen.getByRole('region', { name: '기수 결과' });
    expect(within(region).getByTestId('season-reason').textContent).toBe('천하통일');
    const badge = within(region).getByText('조조');
    // 색만으로 구별하지 않게 이름을 함께 쓰고, 이름표 바탕이 국가색이다.
    expect(badge.style.background).toBe('rgb(0, 0, 128)');
    expect(within(region).getByTestId('season-date').textContent).toBe('192년 3월');
    expect(within(region).getByTestId('season-nations').textContent).toBe('1');
    expect(within(region).queryByText('승자 없음')).toBeNull();
  });

  it('종료 연도 도달은 승자 없음과 그 해 12월을 쓴다', () => {
    render(<SeasonResult result={result({ remainingNations: 5 })} />);
    const region = screen.getByRole('region', { name: '기수 결과' });
    expect(within(region).getByTestId('season-reason').textContent).toBe('종료 연도 도달');
    expect(within(region).getByTestId('season-winner').textContent).toBe('승자 없음');
    expect(within(region).getByTestId('season-date').textContent).toBe('191년 12월');
    expect(within(region).getByTestId('season-nations').textContent).toBe('5');
  });

  it('결과 기록이 없는 종료 월드는 끝났다는 것만 알리고 이유·승자를 지어내지 않는다', () => {
    render(<SeasonResult result={null} />);
    const region = screen.getByRole('region', { name: '기수 결과' });
    expect(region.textContent).toBe('이 판은 끝났습니다.');
    expect(screen.queryByTestId('season-reason')).toBeNull();
    expect(screen.queryByTestId('season-winner')).toBeNull();
  });
});

// 끝난 기수의 최종 장수 순위와 오호장군 (INT-25, 원작 명예의 전당·왕조 상세).
describe('기수 결과 칸 최종 장수 순위', () => {
  const wei = { id: 4, name: '위', color: '#000080' };
  const shu = { id: 5, name: '촉', color: '#008000' };
  const row = (
    generalId: number,
    name: string,
    nation: typeof wei | null,
    values: [number, number, number, number],
  ) => ({
    generalId,
    name,
    nation,
    dedication: values[0],
    experience: values[1],
    wins: values[2],
    captures: values[3],
  });

  it('오호장군은 승자 국가의 승리 상위 다섯 명이고 승리 0은 뺀다', () => {
    const rows = [
      row(1, '하후돈(夏侯惇)', wei, [0, 0, 9, 0]),
      row(2, '관우', shu, [0, 0, 20, 0]),
      row(3, '장료', wei, [0, 0, 7, 0]),
      row(4, '허저', wei, [0, 0, 0, 0]),
      ...[5, 6, 7, 8].map((id) => row(id, `위장수${id}`, wei, [0, 0, id - 4, 0])),
    ];
    expect(fiveTigers(rows, 4)).toEqual(['하후돈(9)', '장료(7)', '위장수8(4)', '위장수7(3)', '위장수6(2)']);
    expect(fiveTigers(rows, null)).toEqual([]);
  });

  it('공헌 순으로 열고 기준 단추로 다시 받는다', async () => {
    season.rows = [row(1, '조조(曹操)', wei, [50, 10, 1, 1]), row(2, '유비', shu, [40, 90, 5, 0])];
    render(
      <SeasonResult result={result({ reason: 'UNIFIED', winner: { nationId: 4, name: '위', color: '#000080' } })} />,
    );
    await screen.findByRole('table', { name: '최종 장수 순위' });
    // 기준을 바꾸면 표를 다시 그리므로 매번 새로 찾는다.
    const names = () =>
      within(screen.getByRole('table', { name: '최종 장수 순위' }))
        .getAllByRole('row')
        .slice(1)
        .map((tr) => tr.children[1]!.textContent);
    expect(names()).toEqual(['조조', '유비']);
    fireEvent.click(screen.getByRole('button', { name: '경험' }));
    await waitFor(() => expect(names()).toEqual(['유비', '조조']));
    expect(screen.getByRole('button', { name: '경험' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('season-tigers').textContent).toBe('오호장군: 조조(1)');
    fireEvent.click(screen.getByText('기수 통계'));
    expect(screen.getByText('최종 2 · 최대 5')).toBeTruthy();
    expect(screen.getByText('최종 장수 수')).toBeTruthy();
    expect(screen.getByText('소속 장수 최대 수 (월간 기록)')).toBeTruthy();
    expect(screen.getByText('위 · 촉')).toBeTruthy();
  });
});
