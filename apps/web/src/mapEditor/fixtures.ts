// 단위 시험용 작은 지도. 도시 수치는 검사에 쓰이지 않아 모두 같다.
import { DEFAULT_CANVAS, emptyTerrain, type MapCity, type MapV2 } from './contract';

const values = { population: 1000, agriculture: 100, commerce: 100, security: 100, defence: 100, wall: 100 };

export const testCity = (id: number, connections: number[], extra: Partial<MapCity> = {}): MapCity => ({
  id,
  name: `도시${id}`,
  level: 1,
  region: 1,
  position: { x: id * 10, y: id * 10 },
  connections,
  max: { ...values },
  initial: { ...values },
  ...extra,
});

// 1-2-3이 한 줄로 이어진 지도
export const testMap = (cities: MapCity[] = [testCity(1, [2]), testCity(2, [1, 3]), testCity(3, [2])]): MapV2 => ({
  version: 2,
  id: 'test',
  name: '시험',
  canvas: { ...DEFAULT_CANVAS },
  defaults: { trust: 50, supplyState: 1 },
  cities,
  terrain: emptyTerrain(),
});
