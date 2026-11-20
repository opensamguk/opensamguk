import { battleWeatherSchema, battleWindSchema, rngFor, type Rng, type TacticalEvent } from '@opensamguk/shared';
import type { DeepReadonly } from '../model/world';
import type { BattleState, BattleUnitState } from './state';

const windSteps = {
  N: [0, -1],
  NE: [1, -1],
  E: [1, 0],
  SE: [1, 1],
  S: [0, 1],
  SW: [-1, 1],
  W: [-1, 0],
  NW: [-1, -1],
} as const;

export function rollEnvironment(rng: Rng) {
  return { weather: rng.pick(battleWeatherSchema.options), wind: rng.pick(battleWindSchema.options) };
}

export function visionRange(b: DeepReadonly<BattleState>, u: { x: number; y: number }, base = 3) {
  const weather = b.weather === 'fog' ? 2 : b.weather === 'downpour' ? 1 : 0;
  const terrain = b.board.terrain[u.y * b.board.width + u.x];
  return Math.max(1, base - weather + (terrain === 'mountain' ? 1 : terrain === 'forest' ? -1 : 0));
}

export function movementCost(terrain: string) {
  return terrain === 'mountain'
    ? 3
    : terrain === 'ford'
      ? 2
      : terrain === 'sandbar'
        ? 1.5
        : ['forest', 'marsh'].includes(terrain)
          ? 2
          : 1;
}

export function canIgnite(b: DeepReadonly<BattleState>, cell: { x: number; y: number }) {
  if (b.weather === 'downpour' || cell.x < 0 || cell.y < 0 || cell.x >= b.board.width || cell.y >= b.board.height)
    return false;
  const index = cell.y * b.board.width + cell.x;
  return !!b.cells[index]?.sourceTileId && !['sea', 'river', 'ford'].includes(b.board.terrain[index]!);
}

export function ignite(b: BattleState, cell: { x: number; y: number }, scope: string) {
  if (!canIgnite(b, cell)) return false;
  if (b.burningCells.some((c) => c.x === cell.x && c.y === cell.y)) return true;
  const terrain = b.board.terrain[cell.y * b.board.width + cell.x]!;
  const chance =
    (['forest', 'grass', 'plain'].includes(terrain) ? 0.8 : 0.4) *
    (b.weather === 'snow' ? 0.25 : b.weather === 'rain' ? 0.5 : 1);
  if (rngFor(b.seed, 'tactical', b.rulesVersion, b.id, b.turn, 'ignite', scope, cell.x, cell.y).next() >= chance)
    return false;
  b.burningCells.push({ x: cell.x, y: cell.y });
  return true;
}

export function updateWeather(b: BattleState) {
  const rng = rngFor(b.seed, 'tactical', b.rulesVersion, b.id, b.turn, 'weather');
  if (rng.next() < 0.2) Object.assign(b, rollEnvironment(rng));
  if (b.weather === 'downpour') b.burningCells = [];
}

export function resolveFire(b: BattleState, events: TacticalEvent[]) {
  if (b.weather === 'downpour') {
    b.burningCells = [];
    return;
  }
  const [dx, dy] = windSteps[b.wind];
  // 번짐 도중 새로 붙은 칸은 다음 정산부터 번진다.
  for (const c of [...b.burningCells]) ignite(b, { x: c.x + dx, y: c.y + dy }, `spread:${c.x}:${c.y}`);
  b.burningCells.sort((a, c) => a.y - c.y || a.x - c.x);
  for (const u of b.units) {
    if (u.troops <= 0 || u.status === 'routed' || !b.burningCells.some((c) => c.x === u.x && c.y === u.y)) continue;
    const loss = Math.ceil(u.troops * 0.05);
    u.troops -= loss;
    const rng = rngFor(b.seed, 'tactical', b.rulesVersion, b.id, b.turn, u.id, 'fire-injury');
    if (u.commanderId !== null && rng.next() < 0.2) u.injury = Math.min(80, u.injury + rng.int(1, 5));
    events.push({ kind: 'scheme', targetId: u.id, text: `화재 피해 ${loss}` });
  }
}

export function terrainDefense(b: DeepReadonly<BattleState>, u: DeepReadonly<BattleUnitState>) {
  const objects = b.board.objects.filter((o) => o.x === u.x && o.y === u.y);
  return objects.some((o) => o.kind === 'earthwork') ? 0.85 : 1;
}
