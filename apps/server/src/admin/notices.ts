import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { notifyWorld } from '@opensamguk/db';
import { z } from 'zod';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

const title = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(2000);
const scope = {
  scope: z.enum(['LOBBY', 'WORLD']),
  worldId: z.uuid().optional(),
};
const validScope = (input: { scope: string; worldId?: string | undefined }) =>
  input.scope === 'WORLD' ? input.worldId !== undefined : input.worldId === undefined;
const cursor = z.strictObject({ at: z.iso.datetime(), id: z.uuid() });
export const noticeListInput = z
  .strictObject({ ...scope, cursor: cursor.optional() })
  .refine(validScope, { message: '공지 범위를 확인하세요.' });
export const noticeCreateInput = z
  .strictObject({ ...scope, title, body, idempotencyKey: z.uuid() })
  .refine(validScope, { message: '공지 범위를 확인하세요.' });
const target = { id: z.uuid(), expectedRevision: z.number().int().min(0).max(2147483646), idempotencyKey: z.uuid() };
export const noticeUpdateInput = z.strictObject({ ...target, title, body });
export const noticeHideInput = z.strictObject({ ...target, reason: z.string().trim().min(1).max(200) });
type Create = z.infer<typeof noticeCreateInput>;
type Update = z.infer<typeof noticeUpdateInput>;
type Hide = z.infer<typeof noticeHideInput>;
type Command = { kind: 'create'; input: Create } | { kind: 'update'; input: Update } | { kind: 'hide'; input: Hide };
const selection = {
  id: true,
  scope: true,
  worldId: true,
  title: true,
  body: true,
  pinned: true,
  publishedAt: true,
  hiddenAt: true,
  revision: true,
} as const;

function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '공지를 처리하지 못했습니다.' });
}
export async function listAdminNotices(ctx: Context, input: z.infer<typeof noticeListInput>) {
  try {
    return await ctx.db.$transaction(async (tx) => {
      await requireCurrentAdmin(tx, ctx, false);
      const rows = await tx.notice.findMany({
        where: {
          scope: input.scope,
          worldId: input.worldId ?? null,
          ...(input.cursor
            ? {
                OR: [
                  { publishedAt: { lt: new Date(input.cursor.at) } },
                  { publishedAt: new Date(input.cursor.at), id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: 51,
        select: selection,
      });
      const page = rows.slice(0, 50),
        last = page.at(-1);
      return {
        items: page.map((row) => ({
          ...row,
          publishedAt: row.publishedAt.toISOString(),
          hiddenAt: row.hiddenAt?.toISOString() ?? null,
        })),
        next: rows.length > 50 && last ? { at: last.publishedAt.toISOString(), id: last.id } : null,
      };
    });
  } catch (error) {
    publicError(error);
  }
}

export async function changeAdminNotice(ctx: Context, command: Command) {
  const { kind, input } = command;
  // strict 스키마를 거친 필드 순서를 고정해 재시도 입력만 비교한다.
  const canonical =
    kind === 'create'
      ? [
          kind,
          (input as Create).scope,
          (input as Create).worldId ?? null,
          (input as Create).title,
          (input as Create).body,
        ]
      : kind === 'update'
        ? [
            kind,
            (input as Update).id,
            (input as Update).expectedRevision,
            (input as Update).title,
            (input as Update).body,
          ]
        : [kind, (input as Hide).id, (input as Hide).expectedRevision, (input as Hide).reason];
  const requestHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  try {
    const result = await ctx.db.$transaction(async (tx) => {
      const hint =
        kind === 'create'
          ? null
          : await tx.notice.findUnique({
              where: { id: (input as Update | Hide).id },
              select: { scope: true, worldId: true },
            });
      const worldId = kind === 'create' ? ((input as Create).worldId ?? null) : (hint?.worldId ?? null);
      if (worldId !== null) await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR KEY SHARE`;
      const actorUserId = await requireCurrentAdmin(tx, ctx, true);
      const key = { actorUserId, idempotencyKey: input.idempotencyKey };
      const prior = await tx.adminNoticeRequest.findUnique({ where: { actorUserId_idempotencyKey: key } });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return { id: prior.noticeId, revision: prior.revision, hidden: prior.hidden, worldId: null };
      }
      if (kind !== 'create' && !hint) throw new TRPCError({ code: 'NOT_FOUND', message: '공지를 찾을 수 없습니다.' });
      if (worldId !== null && !(await tx.world.findUnique({ where: { id: worldId }, select: { id: true } })))
        throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
      let before: { revision: number; hidden: boolean } | null = null;
      let row;
      if (kind === 'create') {
        const value = input as Create;
        row = await tx.notice.create({
          data: { scope: value.scope, worldId, title: value.title, body: value.body, publishedAt: new Date(ctx.now) },
          select: selection,
        });
      } else {
        const value = input as Update | Hide;
        await tx.$queryRaw`SELECT id FROM "Notice" WHERE id=${value.id} FOR UPDATE`;
        const current = await tx.notice.findUnique({ where: { id: value.id }, select: selection });
        if (!current || current.worldId !== worldId || current.scope !== hint!.scope)
          throw new TRPCError({ code: 'CONFLICT', message: '공지 범위가 바뀌었습니다. 다시 조회하세요.' });
        if (current.hiddenAt !== null || current.revision !== value.expectedRevision)
          throw new TRPCError({ code: 'CONFLICT', message: '공지가 바뀌었습니다. 다시 조회하세요.' });
        before = { revision: current.revision, hidden: false };
        row = await tx.notice.update({
          where: { id: value.id },
          data: {
            ...(kind === 'update'
              ? { title: (input as Update).title, body: (input as Update).body }
              : { hiddenAt: new Date(ctx.now) }),
            revision: { increment: 1 },
          },
          select: selection,
        });
      }
      const after = { revision: row.revision, hidden: row.hiddenAt !== null };
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId,
          action: 'notice.' + kind,
          targetType: 'Notice',
          targetId: row.id,
          worldId,
          reason: kind === 'hide' ? (input as Hide).reason : null,
          payload: { before, after, requestId: input.idempotencyKey },
        },
      });
      await tx.adminNoticeRequest.create({ data: { ...key, requestHash, noticeId: row.id, ...after } });
      return { id: row.id, ...after, worldId };
    });
    if (result.worldId)
      await notifyWorld(ctx.db, result.worldId, { kind: 'notice.updated', scope: 'world', target: 'world' }, () =>
        ctx.reply.log.warn('실시간 알림 전송 실패'),
      );
    return { id: result.id, revision: result.revision, hidden: result.hidden };
  } catch (error) {
    publicError(error);
  }
}
