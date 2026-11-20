// 시험과 미리보기용 예시 전투. 실제 화면은 서버의 전술 전투 계약(D-099, D-105)을 읽는다.
// D-105 야전 칸 규칙을 다 보이도록 강(다리, 여울, 모래톱), 지물, 날씨, 번지는 불, 공격측 시야를 넣었다.
import { cellKey, visionCells } from './fieldRules';
import type {
  BattleBase,
  BattleBoardData,
  BattleCell,
  BattleFrame,
  BattleUnit,
  Side,
  TacticalBattle,
  Terrain,
} from './types';

const W = 12;
const H = 12;

function terrain(): Terrain[] {
  const tiles: Terrain[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // 강은 y = 6 줄을 따라 흐르고, 다리 하나, 여울 하나, 모래톱 둘이 건널 곳이다.
      if (y === 6) tiles.push(x === 3 ? 'bridge' : x === 8 ? 'ford' : x === 5 || x === 6 ? 'sandbar' : 'river');
      else if (x === 10 && y === 7) tiles.push('sandbar');
      else if ((x - 2) ** 2 + (y - 9) ** 2 < 4) tiles.push('mountain');
      else if ((x - 8) ** 2 + (y - 2) ** 2 < 4) tiles.push('forest');
      else if (x === 10 && y >= 8) tiles.push('road');
      else if (x === y + 1 || x === y - 1) tiles.push('grass');
      else tiles.push('plain');
    }
  return tiles;
}

const board: BattleBoardData = {
  width: W,
  height: H,
  terrain: terrain(),
  objects: [
    { x: 3, y: 6, kind: 'bridge', direction: 'NW-SE' },
    { x: 8, y: 9, kind: 'earthwork' },
    { x: 2, y: 3, kind: 'rubble' },
    { x: 10, y: 3, kind: 'village' },
  ],
};

// 숲에 붙은 불이 북동풍(x+1, y-1 쪽)을 타고 번진다.
function burningAt(turn: number): BattleCell[] {
  const cells: BattleCell[] = [];
  if (turn >= 3) cells.push({ x: 8, y: 3 });
  if (turn >= 4) cells.push({ x: 9, y: 2 });
  if (turn >= 5) cells.push({ x: 8, y: 2 }, { x: 10, y: 1 });
  return cells;
}

// 데모 병종 이름을 확장 병종표 번호로 (battle/units 그림 이름).
const CREW_IDS: Record<string, number> = {
  보병: 1100,
  궁병: 1200,
  기병: 1300,
  노병: 1202,
  철기병: 1304,
  등갑병: 1105,
  정란: 1400,
  벽력거: 1401,
};

const unit = (
  id: number,
  side: Side,
  generalName: string,
  crewTypeName: string,
  troops: number,
  x: number,
  y: number,
  role: BattleUnit['role'] = null,
): BattleUnit => ({
  id,
  side,
  generalName,
  crewTypeName,
  crewTypeId: CREW_IDS[crewTypeName] ?? null,
  troops,
  troopsMax: troops,
  x,
  y,
  status: 'normal',
  role,
  force: 'main',
  vision: 3,
});

const start: BattleUnit[] = [
  unit(1, 'attack', '유비', '보병', 5000, 10, 11, 'commander'),
  unit(2, 'attack', '관우', '기병', 2500, 11, 10, 'strategist'),
  unit(3, 'attack', '장비', '기병', 1500, 9, 11),
  unit(4, 'attack', '조운', '노병', 1000, 11, 9),
  unit(11, 'defend', '하후돈', '보병', 4000, 1, 0, 'commander'),
  unit(12, 'defend', '이전', '노병', 2000, 0, 2),
  unit(13, 'defend', '우금', '보병', 1000, 2, 1),
];

function step(units: BattleUnit[], turn: number): BattleUnit[] {
  return units.map((entry) => {
    const toward = entry.side === 'attack' ? -1 : 1;
    const moved = {
      ...entry,
      // 관우는 5턴에 불길 곁을 지나며 화상을 입는다.
      ...(entry.id === 2 && turn >= 5 ? { injury: 4 } : {}),
      x: Math.max(0, Math.min(W - 1, entry.x + toward)),
      y: Math.max(0, Math.min(H - 1, entry.y + toward)),
    };
    if (turn >= 4) moved.troops = Math.round(moved.troops * (entry.side === 'attack' ? 0.94 : 0.88));
    return moved;
  });
}

