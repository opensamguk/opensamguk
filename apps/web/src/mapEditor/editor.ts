// 지도 편집 상태 (docs/plans/T4-80.md). 지도는 바꾸지 않고 새 값을 만든다. 편집 하나가 되돌리기 기록 하나다.
import {
  isClosedPolygon,
  linePoints,
  type CityValues,
  type MapCity,
  type MapV2,
  type Point,
  type TerrainLayer,
} from './contract';

export type Selection =
  { kind: 'city'; index: number } | { kind: 'terrain'; layer: TerrainLayer; index: number; point: number | null };

export interface EditorState {
  map: MapV2;
  past: MapV2[];
  future: MapV2[];
  selection: Selection | null;
}

export type CityPatch = Partial<Pick<MapCity, 'name' | 'level' | 'region'>>;

export type EditorAction =
  | { type: 'load'; map: MapV2 }
  | { type: 'select'; selection: Selection | null }
  | { type: 'addCity'; x: number; y: number }
  | { type: 'moveCity'; index: number; x: number; y: number }
  | { type: 'updateCity'; index: number; patch: CityPatch }
  | { type: 'deleteCity'; index: number }
  | { type: 'toggleLink'; a: number; b: number }
  | { type: 'addTerrain'; layer: TerrainLayer; points: Point[] }
  | { type: 'moveTerrainPoint'; layer: TerrainLayer; index: number; point: number; x: number; y: number }
  | { type: 'deleteTerrainPoint'; layer: TerrainLayer; index: number; point: number }
  | { type: 'closeTerrain'; layer: TerrainLayer; index: number }
  | { type: 'deleteTerrain'; layer: TerrainLayer; index: number }
  | { type: 'renameRiver'; index: number; name: string }
  | { type: 'undo' }
  | { type: 'redo' };

// 되돌리기 기록은 이만큼만 둔다. 지도 하나가 도시 94개 정도라 메모리 걱정은 없다.
const HISTORY_LIMIT = 200;

export const initialEditor = (map: MapV2): EditorState => ({ map, past: [], future: [], selection: null });

// 편집기에서 만드는 좌표는 캔버스 안의 정수다. 캔버스 밖 좌표는 불러온 파일에서만 생기고 검증 목록에 나온다.
export function clampPoint(map: MapV2, x: number, y: number): Point {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));
  return [clamp(x, map.canvas.width), clamp(y, map.canvas.height)];
}

const zeroValues = (): CityValues => ({ population: 0, agriculture: 0, commerce: 0, security: 0, defence: 0, wall: 0 });

export function addCity(map: MapV2, x: number, y: number): { map: MapV2; index: number } {
  const id = map.cities.reduce((max, city) => Math.max(max, city.id), 0) + 1;
  // 도시 수치는 이 화면에서 고치지 않는다. 규모 1인 첫 도시를 본뜨고 없으면 첫 도시, 도시가 없으면 0이다.
  const template = map.cities.find((city) => city.level === 1) ?? map.cities[0];
  const [px, py] = clampPoint(map, x, y);
  const city: MapCity = {
    id,
    name: `새 도시 ${id}`,
    level: 1,
    region: 1,
    position: { x: px, y: py },
    connections: [],
    max: template ? { ...template.max } : zeroValues(),
    initial: template ? { ...template.initial } : zeroValues(),
  };
  return { map: { ...map, cities: [...map.cities, city] }, index: map.cities.length };
}

const replaceCity = (map: MapV2, index: number, change: (city: MapCity) => MapCity): MapV2 => ({
  ...map,
  cities: map.cities.map((city, i) => (i === index ? change(city) : city)),
});

export function moveCity(map: MapV2, index: number, x: number, y: number): MapV2 {
  const [px, py] = clampPoint(map, x, y);
  const city = map.cities[index];
  if (!city || (city.position.x === px && city.position.y === py)) return map;
  return replaceCity(map, index, (c) => ({ ...c, position: { x: px, y: py } }));
}

