import { describe, expect, it } from 'vitest';
import { bandGroupOf, bandGroups, bandRole, roleGroups } from './commandBand';

const cmd = (key: string, category: string, available?: boolean) => ({ key, category, available });

describe('직위별 명령 띠', () => {
  it('직위 값으로 띠 종류를 정한다', () => {
    expect(bandRole({ nationId: null, officerLevel: 0 })).toBe('free');
    expect(bandRole({ nationId: 3, officerLevel: 12 })).toBe('ruler');
    expect(bandRole({ nationId: 3, officerLevel: 7 })).toBe('chief');
    expect(bandRole({ nationId: 3, officerLevel: 4 })).toBe('governor');
    expect(bandRole({ nationId: 3, officerLevel: 1 })).toBe('officer');
    expect(bandRole(undefined)).toBe('free');
  });

  it('군주만 임면을, 재야는 첩보와 개인 명령만 띠에 둔다', () => {
    expect(roleGroups('ruler')).toContain('appoint');
    expect(roleGroups('chief')).not.toContain('appoint');
    expect(roleGroups('officer')).not.toContain('diplomacy');
    expect(roleGroups('free')).toEqual(['intel', 'wealth', 'friends', 'conduct', 'rest']);
  });

  it('명령 키를 묶음으로 나누고 모르는 키는 서버 분류로 정한다', () => {
    expect(bandGroupOf(cmd('farm', 'domestic'))).toBe('domestic');
    expect(bandGroupOf(cmd('nation_declare', 'nation'))).toBe('diplomacy');
    expect(bandGroupOf(cmd('nation_research_halberd', 'nation'))).toBe('military');
    expect(bandGroupOf(cmd('spy', 'strategy'))).toBe('intel');
    expect(bandGroupOf(cmd('new_scheme', 'strategy'))).toBe('scheme');
    expect(bandGroupOf(cmd('mystery', 'new-category'))).toBe('new-category');
  });

  it('직위 밖 묶음은 실행할 수 있는 명령만 남기고 순서는 세력 → 임면 → 개인 → 모름이다', () => {
    const groups = bandGroups(
      [
        cmd('rest', 'personal'),
        cmd('farm', 'domestic', false),
        cmd('spy', 'strategy'),
        cmd('trade_rice', 'personal', true),
        cmd('mystery', 'new-category'),
      ],
      'free',
    );
    expect(groups.map((group) => group.key)).toEqual(['intel', 'wealth', 'rest', 'new-category']);
    const ruler = bandGroups([cmd('farm', 'domestic', false), cmd('nation_reward', 'nation')], 'ruler');
    expect(ruler.map((group) => [group.key, group.side])).toEqual([
      ['domestic', 'realm'],
      ['appoint', 'appoint'],
    ]);
  });
});
