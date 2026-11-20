import { commandWorld, testUnits } from './commandFixture';
import { emptyCampaignState } from '../src/campaign/state';
import { emptyCityResourcesState } from '../src/cityResources/state';
import { openTacticalBattle } from '../src/tactical/world';

export { testUnits };
export function tacticalFixture(size = 12) {
  const world = commandWorld();
  for (const g of Object.values(world.generals)) Object.assign(g, { politics: 60, charm: 60, crew: 0, rice: 100000 });
  Object.assign(world.generals[1]!, { userId: 'attacker', leadership: 100, cityKey: 1 });
  Object.assign(world.generals[2]!, { userId: 'defender', leadership: 100, cityKey: 2 });
  world.campaign = emptyCampaignState(world, 'tactical-test', 'fixture');
  world.campaign.units = [
    { id: 1, ownerId: 1, commanderId: 1, troops: 1000, crewType: 1100, train: 100, atmos: 100 },
    { id: 2, ownerId: 2, commanderId: 2, troops: 1000, crewType: 1100, train: 100, atmos: 100 },
  ];
  world.campaign.nextUnitId = 3;
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
            cells: Array.from({ length: size }, (_, i) => ({
              cellId: `cell:${i}:0`,
              x: i * 16,
              y: 0,
              pathCellIndex: i,
              mountain: false,
              remote: false,
              ownerAnchorKey: null,
            })),
          },
        ],
      },
    ],
  };
  world.cityResources = emptyCityResourcesState(world);
  const battle = openTacticalBattle(
    world,
    100,
    world.campaign.units.slice(0, 1),
    world.campaign.units.slice(1),
    2,
    testUnits,
  );
  return { world, battle };
}