export function updateCity(map: MapV2, index: number, patch: CityPatch): MapV2 {
  const city = map.cities[index];
  if (!city || Object.entries(patch).every(([key, value]) => city[key as keyof CityPatch] === value)) return map;
  return replaceCity(map, index, (c) => ({ ...c, ...patch }));
}

// 삭제한 도시를 가리키던 연결도 함께 지운다. 같은 ID를 쓰는 다른 도시가 남아 있으면 그 연결은 둔다.
export function deleteCity(map: MapV2, index: number): MapV2 {
  const removed = map.cities[index];
  if (!removed) return map;
  const cities = map.cities.filter((_, i) => i !== index);
  const idStillUsed = cities.some((city) => city.id === removed.id);
  return {
    ...map,
    cities: idStillUsed
      ? cities
      : cities.map((city) =>
          city.connections.includes(removed.id)
            ? { ...city, connections: city.connections.filter((id) => id !== removed.id) }
            : city,
        ),
  };
}

export const isLinked = (map: MapV2, a: number, b: number) => {
  const ca = map.cities[a];
  const cb = map.cities[b];
  return !!ca && !!cb && (ca.connections.includes(cb.id) || cb.connections.includes(ca.id));
};

// 잇기와 끊기는 늘 양쪽에 함께 한다. 한쪽만 이어져 있던 연결은 끊긴다.
export function toggleLink(map: MapV2, a: number, b: number): MapV2 {
  const ca = map.cities[a];
  const cb = map.cities[b];
  if (!ca || !cb || a === b || ca.id === cb.id) return map;
  const linked = isLinked(map, a, b);
  const change = (city: MapCity, otherId: number): MapCity => ({
    ...city,
    connections: linked
      ? city.connections.filter((id) => id !== otherId)
      : [...city.connections.filter((id) => id !== otherId), otherId],
  });
  return {
    ...map,
    cities: map.cities.map((city, i) => (i === a ? change(city, cb.id) : i === b ? change(city, ca.id) : city)),
  };
}

const withLine = (map: MapV2, layer: TerrainLayer, index: number, change: (points: Point[]) => Point[]): MapV2 => {
  if (layer === 'rivers')
    return {
      ...map,
      terrain: {
        ...map.terrain,
        rivers: map.terrain.rivers.map((river, i) =>
          i === index ? { ...river, points: change(river.points) } : river,
        ),
      },
    };
  return {
    ...map,
    terrain: {
      ...map.terrain,
      [layer]: map.terrain[layer].map((points, i) => (i === index ? change(points) : points)),
    },
  };
};

// 다각형은 마칠 때 첫 점을 끝에 붙여 닫는다. 강은 그대로 둔다.
export function addTerrain(map: MapV2, layer: TerrainLayer, points: Point[]): { map: MapV2; index: number } {
  const clamped = points.map(([x, y]) => clampPoint(map, x, y));
  if (layer === 'rivers')
    return {
      map: { ...map, terrain: { ...map.terrain, rivers: [...map.terrain.rivers, { points: clamped }] } },
      index: map.terrain.rivers.length,
    };
  const first = clamped[0];
  const closed = first && !isClosedPolygon(clamped) ? [...clamped, [first[0], first[1]] as Point] : clamped;
  return {
    map: { ...map, terrain: { ...map.terrain, [layer]: [...map.terrain[layer], closed] } },
    index: map.terrain[layer].length,
  };
}

// 닫힌 다각형의 첫 점과 끝 점은 같은 점이다. 화면은 끝 점을 따로 보이지 않고 첫 점을 옮기면 둘 다 옮긴다.
export function moveTerrainPoint(
  map: MapV2,
  layer: TerrainLayer,
  index: number,
  point: number,
  x: number,
  y: number,
): MapV2 {
  const next = clampPoint(map, x, y);
  return withLine(map, layer, index, (points) => {
    const closed = layer !== 'rivers' && isClosedPolygon(points);
    const last = points.length - 1;
    return points.map((p, i) => (i === point || (closed && point === 0 && i === last) ? next : p));
  });
}

