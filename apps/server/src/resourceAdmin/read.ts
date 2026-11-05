import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { z } from 'zod';
import { checkContent, makeLimits, measureJson, type Content, type Limits } from './payload';

const kinds = ['MAP', 'SCENARIO', 'UNIT_SET', 'STAT_RULES', 'PORTRAIT_MAP'] as const;
const statuses = ['DRAFT', 'PUBLISHED'] as const;
const listInput = z.strictObject({
  kind: z.enum(kinds).optional(),
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  status: z.enum(statuses).optional(),
  cursor: z.string().min(1).max(200).optional(),
});
const rawMeta = z.strictObject({
  id: z.uuid(),
  kind: z.enum(kinds),
  name: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(statuses),
  revision: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  // PostgreSQL jsonb::text 표현의 UTF-8 바이트다.
  contentBytes: z.number().int().positive(),
  source: z.string(),
  createdBy: z.uuid().nullable(),
  createdAt: z.number().finite(),
  updatedBy: z.uuid().nullable(),
  updatedAt: z.number().finite().nullable(),
  publishedBy: z.uuid().nullable(),
  publishedAt: z.number().finite().nullable(),
});

export type ResourceListInput = z.infer<typeof listInput>;
export type ResourceMeta = Omit<z.infer<typeof rawMeta>, 'createdAt' | 'updatedAt' | 'publishedAt'> & {
  createdAt: string;
  updatedAt: string | null;
  publishedAt: string | null;
};
export interface ResourcePage {
  items: ResourceMeta[];
  next: string | null;
}
type ReaderDb = Pick<Prisma.TransactionClient, '$queryRaw'>;
interface Row {
  id: string | null;
  meta: unknown;
  metaTooLarge: boolean;
  contentTooLarge: boolean;
  content: unknown;
}

const internal = () => new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '자원 판을 읽을 수 없습니다.' });
const badInput = () => new TRPCError({ code: 'BAD_REQUEST', message: '요청 값을 확인하세요.' });
const encodeCursor = (id: string) => Buffer.from(`1:${id}`).toString('base64url');

function rowCursor(row: Row): string {
  if (!z.uuid().safeParse(row.id).success) throw internal();
  return encodeCursor(row.id!);
}

function decodeCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const id = decoded.slice(2);
  if (!decoded.startsWith('1:') || !z.uuid().safeParse(id).success || encodeCursor(id) !== value) throw badInput();
  return id;
}

// SQL 한 문장에서 크기 검사와 반환을 묶어 초안이 그 사이 바뀌어도 큰 값을 가져오지 않는다.
async function readRows(
  db: ReaderDb,
  filter: ResourceListInput,
  start: string | null,
  id: string | null,
  limits: Limits,
): Promise<Row[]> {
  const includeContent = id !== null;
  // 독립적인 전송 보호 한도다. 긴 소수 scale을 가진 JSONB는 compact가 작아도 넘을 수 있다.
  const storedMax = BigInt(limits.contentMax) * 64n;
  const metaMax = BigInt(limits.metaMax);
  try {
    return await db.$queryRaw<Row[]>`
      SELECT CASE WHEN length(r.id) = 36 THEN r.id END AS id,
        r."metaBytes" > ${metaMax} AS "metaTooLarge",
        ${includeContent} AND r."contentBytes" > ${storedMax} AS "contentTooLarge",
        CASE WHEN r."metaBytes" <= ${metaMax} THEN jsonb_build_object(
          'id', r.id, 'kind', r.kind, 'name', r.name, 'version', r.version, 'status', r.status,
          'revision', r.revision, 'contentHash', r."contentHash", 'contentBytes', r."contentBytes",
          'source', r.source, 'createdBy', r."createdBy", 'updatedBy', r."updatedBy",
          'publishedBy', r."publishedBy",
          'createdAt', extract(epoch FROM r."createdAt") * 1000,
          'updatedAt', extract(epoch FROM r."updatedAt") * 1000,
          'publishedAt', extract(epoch FROM r."publishedAt") * 1000
        ) END AS meta,
        CASE WHEN ${includeContent} AND r."contentBytes" <= ${storedMax}
          AND r."metaBytes" <= ${metaMax} THEN r.content END AS content
      FROM (
        SELECT g.*,
          octet_length(convert_to(g.content::text, 'UTF8'))::bigint AS "contentBytes",
          octet_length(convert_to(g.id, 'UTF8'))::bigint
            + octet_length(convert_to(g.name, 'UTF8'))::bigint
            + octet_length(convert_to(g.source, 'UTF8'))::bigint
            + octet_length(convert_to(g."contentHash", 'UTF8'))::bigint
            + coalesce(octet_length(convert_to(g."createdBy", 'UTF8'))::bigint, 0)
            + coalesce(octet_length(convert_to(g."updatedBy", 'UTF8'))::bigint, 0)
            + coalesce(octet_length(convert_to(g."publishedBy", 'UTF8'))::bigint, 0) AS "metaBytes"
        FROM "GameResource" g
        WHERE (${id}::text IS NULL OR g.id = ${id})
          AND (${filter.kind ?? null}::text IS NULL OR g.kind::text = ${filter.kind ?? null})
          AND (${filter.name ?? null}::text IS NULL OR g.name = ${filter.name ?? null})
          AND (${filter.status ?? null}::text IS NULL OR g.status::text = ${filter.status ?? null})
          AND (${start}::text IS NULL OR g.id COLLATE "C" >= ${start}::text COLLATE "C")
        ORDER BY g.id COLLATE "C"
        LIMIT ${includeContent ? 1 : 51}
      ) r
      ORDER BY r.id COLLATE "C"
    `;
  } catch {
    throw internal();
  }
}

