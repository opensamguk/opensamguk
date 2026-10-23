// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldSummary } from '../game/types';
import { SeasonResult } from './SeasonResult';

afterEach(cleanup);

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
