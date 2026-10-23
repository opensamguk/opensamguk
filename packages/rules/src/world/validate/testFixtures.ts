import type { MapResource, ScenarioResource, UnitSetResource } from '../resources';
import { normalizeMapToV2 } from '../map/format';
import type { ResourceReport } from './issues';

export function makeCity(id = 1): MapResource['cities'][number] {
  const values = { population: 100, agriculture: 100, commerce: 100, security: 100, defence: 100, wall: 100 };
  return {
    id,
    name: `도시${id}`,
    level: 1,
    region: 1,
    position: { x: id % 700, y: 10 },
    connections: [],
    max: { ...values },
    initial: { ...values },
  };
}
export function mapFixture(): MapResource {
  const a = makeCity(1);
  const b = makeCity(2);
  a.connections = [2];
  b.connections = [1];
  return { id: 'test', name: '지도', defaults: { trust: 50, supplyState: 1 }, cities: [a, b] };
}
export function v2Fixture() {
  const result = normalizeMapToV2(mapFixture());
  if (!result.ok) throw new Error('고정물 형식이 맞지 않습니다.');
  return result.map;
}
export function scenarioFixture(): ScenarioResource {
  return {
    id: 'test',
    title: '시나리오',
    startYear: 191,
    nation: [['국가', '#112233', 0, 0, '', 0, '', 0, ['도시1']]],
    general: [[0, '장수', '', 1, null, 50, 50, 50, 0, 100, 200, null, null]],
    diplomacy: [],
  };
}
export function unitFixture(): UnitSetResource {
  const unit = {
    id: 1100,
    armType: 1,
    name: '보병',
    attack: 1,
    defence: 1,
    speed: 1,
    avoid: 0,
    magicCoef: 1,
    cost: 0,
    rice: 0,
    attackCoef: {},
    defenceCoef: {},
  };
  return {
    id: 'test',
    name: '병종',
    defaultCrewTypeId: 1100,
    armTypes: { '1': '보병' },
    crewTypes: [{ ...unit, id: 1000, armType: 0, name: '성벽' }, unit],
  };
}
export const codes = (report: ResourceReport<unknown>) => report.issues.map((item) => item.code);
export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
