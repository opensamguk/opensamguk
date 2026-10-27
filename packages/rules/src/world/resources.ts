import { z } from 'zod';
import { fiveStatsSchema } from '../general/fiveStats';

const natural = z.number().int().nonnegative();
const positive = z.number().int().positive();
const name = z.string().min(1);
export const portraitMapSchema = z.object({
  portraits: z.record(name, z.number().int().min(10001).max(11000)),
});
const cityValues = z.object({
  population: natural,
  agriculture: natural,
  commerce: natural,
  security: natural,
  defence: natural,
  wall: natural,
});

export const mapSchema = z.object({
  id: name,
  name,
  cities: z
    .array(
      z.object({
        id: positive,
        name,
        level: natural,
        region: natural,
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        connections: z.array(positive),
        max: cityValues,
        initial: cityValues,
      }),
    )
    .min(1),
  defaults: z.object({ trust: z.number().min(0).max(100), supplyState: z.union([z.literal(0), z.literal(1)]) }),
});

export const scenarioSchema = z.object({
  id: name,
  title: name,
  startYear: natural,
  generalStats: z
    .array(
      z.strictObject({
        generalId: positive,
        stats: fiveStatsSchema,
        sourceId: name,
        sourceRevision: name,
        officerId: positive,
      }),
    )
    .optional(),
  nation: z.array(
    z.tuple([
      name,
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
      natural,
      natural,
      z.string(),
      z.number().nonnegative(),
      z.string(),
      natural.max(7),
      z.array(name).min(1),
    ]),
  ),
  general: z.array(
    z.tuple([
      natural,
      name,
      z.string(),
      natural,
      name.nullable(),
      natural.max(100),
      natural.max(100),
      natural.max(100),
      natural.max(12),
      natural,
      natural,
      z.string().nullable(),
      z.string().nullable(),
      z.string().optional(),
    ]),
  ),
  diplomacy: z.array(z.tuple([positive, positive, z.union([z.literal(0), z.literal(1), z.literal(7)]), natural])),
});

const coefficients = z.union([z.record(z.string(), z.number().nonnegative()), z.array(z.never())]);
export const unitSetSchema = z.object({
  id: name,
  name,
  defaultCrewTypeId: positive,
  armTypes: z.record(z.string(), name),
  crewTypes: z
    .array(
      z.object({
        id: positive,
        armType: natural,
        name,
        attack: z.number().nonnegative(),
        defence: z.number().nonnegative(),
        speed: z.number().nonnegative(),
        avoid: z.number().min(0).max(100),
        magicCoef: z.number().nonnegative(),
        cost: z.number().nonnegative(),
        rice: z.number().nonnegative(),
        attackCoef: coefficients,
        defenceCoef: coefficients,
      }),
    )
    .min(1),
});

export const statRulesSchema = z.object({
  stat: z
    .object({ total: positive, min: natural, max: positive, count: z.literal(5).optional() })
    .refine(
      (value) =>
        value.min <= value.max &&
        value.total >= (value.count ?? 3) * value.min &&
        value.total <= (value.count ?? 3) * value.max,
      '능력치 합계·최소·최대가 맞지 않습니다.',
    ),
});

export type MapResource = z.infer<typeof mapSchema>;
export type ScenarioResource = z.infer<typeof scenarioSchema>;
export type UnitSetResource = z.infer<typeof unitSetSchema>;
export type StatRules = z.infer<typeof statRulesSchema>['stat'];
