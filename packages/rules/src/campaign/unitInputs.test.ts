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
  const apply = (value: unknown) =>
    applyCampaignUnitInput(deepFreeze(world), value, 1, world.campaign, {
      tick: 0,
      userId: 'owner',
      userActive: true,
      armyTypes: testUnits.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
    });
  return { world, apply };
}
const form = { type: 'form', commanderId: 2, crewType: 1100, revision: 0 };
describe('AC-INT-06 부곡 편성·실제 지휘관 권한', () => {
  it('빈 부곡만 만들며 원본 병력·금·군량과 다른 사람 예약에 손대지 않는다', () => {
    const f = fixture(),
      before = structuredClone(f.world);
    const result = f.apply(form);
    if (!result.ok) throw new Error(result.code);
    expect(result.campaign.units).toEqual([
      { id: 1, ownerId: 1, commanderId: 2, troops: 0, crewType: 1100, train: 0, atmos: 0 },
    ]);
    expect(result.state.campaign).toEqual(result.campaign);
    expect(result.state.generals).toEqual(before.generals);
    expect(f.world).toEqual(before);
  });
  it.each(['human', 'not-lieutenant', 'position', 'not-appeared', 'wall', 'revision'] as const)(
    '%s 편성을 거부한다',
    (kind) => {
      const f = fixture();
      if (kind === 'not-lieutenant') f.world.campaign!.links[0]!.relation = 'STAFF';
      if (kind === 'position') f.world.generals[2]!.cityKey = 2;
      if (kind === 'not-appeared') f.world.generals[2]!.activeFromYear = 192;
      expect(
        f.apply({
          ...form,
          commanderId: kind === 'human' ? 3 : 2,
          crewType: kind === 'wall' ? 1000 : 1100,
          revision: kind === 'revision' ? 1 : 0,
        }).ok,
      ).toBe(false);
    },
  );
  it('지휘관의 다른 부곡까지 합쳐 상한을 검사하며 병력을 버리는 해산을 거부한다', () => {
    const f = fixture();
    f.world.generals[2]!.leadership = 1;
    f.world.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 50, atmos: 50 },
      { id: 2, ownerId: 1, commanderId: 2, troops: 1, crewType: 1100, train: 50, atmos: 50 },
    ];
    f.world.campaign!.nextUnitId = 3;
    expect(f.apply({ type: 'command', unitId: 1, commanderId: 2, revision: 0 })).toMatchObject({
      ok: false,
      code: 'COMMAND_CAPACITY',
    });
    expect(f.apply({ type: 'disband', unitId: 1, revision: 0 })).toMatchObject({ ok: false, code: 'TROOPS_PRESENT' });
  });
  it('자기 빈 부곡만 해산하며 다른 사람의 부곡·제재 계정은 조작하지 못한다', () => {
    const f = fixture();
    f.world.campaign!.units = [{ id: 1, ownerId: 3, commanderId: 3, troops: 0, crewType: 1100, train: 0, atmos: 0 }];
    f.world.campaign!.nextUnitId = 2;
    expect(f.apply({ type: 'disband', unitId: 1, revision: 0 })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    expect(
      applyCampaignUnitInput(f.world, form, 1, f.world.campaign, {
        tick: 0,
        userId: 'owner',
        userActive: false,
        armyTypes: testUnits.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
      }),
    ).toMatchObject({ ok: false, code: 'ACTOR_INACTIVE' });
    const own = structuredClone(f.world);
    own.campaign!.units[0]!.ownerId = 1;
    own.campaign!.units[0]!.commanderId = 1;
    const removed = applyCampaignUnitInput(
      deepFreeze(own),
      { type: 'disband', unitId: 1, revision: 0 },
      1,
      own.campaign,
      {
        tick: 0,
        userId: 'owner',
        userActive: true,
        armyTypes: testUnits.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
      },
    );
    if (!removed.ok) throw new Error(removed.code);
    expect(removed.campaign.units).toEqual([]);
    expect(removed.campaign.revision).toBe(1);
  });
  it('떨어진 병력을 지휘관 변경으로 이동시키지 않으며 빈 부대는 병력을 옮기지 않는다', () => {
    const f = fixture();
    f.world.generals[2]!.cityKey = 2;
    f.world.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 50 },
    ];
    f.world.campaign!.nextUnitId = 2;
    expect(f.apply({ type: 'command', unitId: 1, commanderId: 1, revision: 0 })).toMatchObject({
      ok: false,
      code: 'MUST_ASSEMBLE',
    });
    const empty = structuredClone(f.world);
    empty.campaign!.units[0]!.troops = 0;
    const reassigned = applyCampaignUnitInput(
      deepFreeze(empty),
      { type: 'command', unitId: 1, commanderId: 1, revision: 0 },
      1,
      empty.campaign,
      {
        tick: 0,
        userId: 'owner',
        userActive: true,
        armyTypes: testUnits.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
      },
    );
    expect(reassigned).toMatchObject({ ok: true, campaign: { units: [{ commanderId: 1, troops: 0 }] } });
    expect(empty.generals[2]!.cityKey).toBe(2);
  });
});
