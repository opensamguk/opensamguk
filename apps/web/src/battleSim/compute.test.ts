import { BALANCE, simulateBattle, unitSetSchema } from '@opensamguk/rules';
import { createRng } from '@opensamguk/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompute } from './compute';
import { PUBLIC_UNIT_SET } from './publicUnitSet';
import { GENERAL_CREW_MAX, LIMITS, type BattleRunRequest } from './request';

// T4-34 E1. compute가 main의 simulateBattle(input, createRng(seed))를 그대로 한 번 부르는지 같은 함수와 대조한다.
// simulateBattle은 원본을 부르는 spy로 감싸 잘못된 입력에서 부르지 않는지도 본다.
vi.mock('@opensamguk/rules', async (importOriginal) => {
  const original = await importOriginal<typeof import('@opensamguk/rules')>();
  return { ...original, simulateBattle: vi.fn(original.simulateBattle) };
});

const unitSet = unitSetSchema.parse(PUBLIC_UNIT_SET);
const compute = createCompute(PUBLIC_UNIT_SET);

function general(overrides: Partial<BattleRunRequest> = {}): BattleRunRequest {
  return {
    type: 'run',
    requestId: 1,
    seed: '1',
    attacker: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
    defender: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
    attackerTech: 0,
    defenderTech: 0,
    ...overrides,
  };
}
function wall(overrides: Partial<BattleRunRequest> = {}): BattleRunRequest {
  return general({ defender: { crew: 3000, crewType: 1000, train: 100, atmos: 100 }, defence: 2000, ...overrides });
}

beforeEach(() => {
  vi.mocked(simulateBattle).mockClear();
});

