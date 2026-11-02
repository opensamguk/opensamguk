import { z } from 'zod';

// Public, fixed geography only. No economy, troops, ownership, or people are accepted here.
const id = z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const point = z.object({ x: z.number().finite().min(0).max(4096), y: z.number().finite().min(0).max(4096) });
const site = z
  .object({
    id,
    name: z.string().min(1).max(60),
    kind: z.enum(['CITY', 'PASS', 'PORT', 'FIELD']),
    position: point,
    anchorKey: z.number().int().positive().optional(),
    parentCityId: id.optional(),
  })
  .superRefine((value, ctx) => {
    const anchor = value.kind === 'CITY' || value.kind === 'PASS';
    if (anchor !== (value.anchorKey !== undefined))
      ctx.addIssue({ code: 'custom', message: '거점 앵커를 확인하세요.' });
    if ((value.kind === 'PORT') !== (value.parentCityId !== undefined))
      ctx.addIssue({ code: 'custom', message: '항구 소속을 확인하세요.' });
  });
export const publicGeographySchema = z
  .object({
    id,
    version: z.literal(3),
    canvas: z.object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }),
    basemap: z.object({
      source: z.literal('natural-earth-5.1.2'),
      projection: z.literal('WGS84 plate carree'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    }),
    sites: z.array(site).min(1).max(500),
    routes: z
      .array(
        z.object({
          id,
          from: id,
          to: id,
          mode: z.enum(['LAND', 'FORD', 'BRIDGE', 'RIVER']),
          direction: z.enum(['BOTH', 'FORWARD']),
          enabled: z.boolean(),
          via: z.array(id).max(200).optional(),
          portIds: z.tuple([id, id]).optional(),
        }),
      )
      .max(2000),
  })
  .superRefine((value, ctx) => {
    if (
      value.canvas.width * value.canvas.height > 4194304 ||
      value.sites.some((site) => site.position.x > value.canvas.width || site.position.y > value.canvas.height)
    )
      ctx.addIssue({ code: 'custom', message: '지도 범위와 거점 좌표를 확인하세요.' });
    const anchors = value.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
    if (
      new Set(value.sites.map((site) => site.id)).size !== value.sites.length ||
      new Set(anchors.map((site) => site.anchorKey)).size !== anchors.length
    )
      ctx.addIssue({ code: 'custom', message: '지도 거점 ID가 중복됩니다.' });
  });
export type PublicGeography = z.infer<typeof publicGeographySchema>;
