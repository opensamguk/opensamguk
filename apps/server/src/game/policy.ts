import { randomUUID } from 'node:crypto';
import type { Prisma } from '@opensamguk/db';
import { INACTIVE_AFTER_DAYS, isPolicyKey, policyOptions } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';

export async function readPolicy(tx: Prisma.TransactionClient, worldId: string, userId: string, generalId: number) {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const general = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
  const current = general.defaultPolicy ?? 'none';
  if (!isPolicyKey(current)) throw new Error('저장된 기본 방침이 올바르지 않습니다.');
  const latest =
    world.policyFromSequence === null
      ? null
      : await tx.inputEvent.findFirst({
          where: { worldId, userId, generalId, kind: 'general.setPolicy' },
          orderBy: { id: 'desc' },
        });
  const pending =
    world.policyFromSequence === null
      ? null
      : await tx.inputEvent.findFirst({
          where: { worldId, userId, generalId, kind: 'general.setPolicy', status: 'PENDING' },
          orderBy: { id: 'asc' },
        });
  const pendingKey = (pending?.payload as { policy?: unknown } | undefined)?.policy;
  const rejectedKey = (latest?.payload as { policy?: unknown } | undefined)?.policy;
  return {
    current,
    pending: isPolicyKey(pendingKey) ? pendingKey : null,
    lastRejected:
      latest?.status === 'REJECTED' && isPolicyKey(rejectedKey)
        ? { policy: rejectedKey, reason: (latest.result as { code: string }).code }
        : null,
    options: policyOptions(),
    inactiveAfterDays: INACTIVE_AFTER_DAYS,
  };
}

export async function queueLoginActivity(tx: Prisma.TransactionClient, userId: string) {
  const generals = await tx.general.findMany({
    where: { userId },
    orderBy: { worldId: 'asc' },
    select: { worldId: true, id: true },
  });
  for (const general of generals) {
    const worldId = general.worldId;
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR SHARE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
    if (world.status === 'ENDED') continue;
    if (
      world.policyFromSequence === null &&
      !(await tx.inputEvent.findFirst({
        where: { worldId, kind: 'system.policy.enable', status: 'PENDING' },
        select: { id: true },
      }))
    )
      continue;
    const key = `general.active:${randomUUID()}`;
    await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
      VALUES (${worldId},${userId},${general.id},'general.active',${key},'{}'::jsonb,'PENDING') ON CONFLICT DO NOTHING`;
  }
}

export function requirePolicyReady(world: { status: string; policyFromSequence: number | null }) {
  if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  if (world.policyFromSequence === null)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '기본 방침 전환을 기다리고 있습니다.' });
}