describe('compute와 simulateBattle의 차등', () => {
  it('상한 상수가 rules의 BALANCE와 같다', () => {
    expect(LIMITS.MAX_TECH).toBe(BALANCE.MAX_TECH);
    expect(LIMITS.CREW_PER_LEADERSHIP).toBe(BALANCE.CREW_PER_LEADERSHIP);
    expect(GENERAL_CREW_MAX).toBe(100 * BALANCE.CREW_PER_LEADERSHIP);
  });

  it('시드 200개 이상과 장수·성벽 입력에서 결과가 같은 입력의 simulateBattle과 깊게 같다', () => {
    const generals = unitSet.crewTypes.filter((u) => u.armType > 0).map((u) => u.id);
    let cases = 0;
    for (let i = 0; i < 240; i++) {
      const seed = `seed-${i}-${'가'.repeat(i % 3)}`;
      const attacker = {
        crew: 1 + ((i * 137) % GENERAL_CREW_MAX),
        crewType: generals[i % generals.length]!,
        train: (i * 7) % 101,
        atmos: (i * 11) % 101,
      };
      const defenderGeneral = {
        crew: 1 + ((i * 251) % GENERAL_CREW_MAX),
        crewType: generals[(i + 1) % generals.length]!,
        train: (i * 13) % 101,
        atmos: (i * 17) % 101,
      };
      const attackerTech = (i * 97) % (BALANCE.MAX_TECH + 1);
      const defenderTech = (i * 59) % (BALANCE.MAX_TECH + 1);
      const requests: BattleRunRequest[] = [
        general({ requestId: i + 1, seed, attacker, defender: defenderGeneral, attackerTech, defenderTech }),
        wall({
          requestId: i + 1,
          seed,
          attacker,
          defender: { crew: 1 + ((i * 331) % LIMITS.WALL_MAX), crewType: 1000, train: 100, atmos: 100 },
          defence: (i * 71) % (LIMITS.WALL_MAX + 1),
          attackerTech,
          defenderTech,
        }),
      ];
      for (const request of requests) {
        const { type, requestId, seed: s, ...input } = request;
        expect(type).toBe('run');
        const expected = simulateBattle({ ...input, unitSet }, createRng(s));
        const reply = compute(request);
        expect(reply).toEqual({
          type: 'result',
          requestId,
          seed: s,
          input,
          unitSetId: 'basic',
          attacker: expected.attacker,
          defender: expected.defender,
        });
        cases++;
      }
    }
    expect(cases).toBe(480);
  });

  it('같은 요청 두 번의 결과가 같고 시드가 다르면 결과가 달라질 수 있다', () => {
    const first = compute(general({ seed: 'same' }));
    expect(compute(general({ seed: 'same' }))).toEqual(first);
    const outcomes = new Set(
      Array.from({ length: 20 }, (_, i) => {
        const reply = compute(general({ seed: `other-${i}` }));
        return reply.type === 'result' ? JSON.stringify([reply.attacker, reply.defender]) : 'error';
      }),
    );
    expect(outcomes.has('error')).toBe(false);
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('받은 객체에 남는 칸이 섞이지 않고 결과 input은 검사를 지난 값만 담는다', () => {
    const reply = compute(general());
    expect(reply.type).toBe('result');
    if (reply.type === 'result')
      expect(Object.keys(reply.input).sort()).toEqual(['attacker', 'attackerTech', 'defender', 'defenderTech']);
    const walled = compute(wall());
    if (walled.type === 'result') expect(walled.input.defence).toBe(2000);
  });
});

describe('잘못된 입력', () => {
  const g = general();
  const cases: Array<[string, unknown, string]> = [
    ['NaN 병력', { ...g, attacker: { ...g.attacker, crew: Number.NaN } }, 'attacker.crew'],
    ['Infinity 기술', { ...g, attackerTech: Number.POSITIVE_INFINITY }, 'attackerTech'],
    ['음수 훈련', { ...g, defender: { ...g.defender, train: -1 } }, 'defender.train'],
    ['소수 사기', { ...g, attacker: { ...g.attacker, atmos: 1.5 } }, 'attacker.atmos'],
    ['문자열 병력', { ...g, attacker: { ...g.attacker, crew: '1000' } }, 'attacker.crew'],
    ['빠진 칸', { ...g, defenderTech: undefined }, 'defenderTech'],
    ['남는 칸', { ...g, unitSet: {} }, 'unitSet'],
    ['병력 안의 남는 칸', { ...g, attacker: { ...g.attacker, leadership: 1 } }, 'attacker.leadership'],
    ['병력 범위 밖', { ...g, attacker: { ...g.attacker, crew: GENERAL_CREW_MAX + 1 } }, 'attacker.crew'],
    ['병력 0', { ...g, defender: { ...g.defender, crew: 0 } }, 'defender.crew'],
    ['기술 범위 밖', { ...g, defenderTech: LIMITS.MAX_TECH + 1 }, 'defenderTech'],
    ['없는 병종 9999', { ...g, attacker: { ...g.attacker, crewType: 9999 } }, 'attacker.crewType'],
    ['공격 쪽 성벽 1000', { ...g, attacker: { ...g.attacker, crewType: 1000 } }, 'attacker.crewType'],
    ['성벽인데 훈련 99', { ...wall(), defender: { ...wall().defender, train: 99 } }, 'defender.train'],
    ['성벽인데 defence 없음', { ...wall(), defence: undefined }, 'defence'],
    ['성벽 값 범위 밖', { ...wall(), defender: { ...wall().defender, crew: LIMITS.WALL_MAX + 1 } }, 'defender.crew'],
    ['장수인데 defence', { ...g, defence: 0 }, 'defence'],
    ['빈 시드', { ...g, seed: '' }, 'seed'],
    ['65자 시드', { ...g, seed: 'a'.repeat(65) }, 'seed'],
    ['문자열이 아닌 시드', { ...g, seed: 1 }, 'seed'],
    ['종류가 다름', { ...g, type: 'other' }, 'type'],
  ];
  for (const [name, message, field] of cases) {
    it(`${name}이면 INVALID_INPUT과 칸 이름을 답하고 simulateBattle을 부르지 않는다`, () => {
      const reply = compute(message);
      expect(reply).toEqual({ type: 'error', requestId: 1, code: 'INVALID_INPUT', field });
      expect(simulateBattle).not.toHaveBeenCalled();
    });
  }

  it('정수가 아닌 requestId는 requestId null로 답한다', () => {
    for (const requestId of [1.5, 0, -1, '1', Number.NaN, undefined]) {
      expect(compute({ ...g, requestId })).toEqual({
        type: 'error',
        requestId: null,
        code: 'INVALID_INPUT',
        field: 'requestId',
      });
    }
    expect(compute(null)).toMatchObject({ type: 'error', requestId: null, code: 'INVALID_INPUT' });
    expect(compute('run')).toMatchObject({ type: 'error', requestId: null, code: 'INVALID_INPUT' });
    expect(simulateBattle).not.toHaveBeenCalled();
  });
});

describe('병종표 오류', () => {
  const base = JSON.parse(JSON.stringify(PUBLIC_UNIT_SET)) as {
    defaultCrewTypeId: number;
    crewTypes: Array<{ id: number; attack: unknown }>;
  };
  const broken: Array<[string, unknown]> = [
    ['schema 위반', { ...base, crewTypes: base.crewTypes.map((u, i) => (i === 0 ? { ...u, attack: 'x' } : u)) }],
    ['id 중복', { ...base, crewTypes: [...base.crewTypes, base.crewTypes[1]] }],
    ['기본 병종 없음', { ...base, defaultCrewTypeId: 4242 }],
    ['병종표 아님', null],
  ];
  for (const [name, raw] of broken) {
    it(`${name}이면 모든 요청에 UNIT_SET_INVALID를 답한다`, () => {
      const bad = createCompute(raw);
      expect(bad(general({ requestId: 7 }))).toEqual({ type: 'error', requestId: 7, code: 'UNIT_SET_INVALID' });
      expect(bad(wall({ requestId: 8 }))).toEqual({ type: 'error', requestId: 8, code: 'UNIT_SET_INVALID' });
      expect(simulateBattle).not.toHaveBeenCalled();
    });
  }
});
