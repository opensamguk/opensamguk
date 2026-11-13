import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { testUnits } from '../../test/commandFixture';
import { legacyBattleGolden } from '../../test/int22LegacyBattle';
import { unitSetSchema, type UnitSetResource } from '../world/resources';
import { deepFreeze } from '../personnel/testFixture';
import { simulateBattle, type BattleForce, type BattleInput } from './simulate';

type MutableInput = Omit<BattleInput, 'attacker' | 'defender' | 'unitSet'> & {
  attacker: BattleForce;
  defender: BattleForce;
  unitSet: UnitSetResource;
};
function fixture(): MutableInput {
  const unitSet = unitSetSchema.parse(testUnits);
  for (const row of unitSet.crewTypes)
    Object.assign(row, { attack: 100, defence: 100, attackCoef: [], defenceCoef: [] });
  return {
    attacker: { crew: 10000, crewType: 1100, train: 100, atmos: 5 },
    defender: { crew: 10000, crewType: 1200, train: 100, atmos: 5 },
    attackerTech: 0,
    defenderTech: 0,
    unitSet,
    coefMode: 'multiply',
  };
}
function rows(input: BattleInput) {
  const units = input.unitSet as UnitSetResource;
  return [
    units.crewTypes.find((row) => row.id === input.attacker.crewType)!,
    units.crewTypes.find((row) => row.id === input.defender.crewType)!,
  ] as const;
}
function run(input: BattleInput, values: number[] = []) {
  let calls = 0;
  const source = rngFor('int22-effect-sequence');
  const result = simulateBattle(deepFreeze(input), { ...source, next: () => values[calls++] ?? 0.5 });
  return { ...result, calls };
}
function crews(result: ReturnType<typeof run>) {
  return [result.attacker.crew, result.defender.crew, result.calls];
}

it('AC-P2-24 선제 교전에서 양쪽 선제사격은 한 번만 계산한다', () => {
  const input = fixture();
  const [attacker, defender] = rows(input);
  attacker.effects = defender.effects = ['firstVolley'];
  input.openingSkirmish = true;
  const result = run(input);
  expect(crews(result)).toEqual([9756, 9756, 2]);
  expect(result.attacker.atmos).toBe(input.attacker.atmos);
  expect(result.defender.atmos).toBe(input.defender.atmos);
});

it('AC-P2-24 본공성에서 아직 쏘지 않은 공격군만 선제사격한다', () => {
  const input = fixture();
  input.defender.crewType = 1000;
  input.unitSet.firstVolleyScope = 'sortie';
  input.siege = true;
  const [attacker, wall] = rows(input);
  attacker.effects = wall.effects = ['firstVolley'];
  expect(run(input)).toMatchObject({ calls: 3, attackerFirstVolleyFired: true });
  const second = run({ ...input, attackerFirstVolleyUsed: true });
  expect(second.calls).toBe(2);
  expect(second).not.toHaveProperty('attackerFirstVolleyFired');
});

it('INT-26 반계 장비는 성공한 계략의 피해를 반대편에 적용하고 전투 기록에 남긴다', () => {
  const input = fixture();
  rows(input)[0].magicCoef = 0.1;
  input.attackerTactics = { leadership: 100, strength: 100, intel: 100 };
  input.recordPhases = true;
  const normal = run(input, [0, 0, 0, 0.5, 0.5]);
  const reflected = run({ ...input, defenderEquipment: { counterTactics: 0.1 } }, [0, 0, 0, 0.05, 0.5, 0.5]);
  expect(normal.phases?.[0]?.attackerTactic).toEqual({ name: '위보', success: true });
  expect(reflected.phases?.[0]).toMatchObject({ defenderTactic: { name: '반계(위보)', success: true } });
  expect(reflected.phases?.[0]).not.toHaveProperty('attackerTactic');
  expect(reflected.attacker.crew).toBeLessThan(normal.attacker.crew);
  expect(reflected.defender.crew).toBeGreaterThan(normal.defender.crew);
});

it('INT-26 저격은 첫 교전에만 사기를 올리고 장수의 부상을 80까지 올린다', () => {
  const input = fixture();
  input.attackerEquipment = { snipe: { chance: 0.2, morale: 20 } };
  input.defenderInjury = 79;
  input.recordPhases = true;
  const hit = run(input, [0.1]);
  expect(hit.defenderInjury).toBe(80);
  expect(hit.attacker.atmos).toBe(20);
  expect(hit.phases?.[0]?.attackerSniped).toBe(true);
  expect(run(input, [0.2])).not.toHaveProperty('defenderInjury');
  const { defenderInjury: _injury, ...wallInput } = input;
  const wall = run(wallInput, [0.1]);
  expect(wall).not.toHaveProperty('defenderInjury');
  expect(wall.attacker.atmos).toBe(20);
});

