import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { operationalFixture, operationalInput } from '../../test/operationalMapFixture';
import { emptyCampaignState } from './state';
import { emptyCityResourcesState } from '../cityResources/state';
import { applyMarchSupply, buildSupplyLedger, marchForce, previewMarchSupply, supplyCellCost } from './supply';
import { campaignAttack } from './attack';
import { applyEffects } from '../commands/effects';
import { deepFreeze } from '../personnel/testFixture';
import { buildInitialWorld } from '../world/bootstrap';
import { initialReplayState } from '../replay';
import { runGeneralTurn } from '../commands/turn';
import { applyCityResourceInput } from '../cityResources/input';
const hashState = (value: unknown) => JSON.stringify(value);
function fixture() {
  const world = commandWorld();
  for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(world.generals[1]!, { userId: 'owner', rice: 100000 });
  world.campaign = emptyCampaignState(world, 'march', 'fixture');
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 101, crewType: 1100, train: 100, atmos: 100 }];
  world.campaign.nextUnitId = 2;
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.rice = 100000;
  world.campaign.supplyLedger = {
    version: 1,
    cellSize: 16,
    routes: [
      {
        routeId: 'route:1',
        from: 1,
        to: 2,
        segments: [
          {
            routeId: 'route:1',
            mode: 'LAND',
            cells: [0, 16, 32, 48].map((x) => ({
              cellId: `cell:${x / 16}:0`,
              pathCellIndex: x / 16,
              x,
              y: 0,
              ownerAnchorKey: null,
              mountain: false,
              remote: false,
            })),
          },
        ],
      },
    ],
  };
  return world;
}
const actor = { generalId: 1, tick: 100, unitSet: testUnits };
describe('AC-INT-28 R3 supply and D-098', () => {
  it('이동 중 보급이 고갈돼 복귀하면 남은 이동도 지운다', () => {
    const world = fixture();
    world.generals[1]!.movePath = [2, 3];
    expect(applyMarchSupply(world, world.campaign!.units, 2, { supplyLoad: 1 })).toBe(false);
    expect(world.generals[1]!.movePath).toBeUndefined();
    const turn = runGeneralTurn(world, actor, { commandKey: 'rest', args: {} }, 'after-exhaustion');
    expect(turn.commandKey).toBe('rest');
    expect(turn.state.generals[1]!.cityKey).toBe(1);
  });
  it('D-103 저장된 경로의 이번 두 구간만 차감하며 새 지름길로 바꾸지 않는다', () => {
    const world = fixture();
    for (const city of Object.values(world.cities)) Object.assign(city, { state: 0, stateTerm: 0, nationId: 1 });
    world.cities[1]!.connections = [2, 4];
    world.cities[2]!.connections = [3];
    world.cities[4]!.connections = [3];
    world.generals[1]!.movePath = [4, 3];
    const first = world.campaign!.supplyLedger!.routes[0]!;
    world.campaign!.supplyLedger!.routes = [
      [1, 2],
      [2, 3],
      [1, 4],
      [4, 3],
    ].map(([from, to]) => ({
      ...structuredClone(first),
      from: from!,
      to: to!,
      routeId: `route:${from}-${to}`,
      segments: [{ ...structuredClone(first.segments[0]!), routeId: `route:${from}-${to}` }],
    }));
    const preview = previewMarchSupply(world, world.campaign!.units[0]!, 3, { cityPath: [1, 4, 3] })!;
    expect(preview.routeId).toBe('route:1-4/route:4-3');
    expect(applyMarchSupply(world, world.campaign!.units, 3, { cityPath: [1, 4, 3] })).toBe(true);
    expect(world.campaign!.units[0]!.supply!.remaining).toBe(preview.estimatedRemaining);
  });
  it.each([
    ['LAND', 1],
    ['FORD', 2],
    ['BRIDGE', 1],
    ['RIVER', 1],
    ['SEA', 2],
  ] as const)('%s costs %i SP', (mode, cost) => {
    expect(supplyCellCost(mode, false, false, false)).toBe(cost);
    expect(supplyCellCost(mode, true, true, true)).toBe(12);
  });
  it('charges arrived cells and gives the exact first failed cell', () => {
    const world = fixture(),
      before = hashState(world);
    const preview = previewMarchSupply(deepFreeze(world), world.campaign!.units[0]!, 2, { supplyLoad: 2 })!;
    expect(preview).toMatchObject({
      loaded: 2,
      remaining: 2,
      estimatedCost: 3,
      estimatedRemaining: 0,
      riceCost: 4,
      reachable: false,
      exhaustedAt: { routeId: 'route:1', pathCellIndex: 3, cellId: 'cell:3:0', x: 48, y: 0, required: 1, available: 0 },
    });
    expect(hashState(world)).toBe(before);
  });
  it('exact zero succeeds and the next move fails without another rice charge', () => {
    const world = fixture(),
      units = world.campaign!.units;
    expect(applyMarchSupply(world, units, 2, { supplyLoad: 3 })).toBe(true);
    expect(units[0]!.supply?.remaining).toBe(0);
    expect(world.cityResources!.cities['1']!.rice).toBe(99994);
    expect(applyMarchSupply(world, world.campaign!.units, 2, {})).toBe(false);
    expect(world.campaign!.units).toEqual([]);
    expect(world.cityResources!.cities['1']!.rice).toBe(99994);
  });
  it('two units use one total troop rice cost and return together on exhaustion', () => {
    const world = fixture();
    Object.assign(world.generals[4]!, { nationId: 1, cityKey: 1, userId: null, officerLevel: 1 });
    world.campaign!.links = [{ masterId: 1, personId: 4, relation: 'LIEUTENANT' }];
    world.campaign!.units.push({
      id: 2,
      ownerId: 1,
      commanderId: 4,
      troops: 50,
      crewType: 1100,
      train: 100,
      atmos: 100,
    });
    world.campaign!.nextUnitId = 3;
    expect(previewMarchSupply(world, marchForce(world.campaign!.units), 2, { supplyLoad: 1 })!.riceCost).toBe(2);
    const result = campaignAttack.execute(world, actor, { cityKey: 2, supplyLoad: 1 }, rngFor('march'));
    const next = applyEffects(world, result.effects);
    expect(next.campaign!.units).toEqual([]);
    expect(next.generals[1]!.cityKey).toBe(1);
    expect(next.generals[4]!.cityKey).toBe(1);
    expect(next.cityResources!.cities['1']!.rice).toBe(99998);
    expect(result).not.toHaveProperty('attackTarget');
  });
  it('ownership and diplomacy revisions change and only explicit war doubles cost', () => {
    const world = fixture();
    world.campaign!.supplyLedger!.routes[0]!.segments[0]!.cells[1]!.ownerAnchorKey = 2;
    world.diplomacies = [];
    const neutral = previewMarchSupply(world, world.campaign!.units[0]!, 2)!;
    world.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    const war = previewMarchSupply(world, world.campaign!.units[0]!, 2)!;
    expect(war.estimatedCost).toBe(neutral.estimatedCost + 1);
    expect(war.diplomacyRevision).not.toBe(neutral.diplomacyRevision);
    world.cities[2]!.nationId = 1;
    expect(previewMarchSupply(world, world.campaign!.units[0]!, 2)!.ownershipRevision).not.toBe(war.ownershipRevision);
    expect(campaignAttack.check(fixture(), actor, { cityKey: 2, routeRevision: 'stale' })).toMatchObject({
      code: 'STALE_SUPPLY_PREVIEW',
    });
  });
  it('insufficient city rice rejects without changing troops or stores', () => {
    const world = fixture();
    world.cityResources!.cities['1']!.rice = 1;
    const before = hashState(world);
    expect(campaignAttack.check(world, actor, { cityKey: 2 })).toMatchObject({ code: 'NO_RICE' });
    expect(hashState(world)).toBe(before);
  });
  it('the route ledger preserves direction and is deterministic', () => {
    const map = operationalFixture();
    map.routes[0]!.direction = 'FORWARD';
    const ledger = buildSupplyLedger(map);
    expect(ledger.routes.some((route) => route.from === 99 && route.to === 1)).toBe(false);
    expect(hashState(ledger)).toBe(hashState(buildSupplyLedger(JSON.parse(JSON.stringify(map)))));
    expect(ledger.routes[0]!.segments[0]!.cells[0]).toHaveProperty('ownerAnchorKey');
  });
  it('replay initializes the same immutable ledger and JSON roundtrip preserves hashes', () => {
    const initial = buildInitialWorld(operationalInput());
    for (const general of initial.generals) general.sex = 'UNKNOWN';
    const data = { policy: { version: 1, turnTermMinutes: 60 } };
    const replay = initialReplayState(initial, data);
    expect(replay.state.campaign!.supplyLedger).toEqual(buildSupplyLedger(initial.operationalMap!));
    expect(hashState(replay)).toBe(hashState(initialReplayState(JSON.parse(JSON.stringify(initial)), data)));
  });
  it('an absent new-unit recipient is rejected and never throws', () => {
    const world = fixture();
    expect(
      applyCityResourceInput(world, { cityKey: 1, unitId: 'new', recipientId: 999, crewType: 1100, amount: 1 }, 1, {
        tick: 100,
        userId: 'owner',
        userActive: true,
        armyTypes: [1100],
      }),
    ).toMatchObject({ ok: false, code: 'BAD_TARGET' });
  });
});
