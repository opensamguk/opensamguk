import { describe, expect, it } from 'vitest';
import type { MapV2 } from './contract';
import { editorReducer, initialEditor, type EditorAction, type EditorState } from './editor';
import { testCity, testMap } from './fixtures';
import { validateMap } from './validate';

// T4-80 편집 reducer. 연결은 늘 양쪽에 함께 들어가고 빠진다.
const run = (map: MapV2, ...actions: EditorAction[]): EditorState => actions.reduce(editorReducer, initialEditor(map));

const symmetric = (map: MapV2) =>
  map.cities.every((city) =>
    city.connections.every((id) => map.cities.find((other) => other.id === id)?.connections.includes(city.id)),
  );

describe('도시', () => {
  it('추가하면 가장 큰 ID + 1, 이름, 규모 1, 연결 없음이고 고른 상태가 된다', () => {
    const state = run(testMap(), { type: 'addCity', x: 100.4, y: 200.6 });
    const added = state.map.cities[3]!;
    expect(added).toMatchObject({
      id: 4,
      name: '새 도시 4',
      level: 1,
      region: 1,
      position: { x: 100, y: 201 },
      connections: [],
    });
    expect(added.max).toEqual(state.map.cities[0]!.max);
    expect(state.selection).toEqual({ kind: 'city', index: 3 });
  });

  it('캔버스 밖을 누르면 가장자리에 둔다', () => {
    const state = run(testMap(), { type: 'addCity', x: -5, y: 900 });
    expect(state.map.cities[3]!.position).toEqual({ x: 0, y: 500 });
  });

  it('옮기면 좌표만 바뀐다', () => {
    const state = run(testMap(), { type: 'moveCity', index: 1, x: 300, y: 120 });
    expect(state.map.cities[1]).toEqual({ ...testMap().cities[1], position: { x: 300, y: 120 } });
  });

  it('삭제하면 다른 도시의 연결에서도 빠진다', () => {
    const state = run(testMap(), { type: 'deleteCity', index: 1 });
    expect(state.map.cities.map((city) => [city.id, city.connections])).toEqual([
      [1, []],
      [3, []],
    ]);
    expect(state.selection).toBeNull();
  });

  it('이름·규모·지역을 고친다. 같은 값이면 기록에 쌓지 않는다', () => {
    const state = run(testMap(), { type: 'updateCity', index: 0, patch: { name: '업', level: 8, region: 3 } });
    expect(state.map.cities[0]).toMatchObject({ name: '업', level: 8, region: 3 });
    expect(state.past).toHaveLength(1);
    expect(editorReducer(state, { type: 'updateCity', index: 0, patch: { name: '업' } }).past).toHaveLength(1);
  });
});

describe('연결', () => {
  it('잇기와 끊기는 양쪽에 함께 한다', () => {
    const linked = run(testMap(), { type: 'toggleLink', a: 0, b: 2 });
    expect(linked.map.cities[0]!.connections).toEqual([2, 3]);
    expect(linked.map.cities[2]!.connections).toEqual([2, 1]);
    expect(symmetric(linked.map)).toBe(true);
    const cut = editorReducer(linked, { type: 'toggleLink', a: 2, b: 0 });
    expect(cut.map.cities[0]!.connections).toEqual([2]);
    expect(cut.map.cities[2]!.connections).toEqual([2]);
    expect(symmetric(cut.map)).toBe(true);
  });

  it('한쪽에만 있던 연결은 끊어서 양쪽을 맞춘다', () => {
    const state = run(testMap([testCity(1, [2]), testCity(2, [])]), { type: 'toggleLink', a: 1, b: 0 });
    expect(state.map.cities.map((city) => city.connections)).toEqual([[], []]);
  });

  it('자기 자신과는 잇지 않는다', () => {
    const state = run(testMap(), { type: 'toggleLink', a: 1, b: 1 });
    expect(state.map).toEqual(testMap());
    expect(state.past).toHaveLength(0);
  });

  it('추가·삭제·잇기를 섞어도 대칭이고 연결망이 이어진다', () => {
    const state = run(
      testMap(),
      { type: 'addCity', x: 10, y: 10 },
      { type: 'addCity', x: 20, y: 20 },
      { type: 'toggleLink', a: 3, b: 4 },
      { type: 'toggleLink', a: 4, b: 2 },
      { type: 'deleteCity', index: 1 },
      { type: 'toggleLink', a: 0, b: 2 },
    );
    expect(symmetric(state.map)).toBe(true);
    expect(validateMap(state.map)).toEqual([]);
  });
});

