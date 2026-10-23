// 설계 C-M3의 지도 항목을 화면에서 미리 보는 임시 검사다 (docs/plans/T4-80.md 검증 표).
// T4-76이 main에 들어오면 `@opensamguk/rules`의 검증기로 바꾼다. 게시를 막는 판단은 서버(T4-78)가 한다.
// 시나리오가 참조하는 도시 검사는 편집기에 시나리오가 없어 여기서 하지 않는다.
import { josa } from './josa';
import { isClosedPolygon, layerLabel, TERRAIN_LAYERS, type MapV2, type Point, type TerrainLayer } from './contract';

export type IssueCode =
  | 'city-id-duplicate'
  | 'city-name-duplicate'
  | 'city-out-of-canvas'
  | 'city-level-range'
  | 'city-region-range'
  | 'link-self'
  | 'link-missing-city'
  | 'link-one-way'
  | 'network-split'
  | 'terrain-open'
  | 'terrain-out-of-canvas';

// 도시는 목록 번호로 가리킨다. 불러온 파일에는 ID가 겹치는 도시가 있을 수 있어서다.
export type IssueTarget = { kind: 'city'; index: number } | { kind: 'terrain'; layer: TerrainLayer; index: number };
export interface Issue {
  code: IssueCode;
  message: string;
  target: IssueTarget;
}

// che의 실제 범위이자 cityRadius가 쓰는 규모 범위다. 정식 범위는 T4-76이 정한다.
export const LEVEL_RANGE = { min: 1, max: 8 };
export const REGION_RANGE = { min: 1, max: 8 };

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

export function validateMap(map: MapV2): Issue[] {
  const issues: Issue[] = [];
  const { width, height } = map.canvas;
  const inside = (x: number, y: number) => x >= 0 && x <= width && y >= 0 && y <= height;
  const cityAt = (index: number) => ({ kind: 'city', index }) as const;
  const label = (index: number) => map.cities[index]!.name || `ID ${map.cities[index]!.id}`;

  const byId = new Map<number, number>();
  const byName = new Map<string, number>();
  map.cities.forEach((city, index) => {
    const sameId = byId.get(city.id);
    if (sameId === undefined) byId.set(city.id, index);
    else
      issues.push({
        code: 'city-id-duplicate',
        message: `도시 ID ${city.id}를 ${josa(label(sameId), '와/과')} ${josa(label(index), '이/가')} 같이 씁니다.`,
        target: cityAt(index),
      });
    const name = city.name.trim();
    const sameName = byName.get(name);
    if (!name)
      issues.push({
        code: 'city-name-duplicate',
        message: `ID ${city.id} 도시의 이름이 비었습니다.`,
        target: cityAt(index),
      });
    else if (sameName === undefined) byName.set(name, index);
    else
      issues.push({
        code: 'city-name-duplicate',
        message: `도시 이름 ${josa(name, '이/가')} ID ${josa(String(map.cities[sameName]!.id), '와/과')} ID ${city.id}에 겹칩니다.`,
        target: cityAt(index),
      });
    if (!inside(city.position.x, city.position.y))
      issues.push({
        code: 'city-out-of-canvas',
        message: `${label(index)}의 좌표 (${city.position.x}, ${city.position.y})는 캔버스 ${width}×${height} 밖입니다.`,
        target: cityAt(index),
      });
    if (!inRange(city.level, LEVEL_RANGE))
      issues.push({
        code: 'city-level-range',
        message: `${label(index)}의 규모 ${josa(String(city.level), '은/는')} ${LEVEL_RANGE.min}~${LEVEL_RANGE.max} 밖입니다.`,
        target: cityAt(index),
      });
    if (!inRange(city.region, REGION_RANGE))
      issues.push({
        code: 'city-region-range',
        message: `${label(index)}의 지역 ${josa(String(city.region), '은/는')} ${REGION_RANGE.min}~${REGION_RANGE.max} 밖입니다.`,
        target: cityAt(index),
      });
  });

  map.cities.forEach((city, index) => {
    for (const otherId of new Set(city.connections)) {
      if (otherId === city.id) {
        issues.push({
          code: 'link-self',
          message: `${josa(label(index), '이/가')} 자기 자신과 이어져 있습니다.`,
          target: cityAt(index),
        });
        continue;
      }
      const other = byId.get(otherId);
      if (other === undefined) {
        issues.push({
          code: 'link-missing-city',
          message: `${josa(label(index), '이/가')} 없는 도시 ID ${josa(String(otherId), '와/과')} 이어져 있습니다.`,
          target: cityAt(index),
        });
        continue;
      }
      if (!map.cities[other]!.connections.includes(city.id))
        issues.push({
          code: 'link-one-way',
          message: `${label(index)}에서 ${josa(label(other), '으로/로')} 가는 연결만 있고 돌아오는 연결이 없습니다.`,
          target: cityAt(index),
        });
    }
  });

  // 연결망은 양쪽 연결만 길로 센다. 한쪽 연결은 위에서 따로 알린다.
  if (map.cities.length > 0) {
    const reached = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const index = queue.shift()!;
      const city = map.cities[index]!;
      for (const otherId of city.connections) {
        const other = byId.get(otherId);
        if (other === undefined || reached.has(other) || !map.cities[other]!.connections.includes(city.id)) continue;
        reached.add(other);
        queue.push(other);
      }
    }
    const cut = map.cities.map((_, index) => index).filter((index) => !reached.has(index));
    const first = cut[0];
    if (first !== undefined)
      issues.push({
        code: 'network-split',
        message: `${label(first)} 등 도시 ${cut.length}개가 ${label(0)}의 연결망에 닿지 않습니다.`,
        target: cityAt(first),
      });
  }

  for (const { layer, closed } of TERRAIN_LAYERS) {
    const lines: Point[][] = layer === 'rivers' ? map.terrain.rivers.map((river) => river.points) : map.terrain[layer];
    lines.forEach((points, index) => {
      const target = { kind: 'terrain', layer, index } as const;
      const name = `${layerLabel(layer)} ${index + 1}`;
      if (closed && !isClosedPolygon(points))
        issues.push({ code: 'terrain-open', message: `${josa(name, '은/는')} 닫히지 않은 다각형입니다.`, target });
      if (!closed && points.length < 2)
        issues.push({
          code: 'terrain-open',
          message: `${name}의 점이 ${points.length}개라서 선이 되지 않습니다.`,
          target,
        });
      const outside = points.filter(([x, y]) => !inside(x, y)).length;
      if (outside > 0)
        issues.push({
          code: 'terrain-out-of-canvas',
          message: `${name}의 점 ${outside}개가 캔버스 ${width}×${height} 밖입니다.`,
          target,
        });
    });
  }
  return issues;
}
