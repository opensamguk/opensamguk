import { z } from 'zod';
import { mapSchema as legacyMapSchema } from '../resources';

export const MAP_DEFAULT_CANVAS = { width: 700, height: 500 } as const;
export const MAP_SKETCH_PALETTE = ['#2b5d8c', '#cbb98a', '#4f8fd0', '#7a6347', '#6aa6d8'] as const;
export const MAP_LIMITS = { cities: 300, pointsPerLine: 2_000, terrainPoints: 20_000 } as const;

export const pointSchema = z.tuple([z.number().finite(), z.number().finite()]);
export const ringSchema = z.array(pointSchema);
export const terrainSchema = z.strictObject({
  coast: z.array(ringSchema),
  lakes: z.array(ringSchema),
  mountains: z.array(ringSchema),
  rivers: z.array(z.strictObject({ name: z.string().min(1).optional(), points: z.array(pointSchema) })),
});
export const mapV1Schema = legacyMapSchema;
export const mapV2Schema = z.strictObject({
  $comment: z.string().optional(),
  version: z.literal(2),
  id: legacyMapSchema.shape.id,
  name: legacyMapSchema.shape.name,
  canvas: z.strictObject({ width: z.number().int(), height: z.number().int() }),
  defaults: z.strictObject({
    ...legacyMapSchema.shape.defaults.shape,
    trade: z.number().finite().optional(),
    frontState: z.number().finite().optional(),
  }),
  cities: z
    .array(
      z.strictObject({
        ...legacyMapSchema.shape.cities.element.shape,
        position: legacyMapSchema.shape.cities.element.shape.position.strict(),
        max: legacyMapSchema.shape.cities.element.shape.max.strict(),
        initial: legacyMapSchema.shape.cities.element.shape.initial.strict(),
      }),
    )
    .min(1),
  terrain: terrainSchema,
});

// version이 있으면 v1의 모르는 칸 버리기로 우회하지 않는다.
export const mapSchema = z.unknown().transform<MapResource>((content, ctx) => {
  const versioned = typeof content === 'object' && content !== null && 'version' in content;
  const parsed = (versioned ? mapV2Schema : mapV1Schema).safeParse(content);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
  return z.NEVER;
});

export type Point = z.infer<typeof pointSchema>;
export type Ring = z.infer<typeof ringSchema>;
export type Terrain = z.infer<typeof terrainSchema>;
export type MapCity = z.infer<typeof legacyMapSchema>['cities'][number];
export type MapResourceV1 = z.infer<typeof legacyMapSchema> & {
  version?: never;
  $comment?: string;
  defaults: { trade?: number; frontState?: number };
};
export type MapResourceV2 = z.infer<typeof mapV2Schema>;
export type MapResource = MapResourceV1 | MapResourceV2;

export function normalizeMapToV2(map: MapResource): MapResourceV2 {
  if (map.version === 2) return map;
  const parsed = legacyMapSchema.parse(map);
  return {
    ...parsed,
    ...(map.$comment === undefined ? {} : { $comment: map.$comment }),
    version: 2,
    canvas: { ...MAP_DEFAULT_CANVAS },
    defaults: {
      ...parsed.defaults,
      ...(map.defaults.trade === undefined ? {} : { trade: map.defaults.trade }),
      ...(map.defaults.frontState === undefined ? {} : { frontState: map.defaults.frontState }),
    },
    terrain: { coast: [], lakes: [], mountains: [], rivers: [] },
  };
}
