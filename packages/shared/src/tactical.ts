import { z } from 'zod';

const natural = z.number().int().min(0).max(2_147_483_647);
const id = natural.min(1);
export const battleCellSchema = z.strictObject({ x: natural.max(63), y: natural.max(63) });
export const battleActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('move'), ...battleCellSchema.shape }),
  z.strictObject({
    kind: z.literal('attack'),
    target: z.union([
      z
        .number()
        .int()
        .min(-2_147_483_647)
        .max(2_147_483_647)
        .refine((v) => v !== 0),
      z.literal('nearest'),
    ]),
  }),
  z.strictObject({ kind: z.enum(['hold', 'retreat', 'followPath', 'capture', 'withdraw']) }),
]);
export const battlePlanSchema = z.strictObject({
  unitId: z.number().int(),
  path: z.array(battleCellSchema).max(64),
  rules: z
    .array(
      z.strictObject({
        when: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('enemyVisible'), range: id.max(3) }),
          z.strictObject({ kind: z.enum(['sideMoraleBelow', 'troopsBelow']), value: natural }),
          z.strictObject({ kind: z.literal('atCell'), ...battleCellSchema.shape }),
          z.strictObject({ kind: z.literal('always') }),
        ]),
        then: battleActionSchema,
      }),
    )
    .max(8),
  fallback: battleActionSchema,
});
export const battleEnvelopeSchema = z.strictObject({
  worldId: z.string().min(1),
  battleId: z.string().min(1).max(200),
  expectedRevision: natural,
  windowNo: natural,
  mapHash: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(100),
});
export const battlePlanInputSchema = battleEnvelopeSchema.extend({ units: z.array(battlePlanSchema).min(1).max(40) });
export const battleCouncilInputSchema = battleEnvelopeSchema.extend({
  placements: z
    .array(z.strictObject({ unitId: z.number().int(), ...battleCellSchema.shape }))
    .max(40)
    .optional(),
  route: z.enum(['front', 'left', 'right', 'encircle']).optional(),
  defense: z.enum(['intercept', 'ambush', 'hold']).optional(),
  traps: z
    .array(z.strictObject({ kind: z.enum(['fire', 'water', 'rock', 'pit', 'poison']), ...battleCellSchema.shape }))
    .max(3)
    .optional(),
  schemes: z
    .array(
      z.strictObject({ kind: z.enum(['inspire', 'haste', 'search']), turn: id.max(30), ...battleCellSchema.shape }),
    )
    .max(5)
    .optional(),
  ready: z.boolean(),
});
export const battleTurnInputSchema = battleEnvelopeSchema.extend({
  turnNo: id.max(30),
  unitId: z.number().int(),
  expectedUnitOrderRevision: natural,
  action: battleActionSchema,
});
export type BattleAction = z.infer<typeof battleActionSchema>;
export type BattlePlan = z.infer<typeof battlePlanSchema>;
export type BattleSide = 'attack' | 'defend';
export type BattleTerrain =
  'plain' | 'grass' | 'forest' | 'mountain' | 'river' | 'ford' | 'bridge' | 'road' | 'marsh' | 'sea';
export interface TacticalUnit {
  id: number;
  side: BattleSide;
  generalName: string;
  portraitId?: number | null;
  crewTypeName: string;
  troops: number;
  troopsMax: number;
  x: number;
  y: number;
  status: 'normal' | 'confused' | 'stopped' | 'provoked' | 'ambush' | 'routed';
  role?: 'commander' | 'strategist' | null;
}
export interface TacticalBase {
  id: number;
  x: number;
  y: number;
  kind: 'contest' | 'supply';
  owner: BattleSide | null;
}
export interface TacticalEvent {
  kind:
    | 'move'
    | 'attack'
    | 'arrow'
    | 'charge'
    | 'duel'
    | 'scheme'
    | 'trap'
    | 'capture'
    | 'reinforce'
    | 'retreat'
    | 'siege'
    | 'morale'
    | 'end';
  text: string;
  actorId?: number | null;
  targetId?: number | null;
  exchange?: {
    attacker: string;
    attackerBefore: number;
    attackerAfter: number;
    defender: string;
    defenderBefore: number;
    defenderAfter: number;
  } | null;
  fortification?: { defenseBefore: number; defenseAfter: number; gateBefore: number; gateAfter: number };
}
export interface TacticalFrame {
  turn: number;
  units: TacticalUnit[];
  bases: TacticalBase[];
  totals: Record<BattleSide, { units: number; troops: number; rice: number; morale: number }>;
  events: TacticalEvent[];
  siege?: { defense: number; defenseMax: number; gate: number; gateMax: number } | null;
}
export interface TacticalBattle {
  id: string;
  year: number;
  month: number;
  place: string;
  phase: 'council' | 'field' | 'siege' | 'ended';
  turnLimit: number;
  route: 'front' | 'left' | 'right' | 'encircle' | null;
  defense: 'intercept' | 'ambush' | 'hold' | null;
  board: { width: number; height: number; terrain: BattleTerrain[] };
  sides: Record<
    BattleSide,
    { nationName: string; color: string; commander: string; strategist: string | null; schemePoints: number }
  >;
  frames: TacticalFrame[];
  result: BattleSide | 'draw' | null;
  liveUntil?: string | null;
}
const sideSchema = z.enum(['attack', 'defend']);
export const tacticalEventSchema = z.strictObject({
  fortification: z
    .strictObject({ defenseBefore: natural, defenseAfter: natural, gateBefore: natural, gateAfter: natural })
    .optional(),
  kind: z.enum([
    'move',
    'attack',
    'arrow',
    'charge',
    'duel',
    'scheme',
    'trap',
    'capture',
    'reinforce',
    'retreat',
    'siege',
    'morale',
    'end',
  ]),
  text: z.string(),
  actorId: z.number().int().nullable().optional(),
  targetId: z.number().int().nullable().optional(),
  exchange: z
    .strictObject({
      attacker: z.string(),
      attackerBefore: natural,
      attackerAfter: natural,
      defender: z.string(),
      defenderBefore: natural,
      defenderAfter: natural,
    })
    .nullable()
    .optional(),
});
const totalSchema = z.strictObject({ units: natural, troops: natural, rice: natural, morale: natural.max(100) });
export const tacticalFrameSchema = z.strictObject({
  turn: natural.max(30),
  units: z.array(
    z.strictObject({
      id: z.number().int(),
      side: sideSchema,
      generalName: z.string(),
      portraitId: natural.nullable().optional(),
      crewTypeName: z.string(),
      troops: natural,
      troopsMax: natural,
      x: natural.max(63),
      y: natural.max(63),
      status: z.enum(['normal', 'confused', 'stopped', 'provoked', 'ambush', 'routed']),
      role: z.enum(['commander', 'strategist']).nullable().optional(),
    }),
  ),
  bases: z.array(
    z.strictObject({
      id: natural,
      ...battleCellSchema.shape,
      kind: z.enum(['contest', 'supply']),
      owner: sideSchema.nullable(),
    }),
  ),
  totals: z.strictObject({ attack: totalSchema, defend: totalSchema }),
  events: z.array(tacticalEventSchema),
  siege: z
    .strictObject({ defense: natural, defenseMax: natural, gate: natural, gateMax: natural })
    .nullable()
    .optional(),
}) as z.ZodType<TacticalFrame>;
