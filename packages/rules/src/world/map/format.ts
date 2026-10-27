import { z } from 'zod';
import { mapSchema, type MapResource } from '../resources';
import {
  addShapeIssues,
  comparePaths,
  isRecord,
  issue,
  ReportBuilder,
  type Path,
  type ResourceReport,
} from '../validate/issues';
import { scanLimits } from '../validate/limits';
import { operationalMapSchema, type OperationalMapResource } from './operational';

export { RESOURCE_LIMITS } from '../validate/limits';
export const MAP_DEFAULT_CANVAS = Object.freeze({ width: 700, height: 500 });
const point = z.tuple([z.number().finite(), z.number().finite()]);
const values = mapSchema.shape.cities.element.shape.max.strict();
const city = mapSchema.shape.cities.element
  .extend({
    position: mapSchema.shape.cities.element.shape.position.strict(),
    max: values,
    initial: values,
  })
  .strict();
export const mapV2Schema = z.strictObject({
  $comment: z.string().optional(),
  version: z.literal(2),
  id: mapSchema.shape.id,
  name: mapSchema.shape.name,
  canvas: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  defaults: mapSchema.shape.defaults
    .extend({ trade: z.number().finite().optional(), frontState: z.number().finite().optional() })
    .strict(),
  cities: z.array(city).min(1),
  terrain: z.strictObject({
    coast: z.array(z.array(point)),
    lakes: z.array(z.array(point)),
    rivers: z.array(z.strictObject({ name: z.string().min(1).optional(), points: z.array(point) })),
    mountains: z.array(z.array(point)),
  }),
});
export type MapResourceV2 = z.infer<typeof mapV2Schema>;
export type Point = [number, number];
export type MapInput = MapResource | MapResourceV2 | OperationalMapResource;
export function readMapVersion(raw: unknown): 1 | 2 | 3 | null {
  if (!isRecord(raw) || !Object.hasOwn(raw, 'version')) return 1;
  return raw.version === 2 || raw.version === 3 ? raw.version : null;
}
export function parseMapInput(raw: unknown, builder: ReportBuilder<MapInput>): MapInput | null {
  builder.did('limits');
  const limits = scanLimits('MAP', raw);
  for (const item of limits.issues) builder.add(item);
  if (limits.issues.length) {
    builder.skip('shape', 'blocked');
    return null;
  }
  builder.did('shape');
  const version = readMapVersion(raw);
  if (version === null) {
    builder.add(issue('map-version-unknown', { kind: 'path', path: ['version'] }));
    return null;
  }
  const parsed =
    version === 1
      ? mapSchema.safeParse(raw)
      : version === 2
        ? mapV2Schema.safeParse(raw)
        : operationalMapSchema.safeParse(raw);
  if (!parsed.success) {
    addShapeIssues(builder, parsed.error.issues);
    return null;
  }
  return parsed.data;
}
export type NormalizeMapResult =
  { ok: true; map: MapResourceV2; dropped: string[] } | { ok: false; report: ResourceReport<MapInput> };
export function normalizeMapToV2(raw: unknown): NormalizeMapResult {
  const builder = new ReportBuilder<MapInput>('MAP');
  const parsed = parseMapInput(raw, builder);
  if (!parsed) return { ok: false, report: builder.finish(null) };
  if ('version' in parsed && parsed.version === 3) {
    builder.add(issue('map-version-unknown', { kind: 'path', path: ['version'] }));
    return { ok: false, report: builder.finish(null) };
  }
  if ('version' in parsed) return { ok: true, map: parsed, dropped: [] };
  const source = raw as Record<string, unknown>;
  const sourceDefaults = source.defaults as Record<string, unknown>;
  const defaults: MapResourceV2['defaults'] = { ...parsed.defaults };
  const dropped: Path[] = [];
  const extra = (record: Record<string, unknown>, allowed: readonly string[], prefix: Path) => {
    for (const key of Object.keys(record)) if (!allowed.includes(key)) dropped.push([...prefix, key]);
  };
  extra(source, ['$comment', 'id', 'name', 'defaults', 'cities'], []);
  if (Object.hasOwn(source, '$comment') && typeof source.$comment !== 'string') dropped.push(['$comment']);
  extra(sourceDefaults, ['trust', 'supplyState', 'trade', 'frontState'], ['defaults']);
  for (const field of ['trade', 'frontState'] as const) {
    if (!Object.hasOwn(sourceDefaults, field)) continue;
    const value = sourceDefaults[field];
    if (typeof value === 'number' && Number.isFinite(value)) defaults[field] = value;
    else dropped.push(['defaults', field]);
  }
  const sourceCities = source.cities as Record<string, unknown>[];
  sourceCities.forEach((entry, i) => {
    extra(entry, ['id', 'name', 'level', 'region', 'position', 'connections', 'max', 'initial'], ['cities', i]);
    extra(entry.position as Record<string, unknown>, ['x', 'y'], ['cities', i, 'position']);
    for (const field of ['max', 'initial'] as const) {
      extra(entry[field] as Record<string, unknown>, Object.keys(values.shape), ['cities', i, field]);
    }
  });
  dropped.sort(comparePaths);
  return {
    ok: true,
    map: {
      ...(typeof source.$comment === 'string' ? { $comment: source.$comment } : {}),
      version: 2,
      id: parsed.id,
      name: parsed.name,
      canvas: { ...MAP_DEFAULT_CANVAS },
      defaults,
      cities: parsed.cities,
      terrain: { coast: [], lakes: [], rivers: [], mountains: [] },
    },
    dropped: dropped.map((path) => path.join('.')),
  };
}
