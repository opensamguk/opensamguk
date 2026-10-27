import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver } from '../commands/resolve';
import { runGeneralTurn } from '../commands/turn';
import { chooseGeneralTurn } from '../npc';
import { createCampaignCommandResolver } from './commands';
import { emptyCampaignState } from './state';

const resolver = createCampaignCommandResolver(createCommandResolver(null));
const context = { tick: 100, unitSet: testUnits, resolver };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['campaign-v1', 'five-stats'];
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 10, charm: 50, crew: 0 });
  for (const nation of Object.values(world.nations)) nation.isNpc = false;
  world.campaign = emptyCampaignState(world, 'npc-seed', 'sourced-fixture');
  return world;
}
describe('AC-INT-09 부곡 병력 정본의 기존 NPC 턴', () => {
  it('NPC가 병력 복제 없이 모병·사기·훈련 뒤 실제 출병·점령까지 실행한다', () => {
    let state = fixture();
    const keys: string[] = [];
    for (let turn = 0; turn < 20 && state.cities[2]!.nationId !== 1; turn++) {
      const next = runGeneralTurn(
        state,
        { generalId: 1, tick: 100 + turn * 10000, unitSet: testUnits },
        { commandKey: 'rest', args: {} },
        'npc-seed',
        {},
        resolver,
      );
      expect('code' in next.result).toBe(false);
      keys.push(next.commandKey);
      state = next.state;
      expect(Object.values(state.generals).every((general) => general.crew === 0)).toBe(true);
    }
    expect(keys[0]).toBe('recruit');
    expect(keys).toEqual(expect.arrayContaining(['morale', 'train', 'attack']));
    expect(state.cities[2]!.nationId).toBe(1);
    expect(state.campaign!.units[0]!.troops).toBeGreaterThan(0);
  });
  it('휘하 NPC는 상관 소유 병력의 예약·모병·이동을 따로 실행하지 않는다', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    const decision = chooseGeneralTurn(world, world.generals[4]!, rngFor('bound'), context);
    expect(
      decision.candidates.some((row) => ['recruit', 'train', 'morale', 'attack', 'move', 'return'].includes(row.key)),
    ).toBe(false);
    expect(decision.candidates.some((row) => row.key === 'farm')).toBe(true);
  });
  it('NPC도 실제 지휘관이 맡은 모든 부곡을 합산해 모병 상한을 검사한다', () => {
    const world = fixture();
    Object.assign(world.generals[2]!, { nationId: 1, cityKey: 1, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 2, relation: 'LIEUTENANT' }];
    world.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 2, troops: 1000, crewType: 1100, train: 80, atmos: 80 },
      { id: 2, ownerId: 2, commanderId: 2, troops: 9000, crewType: 1100, train: 80, atmos: 80 },
    ];
    world.campaign!.nextUnitId = 3;
    const decision = chooseGeneralTurn(world, world.generals[1]!, rngFor('capacity'), context);
    expect(decision.candidates.some((row) => row.key === 'recruit')).toBe(false);
    expect(decision.candidates.some((row) => row.key === 'attack')).toBe(true);
  });
});