function frames(): BattleFrame[] {
  const out: BattleFrame[] = [];
  let units = start;
  for (let turn = 0; turn <= 6; turn++) {
    const sum = (side: Side) =>
      units.filter((entry) => entry.side === side).reduce((acc, entry) => acc + entry.troops, 0);
    const bases: BattleBase[] = [
      { id: 1, x: 6, y: 4, kind: 'contest', owner: turn >= 5 ? 'attack' : null },
      { id: 2, x: 3, y: 8, kind: 'contest', owner: null },
      { id: 3, x: 8, y: 8, kind: 'contest', owner: null },
      { id: 4, x: 4, y: 2, kind: 'contest', structure: 'fort-medium', owner: 'defend' },
      { id: 5, x: 11, y: 11, kind: 'supply', owner: 'attack' },
    ];
    // 서버처럼 공격측(내 편) 시야만 보낸다: 시야 밖 적 부대와 불은 빠진다.
    const visible = visionCells(board, units, bases, 'attack');
    const seen = new Set(visible.map((cell) => cellKey(cell.x, cell.y)));
    out.push({
      turn,
      environment: turn < 3 ? { weather: 'clear', wind: 'E' } : { weather: 'rain', wind: 'NE' },
      burningCells: burningAt(turn).filter((cell) => seen.has(cellKey(cell.x, cell.y))),
      visibleCells: visible,
      units: units.filter((entry) => entry.side === 'attack' || seen.has(cellKey(entry.x, entry.y))),
      bases,
      totals: {
        attack: { units: 4, troops: sum('attack'), rice: 50000 - turn * 400, morale: 80 + (turn >= 5 ? 10 : 0) },
        defend: { units: 3, troops: sum('defend'), rice: 50000, morale: 100 - (turn >= 5 ? 20 : 0) },
      },
      events:
        turn === 5
          ? [
              { kind: 'capture', text: '유비군이 다툼 거점을 차지했습니다.' },
              {
                kind: 'attack',
                text: '관우가 하후돈을 공격했습니다.',
                exchange: {
                  attacker: '관우',
                  attackerBefore: 2350,
                  attackerAfter: 2209,
                  defender: '하후돈',
                  defenderBefore: 3520,
                  defenderAfter: 3098,
                },
              },
            ]
          : turn === 0
            ? [{ kind: 'reinforce', text: '전투가 시작되었습니다.' }]
            : [],
    });
    units = step(units, turn + 1);
  }
  return out;
}

export const demoBattle: TacticalBattle = {
  id: 'demo',
  year: 200,
  month: 3,
  place: '박망',
  phase: 'field',
  turnLimit: 30,
  route: 'encircle',
  defense: 'intercept',
  board,
  sides: {
    attack: { nationName: '유비', color: '#2f7d45', commander: '유비', strategist: '관우', schemePoints: 7 },
    defend: { nationName: '조조', color: '#2f5ea8', commander: '하후돈', strategist: '이전', schemePoints: 5 },
  },
  frames: frames(),
  result: null,
  liveUntil: null,
};

export function demoSiege(): TacticalBattle {
  const base = demoBattle.frames.at(-1)!;
  return {
    ...demoBattle,
    phase: 'siege',
    frames: [0, 1, 2].map((turn) => ({
      ...base,
      turn: 7 + turn,
      siege: { defense: 964 - turn * 220, defenseMax: 964, gate: 300 - turn * 120, gateMax: 300 },
      events: [
        {
          kind: 'siege',
          text: '성벽을 공격했습니다.',
          exchange: {
            attacker: '곽준',
            attackerBefore: 17000,
            attackerAfter: 17000,
            defender: '하의',
            defenderBefore: 8459 - turn * 400,
            defenderAfter: 8050 - turn * 400,
          },
        },
      ],
    })),
  };
}
