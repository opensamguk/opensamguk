// 지도 형식 v2의 화면 쪽 임시 사본이다 (docs/plans/map-editor.md C-M2, docs/plans/T4-80.md).
// T4-76이 main에 들어오면 `@opensamguk/rules`의 타입과 검증기로 바꾼다.
// 도시 필드는 지금 mapSchema(packages/rules/src/world/resources.ts)와 같다. 화면은 rules를 import하지 못해 여기서 직접 읽는다.
import { MAP_HEIGHT, MAP_WIDTH } from '../main/WorldMap';

export type Point = [number, number];
export interface River {
  name?: string;
  points: Point[];
}
export interface Terrain {
  coast: Point[][];
  lakes: Point[][];
  rivers: River[];
  mountains: Point[][];
}
export type PolygonLayer = 'coast' | 'lakes' | 'mountains';
export type TerrainLayer = PolygonLayer | 'rivers';

const CITY_VALUE_KEYS = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const;
export type CityValues = Record<(typeof CITY_VALUE_KEYS)[number], number>;

export interface MapCity {
  id: number;
  name: string;
  level: number;
  region: number;
  position: { x: number; y: number };
  connections: number[];
  max: CityValues;
  initial: CityValues;
}

export interface MapV2 {
  // che의 MIT 출처 고지가 여기 있어 내보낼 때도 남긴다.
  $comment?: string;
  version: 2;
  id: string;
  name: string;
  canvas: { width: number; height: number };
  defaults: { trust: number; supplyState: 0 | 1; [key: string]: unknown };
  cities: MapCity[];
  terrain: Terrain;
}

export const DEFAULT_CANVAS = { width: MAP_WIDTH, height: MAP_HEIGHT };

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

export const isClosedPolygon = (points: readonly Point[]) => {
  const first = points[0];
  const last = points[points.length - 1];
  return (
    points.length >= 4 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
  );
};

export type ParseResult = { ok: true; map: MapV2; legacy: boolean } | { ok: false; error: string };

class ParseError extends Error {}
const fail = (message: string): never => {
  throw new ParseError(message);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown, where: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(`숫자여야 합니다 (${where}).`);
const integer = (value: unknown, where: string): number =>
  Number.isInteger(value) ? (value as number) : fail(`정수여야 합니다 (${where}).`);
const text = (value: unknown, where: string): string =>
  typeof value === 'string' ? value : fail(`글자여야 합니다 (${where}).`);
const list = (value: unknown, where: string): unknown[] =>
  Array.isArray(value) ? value : fail(`목록이어야 합니다 (${where}).`);

function readValues(value: unknown, where: string): CityValues {
  if (!isRecord(value)) return fail(`값이 없습니다 (${where}).`);
  const out = {} as CityValues;
  for (const key of CITY_VALUE_KEYS) out[key] = integer(value[key], `${where}.${key}`);
  return out;
}

function readCity(value: unknown, n: number): MapCity {
  const where = `${n + 1}번째 도시`;
  if (!isRecord(value)) return fail(`모양이 맞지 않습니다 (${where}).`);
  const position = isRecord(value.position) ? value.position : fail(`좌표가 없습니다 (${where}).`);
  return {
    id: integer(value.id, `${where}의 ID`),
    name: text(value.name, `${where}의 이름`),
    level: integer(value.level, `${where}의 규모`),
    region: integer(value.region, `${where}의 지역`),
    position: { x: finite(position.x, `${where}의 x 좌표`), y: finite(position.y, `${where}의 y 좌표`) },
    connections: list(value.connections, `${where}의 연결`).map((id) => integer(id, `${where}의 연결`)),
    max: readValues(value.max, `${where}의 최대치`),
    initial: readValues(value.initial, `${where}의 초기치`),
  };
}

function readPoints(value: unknown, where: string): Point[] {
  return list(value, where).map((point) => {
    const pair = list(point, where);
    if (pair.length !== 2) return fail(`점은 [x, y] 모양이어야 합니다 (${where}).`);
    return [finite(pair[0], `${where}의 x 좌표`), finite(pair[1], `${where}의 y 좌표`)];
  });
}

function readTerrain(value: unknown): Terrain {
  if (value === undefined) return emptyTerrain();
  if (!isRecord(value)) return fail('지형 층의 모양이 맞지 않습니다.');
  const polygons = (layer: PolygonLayer) =>
    value[layer] === undefined
      ? []
      : list(value[layer], `지형 ${layerLabel(layer)}`).map((points, i) =>
          readPoints(points, `${layerLabel(layer)} ${i + 1}`),
        );
  const rivers =
    value.rivers === undefined
      ? []
      : list(value.rivers, '지형 강').map((river, i): River => {
          if (!isRecord(river)) return fail(`모양이 맞지 않습니다 (강 ${i + 1}).`);
          const points = readPoints(river.points, `강 ${i + 1}`);
          return river.name === undefined ? { points } : { name: text(river.name, `강 ${i + 1}의 이름`), points };
        });
  return { coast: polygons('coast'), lakes: polygons('lakes'), rivers, mountains: polygons('mountains') };
}

// 지금 형식(resources/map/che.json 모양)과 v2를 함께 읽는다. 겹치는 ID나 한쪽 연결 같은 뜻의 오류는 막지 않고
// 검증 목록(validate.ts)에 맡긴다. 여기서는 모양이 틀린 파일만 거부한다.
export function parseMapJson(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: 'JSON으로 읽을 수 없는 파일입니다.' };
  }
  try {
    if (!isRecord(raw)) return fail('지도 파일의 모양이 맞지 않습니다.');
    const legacy = raw.version === undefined;
    if (!legacy && raw.version !== 2) return fail(`지원하지 않는 형식 판입니다 (version ${String(raw.version)}).`);
    const canvas =
      raw.canvas === undefined ? DEFAULT_CANVAS : isRecord(raw.canvas) ? raw.canvas : fail('캔버스 크기가 없습니다.');
    const width = finite(canvas.width, '캔버스 너비');
    const height = finite(canvas.height, '캔버스 높이');
    if (width <= 0 || height <= 0) return fail('캔버스 크기는 0보다 커야 합니다.');
    const defaults = isRecord(raw.defaults) ? raw.defaults : fail('도시 기본값(defaults)이 없습니다.');
    const supplyState =
      defaults.supplyState === 0 || defaults.supplyState === 1
        ? defaults.supplyState
        : fail('defaults.supplyState는 0이나 1이어야 합니다.');
    const map: MapV2 = {
      ...(typeof raw.$comment === 'string' ? { $comment: raw.$comment } : {}),
      version: 2,
      id: text(raw.id, '지도 ID'),
      name: text(raw.name, '지도 이름'),
      canvas: { width, height },
      defaults: { ...defaults, trust: finite(defaults.trust, 'defaults.trust'), supplyState },
      cities: list(raw.cities, '도시').map(readCity),
      terrain: readTerrain(raw.terrain),
    };
    return { ok: true, map, legacy };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    throw error;
  }
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
