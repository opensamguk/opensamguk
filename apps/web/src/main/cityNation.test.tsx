// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneralView, NationView, WorldSummary } from '../game/types';
import type { InspectionRow } from '../operations/contract';
import type { ArgNames } from '../turns/args';
import { CityStats, GarrisonLine, GeneralNameCell, TurnFive } from './CityInfo';
import { nextTurnText, NationSummaryGrid, StationedTable } from './NationInfo';

// 도시·국가 칸의 원작 정보 (INT-25 3단계). 장수·국가 값은 city.get·nation.get 응답 모양의 시험 값이다.
vi.mock('../portrait/Portrait', () => ({
  Portrait: ({ name, className }: { name: string; className?: string }) => (
    <span data-portrait={name} className={className} />
  ),
}));

afterEach(cleanup);

const detailed = (id: number, name: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name,
    nationId: 1,
    portraitId: 10,
    cityKey: 3,
    leadership: 70,
    strength: 60,
    intel: 50,
    officerLevel: 1,
    birthYear: 160,
    deathYear: 230,
    activeFromYear: 180,
    personality: null,
    special: null,
    gold: 1000,
    rice: 800,
    crew: 0,
    crewType: 1,
    train: 0,
    atmos: 0,
    experience: 0,
    dedication: 0,
    age: 30,
    injury: 0,
    nextTurnTick: 0,
    ...extra,
  }) as unknown as GeneralView;
const outsider = (id: number, nationId: number | null) => ({ id, name: `타국${id}`, nationId }) as GeneralView;