describe('AC-INT-22 기존 월드 전투', () => {
  it.each(legacyBattleGolden)('$a → $b의 실제 기존 결과와 난수 상태를 보존한다', (golden) => {
    const input = {
      attacker: { crew: 5000, crewType: golden.a, train: 80, atmos: 80 },
      defender: { crew: 5000, crewType: golden.b, train: 80, atmos: 80 },
      attackerTech: 1000,
      defenderTech: 2000,
      defence: 120,
      unitSet: unitSetSchema.parse(testUnits),
    };
    const before = structuredClone(input);
    const source = rngFor('int22-legacy', golden.a, golden.b);
    let calls = 0;
    const result = simulateBattle(deepFreeze(input), {
      ...source,
      next: () => {
        calls++;
        return source.next();
      },
    });
    expect({ ...result, calls, next: source.next() }).toEqual({
      attacker: golden.attacker,
      defender: golden.defender,
      calls: golden.calls,
      next: golden.next,
    });
    expect(input).toEqual(before);
  });
  it('기존 사용자 병종의 ID 계수는 새 계산식을 고르기 전에는 읽지 않는다', () => {
    const input = fixture();
    const [a, b] = rows(input);
    a.attackCoef = { '1200': 0, '2': 1 };
    b.defenceCoef = { '1100': 0, '1': 1 };
    input.coefMode = 'divide';
    expect(crews(run(input))).toEqual([9633, 9633, 2]);
  });
});

