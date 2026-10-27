import { describe, expect, it } from 'vitest';
import { applyModifiers } from '../modifiers';
import { commanderBattleModifiers, fiveStatsBattleModifiers } from './fiveStatsBattle';

describe('AC-INT-09 실제 지휘관 전투 보정', () => {
  it.each([
    [0, 90, 110],
    [50, 100, 100],
    [100, 110, 90],
  ])('통솔/무력 %i의 피해 보정은 각각 %i/%i다', (stat, dealt, taken) => {
    const modifiers = fiveStatsBattleModifiers({
      leadership: stat!,
      strength: stat!,
      intel: 50,
      politics: 50,
      charm: 50,
    });
    expect(applyModifiers(100, modifiers.dealt)).toBeCloseTo(dealt!);
    expect(applyModifiers(100, modifiers.taken)).toBeCloseTo(taken!);
    expect(modifiers.dealt).toHaveLength(1);
    expect(modifiers.taken).toHaveLength(1);
  });
  it('지력·정치·매력을 일반 전투 배율에 섞지 않는다', () => {
    const base = { leadership: 55, strength: 65, intel: 0, politics: 0, charm: 0 };
    expect(fiveStatsBattleModifiers(base)).toEqual(
      fiveStatsBattleModifiers({ ...base, intel: 100, politics: 100, charm: 100 }),
    );
  });
  it('누락하거나 범위를 벗어난 지휘관 능력치를 보정하지 않는다', () => {
    expect(() =>
      fiveStatsBattleModifiers({ leadership: 101, strength: 50, intel: 50, politics: 50, charm: 50 }),
    ).toThrow();
    expect(() =>
      fiveStatsBattleModifiers({ leadership: 50, strength: 50, intel: 50, politics: 50, charm: undefined! }),
    ).toThrow();
  });
  it.each([0, 50, 100])('미리보기의 두 값 %i는 실제 5능력치 지휘관의 같은 보정이다', (value) => {
    const combat = { leadership: value, strength: 100 - value };
    expect(commanderBattleModifiers(combat)).toEqual(
      fiveStatsBattleModifiers({ ...combat, intel: 17, politics: 83, charm: 42 }),
    );
    for (const invalid of [-1, 101, 0.5, NaN, Infinity, undefined, '50']) {
      expect(() => commanderBattleModifiers({ ...combat, leadership: invalid as number })).toThrow();
      expect(() => commanderBattleModifiers({ ...combat, strength: invalid as number })).toThrow();
    }
  });
});
