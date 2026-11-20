import type { TacticalBattle as ServerBattle } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { moveReach } from './BattleBoard';
import {
  attackCells,
  bridgeArtName,
  cellSet,
  fireArtName,
  placedObjects,
  visionCells,
  weatherOverlay,
  windScreen,
} from './fieldRules';
import type { BattleBoardData, BattleUnit, TacticalBattle, Terrain } from './types';

// 서버 응답(shared TacticalBattle, D-105)을 화면 형식에 그대로 넣을 수 있어야 한다. 어긋나면 타입 검사에서 걸린다.
const fromServer = (battle: ServerBattle): TacticalBattle => battle;

function boardOf(rows: string[], objects: BattleBoardData['objects'] = []): BattleBoardData {
  const code: Record<string, Terrain> = { '.': 'plain', '~': 'river', f: 'forest', s: 'sandbar', g: 'grass' };
  return {
    width: rows[0]!.length,
    height: rows.length,
    terrain: rows.flatMap((row) => [...row].map((ch) => code[ch]!)),
    objects,
  };
}

const unit = (id: number, side: BattleUnit['side'], x: number, y: number, extra: Partial<BattleUnit> = {}) =>
  ({
    id,
    side,
    generalName: `장수${id}`,
    crewTypeName: '보병',
    troops: 1000,
    troopsMax: 1000,
    x,
    y,
    status: 'normal',
    ...extra,
  }) satisfies BattleUnit;