describe('AC-INT-22 상성 곱셈과 효과', () => {
  it('각 소유자의 ID 계수가 계열보다 앞서며 비대칭 공격·방어를 곱한다', () => {
    const input = fixture();
    const [a, b] = rows(input);
    a.attackCoef = { '1200': 1.3, '2': 9 };
    b.defenceCoef = { '1100': 0.9, '1': 9 };
    b.attackCoef = { '1100': 1.6, '1': 9 };
    a.defenceCoef = { '1200': 0.7, '2': 9 };
    expect(crews(run(input))).toEqual([9589, 9571, 2]);
  });
  it.each(['attackId', 'defenceId', 'family'] as const)(
    '%s 계수 0을 기본값으로 바꾸지 않고 최소 피해만 적용한다',
    (kind) => {
      const input = fixture();
      const [a, b] = rows(input);
      if (kind === 'attackId') a.attackCoef = { '1200': 0, '2': 5 };
      else if (kind === 'defenceId') b.defenceCoef = { '1100': 0, '1': 5 };
      else a.attackCoef = { '2': 0 };
      expect(crews(run(input))).toEqual([9633, 9999, 2]);
    },
  );
  it('ID가 없으면 계열, 둘 다 없거나 빈 배열이면 1을 쓴다', () => {
    const input = fixture();
    const [a, b] = rows(input);
    a.attackCoef = { '2': 1.3 };
    b.defenceCoef = { '1': 0.9 };
    expect(crews(run(input))).toEqual([9633, 9571, 2]);
    const plain = fixture();
    rows(plain)[0].attackCoef = { '3': 9 };
    expect(crews(run(plain))).toEqual([9633, 9633, 2]);
  });
  it('성벽의 계열 0 계수도 조회한다', () => {
    const input = fixture();
    const [a, b] = rows(input);
    b.armType = 0;
    a.attackCoef = { '0': 2 };
    expect(crews(run(input))).toEqual([9633, 9267, 2]);
  });
  it.each(['attacker', 'defender', 'both'] as const)(
    '선제 %s는 쏘는 쪽만 난수를 쓰고 동시에 전멸하면 사기를 줄이지 않는다',
    (side) => {
      const input = fixture();
      input.attacker.crew = input.defender.crew = 1;
      const [a, b] = rows(input);
      if (side !== 'defender') a.effects = ['firstVolley', 'avoid'];
      if (side !== 'attacker') b.effects = ['firstVolley', 'hold', 'avoid'];
      const result = run(input);
      expect(crews(result)).toEqual([
        side === 'attacker' ? 1 : 0,
        side === 'defender' ? 1 : 0,
        side === 'both' ? 2 : 1,
      ]);
      expect([result.attacker.atmos, result.defender.atmos]).toEqual([5, 5]);
    },
  );
  it('선제 피해는 2/3이며 양쪽 동시 반영 뒤 정규 페이즈를 계속한다', () => {
    const input = fixture();
    rows(input)[0].effects = ['firstVolley'];
    expect(crews(run(input))).toEqual([9642, 9389, 3]);
    const both = fixture();
    for (const row of rows(both)) row.effects = ['firstVolley'];
    expect(crews(run(both))).toEqual([9398, 9398, 4]);
  });
  it.each(['crew', 'atmos'] as const)('%s 0인 선제 교전은 병종·효과·난수를 읽지 않는다', (field) => {
    const input = fixture();
    input.defender[field] = 0;
    input.attacker.crewType = input.defender.crewType = 9999;
    expect(run(input)).toMatchObject({ attacker: input.attacker, defender: input.defender, calls: 0 });
  });
  it('guard5는 수비측만 받는 피해를 1.05로 나누고 기존 수정자를 그 뒤에 적용한다', () => {
    const input = fixture();
    for (const row of rows(input)) row.effects = ['guard5'];
    input.attackerModifiers = { dealt: [{ source: 'test:bonus', op: 'add', value: 10 }] };
    input.defenderModifiers = { taken: [{ source: 'test:taken', op: 'mul', value: 2 }] };
    expect(crews(run(input))).toEqual([9633, 9282, 2]);
  });
  it.each(['attacker', 'defender', 'both'] as const)(
    '기병 %s의 실제 공수 위치에 따라 주고받는 피해를 보정한다',
    (side) => {
      const input = fixture();
      const [a, b] = rows(input);
      if (side !== 'defender') a.effects = ['cavalryClash'];
      if (side !== 'attacker') b.effects = ['cavalryClash'];
      expect(crews(run(input))).toEqual(side === 'both' ? [9655, 9619, 2] : [9644, 9626, 2]);
    },
  );
  it.each(['attacker', 'defender'] as const)('창극 %s는 상대 기병의 주고받는 보정을 모두 끈다', (side) => {
    const input = fixture();
    const [a, b] = rows(input);
    a.effects = [side === 'attacker' ? 'pikeWall' : 'cavalryClash'];
    b.effects = [side === 'defender' ? 'pikeWall' : 'cavalryClash'];
    expect(crews(run(input))).toEqual([9633, 9633, 2]);
  });
  it.each(['attacker', 'defender'] as const)('기병 %s가 성벽을 만나면 주는 피해 0.9만 적용한다', (side) => {
    const input = fixture();
    const [a, b] = rows(input);
    a.armType = side === 'attacker' ? 3 : 0;
    b.armType = side === 'defender' ? 3 : 0;
    (side === 'attacker' ? a : b).effects = ['cavalryClash'];
    expect(crews(run(input))).toEqual(side === 'attacker' ? [9633, 9670, 2] : [9670, 9633, 2]);
  });
  it('저지는 성공한 페이즈의 피해·사기를 건너뛰고 이후 다시 시도하지 않는다', () => {
    const input = fixture();
    input.attacker.atmos = input.defender.atmos = 100;
    rows(input)[1].effects = ['hold'];
    const result = run(input, [0]);
    expect(result.calls).toBe(19);
    expect([result.attacker.atmos, result.defender.atmos]).toEqual([55, 55]);
  });
  it('저지는 실패하면 다음 페이즈에 다시 시도하고 성공 뒤에는 피해 난수만 쓴다', () => {
    const input = fixture();
    input.attacker.atmos = input.defender.atmos = 15;
    rows(input)[1].effects = ['hold'];
    const result = run(input, [0.9, 0.5, 0.5, 0]);
    expect(result.calls).toBe(8);
    expect([result.attacker.atmos, result.defender.atmos]).toEqual([0, 0]);
  });
  it('저지 성공 페이즈는 양쪽 회피 판정도 건너뛴다', () => {
    const input = fixture();
    const [a, b] = rows(input);
    a.effects = ['avoid'];
    b.effects = ['hold', 'avoid'];
    a.avoid = b.avoid = 100;
    expect(crews(run(input, [0, 0, 0, 0.5, 0.5]))).toEqual([9939, 9939, 5]);
  });
  it('저지 확률과 같은 값은 실패하며 공격측의 저지는 발동하지 않는다', () => {
    const input = fixture();
    input.attacker.atmos = input.defender.atmos = 100;
    for (const row of rows(input)) row.effects = ['hold'];
    expect(run(input).calls).toBe(30);
    const attackerOnly = fixture();
    rows(attackerOnly)[0].effects = ['hold'];
    expect(crews(run(attackerOnly))).toEqual([9633, 9633, 2]);
  });
  it.each([
    [
      [0.1, 0.5],
      [9939, 9633, 4],
    ],
    [
      [0.3, 0.1],
      [9633, 9939, 4],
    ],
    [
      [0.2, 0.4],
      [9633, 9633, 4],
    ],
  ])('회피는 공격·수비 순서로 %j를 판정한 뒤 성공한 쪽의 받는 피해만 1/6로 한다', (values, expected) => {
    const input = fixture();
    const [a, b] = rows(input);
    a.effects = b.effects = ['avoid'];
    a.avoid = 20;
    b.avoid = 40;
    expect(crews(run(input, values))).toEqual(expected);
  });
});
