import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { z } from 'zod';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

const reason = z.string().trim().min(1).max(200);
export const createSanctionInput = z.strictObject({
  userId: z.uuid(),
  worldId: z.uuid().nullable(),
  reason,
  expiresAt: z.iso.datetime().nullable(),
  expectedUserId: z.uuid().optional(),
  idempotencyKey: z.uuid().optional(),
});
export const liftSanctionInput = z.strictObject({ sanctionId: z.uuid(), reason, expectedUserId: z.uuid().optional() });

async function lockTarget(
  tx: Prisma.TransactionClient,
  userId: string,
  worldId: string | null,
  actorId?: string,
  ctx?: Context,
) {
  let worldExists = true;
  if (worldId !== null) {
    const worlds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "World" WHERE id = ${worldId} FOR KEY SHARE
    `;
    worldExists = worlds.length > 0;
  }
  if (actorId !== undefined)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${actorId}, ${userId}) ORDER BY id FOR UPDATE`;
  if (ctx) await requireCurrentAdmin(tx, ctx, true);
  const users = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`
    SELECT id,status,role FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  return { user: users[0], worldExists };
}

function requireTarget(locked: Awaited<ReturnType<typeof lockTarget>>) {
  if (!locked.worldExists) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
  if (!locked.user) throw new TRPCError({ code: 'NOT_FOUND', message: '계정을 찾을 수 없습니다.' });
  return locked.user;
}

async function executeCreate(
  db: PrismaClient,
  actorId: string,
  input: z.input<typeof createSanctionInput>,
  now: number,
  ctx?: Context,
) {
  const request = createSanctionInput.parse(input);
  checkExpectedActor(actorId, request.expectedUserId);
  const expiresAt = request.expiresAt === null ? null : new Date(request.expiresAt);
  const requestHash = createHash('sha256')
    .update(JSON.stringify([request.userId, request.worldId, request.reason, expiresAt?.toISOString() ?? null]))
    .digest('hex');
  return db.$transaction(async (tx) => {
    const locked = await lockTarget(
      tx,
      request.userId,
      request.worldId,
      ctx || request.idempotencyKey ? actorId : undefined,
      ctx,
    );
    if (request.idempotencyKey) {
      const prior = await tx.adminSanctionRequest.findUnique({
        where: { actorUserId_idempotencyKey: { actorUserId: actorId, idempotencyKey: request.idempotencyKey } },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return { sanctionId: prior.sanctionId, closedSessionIds: [] as string[] };
      }
    }
    const user = requireTarget(locked);
    if (expiresAt && expiresAt.getTime() <= now)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '만료 시각은 현재보다 뒤여야 합니다.' });
    if (user.id === actorId || user.role === 'ADMIN')
      throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 계정은 제재할 수 없습니다.' });
    if (user.status !== 'ACTIVE')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '활성 계정만 제재할 수 있습니다.' });
    const sanction = await tx.sanction.create({
      data: {
        userId: request.userId,
        worldId: request.worldId,
        reason: request.reason,
        expiresAt,
        createdBy: actorId,
      },
      select: { id: true },
    });
    const sessions =
      request.worldId === null ? await tx.session.findMany({ where: { userId: user.id }, select: { id: true } }) : [];
    if (request.worldId === null) await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: actorId,
        action: 'sanction.create',
        targetType: 'User',
        targetId: user.id,
        worldId: request.worldId,
        reason: request.reason,
        payload: {
          sanctionId: sanction.id,
          worldId: request.worldId,
          expiresAt: expiresAt?.toISOString() ?? null,
          changed: true,
        },
      },
    });
    if (request.idempotencyKey)
      await tx.adminSanctionRequest.create({
        data: { actorUserId: actorId, idempotencyKey: request.idempotencyKey, requestHash, sanctionId: sanction.id },
      });
    return { sanctionId: sanction.id, closedSessionIds: sessions.map(({ id }) => id) };
  });
}

async function executeLift(
  db: PrismaClient,
  actorId: string,
  input: z.input<typeof liftSanctionInput>,
  now: number,
  ctx?: Context,
) {
  const request = liftSanctionInput.parse(input);
  checkExpectedActor(actorId, request.expectedUserId);
  return db.$transaction(async (tx) => {
    const hint = await tx.sanction.findUnique({
      where: { id: request.sanctionId },
      select: { userId: true, worldId: true },
    });
    if (!hint) {
      if (ctx) await requireCurrentAdmin(tx, ctx, true);
      throw new TRPCError({ code: 'NOT_FOUND', message: '제재 기록을 찾을 수 없습니다.' });
    }
    requireTarget(await lockTarget(tx, hint.userId, hint.worldId, ctx ? actorId : undefined, ctx));
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Sanction" WHERE id = ${request.sanctionId} FOR UPDATE`;
    const current = rows.length ? await tx.sanction.findUnique({ where: { id: request.sanctionId } }) : null;
    if (!current || current.userId !== hint.userId || current.worldId !== hint.worldId)
      throw new TRPCError({ code: 'CONFLICT', message: '제재 대상이 바뀌었습니다. 다시 확인하세요.' });
    const changed = current.liftedAt === null;
    if (changed)
      await tx.sanction.update({
        where: { id: current.id },
        data: { liftedAt: new Date(now), liftedBy: actorId, liftReason: request.reason },
      });
    await tx.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: actorId,
        action: 'sanction.lift',
        targetType: 'User',
        targetId: current.userId,
        worldId: current.worldId,
        reason: request.reason,
        payload: {
          sanctionId: current.id,
          worldId: current.worldId,
          expiresAt: current.expiresAt?.toISOString() ?? null,
          beforeLiftedAt: current.liftedAt?.toISOString() ?? null,
          afterLiftedAt: (current.liftedAt ?? new Date(now)).toISOString(),
          changed,
        },
      },
    });
    return { ok: true as const };
  });
}

function checkExpectedActor(actorId: string, expectedUserId: string | undefined) {
  if (expectedUserId !== undefined && expectedUserId !== actorId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인 계정이 바뀌었습니다. 다시 확인하세요.' });
}

function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '제재를 처리하지 못했습니다.' });
}

export async function createAdminSanction(ctx: Context, input: z.input<typeof createSanctionInput>) {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  try {
    return await executeCreate(ctx.db, ctx.user.id, input, ctx.now, ctx);
  } catch (error) {
    publicError(error);
  }
}

export async function liftAdminSanction(ctx: Context, input: z.input<typeof liftSanctionInput>) {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  try {
    return await executeLift(ctx.db, ctx.user.id, input, ctx.now, ctx);
  } catch (error) {
    publicError(error);
  }
}

// 엔진·운영 내부 시험의 기존 신뢰 경계다. HTTP는 위 Context 필수 함수를 쓴다.
export function createSanction(
  db: PrismaClient,
  actorId: string,
  input: z.input<typeof createSanctionInput>,
  now: number,
) {
  return executeCreate(db, actorId, input, now);
}

export function liftSanction(db: PrismaClient, actorId: string, input: z.input<typeof liftSanctionInput>, now: number) {
  return executeLift(db, actorId, input, now);
}
