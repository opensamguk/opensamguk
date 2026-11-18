import { z } from 'zod';
import {
  battleTerrainSchema,
  battleWeatherSchema,
  battleWindSchema,
  battleObjectSchema,
  battleStructureSchema,
  battlePlanSchema,
  battleActionSchema,
  battleCellSchema,
  tacticalFrameSchema,
  tacticalEventSchema,
  type TacticalBattle,
} from '@opensamguk/shared';

const n = z.number().int().nonnegative();
const side = z.enum(['attack', 'defend']);
const modifier = z.object({ source: z.string(), op: z.enum(['add', 'mul']), value: z.number().finite() });
export const tacticalUnitSchema = z.object({
  id: z.number().int(),
  sourceId: n.nullable(),
  ownerId: n.nullable(),
  commanderId: n.nullable(),
  side,
  generalName: z.string(),
  portraitId: n.nullable(),
  crewTypeName: z.string(),
  crewType: n,
  troops: n,
  troopsMax: n,
  train: n.max(100),
  intelligence: n,
  leadership: n,
  strength: n,
  injury: n.max(100).default(0),
  x: n.max(63),
  y: n.max(63),
  sp: n.max(100).nullable(),
  loadedSp: n.max(100).nullable(),
  originCityKey: n,
  order: n,
  move: n,
  range: n,
  naval: z.boolean(),
  volley: z.boolean(),
  status: z.enum(['normal', 'confused', 'stopped', 'provoked', 'ambush', 'routed']),
  role: z.enum(['commander', 'strategist']).nullable(),
  cursor: n,
  plan: battlePlanSchema.nullable(),
  combat: z.object({ tech: n, dealt: z.array(modifier), taken: z.array(modifier) }),
});
const army = z.object({
  nationId: n.nullable(),
  nationName: z.string(),
  color: z.string(),
  commanderId: n.nullable(),
  advisorId: n.nullable(),
  commander: z.string(),
  strategist: z.string().nullable(),
  schemePoints: n.max(10),
  morale: n.max(100),
  rice: n,
  riceOwners: z.array(z.object({ kind: z.enum(['general', 'city']), id: n, remaining: n })),
  ready: z.boolean(),
  routeReward: z.boolean(),
});
export const tacticalBattleSchema = z.object({
  formatVersion: z.literal(1),
  rulesVersion: z.literal('tactical-v1'),
  unitSetHash: z.string(),
  id: z.string(),
  revision: n,
  tick: n,
  year: n,
  month: n,
  place: z.string(),
  seed: z.string(),
  targetCityKey: n,
  originCityKey: n,
  fortificationDefence: n,
  settled: z.boolean(),
  phase: z.enum(['council', 'field', 'siege', 'ended']),
  mode: z.enum(['RESERVED', 'LIVE']),
  turn: n.max(30),
  windowNo: n,
  deadlineAt: n,
  hardDeadlineAt: n,
  pausedAt: n.nullable(),
  fault: z.string().nullable(),
  turnMs: n,
  councilMs: n,
  mapHash: z.string(),
  weather: battleWeatherSchema.default('clear'),
  wind: battleWindSchema.default('E'),
  burningCells: z.array(battleCellSchema).default([]),
  board: z.object({
    width: n.max(64),
    height: n.max(64),
    terrain: z.array(battleTerrainSchema),
    objects: z.array(battleObjectSchema).default([]),
  }),
  exits: z.object({ attack: battleCellSchema, defend: battleCellSchema }),
  cells: z.array(z.object({ sourceTileId: z.string(), spCost: n.min(1).max(12), defendSpCost: n.min(1).max(12) })),
  edges: z.array(z.tuple([n, n])),
  route: z.enum(['front', 'left', 'right', 'encircle']),
  defense: z.enum(['intercept', 'ambush', 'hold']),
  sides: z.object({ attack: army, defend: army }),
  units: z.array(tacticalUnitSchema).max(40),
  bases: z.array(
    z.object({
      id: n,
      ...battleCellSchema.shape,
      kind: z.enum(['contest', 'supply']),
      structure: battleStructureSchema.default('camp'),
      owner: side.nullable(),
      rewarded: z.boolean(),
    }),
  ),
  traps: z.array(
    z.object({
      kind: z.enum(['fire', 'water', 'rock', 'pit', 'poison']),
      ...battleCellSchema.shape,
      spent: z.boolean(),
      revealed: z.boolean(),
    }),
  ),
  schemes: z.array(
    z.object({
      side,
      kind: z.enum(['inspire', 'haste', 'search', 'fire']),
      turn: n,
      ...battleCellSchema.shape,
      used: z.boolean(),
    }),
  ),
  siege: z.object({ defense: n, defenseMax: n, gate: n, gateMax: n }).nullable(),
  frames: z.array(tacticalFrameSchema),
  views: z.object({ attack: z.array(tacticalFrameSchema), defend: z.array(tacticalFrameSchema) }),
  records: z.array(
    z.object({
      turn: n,
      beforeHash: z.string(),
      afterHash: z.string(),
      orders: z.array(z.object({ unitId: z.number().int(), action: battleActionSchema })),
      events: z.array(tacticalEventSchema),
    }),
  ),
  receipts: z.array(
    z.object({ id: z.string(), status: z.enum(['APPLIED', 'REJECTED']), reason: z.string().nullable() }),
  ),
  result: side.nullable(),
  reason: z.string().nullable(),
});
export const tacticalStateSchema = z.object({ nextId: n.min(1), battles: z.array(tacticalBattleSchema) });
export type BattleState = z.infer<typeof tacticalBattleSchema>;
export type BattleUnitState = z.infer<typeof tacticalUnitSchema>;
export type TacticalState = z.infer<typeof tacticalStateSchema>;
export type BattleOrder = { unitId: number; action: z.infer<typeof battleActionSchema> };
export const BATTLE_DEFAULTS = {
  councilMs: 120_000,
  turnLimit: 30,
  maxTurnMs: 60_000,
  presenceMs: 45_000,
  vision: 3,
  baseVision: 2,
  starvation: 10,
} as const;

