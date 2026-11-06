import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { z } from 'zod';
import type { Context } from '../context';
import { databaseTime } from '../messaging';
import { requireResourceEditor } from './access';
import { checkContent, measureJson, RESOURCE_PAYLOAD_LIMITS, type Content } from './payload';
import { getResource, listResources, resourceName, type ResourceListInput, type ResourceMeta } from './read';
import { lockValidationResources, readValidationContext, resourceRevision, validationContext } from './context';
import { publishVerdict } from './verdict';

export const getResourceInput = z.strictObject({ id: z.uuid() });
export const cloneResourceInput = z.strictObject({ sourceId: z.uuid(), name: resourceName.optional() });
export const saveResourceInput = z.strictObject({
  id: z.uuid(),
  revision: resourceRevision,
  context: validationContext.optional(),
  content: z.unknown().transform((input, ctx) => {
    const checked = checkContent(input, RESOURCE_PAYLOAD_LIMITS);
    if (checked.ok) return checked.content;
    ctx.addIssue({ code: 'custom', message: '자원 내용의 형식과 크기를 확인하세요.' });
    return z.NEVER;
  }),
});
export const publishResourceInput = z.strictObject({
  id: z.uuid(),
  revision: resourceRevision,
  context: validationContext.optional(),
  reason: z.string().trim().min(1).max(200),
});
export const discardResourceInput = z.strictObject({
  id: z.uuid(),
  revision: resourceRevision,
  reason: z.string().trim().min(1).max(200),
});
const cloneUniqueViolation = z.object({
  code: z.literal('P2002'),
  meta: z.object({
    target: z.union([
      z.literal('GameResource_one_draft_per_name_key'),
      z.literal('GameResource_kind_name_version_key'),
      z.tuple([z.literal('kind'), z.literal('name'), z.literal('version')]),
    ]),
  }),
});

class ResponseTooLarge extends Error {}

function response<T>(result: T): T {
  if (!measureJson(result, RESOURCE_PAYLOAD_LIMITS.responseMax).ok) throw new ResponseTooLarge();
  return result;
}

async function resourceMutation<T>(ctx: Context, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await ctx.db.$transaction(async (tx) => response(await action(tx)));
  } catch (error) {
    if (error instanceof ResponseTooLarge) return { ok: false as const, reason: 'RESPONSE_TOO_LARGE' as const };
    throw error;
  }
}

async function audit(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  action: string,
  before: ResourceMeta | null,
  after: ResourceMeta | null,
  reason?: string,
  details: Prisma.InputJsonObject = {},
) {
  const target = after ?? before;
  if (!target) throw new Error('감사 대상 자원이 없습니다.');
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId,
      action,
      targetType: 'GameResource',
      targetId: target.id,
      reason: reason ?? null,
      payload: {
        kind: target.kind,
        name: target.name,
        version: target.version,
        beforeHash: before?.contentHash ?? null,
        afterHash: after?.contentHash ?? null,
        beforeRevision: before?.revision ?? null,
        afterRevision: after?.revision ?? null,
        ...details,
      },
    },
  });
}

export async function listResourceCatalog(ctx: Context, input: ResourceListInput) {
  return ctx.db.$transaction(async (tx) => {
    await requireResourceEditor(tx, ctx, false);
    return listResources(tx, input, RESOURCE_PAYLOAD_LIMITS);
  });
}

export async function getResourceCatalog(ctx: Context, input: z.infer<typeof getResourceInput>) {
  return ctx.db.$transaction(async (tx) => {
    await requireResourceEditor(tx, ctx, false);
    return getResource(tx, input.id, RESOURCE_PAYLOAD_LIMITS);
  });
}

export async function cloneResource(ctx: Context, input: z.infer<typeof cloneResourceInput>) {
  try {
    return await resourceMutation(ctx, async (tx) => {
      const actorUserId = await requireResourceEditor(tx, ctx, true);
      const source = await getResource(tx, input.sourceId, RESOURCE_PAYLOAD_LIMITS);
      if (source.meta.status !== 'PUBLISHED')
        throw new TRPCError({ code: 'BAD_REQUEST', message: '게시한 판만 복제할 수 있습니다.' });
      const { kind } = source.meta;
      const name = input.name ?? source.meta.name;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource:${kind}:${name}`}, 0))`;
      const renamed = name !== source.meta.name;
      if (renamed && (await tx.gameResource.count({ where: { kind, name } })) > 0)
        return { ok: false as const, reason: 'NAME_TAKEN' as const };
      const draft = await tx.gameResource.findFirst({ where: { kind, name, status: 'DRAFT' }, select: { id: true } });
      if (draft) return { ok: false as const, reason: 'DRAFT_EXISTS' as const, draftId: draft.id };
      const latest = await tx.gameResource.aggregate({ where: { kind, name }, _max: { version: true } });
      const version = renamed ? 1 : (latest._max.version ?? 0) + 1;
      if (version > 2_147_483_647)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '자원 판 번호의 상한에 도달했습니다.' });
      const copied =
        renamed && ['MAP', 'SCENARIO', 'UNIT_SET'].includes(kind) ? { ...source.content, id: name } : source.content;
      const checked = checkContent(copied, RESOURCE_PAYLOAD_LIMITS);
      if (!checked.ok)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '새 이름을 적용한 자원의 크기를 확인하세요.' });
      const created = await tx.gameResource.create({
        data: {
          kind,
          name,
          version,
          status: 'DRAFT',
          content: checked.content,
          contentHash: hashState(checked.content),
          source: source.meta.source,
          createdBy: actorUserId,
        },
        select: { id: true },
      });
      const { meta } = await getResource(tx, created.id, RESOURCE_PAYLOAD_LIMITS);
      await audit(tx, actorUserId, 'resource.clone', null, meta, undefined, {
        sourceId: source.meta.id,
        sourceName: source.meta.name,
        sourceVersion: source.meta.version,
        sourceHash: source.meta.contentHash,
      });
      return { ok: true as const, meta };
    });
  } catch (error) {
    if (!cloneUniqueViolation.safeParse(error).success) throw error;
    // 유일 위반 뒤에는 원래 트랜잭션이 끝난 다음 현재 권한과 공유 초안을 다시 읽는다.
    return ctx.db.$transaction(async (tx) => {
      await requireResourceEditor(tx, ctx, false);
      const source = await getResource(tx, input.sourceId, RESOURCE_PAYLOAD_LIMITS);
      const name = input.name ?? source.meta.name;
      if (name !== source.meta.name && (await tx.gameResource.count({ where: { kind: source.meta.kind, name } })) > 0)
        return { ok: false as const, reason: 'NAME_TAKEN' as const };
      const draft = await tx.gameResource.findFirst({
        where: { kind: source.meta.kind, name, status: 'DRAFT' },
        select: { id: true },
      });
      if (draft) return { ok: false as const, reason: 'DRAFT_EXISTS' as const, draftId: draft.id };
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '자원 초안을 만들 수 없습니다.' });
    });
  }
}

