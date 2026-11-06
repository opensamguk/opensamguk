import { z } from 'zod';
import type { OperationalMapResource } from '../../packages/rules/src/world/map/operational';

const label = z.string().min(1).max(160);
export const provinceTableSchema = z.strictObject({
  version: z.literal(1),
  regionScheme: z.literal('province-191'),
  sources: z.array(z.strictObject({ id: label, title: label, url: z.string().url() })).min(1),
  sites: z
    .array(
      z.strictObject({
        siteId: label,
        name: label,
        region: z.number().int().min(1).max(16),
        source: label,
        supportingSources: z.array(label).optional(),
        sourceSection: label.optional(),
        referenceName: label.optional(),
        method: z.enum(['regional-reference', 'historical-landmark', 'game-category']),
        quote: z.string().min(1).max(2000),
        note: z.string().min(1).max(2000).optional(),
      }),
    )
    .min(1),
});

export function applyProvinceRegions(sites: OperationalMapResource['sites'], input: unknown) {
  const table = provinceTableSchema.parse(input);
  const sources = new Set(table.sources.map((source) => source.id));
  if (sources.size !== table.sources.length) throw Error('州 배정 출처가 중복됩니다.');
  const assignments = new Map(table.sites.map((site) => [site.siteId, site]));
  if (assignments.size !== table.sites.length) throw Error('州 배정 거점이 중복됩니다.');
  const anchors = sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
  if (anchors.length !== assignments.size || table.sites.some((row) => !anchors.some((site) => site.id === row.siteId)))
    throw Error('州 배정은 운영 도시·관문 전체와 정확히 대응해야 합니다.');
  return sites.map((site) => {
    if (site.kind !== 'CITY' && site.kind !== 'PASS') return site;
    const row = assignments.get(site.id);
    if (!row || row.name !== site.name) throw Error(`州 배정 거점 이름이 다릅니다: ${site.id}`);
    if ([row.source, ...(row.supportingSources ?? [])].some((source) => !sources.has(source)))
      throw Error(`州 배정 출처가 없습니다: ${site.id}`);
    return { ...site, region: row.region };
  });
}
