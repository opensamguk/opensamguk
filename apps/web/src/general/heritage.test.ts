import { describe, expect, it } from 'vitest';
import type { StatValues } from './createForm';
import { checkHeritage, HERITAGE_STALE, withBonus } from './heritage';

const FIVE = { count: 5, total: 275, min: 15, max: 90 };
const H = { balance: 4, perStat: 3, perGeneral: 6 };
const five = (l: string, s = '55', i = '55', p = '55', c = '55'): StatValues => ({
  leadership: l,
  strength: s,
  intel: i,
  politics: p,
  charm: c,
});

describe('T4-96 AC-P2-33 유산 배분 안내', () => {
  it('처음에는 사용 0점이고 문제가 없다', () => {
    const result = checkHeritage({}, five('55'), FIVE, H, false);
    expect([result.spent, result.after, result.problems]).toEqual([0, 4, []]);
    expect(result.rows.map((row) => row.why)).toEqual([null, null, null, null, null]);
  });

  it('막힘 이유는 기본값 없음 → 능력치당 → 최종 최대 → 장수당 → 잔액 순이다', () => {
    const rich = { ...H, balance: 9 };
    expect(checkHeritage({}, five(''), FIVE, rich, false).rows[0]!.why).toBe(
      '기본 통솔에 정수를 넣으면 유산을 붙일 수 있습니다.',
    );
    expect(checkHeritage({ leadership: 3 }, five('55'), FIVE, rich, false).rows[0]!.why).toBe(
      '능력치 하나에는 +3까지입니다.',
    );
    expect(checkHeritage({ leadership: 1 }, five('89'), FIVE, rich, false).rows[0]!.why).toBe(
      '최종값이 최대 90에 닿아 더 올릴 수 없습니다.',
    );
    // 잔액이 6을 넘어도 한 장수 한도가 먼저 나온다.
    expect(checkHeritage({ leadership: 3, intel: 3 }, five('55'), FIVE, rich, false).rows[1]!.why).toBe(
      '한 장수에는 합계 +6까지입니다.',
    );
    expect(checkHeritage({ leadership: 2, intel: 2 }, five('55'), FIVE, H, false).rows[1]!.why).toBe(
      '보유 4점을 모두 배분했습니다.',
    );
    expect(checkHeritage({}, five('55'), FIVE, { ...H, balance: 0 }, false).rows[1]!.why).toBe(
      '보유한 유산 포인트가 없습니다.',
    );
  });

  it('기본값을 올려 최종값이 최대를 넘거나 잔액이 줄면 배분을 바꾸지 않고 문제로 막는다', () => {
    const bonus = { leadership: 2 };
    const over = checkHeritage(bonus, five('90'), FIVE, H, false);
    expect(over.problems).toEqual(['통솔 최종값은 92입니다. 최대 90까지라 유산이나 기본값을 줄이세요.']);
    expect(over.rows[0]!.bonus).toBe(2);
    const short = checkHeritage({ leadership: 2, intel: 1 }, five('55'), FIVE, { ...H, balance: 1 }, false);
    expect(short.problems).toEqual(['유산 배분은 3점이고 보유는 1점입니다. 2점 줄이세요.']);
    expect(short.after).toBe(-2);
  });

  it('잔액 확인이 필요하면 그 문장을 맨 앞에 둔다', () => {
    expect(checkHeritage({ leadership: 1 }, five('55'), FIVE, H, true).problems[0]).toBe(HERITAGE_STALE);
  });

  it('3능력치 월드는 통솔·무력·지력만 셈하고 요약용 최종값만 보너스를 더한다', () => {
    const three = { count: 3, total: 165, min: 15, max: 80 };
    const values = { leadership: '55', strength: '55', intel: '55' };
    expect(checkHeritage({ intel: 2 }, values, three, H, false).rows.map((row) => row.final)).toEqual([55, 55, 57]);
    expect(withBonus(values, { intel: 2 })).toEqual({ leadership: '55', strength: '55', intel: '57' });
    expect(values.intel).toBe('55');
  });
});
