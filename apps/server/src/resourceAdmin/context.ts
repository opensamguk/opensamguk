import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { RESOURCE_LIMITS } from '@opensamguk/rules/resource-validation';
import { z } from 'zod';
import { RESOURCE_PAYLOAD_LIMITS } from './payload';
import { getResource, type ResourceMeta } from './read';
import type { VerdictContext } from './verdict';

export const resourceRevision = z.number().int().min(0).max(2_147_483_646);
const reference = z.strictObject({
  id: z.uuid(),
  revision: resourceRevision,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const validationContext = z.union([
  z.strictObject({ map: reference }),
  z.strictObject({
    scenarios: z
      .array(reference)
      .min(1)
      .max(RESOURCE_LIMITS.contextScenarios)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  }),
]);
type Selection = z.infer<typeof validationContext>;
type Reference = z.infer<typeof reference>;
export type ContextMeta = Pick<ResourceMeta, 'id' | 'kind' | 'name' | 'version' | 'revision' | 'contentHash'>;

function references(context?: Selection): Reference[] {
  return context === undefined ? [] : 'map' in context ? [context.map] : context.scenarios;
}

// 대상과 참조를 같은 순서로 잠가 서로를 검사하는 두 저장의 교착을 막는다.
export async function lockValidationResources(tx: Prisma.TransactionClient, id: string, context?: Selection) {
  for (const key of [...new Set([id, ...references(context).map((item) => item.id)])].sort()) {
    if (key === id) await tx.$queryRaw`SELECT id FROM "GameResource" WHERE id=${key} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "GameResource" WHERE id=${key} FOR SHARE`;
  }
  return getResource(tx, id, RESOURCE_PAYLOAD_LIMITS);
}

export async function readValidationContext(
  tx: Prisma.TransactionClient,
  target: ResourceMeta,
  context?: Selection,
): Promise<{ ok: true; verdict?: VerdictContext; selected: ContextMeta[] } | { ok: false }> {
  if (context === undefined) return { ok: true, selected: [] };
  const kind = 'map' in context ? 'MAP' : 'SCENARIO';
  if ((kind === 'MAP' && target.kind !== 'SCENARIO') || (kind === 'SCENARIO' && target.kind !== 'MAP'))
    throw new TRPCError({ code: 'BAD_REQUEST', message: '검사 대상의 자원 종류를 확인하세요.' });
  const selected: ContextMeta[] = [],
    contents: unknown[] = [];
  for (const ref of references(context).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    let resource;
    try {
      resource = await getResource(tx, ref.id, RESOURCE_PAYLOAD_LIMITS);
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'NOT_FOUND') return { ok: false };
      throw error;
    }
    if (resource.meta.kind !== kind)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '검사 대상의 자원 종류를 확인하세요.' });
    if (resource.meta.revision !== ref.revision || resource.meta.contentHash !== ref.contentHash) return { ok: false };
    const { id, kind: selectedKind, name, version, revision, contentHash } = resource.meta;
    selected.push({ id, kind: selectedKind, name, version, revision, contentHash });
    contents.push(resource.content);
  }
  return { ok: true, selected, verdict: kind === 'MAP' ? { map: contents[0] } : { scenarios: contents } };
}