function toMeta(row: Row, limits: Limits): ResourceMeta {
  const parsed = rawMeta.safeParse(row.meta);
  if (row.metaTooLarge || !parsed.success || parsed.data.id !== row.id) throw internal();
  try {
    const value = parsed.data;
    const meta: ResourceMeta = {
      ...value,
      createdAt: new Date(value.createdAt).toISOString(),
      updatedAt: value.updatedAt === null ? null : new Date(value.updatedAt).toISOString(),
      publishedAt: value.publishedAt === null ? null : new Date(value.publishedAt).toISOString(),
    };
    if (!measureJson(meta, limits.metaMax).ok) throw internal();
    return meta;
  } catch {
    throw internal();
  }
}

// 같은 필터로 이어 읽는다. next는 아직 반환하지 않은 첫 ID이며 마지막 쪽은 null이다.
export async function listResources(
  db: ReaderDb,
  input: ResourceListInput,
  inputLimits: Limits,
): Promise<ResourcePage> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw badInput();
  const limits = makeLimits(inputLimits);
  const start = decodeCursor(parsed.data.cursor);
  const rows = await readRows(db, parsed.data, start, null, limits);
  let result: ResourcePage = { items: [], next: null };
  for (let index = 0; index < Math.min(rows.length, 50); index++) {
    const candidate = {
      items: [...result.items, toMeta(rows[index]!, limits)],
      next: rows[index + 1] ? rowCursor(rows[index + 1]!) : null,
    };
    if (!measureJson(candidate, limits.responseMax).ok) {
      if (result.items.length === 0) throw internal();
      return result;
    }
    result = candidate;
  }
  if (!measureJson(result, limits.responseMax).ok) throw internal();
  return result;
}

export async function getResource(
  db: ReaderDb,
  id: string,
  inputLimits: Limits,
): Promise<{ meta: ResourceMeta; content: Content }> {
  if (!z.uuid().safeParse(id).success) throw badInput();
  const limits = makeLimits(inputLimits);
  const [row] = await readRows(db, {}, null, id, limits);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '자원 판을 찾지 못했습니다.' });
  const meta = toMeta(row, limits);
  if (row.contentTooLarge) throw internal();
  const checked = checkContent(row.content, limits);
  if (!checked.ok || hashState(checked.content) !== meta.contentHash) throw internal();
  const result = { meta, content: checked.content };
  if (!measureJson(result, limits.responseMax).ok) throw internal();
  return result;
}
