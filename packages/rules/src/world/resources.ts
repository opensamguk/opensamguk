import { z } from 'zod';
import { fiveStatsSchema } from '../general/fiveStats';

const natural = z.number().int().nonnegative();
const positive = z.number().int().positive();
const name = z.string().min(1);
export const portraitMapSchema = z.object({
  portraits: z.record(name, z.number().int().min(10001).max(11008)),
});
export const cityValues = z.object({
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

const statRulesValueSchema = z
  .object({ total: positive, min: natural, max: positive, count: z.literal(5).optional() })
  .refine(
    (value) =>
      value.min <= value.max &&
      value.total >= (value.count ?? 3) * value.min &&
      value.total <= (value.count ?? 3) * value.max,
    '능력치 합계·최소·최대가 맞지 않습니다.',
  );

export const scenarioSchema = z.object({
  id: name,
  title: name,
  startYear: natural,
  requiredMap: name.optional(),
  randomizeZeroAffinity: z.literal(true).optional(),
  openingCityProfile: z.literal('legacy-research-70').optional(),
  lastNationRecruitmentLockYear: positive.max(9999).optional(),
  requiredUnitSet: name.optional(),
  requiredStatRules: statRulesValueSchema.strict().optional(),
  cityScale: z
    .strictObject({
      cities: z
        .array(
          z
            .strictObject({ city: name, level: natural.max(9).optional(), ruin: z.literal(true).optional() })
            .refine((row) => row.level !== undefined || row.ruin === true, '도시 규모나 폐허 상태를 지정하세요.'),
        )
        .min(1)
        .max(300)
        .refine((rows) => new Set(rows.map((row) => row.city)).size === rows.length, '도시 규모 지정이 겹칩니다.'),
    })
    .optional(),
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
      z.array(name),
    ]),
  ),
  general: z.array(
    z.tuple([
      natural,
      name,
      z.string().nullable(),
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
export const crewResearchNames = z.enum([
  'greatsword',
  'halberd',
  'fire_arrow',
  'repeater',
  'mountain',
  'elephant',
  'fire_wheel',
]);
export const crewRequirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('impossible') }),
  z.strictObject({ kind: z.literal('tech'), min: natural }),
  z.strictObject({ kind: z.literal('regions'), regions: z.array(positive.max(16)).min(1) }),
  z.strictObject({ kind: z.literal('legacyCheRegions'), regions: z.array(positive.max(8)).min(1) }),
  z.strictObject({ kind: z.literal('cities'), cityKeys: z.array(positive).min(1) }),
  z.strictObject({ kind: z.literal('citiesWithLevel'), cityKeys: z.array(positive).min(1), level: positive }),
  z.strictObject({ kind: z.literal('minRelYear'), min: natural }),
  z.strictObject({ kind: z.literal('research'), name: crewResearchNames }),
  z.strictObject({ kind: z.literal('scorched'), min: natural }),
  z.strictObject({ kind: z.literal('chief') }),
]);
const crewEffects = z.enum(['firstVolley', 'guard5', 'cavalryClash', 'pikeWall', 'hold', 'avoid', 'wallFirst']);
const unitSetValueSchema = z.object({
  id: name,
  name,
  defaultCrewTypeId: positive,
  armTypes: z.record(z.string(), name),
  coefMode: z.literal('multiply').optional(),
  firstVolleyScope: z.literal('sortie').optional(),
  regionScheme: z.literal('province-191').optional(),
  legacyCheMapIds: z
    .array(name)
    .min(1)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length, '병종 지도 ID가 겹칩니다.')
    .optional(),
  legacyCheCityRegions: z
    .array(z.tuple([positive, name, natural]))
    .min(1)
    .max(300)
    .optional(),
  crewTypes: z
    .array(
      z
        .object({
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
          requirements: z.array(crewRequirementSchema).optional(),
          effects: z.array(crewEffects).optional(),
        })
        .transform(({ requirements, effects, ...unit }) => ({
          ...unit,
          ...(requirements?.length ? { requirements } : {}),
          ...(effects?.length ? { effects } : {}),
        })),
    )
    .min(1),
});

export const unitSetSchema = unitSetValueSchema.refine(
  (unitSet) => !unitSet.legacyCheMapIds || !!unitSet.legacyCheCityRegions,
  {
    path: ['legacyCheCityRegions'],
    message: '병종에 지정한 지도의 도시·지역 대응이 필요합니다.',
  },
);

export const statRulesSchema = z.object({
  stat: statRulesValueSchema,
});

export type MapResource = z.infer<typeof mapSchema>;
export type ScenarioResource = z.infer<typeof scenarioSchema>;
export type UnitSetResource = z.infer<typeof unitSetSchema>;
export type StatRules = z.infer<typeof statRulesSchema>['stat'];

export function scenarioStatRulesMatch({ requiredStatRules }: ScenarioResource, statRules: StatRules): boolean {
  return (
    requiredStatRules === undefined ||
    (requiredStatRules.total === statRules.total &&
      requiredStatRules.min === statRules.min &&
      requiredStatRules.max === statRules.max &&
      requiredStatRules.count === statRules.count)
  );
}

export function scenarioMapMismatch(scenario: ScenarioResource, mapId: string): string | undefined {
  return scenario.requiredMap === mapId ? undefined : scenario.requiredMap;
}
