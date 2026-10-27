import type { OperationalMapResource } from '../src/world/map/operational';
import { FIVE_STAT_RULES } from '../src/general/fiveStats';
import { testUnits } from './commandFixture';

export function operationalFixture(): OperationalMapResource {
  const values = { population: 1000, agriculture: 100, commerce: 100, security: 100, defence: 100, wall: 100 };
  return {
    version: 3,
    id: 'operational-test',
    name: '운영 계약 고정물',
    canvas: { width: 1000, height: 700 },
    basemap: {
      source: 'natural-earth-5.1.2',
      projection: 'WGS84 plate carree',
      sha256: 'a'.repeat(64),
      bounds: [94, 17, 132.571428571429, 44],
    },
    defaults: { trust: 80, supplyState: 1 },
    sites: [
      {
        id: 'city:1',
        kind: 'CITY',
        name: '도시1',
        anchorKey: 1,
        legacyCityId: 1,
        level: 1,
        region: 1,
        position: { x: 100, y: 200 },
        initial: { ...values },
        max: { ...values, population: 2000 },
      },
      {
        id: 'city:2',
        kind: 'CITY',
        name: '도시2',
        anchorKey: 2,
        legacyCityId: 2,
        level: 1,
        region: 1,
        position: { x: 300, y: 400 },
        initial: { ...values },
        max: { ...values, population: 2000 },
      },
      {
        id: 'pass:99',
        kind: 'PASS',
        name: '관문',
        anchorKey: 99,
        region: 1,
        position: { x: 200, y: 300 },
        defence: { initial: 100, max: 500 },
        wall: { initial: 100, max: 500 },
      },
      { id: 'port:1', kind: 'PORT', name: '항구', parentCityId: 'city:1', position: { x: 110, y: 200 } },
      { id: 'field:1', kind: 'FIELD', name: '전장', position: { x: 200, y: 210 } },
    ],
    routes: [
      { id: 'route:1', from: 'city:1', to: 'pass:99', mode: 'LAND', direction: 'BOTH', enabled: true },
      { id: 'route:2', from: 'pass:99', to: 'city:2', mode: 'LAND', direction: 'BOTH', enabled: true },
    ],
  };
}

export function operationalInput() {
  return {
    map: operationalFixture(),
    seed: 'operational-contract-test',
    unitSet: testUnits,
    statRules: { stat: { ...FIVE_STAT_RULES } },
    scenario: {
      id: 'operational-test',
      title: '운영 계약 고정물',
      startYear: 191,
      nation: [
        ['국가1', '#112233', 10000, 10000, '', 0, '', 0, ['도시1', '관문']],
        ['국가2', '#445566', 10000, 10000, '', 0, '', 0, ['도시2']],
      ],
      general: [
        [0, '장수1', '', 1, '도시1', 50, 50, 50, 12, 100, 250, null, null],
        [0, '장수2', '', 2, '도시2', 50, 50, 50, 12, 100, 250, null, null],
      ],
      generalStats: [1, 2].map((generalId) => ({
        generalId,
        stats: { leadership: 50, strength: 50, intel: 50, politics: 50, charm: 50 },
        sourceId: 'test-fixture',
        sourceRevision: 'test-fixture-v1',
        officerId: generalId,
      })),
      diplomacy: [],
    },
  };
}