export function deleteTerrainPoint(map: MapV2, layer: TerrainLayer, index: number, point: number): MapV2 {
  return withLine(map, layer, index, (points) => {
    if (layer === 'rivers' || !isClosedPolygon(points)) return points.filter((_, i) => i !== point);
    const ring = points.slice(0, -1).filter((_, i) => i !== point);
    const first = ring[0];
    return first ? [...ring, [first[0], first[1]]] : [];
  });
}

export const closeTerrain = (map: MapV2, layer: TerrainLayer, index: number): MapV2 =>
  layer === 'rivers'
    ? map
    : withLine(map, layer, index, (points) => {
        const first = points[0];
        return !first || isClosedPolygon(points) ? points : [...points, [first[0], first[1]]];
      });

export function deleteTerrain(map: MapV2, layer: TerrainLayer, index: number): MapV2 {
  if (layer === 'rivers')
    return { ...map, terrain: { ...map.terrain, rivers: map.terrain.rivers.filter((_, i) => i !== index) } };
  return { ...map, terrain: { ...map.terrain, [layer]: map.terrain[layer].filter((_, i) => i !== index) } };
}

export function renameRiver(map: MapV2, index: number, name: string): MapV2 {
  const trimmed = name.trim();
  return {
    ...map,
    terrain: {
      ...map.terrain,
      rivers: map.terrain.rivers.map((river, i) =>
        i !== index ? river : trimmed ? { name: trimmed, points: river.points } : { points: river.points },
      ),
    },
  };
}

function commit(state: EditorState, map: MapV2, selection: Selection | null = state.selection): EditorState {
  if (map === state.map) return { ...state, selection };
  return { map, past: [...state.past, state.map].slice(-HISTORY_LIMIT), future: [], selection };
}

// 되돌린 뒤 고른 것이 사라졌으면 고르기를 푼다.
function validSelection(map: MapV2, selection: Selection | null): Selection | null {
  if (!selection) return null;
  if (selection.kind === 'city') return map.cities[selection.index] ? selection : null;
  const points = linePoints(map.terrain, selection.layer, selection.index);
  if (!points) return null;
  return selection.point !== null && selection.point >= points.length ? { ...selection, point: null } : selection;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { map } = state;
  switch (action.type) {
    case 'load':
      return initialEditor(action.map);
    case 'select':
      return { ...state, selection: action.selection };
    case 'addCity': {
      const added = addCity(map, action.x, action.y);
      return commit(state, added.map, { kind: 'city', index: added.index });
    }
    case 'moveCity':
      return commit(state, moveCity(map, action.index, action.x, action.y), { kind: 'city', index: action.index });
    case 'updateCity':
      return commit(state, updateCity(map, action.index, action.patch));
    case 'deleteCity':
      return commit(state, deleteCity(map, action.index), null);
    case 'toggleLink':
      return commit(state, toggleLink(map, action.a, action.b));
    case 'addTerrain': {
      const added = addTerrain(map, action.layer, action.points);
      return commit(state, added.map, { kind: 'terrain', layer: action.layer, index: added.index, point: null });
    }
    case 'moveTerrainPoint':
      return commit(state, moveTerrainPoint(map, action.layer, action.index, action.point, action.x, action.y), {
        kind: 'terrain',
        layer: action.layer,
        index: action.index,
        point: action.point,
      });
    case 'deleteTerrainPoint':
      return commit(state, deleteTerrainPoint(map, action.layer, action.index, action.point), {
        kind: 'terrain',
        layer: action.layer,
        index: action.index,
        point: null,
      });
    case 'closeTerrain':
      return commit(state, closeTerrain(map, action.layer, action.index));
    case 'deleteTerrain':
      return commit(state, deleteTerrain(map, action.layer, action.index), null);
    case 'renameRiver':
      return commit(state, renameRiver(map, action.index, action.name));
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        map: previous,
        past: state.past.slice(0, -1),
        future: [map, ...state.future],
        selection: validSelection(previous, state.selection),
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        map: next,
        past: [...state.past, map],
        future: state.future.slice(1),
        selection: validSelection(next, state.selection),
      };
    }
  }
}
