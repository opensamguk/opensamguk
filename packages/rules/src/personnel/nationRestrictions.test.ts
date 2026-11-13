import { expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { runCommand } from '../commands/registry';
import { rngFor } from '@opensamguk/shared';
import { NATION_RESTRICTIONS_FEATURE, changeNationRestrictions, nationRestrictions } from './nationRestrictions';

it('checks recruitment and outgoing attacks at command execution, with monthly war changes capped at ten', () => {
  const world = commandWorld();
  world.ruleFeatures = [NATION_RESTRICTIONS_FEATURE];
  const nation = world.nations[1]!;
  const change = (setting: 'war' | 'recruitment', blocked: boolean, tick: number) =>
    changeNationRestrictions(nationRestrictions(world, nation, tick), { nationId: 1, setting, blocked });
  expect(change('war', true, 0)).toBeNull();
  nation.restrictions = change('recruitment', true, 0)!;
  const run = (key: string, generalId: number, args: Record<string, number>) =>
    runCommand(world, { generalId, tick: 10_000, unitSet: testUnits }, key, args, rngFor('restrictions', key));
  expect(run('join', 4, { nationId: 1 })).toMatchObject({ code: 'PROTECTED' });
  world.commandMeta = { nextNationId: 3, offers: { 4: 1 } };
  expect(run('accept_invite', 4, {})).toMatchObject({ code: 'PROTECTED' });
  nation.restrictions = change('war', true, 10_000)!;
  expect(nation.restrictions.warChanges).toBe(1);
  expect(run('attack', 1, { cityKey: 2 })).toMatchObject({ code: 'PROTECTED' });
  expect(nationRestrictions(world, nation, 90_000).warChanges).toBe(10);
  delete world.ruleFeatures;
  expect(run('attack', 1, { cityKey: 2 })).not.toHaveProperty('code');
});
