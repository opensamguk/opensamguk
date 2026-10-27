import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { emptyCampaignState } from './state';
import { followCampaignCommanders } from './movement';

function fixture() {
  const world = commandWorld();
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1, nationId: 1 });
  Object.assign(world.generals[1]!, { userId: 'owner' });
  Object.assign(world.generals[2]!, { userId: null, officerLevel: 1 });
  Object.assign(world.generals[3]!, { userId: 'other', officerLevel: 1 });
  world.campaign = emptyCampaignState(world, 'movement-seed', 'sourced-test');
  world.campaign.links = [
    { masterId: 1, personId: 2, relation: 'LIEUTENANT' },
    { masterId: 1, personId: 3, relation: 'STAFF' },
  ];
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
  world.campaign.nextUnitId = 2;
  return world;
}
describe('AC-INT-09 기존 거점 이동과 실제 NPC 지휘관', () => {
  it('집결한 부장은 기존 명령의 목적지로 따라가며 사람 휘하·군량·병력·예약을 보존한다', () => {
    const before = fixture(),
      raw = structuredClone(before);
    raw.generals[1]!.cityKey = 2;
    const next = followCampaignCommanders(deepFreeze(before), deepFreeze(raw));
    expect(next.generals[2]!.cityKey).toBe(2);
    expect(next.generals[3]!.cityKey).toBe(1);
    expect(next.campaign).toEqual(before.campaign);
    for (const general of Object.values(next.generals)) expect(general.rice).toBe(before.generals[general.id]!.rice);
    expect(before.generals[2]!.cityKey).toBe(1);
    expect(raw.generals[2]!.cityKey).toBe(1);
  });
  it.each(['away', 'empty', 'already-moved'] as const)('%s 부장을 순간 이동시키지 않는다', (kind) => {
    const before = fixture();
    if (kind === 'away') before.generals[2]!.cityKey = 2;
    if (kind === 'empty') before.campaign!.units[0]!.troops = 0;
    const raw = structuredClone(before);
    raw.generals[1]!.cityKey = 2;
    if (kind === 'already-moved') raw.generals[2]!.cityKey = 3;
    const next = followCampaignCommanders(deepFreeze(before), deepFreeze(raw));
    expect(next.generals[2]!.cityKey).toBe(raw.generals[2]!.cityKey);
    expect(next.campaign!.units[0]!.troops).toBe(before.campaign!.units[0]!.troops);
  });
  it('중첩된 NPC 부대도 같은 거점에서만 따라가며 입력 순서에 기대지 않는다', () => {
    const before = fixture();
    before.generals[3]!.userId = null;
    before.campaign!.links[1] = { masterId: 2, personId: 3, relation: 'LIEUTENANT' };
    before.campaign!.units.unshift({
      id: 2,
      ownerId: 2,
      commanderId: 3,
      troops: 100,
      crewType: 1100,
      train: 50,
      atmos: 50,
    });
    before.campaign!.nextUnitId = 3;
    const raw = structuredClone(before);
    raw.generals[1]!.cityKey = 2;
    const next = followCampaignCommanders(deepFreeze(before), deepFreeze(raw));
    expect([1, 2, 3].map((id) => next.generals[id]!.cityKey)).toEqual([2, 2, 2]);
    expect(next.campaign).toEqual(before.campaign);
  });
});
