// 지도 형식 v2 (docs/plans/map-editor.md C-M2, docs/plans/T4-80.md, docs/plans/T4-88.md).
// 형식과 읽기 판단은 공개 검증기 `@opensamguk/rules/resources`의 validateMap이 정본이다. 여기서는 별칭과 화면용 도구만 둔다.
import {
  isClosedRing,
  MAP_DEFAULT_CANVAS,
  normalizeMapToV2,
  validateMap,
  type MapCity as RulesMapCity,
  type MapResourceV2,
  type Point as RulesPoint,
  type Terrain as RulesTerrain,
} from '@opensamguk/rules/resources';

export type Point = RulesPoint;
export type Terrain = RulesTerrain;
export type River = Terrain['rivers'][number];
export type PolygonLayer = 'coast' | 'lakes' | 'mountains';
export type TerrainLayer = PolygonLayer | 'rivers';

// che의 MIT 출처 고지($comment)도 v2 형식에 있어 내보낼 때 남는다.
export type MapV2 = MapResourceV2;
export type MapCity = RulesMapCity;
export type CityValues = MapCity['max'];
const CITY_VALUE_KEYS = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const;

export const DEFAULT_CANVAS = MAP_DEFAULT_CANVAS;

export const TERRAIN_LAYERS: ReadonlyArray<{ layer: TerrainLayer; label: string; closed: boolean }> = [
  { layer: 'coast', label: '해안', closed: true },
  { layer: 'lakes', label: '호수', closed: true },
  { layer: 'mountains', label: '산맥', closed: true },
  { layer: 'rivers', label: '강', closed: false },
];
export const layerLabel = (layer: TerrainLayer) => TERRAIN_LAYERS.find((entry) => entry.layer === layer)!.label;

// 밑그림 5색. 번호가 PNG 팔레트 번호다. 바탕 그림 생성(T4-83)이 이 표로 층을 읽는다.
export const SKETCH_PALETTE = [
  { name: '바다', color: '#2b5d8c' },
  { name: '땅', color: '#cbb98a' },
  { name: '강', color: '#4f8fd0' },
  { name: '산', color: '#7a6347' },
  { name: '호수', color: '#6aa6d8' },
] as const;
export const SKETCH = { sea: 0, land: 1, river: 2, mountain: 3, lake: 4 } as const;

export const emptyTerrain = (): Terrain => ({ coast: [], lakes: [], rivers: [], mountains: [] });

export const linePoints = (terrain: Terrain, layer: TerrainLayer, index: number): Point[] | undefined =>
  layer === 'rivers' ? terrain.rivers[index]?.points : terrain[layer][index];

export const isClosedPolygon = isClosedRing;

export type ParseResult = { ok: true; map: MapV2; legacy: boolean } | { ok: false; error: string };

// 지금 형식(v1)과 v2를 공개 validateMap으로 읽는다. 형식이 틀리거나 캔버스가 700×500이 아니면 그 문구로 거부하고,
// 겹치는 ID나 한쪽 연결 같은 뜻의 오류는 막지 않고 검증 목록(validate.ts)에 맡긴다. v1은 v2로 바꿔 돌려준다.
export function parseMapJson(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: 'JSON으로 읽을 수 없는 파일입니다.' };
  }
  const report = validateMap(raw);
  if (report.value === null) return { ok: false, error: report.issues[0]!.message };
  const canvas = report.issues.find((issue) => issue.code === 'map-canvas-range');
  if (canvas) return { ok: false, error: canvas.message };
  return { ok: true, map: normalizeMapToV2(report.value), legacy: report.value.version !== 2 };
}

// 키 순서를 고정해 같은 지도는 늘 같은 글자열이 되게 한다.
export function serializeMap(map: MapV2): string {
  const values = (v: CityValues) => Object.fromEntries(CITY_VALUE_KEYS.map((key) => [key, v[key]]));
  const out = {
    ...(map.$comment === undefined ? {} : { $comment: map.$comment }),
    version: 2,
    id: map.id,
    name: map.name,
    canvas: { width: map.canvas.width, height: map.canvas.height },
    defaults: map.defaults,
    cities: map.cities.map((city) => ({
      id: city.id,
      name: city.name,
      level: city.level,
      region: city.region,
      position: { x: city.position.x, y: city.position.y },
      connections: city.connections,
      max: values(city.max),
      initial: values(city.initial),
    })),
    terrain: {
      coast: map.terrain.coast,
      lakes: map.terrain.lakes,
      rivers: map.terrain.rivers.map((river) =>
        river.name === undefined ? { points: river.points } : { name: river.name, points: river.points },
      ),
      mountains: map.terrain.mountains,
    },
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
