import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { emptyCampaignState } from './state';
import { applyCampaignUnitInput } from './unitInputs';
function fixture() {
  const world = commandWorld();
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1 });
  Object.assign(world.generals[1]!, { userId: 'owner', nationId: 1 });
  Object.assign(world.generals[2]!, { userId: null, nationId: 1, officerLevel: 1 });
  Object.assign(world.generals[3]!, { userId: 'other', nationId: 1 });
  world.campaign = emptyCampaignState(world, 'unit-test-seed', 'sourced-test');
  world.campaign.links = [{ masterId: 1, personId: 2, relation: 'LIEUTENANT' }];
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
  world.campaign.nextUnitId = 2;
  const context = { tick: 0, userId: 'owner', userActive: true, armyTypes: [1100], unitSet: testUnits };
  const apply = (value: unknown) => applyCampaignUnitInput(deepFreeze(world), value, 1, world.campaign, context);
  return { world, apply, context };
}
const command = { type: 'command', unitId: 1, commanderId: 2, revision: 0 };
describe('AC-INT-19A D-098 부곡 지휘관 변경', () => {
  it('병력·소유·금·쌀은 유지하고 지휘관만 바꾼다', () => {
    const f = fixture(),
      before = structuredClone(f.world);
    expect(f.apply(command)).toMatchObject({
      ok: true,
      campaign: { units: [{ ownerId: 1, commanderId: 2, troops: 100 }] },
    });
    expect(f.world).toEqual(before);
  });
  it.each(['human', 'not-lieutenant', 'position', 'not-appeared', 'revision', 'not-owner', 'capacity'])(
    '%s 변경 거절',
    (kind) => {
      const f = fixture();
      if (kind === 'not-lieutenant') f.world.campaign!.links[0]!.relation = 'STAFF';
      if (kind === 'position') f.world.generals[2]!.cityKey = 2;
      if (kind === 'not-appeared') f.world.generals[2]!.activeFromYear = 192;
      if (kind === 'not-owner') {
        f.world.campaign!.units[0]!.ownerId = 3;
        f.world.campaign!.units[0]!.commanderId = 3;
      }
      if (kind === 'capacity') f.world.generals[2]!.leadership = 0;
      expect(
        f.apply({ ...command, commanderId: kind === 'human' ? 3 : 2, revision: kind === 'revision' ? 1 : 0 }).ok,
      ).toBe(false);
    },
  );
  it.each(['form', 'disband'])('제거한 %s 입력을 거절한다', (type) => {
    const f = fixture(),
      before = structuredClone(f.world);
    expect(f.apply({ ...command, type })).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    expect(f.world).toEqual(before);
  });
  it('제재 계정과 전체 지휘 상한 우회를 거절한다', () => {
    const f = fixture();
    expect(
      applyCampaignUnitInput(f.world, command, 1, f.world.campaign, { ...f.context, userActive: false }),
    ).toMatchObject({ ok: false, code: 'ACTOR_INACTIVE' });
    f.world.generals[2]!.leadership = 1;
    f.world.campaign!.units.push({
      id: 2,
      ownerId: 1,
      commanderId: 2,
      troops: 1,
      crewType: 1100,
      train: 50,
      atmos: 50,
    });
    f.world.campaign!.nextUnitId = 3;
    expect(f.apply(command)).toMatchObject({ ok: false, code: 'COMMAND_CAPACITY' });
  });
});
