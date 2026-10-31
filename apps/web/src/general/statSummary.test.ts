import { describe, expect, it } from 'vitest';
import type { StatValues } from './createForm';
import { EVEN_TEXT, stepStat, summarizeStats } from './statSummary';

const five = (l: string, s: string, i: string, p: string, c: string): StatValues => ({
  leadership: l,
  strength: s,
  intel: i,
  politics: p,
  charm: c,
});

describe('이 장수는 (INT-20)', () => {
  it('가장 높은 능력치의 강점과 가장 낮은 능력치의 주의를 한 줄씩 낸다', () => {
    expect(summarizeStats(five('50', '30', '90', '60', '45'), { count: 5 })).toEqual({
      strong: '지력이 높아 기술 연구와 화계에 강합니다.',
      caution: '무력이 낮아 직접 싸우면 피해를 적게 줍니다.',
    });
  });

  it('같은 값이면 앞 능력치를 고른다', () => {
    expect(summarizeStats(five('90', '90', '35', '35', '25'), { count: 5 })).toEqual({
      strong: '통솔이 높아 많은 병력을 지휘하고 받는 피해를 줄입니다.',
      caution: '매력이 낮아 모병 비용이 많이 듭니다.',
    });
  });

  it('모두 같으면 고르다는 문장만 낸다', () => {
    expect(summarizeStats(five('55', '55', '55', '55', '55'), { count: 5 })).toEqual({
      strong: EVEN_TEXT,
      caution: null,
    });
  });

  it('3능력치 월드는 정치·매력을 보지 않는다', () => {
    expect(summarizeStats(five('40', '70', '55', '15', ''), {})).toEqual({
      strong: '무력이 높아 직접 싸울 때 피해를 크게 줍니다.',
      caution: '통솔이 낮아 지휘할 수 있는 병력이 적습니다.',
    });
  });

  it('정수가 아닌 칸이 있으면 쓰지 않는다', () => {
    expect(summarizeStats(five('55', '', '55', '55', '55'), { count: 5 })).toBeNull();
    expect(summarizeStats(five('55', '5.5', '55', '55', '55'), { count: 5 })).toBeNull();
  });
});

describe('−/+ 버튼 (INT-20)', () => {
  const rules = { min: 15, max: 90 };
  it('한 칸씩 움직이고 범위 끝에서 막는다', () => {
    expect(stepStat('50', 1, rules, 3)).toBe('51');
    expect(stepStat('50', -1, rules, 3)).toBe('49');
    expect(stepStat('90', 1, rules, 3)).toBeNull();
    expect(stepStat('15', -1, rules, 0)).toBeNull();
  });

  it('남은 점수가 없으면 늘리지 못하고 줄이기만 한다', () => {
    expect(stepStat('50', 1, rules, 0)).toBeNull();
    expect(stepStat('50', -1, rules, -4)).toBe('49');
  });

  it('범위 밖 값은 가장 가까운 끝으로 들어오고 정수가 아니면 막는다', () => {
    expect(stepStat('99', -1, rules, -9)).toBe('90');
    expect(stepStat('3', 1, rules, 20)).toBe('15');
    expect(stepStat('', 1, rules, 20)).toBeNull();
    expect(stepStat('4.5', -1, rules, 20)).toBeNull();
  });
});