describe('지형', () => {
  it('다각형은 마칠 때 닫히고 강은 열린 선으로 남는다', () => {
    const state = run(
      testMap(),
      {
        type: 'addTerrain',
        layer: 'coast',
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
      },
      {
        type: 'addTerrain',
        layer: 'rivers',
        points: [
          [1, 1],
          [5, 5],
        ],
      },
    );
    expect(state.map.terrain.coast).toEqual([
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 0],
      ],
    ]);
    expect(state.map.terrain.rivers).toEqual([
      {
        points: [
          [1, 1],
          [5, 5],
        ],
      },
    ]);
    expect(state.selection).toEqual({ kind: 'terrain', layer: 'rivers', index: 0, point: null });
  });

  it('닫힌 다각형의 첫 점을 옮기면 끝 점도 같이 옮긴다', () => {
    const state = run(
      testMap(),
      {
        type: 'addTerrain',
        layer: 'lakes',
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
      },
      { type: 'moveTerrainPoint', layer: 'lakes', index: 0, point: 0, x: 10, y: 5 },
    );
    expect(state.map.terrain.lakes[0]).toEqual([
      [10, 5],
      [100, 0],
      [100, 100],
      [10, 5],
    ]);
  });

  it('닫힌 다각형의 첫 점을 지우면 다음 점으로 다시 닫는다', () => {
    const state = run(
      testMap(),
      {
        type: 'addTerrain',
        layer: 'mountains',
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ],
      },
      { type: 'deleteTerrainPoint', layer: 'mountains', index: 0, point: 0 },
    );
    expect(state.map.terrain.mountains[0]).toEqual([
      [100, 0],
      [100, 100],
      [0, 100],
      [100, 0],
    ]);
  });

  it('열린 다각형을 닫고 강 이름을 고치고 선을 지운다', () => {
    const open = {
      ...testMap(),
      terrain: {
        coast: [
          [
            [0, 0],
            [9, 0],
            [9, 9],
          ],
        ],
        lakes: [],
        rivers: [
          {
            points: [
              [1, 1],
              [2, 2],
            ],
          },
        ],
        mountains: [],
      },
    } as MapV2;
    const state = run(
      open,
      { type: 'closeTerrain', layer: 'coast', index: 0 },
      { type: 'renameRiver', index: 0, name: ' 장강 ' },
    );
    expect(validateMap(state.map)).toEqual([]);
    expect(state.map.terrain.rivers[0]).toEqual({
      name: '장강',
      points: [
        [1, 1],
        [2, 2],
      ],
    });
    expect(editorReducer(state, { type: 'deleteTerrain', layer: 'rivers', index: 0 }).map.terrain.rivers).toEqual([]);
  });
});

describe('되돌리기와 다시 하기', () => {
  it('편집 3번을 차례로 되돌리고 다시 한다', () => {
    const maps: MapV2[] = [];
    let state = initialEditor(testMap());
    maps.push(state.map);
    for (const action of [
      { type: 'addCity', x: 1, y: 1 },
      { type: 'moveCity', index: 0, x: 5, y: 5 },
      { type: 'toggleLink', a: 0, b: 2 },
    ] as EditorAction[]) {
      state = editorReducer(state, action);
      maps.push(state.map);
    }
    for (let i = 2; i >= 0; i--) {
      state = editorReducer(state, { type: 'undo' });
      expect(state.map).toBe(maps[i]);
    }
    expect(editorReducer(state, { type: 'undo' })).toBe(state);
    for (let i = 1; i <= 3; i++) {
      state = editorReducer(state, { type: 'redo' });
      expect(state.map).toBe(maps[i]);
    }
    expect(editorReducer(state, { type: 'redo' })).toBe(state);
  });

  it('되돌린 뒤 새로 고치면 다시 하기 기록이 사라진다', () => {
    let state = run(testMap(), { type: 'addCity', x: 1, y: 1 }, { type: 'undo' });
    expect(state.future).toHaveLength(1);
    state = editorReducer(state, { type: 'moveCity', index: 0, x: 3, y: 3 });
    expect(state.future).toHaveLength(0);
  });

  it('되돌려서 사라진 도시는 고르기를 푼다', () => {
    const state = run(testMap(), { type: 'addCity', x: 1, y: 1 }, { type: 'undo' });
    expect(state.selection).toBeNull();
  });

  it('불러오기는 기록을 비운다', () => {
    const state = run(testMap(), { type: 'addCity', x: 1, y: 1 }, { type: 'load', map: testMap() });
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
  });
});