export async function saveResource(ctx: Context, input: z.infer<typeof saveResourceInput>) {
  return resourceMutation(ctx, async (tx) => {
    const actorUserId = await requireResourceEditor(tx, ctx, true);
    const before = await lockValidationResources(tx, input.id, input.context);
    if (before.meta.status === 'PUBLISHED')
      return { ok: false as const, reason: 'PUBLISHED' as const, meta: before.meta };
    if (before.meta.revision !== input.revision)
      return { ok: false as const, reason: 'STALE' as const, meta: before.meta };
    const context = await readValidationContext(tx, before.meta, input.context);
    if (!context.ok) return { ok: false as const, reason: 'CONTEXT_STALE' as const, meta: before.meta };
    if (input.revision === 2_147_483_646)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '초안 저장 횟수의 상한에 도달했습니다. 게시 후 복제하세요.',
      });
    // 라우터 밖에서 재사용해도 같은 JSON·크기 경계를 지킨다.
    const checked = checkContent(input.content, RESOURCE_PAYLOAD_LIMITS);
    if (!checked.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: '자원 내용의 형식과 크기를 확인하세요.' });
    const content: Content = checked.content;
    const contentHash = hashState(content),
      report = publishVerdict(before.meta.kind, content, context.verdict).report;
    await tx.gameResource.update({
      where: { id: input.id, revision: input.revision, status: 'DRAFT' },
      data: {
        content,
        contentHash,
        revision: { increment: 1 },
        updatedBy: actorUserId,
        updatedAt: await databaseTime(tx),
      },
    });
    const { meta } = await getResource(tx, input.id, RESOURCE_PAYLOAD_LIMITS);
    await audit(
      tx,
      actorUserId,
      'resource.save',
      before.meta,
      meta,
      undefined,
      input.context === undefined ? {} : { context: context.selected },
    );
    return { ok: true as const, meta, report };
  });
}

export async function publishResource(ctx: Context, input: z.infer<typeof publishResourceInput>) {
  return resourceMutation(ctx, async (tx) => {
    const actorUserId = await requireResourceEditor(tx, ctx, true);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('resource:publish', 0))`;
    const before = await lockValidationResources(tx, input.id, input.context);
    if (before.meta.status === 'PUBLISHED')
      return { ok: false as const, reason: 'PUBLISHED' as const, meta: before.meta };
    if (before.meta.revision !== input.revision)
      return { ok: false as const, reason: 'STALE' as const, meta: before.meta };
    const context = await readValidationContext(tx, before.meta, input.context);
    if (!context.ok) return { ok: false as const, reason: 'CONTEXT_STALE' as const, meta: before.meta };
    if (['MAP', 'SCENARIO', 'UNIT_SET'].includes(before.meta.kind) && before.content.id !== before.meta.name)
      return { ok: false as const, reason: 'ID_MISMATCH' as const };
    const verdict = publishVerdict(before.meta.kind, before.content, context.verdict);
    if (!verdict.publishable) return { ok: false as const, reason: 'NOT_PASS' as const, report: verdict.report };
    await tx.gameResource.update({
      where: { id: input.id, revision: input.revision, status: 'DRAFT' },
      data: { status: 'PUBLISHED', publishedBy: actorUserId, publishedAt: await databaseTime(tx) },
    });
    const { meta } = await getResource(tx, input.id, RESOURCE_PAYLOAD_LIMITS);
    await audit(
      tx,
      actorUserId,
      'resource.publish',
      before.meta,
      meta,
      input.reason,
      input.context === undefined ? {} : { context: context.selected },
    );
    return { ok: true as const, meta, report: verdict.report };
  });
}

export async function discardResource(ctx: Context, input: z.infer<typeof discardResourceInput>) {
  return resourceMutation(ctx, async (tx) => {
    const actorUserId = await requireResourceEditor(tx, ctx, true);
    const { meta } = await lockValidationResources(tx, input.id);
    if (meta.status === 'PUBLISHED') return { ok: false as const, reason: 'PUBLISHED' as const, meta };
    if (meta.revision !== input.revision) return { ok: false as const, reason: 'STALE' as const, meta };
    await tx.gameResource.delete({ where: { id: input.id, revision: input.revision, status: 'DRAFT' } });
    await audit(tx, actorUserId, 'resource.discard', meta, null, input.reason);
    const { id, kind, name, version, revision, contentHash } = meta;
    return { ok: true as const, discarded: { id, kind, name, version, revision, contentHash } };
  });
}
