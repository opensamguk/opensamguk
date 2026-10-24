// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldSummary } from '../game/types';
import { GeneralLogList } from './Records';

afterEach(cleanup);

// 개인 기록 연월이 종료 직전, 종료 직후, 재조회 뒤에 같은지 본다 (T1-27 후속, AC-M1-21).
// AppRouter 출력 모양의 synthetic summary다. 시작 연도 300, 한 달 10,000 tick(turnTermMinutes 1, msPerTick 6),
// 종료 연도 결과 300년 12월, 결정 tick 120,000, 로그 tick 119,999. 실제 API 증거가 아니다.
const running: WorldSummary = {
  name: '시험 월드',
  status: 'RUNNING',
  startYear: 300,
  gameDate: { year: 300, month: 12 },
  clockMode: 'ACCELERATED',
  endYear: 300,
  result: null,
  nowTick: 119_999,
  msPerTick: 6,
  turnTermMinutes: 1,
};

const ended = (): WorldSummary => ({
  name: '시험 월드',
  status: 'ENDED',
  startYear: 300,
  gameDate: { year: 300, month: 12 },
  clockMode: 'ACCELERATED',
  endYear: 300,
  result: {
    reason: 'END_YEAR',
    year: 300,
    month: 12,
    winner: null,
    remainingNations: 3,
    endedAt: '2026-10-23T00:00:00.000Z',
  },
  nowTick: 120_000,
  msPerTick: 6,
  turnTermMinutes: 1,
});

const items = [{ id: 'log-1', tick: 119_999, commandKey: 'farm', kind: 'success', text: '농지를 개간했다' }];
const shownDate = () => screen.getByRole('listitem').firstElementChild?.textContent;

describe('개인 기록 연월 (T1-27 종료 뒤)', () => {
  it('종료 직전, 종료 직후, 재조회 뒤 같은 로그를 모두 300년 12월로 쓴다', () => {
    const { rerender } = render(<GeneralLogList items={items} clock={running} />);
    expect(shownDate()).toBe('300년 12월');

    const first = ended();
    rerender(<GeneralLogList items={items} clock={first} />);
    expect(shownDate()).toBe('300년 12월');

    const refetched = ended();
    expect(refetched).not.toBe(first);
    rerender(<GeneralLogList items={items} clock={refetched} />);
    expect(shownDate()).toBe('300년 12월');
  });

  it('요약이 없거나 tick 길이를 셀 수 없으면 연월 대신 —를 쓴다', () => {
    const { rerender } = render(<GeneralLogList items={items} clock={undefined} />);
    expect(shownDate()).toBe('—');
    rerender(<GeneralLogList items={items} clock={{ ...ended(), msPerTick: 0 }} />);
    expect(shownDate()).toBe('—');
  });
});
