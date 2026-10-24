import type { MapResourceV2 } from '../map/format';
import type { ScenarioResource, UnitSetResource } from '../resources';

export function mapFixture(): MapResourceV2 {
  const values = { population: 10, agriculture: 10, commerce: 10, security: 10, defence: 10, wall: 10 };
  return {
    version: 2,
    id: 'map',
    name: '지도',
    canvas: { width: 700, height: 500 },
    defaults: { trust: 50, supplyState: 1 },
    cities: [1, 2, 3].map((id) => ({
      id,
      name: `도시${id}`,
      level: 1,
      region: 1,
      position: { x: id * 10, y: 10 },
      connections: [1, 2, 3].filter((other) => other !== id),
      max: { ...values },
      initial: { ...values },
    })),
    terrain: { coast: [], lakes: [], mountains: [], rivers: [] },
  };
}

export function scenarioFixture(): ScenarioResource {
  return {
    id: 'scenario',
    title: '시나리오',
    startYear: 191,
    nation: [
      ['국가1', '#ffffff', 0, 0, '', 0, '', 0, ['도시1']],
      ['국가2', '#000000', 0, 0, '', 0, '', 0, ['도시2']],
    ],
    general: [
      [0, '장수1', '', 1, null, 50, 50, 50, 0, 170, 220, null, null],
      [0, '장수2', '', 0, null, 50, 50, 50, 0, 170, 220, null, null],
    ],
    diplomacy: [[1, 2, 0, 0]],
  };
}

export function unitSetFixture(): UnitSetResource {
  return {
    id: 'units',
    name: '병종',
    defaultCrewTypeId: 1,
    armTypes: { '1': '보병' },
    crewTypes: [1000, 1, 2].map((id) => ({
      id,
      name: `병종${id}`,
      armType: id === 1000 ? 0 : 1,
      attack: 1,
      defence: 1,
      speed: 1,
      avoid: 0,
      magicCoef: 1,
      cost: 1,
      rice: 1,
      attackCoef: {},
      defenceCoef: {},
    })),
  };
}