export function battleDuration(turnTermMinutes: number) {
  const interval = Math.floor(turnTermMinutes * 60_000);
  return {
    councilMs: BATTLE_DEFAULTS.councilMs,
    turnMs: interval <= 120_000 ? 0 : Math.min(60_000, Math.floor((interval - BATTLE_DEFAULTS.councilMs) / 30)),
  };
}
export function battleHash(value: unknown): string {
  let hash = 14695981039346656037n;
  const serialized = JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, (v as Record<string, unknown>)[key]]),
        )
      : v,
  );
  if (serialized === undefined) throw Error('전투 해시에 JSON 값이 필요합니다.');
  for (let index = 0; index < serialized.length; index++)
    hash = BigInt.asUintN(64, (hash ^ BigInt(serialized.charCodeAt(index))) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}
export function tacticalView(b: BattleState, ownSide: 'attack' | 'defend', afterTurn = -1, limit = 5): TacticalBattle {
  return {
    id: b.id,
    year: b.year,
    month: b.month,
    place: b.place,
    phase: b.phase,
    turnLimit: 30,
    route: ownSide === 'attack' || b.phase !== 'council' ? b.route : null,
    defense: ownSide === 'defend' || b.phase !== 'council' ? b.defense : null,
    board: structuredClone(b.board),
    sides: Object.fromEntries(
      (['attack', 'defend'] as const).map((s) => [
        s,
        {
          nationName: b.sides[s].nationName,
          color: b.sides[s].color,
          commander: b.sides[s].commander,
          strategist: b.sides[s].strategist,
          schemePoints: s === ownSide ? b.sides[s].schemePoints : 0,
        },
      ]),
    ) as TacticalBattle['sides'],
    frames: structuredClone(b.views[ownSide].filter((f) => f.turn > afterTurn).slice(0, limit)),
    result: b.result,
    liveUntil: null,
  };
}
