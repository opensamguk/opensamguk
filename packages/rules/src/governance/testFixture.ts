import { commandWorld } from '../../test/commandFixture';
import type { GovernanceConfig } from './config';
import { initialGovernanceState } from './state';

export const governanceTestConfig: GovernanceConfig = {
  version: 1,
  seatCityKey: 1,
  legitimacy: {
    seatGain: 2,
    emperorGain: 1,
    officeGain: 1,
    maxOfficeGain: 3,
    decay: 1,
    ascendAt: 60,
    censureLoss: 5,
    renounceLoss: 10,
  },
  tribute: { maxBp: 2000, maxAmount: 100_000 },
  stipendGold: { chancellor: 100, grandMarshal: 100, minister: 100 },
  offerMonths: 6,
  maxDepth: 3,
  maxRemitMonths: 12,
  censureCooldownMonths: 6,
  npc: { cityRatio: 2, acceptMaxBp: 1000, offerBp: 500, cooldownMonths: 12 },
  limits: { sentOffers: 3, receivedOffers: 5, worldOffers: 200 },
};
export function governanceFixture(count = 5) {
  const world = commandWorld();
  world.ruleFeatures = ['governance-v1'];
  world.diplomacies = [];
  for (let id = 1; id <= count; id++) {
    world.nations[id] = { ...world.nations[1]!, id, name: `국가${id}`, capitalCityKey: id };
    world.cities[id] = {
      ...world.cities[1]!,
      cityKey: id,
      name: `도시${id}`,
      nationId: id,
      supplied: true,
      connections: [],
    };
    world.generals[id] = { ...world.generals[1]!, id, nationId: id, cityKey: id, officerLevel: 12 };
  }
  world.governance = initialGovernanceState(governanceTestConfig, world);
  return world;
}
export function vassal(id: number, lower: number, upper: number) {
  return {
    id,
    vassalNationId: lower,
    overlordNationId: upper,
    vassalMonarchId: lower,
    overlordMonarchId: upper,
    goldBp: 500,
    riceBp: 500,
    sinceTick: 0,
    remitUntilTick: 0,
  };
}
