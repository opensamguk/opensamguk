import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { simulateBattle, type BattleForce, type BattleInput, type DeepReadonly } from '../index';
import { testUnits } from '../../test/commandFixture';

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

type Golden = {
  name: string;
  input: Omit<BattleInput, 'unitSet'>;
  expected: { attacker?: BattleForce; defender?: BattleForce; error?: string; calls: number; next: number };
};
// main 5432ee83의 fight를 실제 실행해 얻은 값이다. 후보 함수에서 다시 생성하지 않는다.
const cases: Golden[] = [
  {
    name: '열 페이즈',
    input: {
      attacker: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      attacker: {
        crew: 5434,
        crewType: 1100,
        train: 100,
        atmos: 50,
      },
      defender: {
        crew: 5677,
        crewType: 1100,
        train: 100,
        atmos: 50,
      },
      calls: 20,
      next: 0.3014609052333981,
    },
  },
  {
    name: '상성과 기술',
    input: {
      attacker: {
        crew: 2000,
        crewType: 1300,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 2000,
        crewType: 1200,
        train: 100,
        atmos: 100,
      },
      attackerTech: 12000,
      defenderTech: 3000,
    },
    expected: {
      attacker: {
        crew: 1384,
        crewType: 1300,
        train: 100,
        atmos: 75,
      },
      defender: {
        crew: 0,
        crewType: 1200,
        train: 100,
        atmos: 75,
      },
      calls: 10,
      next: 0.9799679480493069,
    },
  },
  {
    name: '성벽 보정',
    input: {
      attacker: {
        crew: 2000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 1000,
        crewType: 1000,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
      defence: 200,
    },
    expected: {
      attacker: {
        crew: 1536,
        crewType: 1100,
        train: 100,
        atmos: 50,
      },
      defender: {
        crew: 591,
        crewType: 1000,
        train: 100,
        atmos: 50,
      },
      calls: 20,
      next: 0.016839083982631564,
    },
  },
  {
    name: '최소 피해와 동시 전멸',
    input: {
      attacker: {
        crew: 1,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 1,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      attacker: {
        crew: 0,
        crewType: 1100,
        train: 100,
        atmos: 95,
      },
      defender: {
        crew: 0,
        crewType: 1100,
        train: 100,
        atmos: 95,
      },
      calls: 2,
      next: 0.2546069794334471,
    },
  },
  {
    name: '사기 동시 소진',
    input: {
      attacker: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 50,
      },
      defender: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 50,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      attacker: {
        crew: 7069,
        crewType: 1100,
        train: 100,
        atmos: 0,
      },
      defender: {
        crew: 7031,
        crewType: 1100,
        train: 100,
        atmos: 0,
      },
      calls: 20,
      next: 0.922679650131613,
    },
  },
  {
    name: '빈 교전의 누락 병종',
    input: {
      attacker: {
        crew: 0,
        crewType: 9999,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 10000,
        crewType: 9998,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      attacker: {
        crew: 0,
        crewType: 9999,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 10000,
        crewType: 9998,
        train: 100,
        atmos: 100,
      },
      calls: 0,
      next: 0.20431907125748694,
    },
  },
  {
    name: '사기 소진의 누락 병종',
    input: {
      attacker: {
        crew: 10000,
        crewType: 9999,
        train: 100,
        atmos: 0,
      },
      defender: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      attacker: {
        crew: 10000,
        crewType: 9999,
        train: 100,
        atmos: 0,
      },
      defender: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      calls: 0,
      next: 0.994826190173626,
    },
  },
  {
    name: '공격 병종 누락',
    input: {
      attacker: {
        crew: 10000,
        crewType: 9999,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      error: '전투 병종이 없습니다.',
      calls: 0,
      next: 0.3348739603534341,
    },
  },
  {
    name: '수비 병종 누락',
    input: {
      attacker: {
        crew: 10000,
        crewType: 1100,
        train: 100,
        atmos: 100,
      },
      defender: {
        crew: 10000,
        crewType: 9999,
        train: 100,
        atmos: 100,
      },
      attackerTech: 0,
      defenderTech: 0,
    },
    expected: {
      error: '전투 병종이 없습니다.',
      calls: 0,
      next: 0.599688314134255,
    },
  },
];

describe('T4-33 전투 계산', () => {
  it.each(cases)('$name의 결과·예외·난수 소비가 원 구현과 같다', ({ name, input, expected }) => {
    const value = { ...structuredClone(input), unitSet: structuredClone(testUnits) };
    const before = structuredClone(value);
    const frozen = freeze(value);
    const source = rngFor('t4-33-pure', name);
    let calls = 0;
    const rng = {
      ...source,
      next: () => {
        calls++;
        return source.next();
      },
    };
    let outcome: { attacker?: BattleForce; defender?: BattleForce; error?: string };
    try {
      outcome = simulateBattle(frozen, rng);
    } catch (error) {
      outcome = { error: (error as Error).message };
    }
    expect({ ...outcome, calls, next: source.next() }).toEqual(expected);
    expect(value).toEqual(before);
  });

  it('같은 입력과 시드는 같은 결과를 내고 네 필드의 독립 사본만 돌려준다', () => {
    const force = { crew: 10000, crewType: 1100, train: 100, atmos: 100, rice: 123, extra: '보존' };
    const input = freeze({
      attacker: force,
      defender: force,
      attackerTech: 0,
      defenderTech: 0,
      unitSet: structuredClone(testUnits),
    });
    const aRng = rngFor('copy'),
      bRng = rngFor('copy');
    const a = simulateBattle(input, aRng),
      b = simulateBattle(input, bRng);
    expect(a).toEqual(b);
    expect(aRng.next()).toBe(bRng.next());
    expect(a.attacker).not.toBe(force);
    expect(a.defender).not.toBe(force);
    expect(a.attacker).not.toBe(a.defender);
    expect(Object.keys(a.attacker)).toEqual(['crew', 'crewType', 'train', 'atmos']);
    expect(Object.keys(a.defender)).toEqual(['crew', 'crewType', 'train', 'atmos']);
    a.attacker.crew = 0;
    expect(force.crew).toBe(10000);
    expect(a.defender.crew).toBe(b.defender.crew);
  });

  it('방어 보정을 생략하면 0과 같은 계산과 난수 순서를 쓴다', () => {
    const input = { ...cases[0]!.input, unitSet: testUnits };
    const a = rngFor('default-defence'),
      b = rngFor('default-defence');
    expect(simulateBattle(input, a)).toEqual(simulateBattle({ ...input, defence: 0 }, b));
    expect(a.next()).toBe(b.next());
  });

  it.each(['crew', 'atmos'] as const)('수비의 %s가 0이면 병종을 읽거나 난수를 쓰지 않는다', (field) => {
    const attacker = { crew: 10, crewType: 9998, train: 100, atmos: 100 };
    const defender = { ...attacker, crewType: 9999, [field]: 0 };
    const rng = rngFor('empty-defender'),
      reference = rngFor('empty-defender');
    expect(simulateBattle({ attacker, defender, attackerTech: 0, defenderTech: 0, unitSet: testUnits }, rng)).toEqual({
      attacker,
      defender,
    });
    expect(rng.next()).toBe(reference.next());
  });
});
