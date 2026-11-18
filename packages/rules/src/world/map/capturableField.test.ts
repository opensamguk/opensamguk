import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../../test/builtinCommandFixture';
import { runCommand } from '../../commands/registry';
import { applyEffects } from '../../commands/effects';
import { settlePopulation } from '../../monthly';

it.each([null, 2])('AC-INT-28 중립·적국 전장(%j)은 출병으로 점령하며 이동은 소유를 바꾸지 않는다', (nationId) => {
  const state = commandWorld();
  Object.assign(state.cities[2]!, {
    kind: 'FIELD',
    nationId,
    population: 0,
    populationMax: 0,
    wall: 0,
    wallMax: 0,
    defence: 0,
    defenceMax: 0,
  });
  state.cities[3]!.nationId = 2;
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  if (nationId === null) {
    const moved = runCommand(state, actor, 'move', { cityKey: 2 }, rngFor('field-move', 0));
    if ('code' in moved) throw Error(moved.message);
    expect(applyEffects(state, moved.effects).cities[2]!.nationId).toBeNull();
  } else {
    const peace = structuredClone(state);
    peace.diplomacies = [];
    expect(runCommand(peace, actor, 'attack', { cityKey: 2 }, rngFor('field', 0))).toMatchObject({ code: 'NOT_WAR' });
  }
  const result = runCommand(state, actor, 'attack', { cityKey: 2 }, rngFor('field', 0));
  if ('code' in result) throw Error(result.message);
  const next = applyEffects(state, result.effects);
  expect(next.cities[2]!.nationId).toBe(1);
  expect(next.nations[2]).toBeDefined();
  expect(next.generals[1]!.cityKey).toBe(2);
  expect(runCommand(next, actor, 'attack', { cityKey: 2 }, rngFor('field', 0))).toHaveProperty('code');
  expect(settlePopulation(next).cities[2]!.population).toBe(0);
  for (const [key, args] of [
    ['recruit', { amount: 1, crewType: 1100 }],
    ['wall', {}],
    ['farm', {}],
  ] as const)
    expect(runCommand(next, actor, key, args, rngFor('field', 0))).toHaveProperty('code', 'BAD_TARGET');
  expect(
    runCommand(next, { ...actor, target: 'nation' }, 'nation_capital', { cityKey: 2 }, rngFor('field', 0)),
  ).toHaveProperty('code', 'BAD_TARGET');
});
