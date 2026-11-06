import { z } from 'zod';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { formatResourceKey, parseResourceKey } from '@opensamguk/rules';

export const mapBackgroundKeySchema = z.string().refine((value) => {
  try {
    return formatResourceKey(parseResourceKey(value)) === value;
  } catch {
    return false;
  }
}, '정규 지도 판 키가 필요합니다.');
const positive = z.number().int().min(1).max(2_147_483_647);
export const mapBackgroundInputSchema = z.strictObject({
  mapKey: mapBackgroundKeySchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: positive,
  width: positive,
  height: positive,
  imageCommit: z.string().regex(/^[a-f0-9]{40}$/),
});

// 게시 내용은 수정하지 않고 정확한 판의 그림만 한 번 등록한다.
export async function registerMapBackground(db: PrismaClient, raw: unknown) {
  const { mapKey, ...image } = mapBackgroundInputSchema.parse(raw);
  const key = parseResourceKey(mapKey);
  return db.$transaction(async (tx) => {
    const [resource] = await tx.$queryRaw<Array<{ id: string; status: string; contentHash: string }>>`
      SELECT id, status, "contentHash" FROM "GameResource"
      WHERE kind='MAP' AND name=${key.name} AND version=${key.version} FOR SHARE
    `;
    if (!resource) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (resource.status !== 'PUBLISHED') return { ok: false, reason: 'NOT_PUBLISHED' } as const;
    const data = { resourceId: resource.id, mapContentHash: resource.contentHash, ...image };
    const added = await tx.mapBackground.createMany({ data: [data], skipDuplicates: true });
    const stored = await tx.mapBackground.findUniqueOrThrow({ where: { resourceId: resource.id } });
    if (Object.entries(data).some(([field, value]) => stored[field as keyof typeof data] !== value))
      return { ok: false, reason: 'DIFFERENT_EXISTS' } as const;
    return { ok: true, existing: added.count === 0 } as const;
  });
}

export type MapBackground = { path: string; width: number; height: number };
export async function readMapBackgrounds(
  db: Pick<Prisma.TransactionClient, 'gameResource'>,
  mapKeys: readonly string[],
) {
  const keys = [...new Set(mapKeys)]
    .filter((key) => mapBackgroundKeySchema.safeParse(key).success)
    .map(parseResourceKey);
  const result = new Map<string, MapBackground>();
  if (!keys.length) return result;
  const resources = await db.gameResource.findMany({
    where: { kind: 'MAP', status: 'PUBLISHED', OR: keys },
    select: {
      name: true,
      version: true,
      contentHash: true,
      background: { select: { mapContentHash: true, width: true, height: true } },
    },
  });
  for (const row of resources) {
    if (!row.background || row.background.mapContentHash !== row.contentHash) continue;
    const key = formatResourceKey(row);
    result.set(key, { path: `maps/${key}/base.webp`, width: row.background.width, height: row.background.height });
  }
  return result;
}