describe('주둔 장수 이름 칸', () => {
  it('같은 국가 장수는 얼굴·괄호 뺀 이름·부상을 쓰고 얼굴은 읽기 이름에서 뺀다', () => {
    render(<GeneralNameCell general={detailed(1, '조조(曹操)', { injury: 12 })} />);
    expect(screen.getByText('조조').hasAttribute('data-general-name')).toBe(true);
    expect(screen.getByText('부상 12')).toBeTruthy();
    expect(document.querySelector('[data-portrait="조조"]')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('수치를 받지 못한 장수는 얼굴 없이 이름만 쓴다', () => {
    render(<GeneralNameCell general={outsider(2, 2)} />);
    expect(document.querySelector('[data-portrait]')).toBeNull();
    expect(screen.getByText('타국2')).toBeTruthy();
  });
});

describe('주둔 병력 요약 줄', () => {
  it('아군 병력·출전 가능 병력·타국·재야 수를 쓴다', () => {
    render(
      <GarrisonLine
        campaign={false}
        defense={{
          minimumTraining: 20,
          minimumMorale: 20,
          troops: 4000,
          generals: [
            { generalId: 1, troops: 3000 },
            { generalId: 2, troops: 1000 },
          ],
        }}
        generals={[
          detailed(1, '가', { crew: 3000, train: 95, atmos: 92 }),
          detailed(2, '나', { crew: 1000, train: 70, atmos: 65 }),
          detailed(3, '다'),
          outsider(4, 2),
          outsider(5, null),
        ]}
      />,
    );
    const line = screen.getByTestId('garrison-summary').textContent;
    expect(line).toContain('아군 병력 4,000 · 병력 있는 장수 2명 / 아군 3명');
    expect(line).toContain('훈련·사기 90 이상 3,000명(1장수) · 60 이상 4,000명(2장수)');
    expect(line).toContain('타국 장수 1명 · 재야 1명');
    expect(line).toContain('수비 참가 4,000명 · 장수 2명');
  });
});

describe('국가 요약 칸', () => {
  const member = {
    id: 1,
    name: '위',
    color: '#000080',
    cityCount: 3,
    generalCount: 2,
    description: '',
    tech: 3456,
    philosophy: '법가',
    level: 2,
    capitalCityKey: 3,
    gold: 10_000,
    rice: 9_000,
    taxRate: 0.1,
  } as unknown as NationView;
  const value = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

  it('군주·참모·총 병사·국력·기술 등급을 쓴다', () => {
    render(
      <NationSummaryGrid
        nation={member}
        capitalName="허창"
        generals={
          [
            detailed(1, '조조(曹操)', { officerLevel: 12, crew: 2000, leadership: 80 }),
            detailed(2, '순욱', { officerLevel: 11, leadership: 30 }),
          ] as unknown as NationView['generals']
        }
        power={{ power: 1234, rank: 2, at: '191년 3월 정산 기준' }}
      />,
    );
    expect(value('군주')).toBe('조조');
    expect(value('참모')).toBe('순욱');
    expect(value('총 병사')).toBe('2,000 / 11,000');
    expect(value('국력')).toBe('1,234 · 2위');
    expect(value('기술')).toBe('3등급 / 3,456');
    expect(value('수도')).toBe('허창');
  });

  it('다른 국가는 군주·총 병사를 가리고 수도는 지도 값으로 쓴다', () => {
    const other = { id: 2, name: '촉', color: '#008000', cityCount: 1, generalCount: 1 } as unknown as NationView;
    render(<NationSummaryGrid nation={other} capitalName="성도" generals={[]} power={null} />);
    expect(value('군주')).toBe('—');
    expect(screen.getByText('군주', { selector: 'dt' }).parentElement?.getAttribute('title')).toBe('다른 국가 정보');
    expect(value('총 병사')).toBe('—');
    expect(value('국력')).toBe('—');
    expect(value('수도')).toBe('성도');
  });
});

describe('도시 수치 구간', () => {
  it('막대 읽기 이름은 그대로 두고 낮음·보통·높음 글자를 붙인다', () => {
    render(
      <CityStats
        rows={[
          { label: '주민', value: 10_000, max: 100_000 },
          { label: '농업', value: 500, max: 1000 },
          { label: '성벽', value: 950, max: 1000 },
          { label: '치안', value: null, max: 1000, hiddenReason: '다른 국가의 도시입니다' },
        ]}
      />,
    );
    expect(screen.getByRole('meter', { name: '주민 10000 / 100000' })).toBeTruthy();
    const band = (label: string) =>
      screen.getByText(label, { selector: 'th' }).closest('tr')?.getAttribute('data-band') ?? null;
    expect(band('주민')).toBe('low');
    expect(band('농업')).toBe('mid');
    expect(band('성벽')).toBe('high');
    expect(band('치안')).toBeNull();
    expect(screen.getByText('낮음')).toBeTruthy();
    expect(screen.getByText('보통')).toBeTruthy();
    expect(screen.getByText('높음')).toBeTruthy();
  });
});

const names: ArgNames = { city: (key) => (key === 12 ? '낙양' : undefined), nation: () => undefined };
const slots = [
  { commandKey: 'farm', args: {}, explicit: true, name: '농지 개간' },
  { commandKey: 'attack', args: { cityKey: 12 }, explicit: true, name: '출병' },
  { commandKey: 'rest', args: {}, explicit: false, name: '휴식' },
  { commandKey: 'rest', args: {}, explicit: true, name: '휴식' },
  { commandKey: 'rest', args: {}, explicit: false, name: '휴식' },
] as InspectionRow['turns'];
const inspectionRow = (generalId: number, isHuman: boolean) =>
  ({
    generalId,
    name: '',
    officerLevel: 1,
    cityKey: 3,
    cityName: '허창',
    isHuman,
    crew: 0,
    train: 0,
    atmos: 0,
    turns: slots,
    nextTurnAt: '2026-11-13T09:30:00.000Z',
    lastActiveAt: null,
    idle: false,
  }) as InspectionRow;

describe('예턴 앞 5칸', () => {
  it('칸 번호와 인자 이름을 붙이고 비워 둔 칸은 빈 칸으로 쓴다', () => {
    render(<TurnFive turns={slots} names={names} />);
    const items = Array.from(screen.getByTestId('turn-five').querySelectorAll('li'), (li) => li.textContent);
    expect(items).toEqual(['1 농지 개간', '2 출병 낙양', '3 빈 칸', '4 휴식', '5 빈 칸']);
  });
});

describe('펼친 도시의 장수 표', () => {
  const generals = [
    detailed(1, '조조(曹操)', { officerLevel: 12, crew: 2000, train: 80, atmos: 70, gold: 3000, rice: 2500 }),
    detailed(2, '하후돈', { nextTurnTick: 12 }),
  ] as unknown as Parameters<typeof StationedTable>[0]['generals'];
  const props = {
    caption: '허창 배치 장수 2명',
    generals,
    crewTypes: undefined,
    campaign: false,
    fiveStats: false,
    names,
    summary: undefined,
  };
  const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent?.replace(/[▲▼]/g, '').trim());

  it('일반 장수에게는 능력치·금·쌀·병종·병력·훈련·사기·다음 턴만 보이고 예턴 열이 없다', () => {
    render(<StationedTable {...props} inspection={null} />);
    expect(headers()).toEqual(['장수', '직책', '통·무·지', '금', '쌀', '병종', '병력', '훈련', '사기', '다음 턴']);
    const row = screen.getByText('조조').closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td'), (td) => td.textContent);
    expect(cells.slice(1, 9)).toEqual(['군주', '70 / 60 / 50', '3,000', '2,500', '병종 1', '2,000', '80', '70']);
    expect(screen.queryByText('NPC')).toBeNull();
  });

  it('직책자는 감찰 자료로 예턴 5칸·서버 다음 턴 시각·NPC 딱지를 본다', () => {
    const inspection = new Map([
      [1, inspectionRow(1, true)],
      [2, inspectionRow(2, false)],
    ]);
    render(<StationedTable {...props} inspection={inspection} now={new Date('2026-11-13T09:00:00.000Z')} />);
    expect(headers().at(-1)).toBe('예턴');
    expect(screen.getAllByTestId('turn-five')).toHaveLength(2);
    expect(screen.getByText('하후돈').closest('tr')?.textContent).toContain('NPC');
    expect(screen.getByText('조조').closest('tr')?.textContent).not.toContain('NPC');
  });
});

describe('다음 턴 글자', () => {
  const summary = {
    gameDate: { year: 191, month: 3 },
    nowTick: 0,
    msPerTick: 60_000,
    turnTermMinutes: 60,
  } as unknown as WorldSummary;

  it('감찰 시각이 없으면 nextTurnTick으로 센 게임 연월만 쓴다', () => {
    expect(nextTurnText({ nextTurnTick: 60 }, undefined, summary)).toBe('191년 4월');
    expect(nextTurnText({ nextTurnTick: 60 }, undefined, undefined)).toBe('—');
  });

  it('감찰 시각이 있으면 그 시각을 쓴다', () => {
    const now = new Date(2026, 10, 13, 9, 0);
    expect(
      nextTurnText({ nextTurnTick: 60 }, { nextTurnAt: new Date(2026, 10, 13, 9, 30).toISOString() }, summary, now),
    ).toBe('09:30');
  });
});
