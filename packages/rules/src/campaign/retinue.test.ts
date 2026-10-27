// Scenarios adapted from opensamguk-v1 bc053629, MIT; see NOTICE.
import { describe, expect, it } from 'vitest';
import {
  assessCampaignDeployment,
  buildRetinueHierarchy,
  retinuePersonCost,
  type RetinuePerson,
  type DeploymentSnapshot,
  type SourcedFiveStats,
  type DeploymentRequest,
} from './retinue';
const stats: SourcedFiveStats = {
  leadership: 80,
  strength: 80,
  intel: 80,
  politics: 80,
  charm: 80,
  source: 'test:five-stats',
};
const person = (id: number): RetinuePerson => ({ id, nationId: 1, worldId: 'world:a', stats: { ...stats } });
function snapshot(): DeploymentSnapshot {
  return {
    people: [1, 2, 3].map((id) => ({ ...person(id), isUnownedNpc: id !== 1, node: 'city:4', inBattle: false })),
    links: [
      { masterId: 1, personId: 2, relation: 'LIEUTENANT' },
      { masterId: 2, personId: 3, relation: 'LIEUTENANT' },
    ],
    units: [
      { id: 10, ownerId: 1, commanderId: 2, troops: 300 },
      { id: 11, ownerId: 1, commanderId: 2, troops: 200 },
    ],
    deployed: [],
  };
}
const request: DeploymentRequest = { ownerId: 1, commanderId: 2, unitIds: [11, 10] };
describe('ported personal retinue forest', () => {
  it('preserves nested relationships, sorted preorder and direct-only renown charges', () => {
    const tree = buildRetinueHierarchy(
      [person(3), person(2), person(1)],
      [
        { masterId: 1, personId: 2, relation: 'LIEUTENANT' },
        { masterId: 2, personId: 3, relation: 'STAFF' },
      ],
    );
    expect(tree.subtree(1)).toEqual([1, 2, 3]);
    expect(tree.ancestors(3)).toEqual([2, 1]);
    expect(tree.directCost(1)).toBe(8);
    expect(tree.directCost(2)).toBe(8);
    expect(tree.withinCapacity(1, 7)).toBe(false);
    expect(tree.withinCapacity(1, 8)).toBe(true);
  });
  it('has no legacy five-person cap on the renown profile', () => {
    const people = Array.from({ length: 7 }, (_, i) => ({
      ...person(i + 1),
      stats: { ...stats, leadership: 0, strength: 0, intel: 0, politics: 0, charm: 0 },
    }));
    const tree = buildRetinueHierarchy(
      people,
      people.slice(1).map((p) => ({ masterId: 1, personId: p.id, relation: 'GUEST' })),
    );
    expect(tree.directCost(1)).toBe(6);
  });
  it('rejects cycles and duplicate superiors rather than flattening the tree', () => {
    const people = [person(1), person(2), person(3)];
    expect(() =>
      buildRetinueHierarchy(people, [
        { masterId: 1, personId: 2, relation: 'STAFF' },
        { masterId: 2, personId: 1, relation: 'STAFF' },
      ]),
    ).toThrow('CYCLE');
    expect(() =>
      buildRetinueHierarchy(people, [
        { masterId: 1, personId: 2, relation: 'STAFF' },
        { masterId: 3, personId: 2, relation: 'STAFF' },
      ]),
    ).toThrow('MULTIPLE_SUPERIORS');
  });
  it.each(['world', 'nation', 'self', 'missing', 'duplicate'] as const)(
    'rejects %s relationship corruption',
    (kind) => {
      const people = [person(1), person(2)];
      const link = { masterId: 1, personId: 2, relation: 'STAFF' as const };
      if (kind === 'world') people[1]!.worldId = 'world:b';
      if (kind === 'nation') people[1]!.nationId = 2;
      if (kind === 'self') link.personId = 1;
      if (kind === 'missing') link.personId = 99;
      if (kind === 'duplicate') people.push(person(1));
      expect(() => buildRetinueHierarchy(people, [link])).toThrow();
    },
  );
  it('requires canonical intel and five sourced stats in 0..100', () => {
    expect(retinuePersonCost({ ...stats, leadership: 0, strength: 0, intel: 0, politics: 0, charm: 0 })).toBe(1);
    expect(retinuePersonCost({ ...stats, charm: 81 })).toBe(9);
    expect(() => retinuePersonCost({ ...stats, politics: undefined as unknown as number })).toThrow(
      'FIVE_STATS_REQUIRED',
    );
    expect(() => retinuePersonCost({ ...stats, source: '' })).toThrow('SOURCE');
    expect(() => retinuePersonCost({ ...stats, strength: -1 })).toThrow();
    expect(() => retinuePersonCost({ ...stats, leadership: Number.MAX_SAFE_INTEGER })).toThrow('FIVE_STATS_REQUIRED');
    expect(retinuePersonCost({ ...stats, leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55 })).toBe(6);
    expect(retinuePersonCost({ ...stats, leadership: 100, strength: 100, intel: 100, politics: 100, charm: 100 })).toBe(
      10,
    );
    const legacy = { ...stats, intelligence: 80 };
    Reflect.deleteProperty(legacy, 'intel');
    expect(() => retinuePersonCost(legacy)).toThrow('FIVE_STATS_REQUIRED');
    for (const value of [101, -1, 1.5, NaN, Infinity])
      expect(() => retinuePersonCost({ ...stats, intel: value })).toThrow('FIVE_STATS_REQUIRED');
  });
});
describe('ported bugok deployment gate', () => {
  it('accepts direct NPC lieutenants and canonical unit IDs without copying troops', () => {
    const s = snapshot();
    const before = JSON.stringify(s);
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: true, ownerId: 1, commanderId: 2, unitIds: [10, 11] });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('preserves human command and denies indirect or staff commanders', () => {
    const s = snapshot();
    s.people[1]!.isUnownedNpc = false;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'COMMANDER_UNAVAILABLE' });
    s.people[1]!.isUnownedNpc = true;
    expect(assessCampaignDeployment({ ...request, commanderId: 3 }, s)).toEqual({
      ok: false,
      reason: 'COMMANDER_UNAVAILABLE',
    });
    s.links[0]!.relation = 'STAFF';
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'COMMANDER_UNAVAILABLE' });
  });
  it('requires assembly and denies battle participants', () => {
    const s = snapshot();
    s.people[1]!.node = 'city:3';
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'MUST_ASSEMBLE' });
    s.people[1]!.node = null;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'POSITION_UNAVAILABLE' });
    s.people[1]!.inBattle = true;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'BATTLE_PENDING' });
  });
  it('ports and field labels are not assembly positions', () => {
    for (const node of ['port:1', 'field:1']) {
      const s = snapshot();
      s.people[0]!.node = node;
      s.people[1]!.node = node;
      expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'POSITION_UNAVAILABLE' });
    }
  });
  it.each([0, 50, 90, 100])(
    'commander leadership %i limits all assigned troops even outside this request',
    (leadership) => {
      const s = snapshot();
      s.people[1]!.stats.leadership = leadership;
      s.people[0]!.stats.leadership = 100;
      const capacity = leadership * 100;
      s.units[0]!.troops = Math.max(1, capacity - 1);
      s.units[1]!.troops = 1;
      if (leadership > 0) expect(assessCampaignDeployment({ ...request, unitIds: [10] }, s).ok).toBe(true);
      s.units[1]!.troops = 2;
      expect(assessCampaignDeployment({ ...request, unitIds: [10] }, s)).toEqual({
        ok: false,
        reason: 'COMMAND_CAPACITY',
      });
    },
  );
  it('self command and active deployments recheck capacity without copying troops', () => {
    const s = snapshot();
    s.people[0]!.stats.leadership = 5;
    for (const unit of s.units) unit.commanderId = 1;
    const self = { ...request, commanderId: 1 };
    expect(assessCampaignDeployment(self, s).ok).toBe(true);
    s.deployed = [{ id: 1, worldId: 'world:a', nationId: 1, ownerId: 1, commanderId: 1, unitIds: [10, 11] }];
    expect(assessCampaignDeployment(self, s, 1).ok).toBe(true);
    s.people[0]!.stats.leadership = 4;
    expect(assessCampaignDeployment(self, s, 1)).toEqual({ ok: false, reason: 'COMMAND_CAPACITY' });
    expect(s.units.map((unit) => unit.troops)).toEqual([300, 200]);
    s.units[1]!.troops = Number.MAX_SAFE_INTEGER;
    expect(assessCampaignDeployment(self, s, 1)).toEqual({ ok: false, reason: 'COMMAND_CAPACITY' });
  });
  it('rejects another owner’s unit, changed commanders, empty units and repeated IDs', () => {
    const s = snapshot();
    s.units[0]!.ownerId = 3;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'UNIT_UNAVAILABLE' });
    s.units[0]!.ownerId = 1;
    s.units[0]!.commanderId = 1;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'COMMANDER_CHANGED' });
    expect(assessCampaignDeployment({ ...request, unitIds: [10, 10] }, s)).toEqual({
      ok: false,
      reason: 'INVALID_INPUT',
    });
    s.units[0]!.commanderId = 2;
    s.units[0]!.troops = 0;
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'UNIT_UNAVAILABLE' });
  });
  it('rejects double deployment; active corps rechecks allegiance and unit identity after moving', () => {
    const s = snapshot();
    s.deployed = [{ id: 1, worldId: 'world:a', nationId: 1, ownerId: 1, commanderId: 2, unitIds: [10, 11] }];
    expect(assessCampaignDeployment(request, s)).toEqual({ ok: false, reason: 'ALREADY_DEPLOYED' });
    s.people[1]!.node = 'field:80';
    expect(assessCampaignDeployment(request, s, 1).ok).toBe(true);
    s.deployed[0]!.nationId = 2;
    expect(assessCampaignDeployment(request, s, 1)).toEqual({ ok: false, reason: 'STATE_UNAVAILABLE' });
  });
});
