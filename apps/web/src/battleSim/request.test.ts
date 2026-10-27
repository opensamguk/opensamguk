import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CREW_TYPE_ID, UNIT_CHOICES } from './publicUnitSet';
import { checkForm, defaultForm, formBody, LIMITS, problemText, requestProblems, type BattleForm } from './request';

// T4-34 화면 쪽 검사. 메인 스레드와 Worker가 같은 함수를 쓴다.
const form = (patch: (f: BattleForm) => BattleForm = (f) => f) => patch(defaultForm(DEFAULT_CREW_TYPE_ID));
const fields = (f: BattleForm) => checkForm(f, UNIT_CHOICES).problems.map((p) => p.field);

describe('폼 검사', () => {
  it('통합판을 고르면 명시한 통솔·무력만 보내고 성벽 쪽 값은 보내지 않는다', () => {
    const base = form((value) => ({ ...value, statProfile: 'five-stats' }));
    expect(checkForm(base, UNIT_CHOICES).body).toBeNull();
    const entered = {
      ...base,
      attackerCommander: { leadership: '78', strength: '80' },
      defenderCommander: { leadership: '50', strength: '0' },
    };
    expect(checkForm(entered, UNIT_CHOICES).body).toMatchObject({
      commanders: { attacker: { leadership: 78, strength: 80 }, defender: { leadership: 50, strength: 0 } },
    });
    expect(
      checkForm(
        { ...entered, defenderKind: 'wall', defenderCommander: { leadership: 'bad', strength: '' } },
        UNIT_CHOICES,
      ).body,
    ).toMatchObject({ commanders: { attacker: { leadership: 78, strength: 80 } } });
    expect(checkForm({ ...entered, statProfile: 'legacy' }, UNIT_CHOICES).body).not.toHaveProperty('commanders');
  });
  it('기본값은 게임 상태와 무관한 고정값이고 그대로 보낼 수 있다', () => {
    const checked = checkForm(form(), UNIT_CHOICES);
    expect(checked.problems).toEqual([]);
    expect(checked.body).toEqual({
      seed: '1',
      attacker: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
      defender: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
      attackerTech: 0,
      defenderTech: 0,
    });
  });

  it('병력에 1.5·-1·10001·빈칸·문자를 넣으면 그 칸 이유를 낸다', () => {
    const texts = new Map<string, string>();
    for (const crew of ['1.5', '-1', '10001', '', 'abc', 'Infinity', 'NaN']) {
      const checked = checkForm(
        form((f) => ({ ...f, attacker: { ...f.attacker, crew } })),
        UNIT_CHOICES,
      );
      expect(checked.body, crew).toBeNull();
      const found = checked.problems.find((p) => p.field === 'attacker.crew');
      expect(found, crew).toBeDefined();
      texts.set(crew, problemText(found!));
    }
    expect(texts.get('1.5')).toBe('정수로 넣어 주세요.');
    expect(texts.get('-1')).toBe('1~10,000 사이로 넣어 주세요.');
    expect(texts.get('10001')).toBe('1~10,000 사이로 넣어 주세요.');
    expect(texts.get('')).toBe('값을 넣어 주세요.');
    expect(texts.get('abc')).toBe('숫자로 넣어 주세요.');
    expect(texts.get('Infinity')).toBe('숫자로 넣어 주세요.');
  });

  it('시드는 다듬지 않고 1~64자만 받는다', () => {
    expect(
      checkForm(
        form((f) => ({ ...f, seed: ' a ' })),
        UNIT_CHOICES,
      ).body?.seed,
    ).toBe(' a ');
    expect(fields(form((f) => ({ ...f, seed: '' })))).toEqual(['seed']);
    expect(fields(form((f) => ({ ...f, seed: 'x'.repeat(65) })))).toEqual(['seed']);
    expect(fields(form((f) => ({ ...f, seed: 'x'.repeat(64) })))).toEqual([]);
  });

  it('장수 쪽에서 성벽 1000이나 없는 병종을 고르면 막는다', () => {
    expect(fields(form((f) => ({ ...f, attacker: { ...f.attacker, crewType: '1000' } })))).toEqual([
      'attacker.crewType',
    ]);
    expect(fields(form((f) => ({ ...f, defender: { ...f.defender, crewType: '9999' } })))).toEqual([
      'defender.crewType',
    ]);
  });

  it('성벽이면 병종 1000·훈련 100·사기 100과 수비 값을 보내고 장수면 수비 값을 보내지 않는다', () => {
    const walled = form((f) => ({ ...f, defenderKind: 'wall', wall: '3000', defence: '2000' }));
    expect(checkForm(walled, UNIT_CHOICES).body).toMatchObject({
      defender: { crew: 3000, crewType: 1000, train: 100, atmos: 100 },
      defence: 2000,
    });
    expect('defence' in formBody(form())).toBe(false);
    expect(fields({ ...walled, wall: String(LIMITS.WALL_MAX + 1) })).toEqual(['defender.crew']);
    expect(fields({ ...walled, defence: '-1' })).toEqual(['defence']);
    expect(fields({ ...walled, defence: '' })).toEqual(['defence']);
  });

  it('기술은 0~12,000 정수다', () => {
    expect(fields(form((f) => ({ ...f, attackerTech: '12001', defenderTech: '0.5' })))).toEqual([
      'attackerTech',
      'defenderTech',
    ]);
  });

  it('문제를 모두 모은다', () => {
    const problems = requestProblems(
      { type: 'run', requestId: 1, ...formBody(form((f) => ({ ...f, seed: '', attackerTech: '-1' }))) },
      UNIT_CHOICES,
    );
    expect(problems.map((p) => p.field)).toEqual(['seed', 'attackerTech']);
  });
});

describe('상한 상수', () => {
  it('성벽 상한 12,500이 resources/map/che.json 도시 max.wall·max.defence 최댓값과 같다', () => {
    const map = JSON.parse(readFileSync(new URL('../../../../resources/map/che.json', import.meta.url), 'utf8')) as {
      cities: Array<{ max: { wall: number; defence: number } }>;
    };
    const wall = Math.max(...map.cities.map((c) => c.max.wall));
    const defence = Math.max(...map.cities.map((c) => c.max.defence));
    expect(LIMITS.WALL_MAX).toBe(wall);
    expect(LIMITS.WALL_MAX).toBe(defence);
  });

  it('장수 병종 목록은 armType > 0인 병종이다', () => {
    expect(UNIT_CHOICES.filter((u) => u.armType > 0).map((u) => u.id)).toEqual([1100, 1200, 1300]);
    expect(UNIT_CHOICES.find((u) => u.id === 1000)?.armType).toBe(0);
  });
});
