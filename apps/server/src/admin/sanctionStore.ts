import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { z } from 'zod';

const reason = z.string().trim().min(1).max(200);
export const createSanctionInput = z.strictObject({
  userId: z.uuid(),
  worldId: z.uuid().nullable(),
  reason,
  expiresAt: z.iso.datetime().nullable(),
});
export const liftSanctionInput = z.strictObject({ sanctionId: z.uuid(), reason });

async function lockTarget(tx: Prisma.TransactionClient, userId: string, worldId: string | null) {
  if (worldId !== null) {
    const worlds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "World" WHERE id = ${worldId} FOR KEY SHARE
    `;
    if (!worlds.length) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
  }
  const users = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`
    SELECT id,status,role FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  const user = users[0];
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: '계정을 찾을 수 없습니다.' });
  return user;
}

export async function createSanction(
  db: PrismaClient,
  actorId: string,
  input: z.input<typeof createSanctionInput>,
  now: number,
) {
  const request = createSanctionInput.parse(input);
  const expiresAt = request.expiresAt === null ? null : new Date(request.expiresAt);
  if (expiresAt && expiresAt.getTime() <= now)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '만료 시각은 현재보다 뒤여야 합니다.' });
  return db.$transaction(async (tx) => {
    const user = await lockTarget(tx, request.userId, request.worldId);
    if (user.id === actorId || user.role === 'ADMIN')
      throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 계정은 제재할 수 없습니다.' });
    if (user.status !== 'ACTIVE')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '활성 계정만 제재할 수 있습니다.' });
    const sanction = await tx.sanction.create({
      data: { ...request, expiresAt, createdBy: actorId },
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
    return { sanctionId: sanction.id, closedSessionIds: sessions.map(({ id }) => id) };
  });
}

export async function liftSanction(
  db: PrismaClient,
  actorId: string,
  input: z.input<typeof liftSanctionInput>,
  now: number,
) {
  const request = liftSanctionInput.parse(input);
  return db.$transaction(async (tx) => {
    const hint = await tx.sanction.findUnique({
      where: { id: request.sanctionId },
      select: { userId: true, worldId: true },
    });
    if (!hint) throw new TRPCError({ code: 'NOT_FOUND', message: '제재 기록을 찾을 수 없습니다.' });
    await lockTarget(tx, hint.userId, hint.worldId);
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
