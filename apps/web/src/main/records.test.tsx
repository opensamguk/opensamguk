// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldSummary } from '../game/types';
import { GeneralLogList, WorldHistoryList } from './Records';

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
  truce: null,
  quota: { humans: 0, max: 500 },
  npcCount: 0,
  scenarioType: null,
  serverTime: '2026-01-01T00:00:00.000Z',
  engine: null,
  engineStale: null,
  protection: { war: null, founding: null },
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
  truce: null,
  quota: { humans: 0, max: 500 },
  npcCount: 0,
  scenarioType: null,
  serverTime: '2026-01-01T00:00:00.000Z',
  engine: null,
  engineStale: null,
  protection: { war: null, founding: null },
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

// 중원 정세는 원작처럼 사건 글줄이다 (INT-25). 연감 두 달을 견주어 글줄을 만들고 월단평 머리글을 앞에 둔다.
describe('중원 정세 글줄', () => {
  const nations = [
    { id: 1, name: '위', color: '#000080', capitalCityKey: 1, description: '' },
    { id: 2, name: '촉', color: '#008000', capitalCityKey: 2, description: '' },
  ];
  const cities = [
    { key: 1, name: '허창' },
    { key: 2, name: '성도' },
  ];
  const month = (tick: number, m: number, owner2: number | null, headline?: string) => ({
    tick,
    year: 191,
    month: m,
    nations: [
      { nationId: 1, cities: owner2 === 1 ? 2 : 1, generals: 3 },
      { nationId: 2, cities: owner2 === 2 ? 1 : 0, generals: 2 },
    ],
    cities: [
      { cityKey: 1, nationId: 1 },
      { cityKey: 2, nationId: owner2 },
    ],
    ...(headline ? { review: { headline } } : {}),
  });

  it('메인은 변화가 있는 달만 글줄로 쓴다', () => {
    const items = [month(30, 4, 1, '조조가 성도를 얻다'), month(20, 3, 2), month(10, 2, 2)];
    render(<WorldHistoryList items={items} nations={nations} cities={cities} compact />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toBe('191년 4월월단평: 조조가 성도를 얻다위가 성도를 차지했습니다.');
  });

  it('불러온 달에 변화가 없으면 가장 최근 달의 세력 수를 한 줄로 쓴다', () => {
    render(<WorldHistoryList items={[month(20, 3, 2), month(10, 2, 2)]} nations={nations} cities={cities} compact />);
    expect(screen.getByRole('listitem').textContent).toBe('191년 3월영토 변화 없음 · 세력 2곳 · 공백지 0성');
  });

  it('기록 화면은 달마다 세력 크기를 함께 쓴다', () => {
    render(<WorldHistoryList items={[month(20, 3, null), month(10, 2, 2)]} nations={nations} cities={cities} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('성도가 공백지가 되었습니다.');
    expect(rows[0]!.textContent).toContain('공백지 1성');
  });

  // 기록 화면 월별 세력 (INT-25, D-085). 사건 글줄과 월단평은 서버 사건을 쓰는 중원 정세 칸에만 있다.
  it('글줄을 끄면 달마다 세력 크기만 쓰고 월단평 머리글을 두 번 쓰지 않는다', () => {
    render(
      <WorldHistoryList
        items={[month(20, 3, null, '조조가 성도를 얻다'), month(10, 2, 2)]}
        nations={nations}
        cities={cities}
        lines={false}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toBe('191년 3월위1성 3명공백지 1성');
    expect(screen.queryByTestId('world-review-headline')).toBeNull();
  });
});
