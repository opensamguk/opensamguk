// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneralView, NationView } from '../game/types';
import { GarrisonLine, GeneralNameCell } from './CityInfo';
import { NationSummaryGrid } from './NationInfo';

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