describe('야전 칸 규칙 자료 잇기 (D-105)', () => {
  it('서버 응답 형식을 화면 형식으로 받는다', () => {
    expect(typeof fromServer).toBe('function');
  });

  it('visibleCells가 없으면 가리지 않고, 빈 목록이면 전부 가린다', () => {
    expect(cellSet(undefined)).toBeNull();
    expect(cellSet([])!.size).toBe(0);
    expect(cellSet([{ x: 2, y: 3 }])!.has('2,3')).toBe(true);
  });

  it('바람 방향을 화면 방향의 정수 무늬 장으로 바꾼다', () => {
    // 북(y-1)은 화면 오른쪽 위, 북동(x+1, y-1)은 화면 오른쪽, 남동(x+1, y+1)은 화면 아래.
    expect(windScreen('N')).toEqual({ dx: 2, dy: -1, angle: -27 });
    expect(windScreen('NE')).toEqual({ dx: 4, dy: 0, angle: 0 });
    expect(windScreen('SE')).toEqual({ dx: 0, dy: 2, angle: 90 });
    expect(windScreen('SW').dx).toBe(-4);
  });

  it('날씨 덮개: 맑으면 없고, 비는 rain 무늬를 바람 쪽과 아래로 흘린다', () => {
    expect(weatherOverlay('clear', 'N')).toBeNull();
    expect(weatherOverlay(undefined, undefined)).toBeNull();
    const rain = weatherOverlay('rain', 'NE')!;
    expect(rain.url).toContain('effects/rain.webp');
    expect([rain.dx, rain.dy]).toEqual([4, 4]);
    expect(weatherOverlay('downpour', 'NE')!.url).toContain('effects/rain.webp');
    expect(weatherOverlay('snow', 'S')!.url).toContain('effects/snow.webp');
    expect(weatherOverlay('fog', 'W')!.url).toContain('effects/dust.webp');
  });

  it('숲이거나 둘레에 불이 셋 이상이면 큰 불을 쓴다', () => {
    const board = boardOf(['...', '.f.', '...']);
    expect(fireArtName(board, new Set(['1,1']), 1, 1)).toBe('effects/fire-big');
    expect(fireArtName(board, new Set(['0,0']), 0, 0)).toBe('effects/fire');
    expect(fireArtName(board, new Set(['0,0', '1,0', '2,0', '0,1']), 0, 1)).toBe('effects/fire');
    const open = boardOf(['...', '...', '...']);
    expect(fireArtName(open, new Set(['0,0', '1,0', '1,1']), 1, 1)).toBe('effects/fire');
    expect(fireArtName(open, new Set(['0,0', '1,0', '2,0', '1,1']), 1, 1)).toBe('effects/fire-big');
  });

  it('다리는 물이 흐르는 축을 가로질러 놓고, 판단이 안 되면 서버 방향 이름을 따른다', () => {
    // x축으로 흐르는 강을 건너는 다리는 판 y축(화면 왼쪽 아래↔오른쪽 위) 그림이다.
    const across = boardOf(['...', '~~~', '...']);
    expect(bridgeArtName(across, { x: 1, y: 1, kind: 'bridge', direction: 'NW-SE' })).toBe('objects/bridge-ne');
    const down = boardOf(['.~.', '.~.', '.~.']);
    expect(bridgeArtName(down, { x: 1, y: 1, kind: 'bridge', direction: 'NE-SW' })).toBe('objects/bridge-nw');
    const dry = boardOf(['...', '...', '...']);
    expect(bridgeArtName(dry, { x: 1, y: 1, kind: 'bridge', direction: 'NE-SW' })).toBe('objects/bridge-ne');
    expect(bridgeArtName(dry, { x: 1, y: 1, kind: 'bridge', direction: 'NW-SE' })).toBe('objects/bridge-nw');
  });

  it('지물 그림: 판 지물이 먼저이고 거점은 지물 종류, 없으면 진영, 보급 거점은 보급 그림', () => {
    const board = boardOf(
      ['....', '....'],
      [
        { x: 0, y: 0, kind: 'earthwork' },
        { x: 1, y: 0, kind: 'rubble' },
        { x: 2, y: 0, kind: 'fort-large' },
      ],
    );
    const placed = placedObjects(board, [
      { id: 1, x: 0, y: 0, kind: 'contest', owner: null },
      { id: 2, x: 0, y: 1, kind: 'contest', owner: 'attack' },
      { id: 3, x: 1, y: 1, kind: 'contest', structure: 'fort-medium', owner: 'defend' },
      { id: 4, x: 2, y: 1, kind: 'supply', owner: 'attack' },
    ]);
    const art = Object.fromEntries(placed.map((p) => [`${p.x},${p.y}`, p.art]));
    expect(art).toEqual({
      '0,0': 'objects/mound',
      '1,0': 'objects/ruin',
      '2,0': 'objects/fort-3',
      '0,1': 'objects/camp',
      '1,1': 'objects/fort-2',
      '2,1': 'objects/supply',
    });
  });

  it('고른 부대 둘레 8칸의 살아 있는 적만 공격 표시를 받는다', () => {
    const me = unit(1, 'attack', 2, 2);
    const units = [
      me,
      unit(2, 'defend', 3, 3),
      unit(3, 'defend', 4, 2),
      unit(4, 'defend', 1, 2, { status: 'routed' }),
      unit(5, 'attack', 2, 1),
    ];
    expect([...attackCells(units, me)]).toEqual(['3,3']);
    expect(attackCells(units, null).size).toBe(0);
  });

  it('미리보기 시야는 부대 vision과 소유 거점 2칸을 체비셰프 거리로 잰다', () => {
    const board = boardOf(['.......', '.......', '.......']);
    const cells = visionCells(
      board,
      [unit(1, 'attack', 0, 0, { vision: 1 })],
      [
        { id: 1, x: 6, y: 2, kind: 'contest', owner: 'attack' },
        { id: 2, x: 3, y: 0, kind: 'contest', owner: 'defend' },
      ],
      'attack',
    );
    const keys = new Set(cells.map((c) => `${c.x},${c.y}`));
    expect(keys.has('1,1')).toBe(true);
    expect(keys.has('2,0')).toBe(false);
    expect(keys.has('4,0')).toBe(true);
    expect(keys.has('3,0')).toBe(false);
  });

  it('이동 범위: 모래톱은 1.5, 무너진 터는 들어갈 때 1을 더 쓴다', () => {
    const sand = boardOf(['.ss.']);
    const mover = unit(1, 'attack', 0, 0);
    expect(moveReach(sand, [mover], mover, 3)).toEqual(new Set(['1,0', '2,0']));
    const ruin = boardOf(['....'], [{ x: 1, y: 0, kind: 'rubble' }]);
    expect(moveReach(ruin, [mover], mover, 2)).toEqual(new Set(['1,0']));
  });
});
