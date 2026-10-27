import { describe, expect, it } from 'vitest';
import { checkCreation, FIVE_STAT_PRESETS, FIVE_STATS } from './createForm';

const stats = (l: string, s: string, i: string) => ({ leadership: l, strength: s, intel: i });

describe('장수 생성 입력 검사', () => {
  it('월드의5값275·15~90을 검사하고 기존3값 전송에는 정치·매력을 넣지 않는다', () => {
    const values = { leadership: '55', strength: '55', intel: '55', politics: '55', charm: '55' };
    const rules = { count: 5, total: 275, min: 15, max: 90 };
    expect(checkCreation('사람', values, rules).stats).toEqual({
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    });
    expect(checkCreation('사람', values).stats).toEqual({ leadership: 55, strength: 55, intel: 55 });
    expect(checkCreation('사람', { leadership: '55', strength: '55', intel: '55' }, rules).stats).toBeNull();
    expect(checkCreation('사람', { ...values, politics: '91', charm: '19' }, rules).problems).toContain(
      '정치는 15~90 사이여야 합니다.',
    );
    for (const preset of FIVE_STAT_PRESETS) {
      const draft = Object.fromEntries(
        FIVE_STATS.map((stat, index) => [stat.key, String(preset.values[index])]),
      ) as typeof values;
      expect(checkCreation('사람', draft, rules).problems).toEqual([]);
    }
  });
  it('합계 165, 각각 15~80이면 통과하고 남은 점수는 0이다', () => {
    const check = checkCreation(' 조운 ', stats('80', '70', '15'));
    expect(check.problems).toEqual([]);
    expect(check.name).toBe('조운');
    expect(check.stats).toEqual({ leadership: 80, strength: 70, intel: 15 });
    expect(check.remaining).toBe(0);
  });

  it('합계를 넘거나 모자라면 남은 점수와 이유를 준다', () => {
    const over = checkCreation('조운', stats('80', '80', '15'));
    expect(over.remaining).toBe(-10);
    expect(over.stats).toBeNull();
    expect(over.problems).toEqual(['능력치 합계가 10점 넘습니다. 합계는 165입니다.']);
    expect(checkCreation('조운', stats('50', '50', '50')).problems).toEqual(['능력치를 15점 더 나눠야 합니다.']);
  });

  it('범위 밖 능력치와 빈 칸을 막는다', () => {
    expect(checkCreation('조운', stats('81', '70', '14')).problems).toContain('통솔은 15~80 사이여야 합니다.');
    expect(checkCreation('조운', stats('', '80', '80')).problems).toContain('통솔에 정수를 넣으세요.');
    expect(checkCreation('조운', stats('55.5', '55', '54.5')).stats).toBeNull();
  });

  it('이름은 1~6글자 한글·한자·영문·숫자다', () => {
    expect(checkCreation('', stats('55', '55', '55')).problems).toEqual(['이름을 입력하세요.']);
    expect(checkCreation('일곱글자이름임', stats('55', '55', '55')).problems).toEqual(['이름은 6글자까지입니다.']);
    expect(checkCreation('조 운', stats('55', '55', '55')).problems).toEqual(['이름은 한글·한자·영문·숫자만 씁니다.']);
    expect(checkCreation('趙雲Z1', stats('55', '55', '55')).problems).toEqual([]);
  });
});
