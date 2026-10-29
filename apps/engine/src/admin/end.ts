import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  adminEndPayloadSchema,
  ADMIN_END_KIND,
  ADMIN_RESET_KIND,
  adminEndAppliedSchema,
  adminEndRejectMessages,
  checkAdminEndOrigin,
  checkReplayOrigin,
  validateAdminEndRecord,
  type AdminEndRejectCode,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { databaseNow } from '../lease';
import { loadReplayState } from '../monthly';
import { checkedAdminResetResult } from './reset';

export function checkedAdminEndResult(
  world: Prisma.WorldGetPayload<Record<string, never>>,
  event: Prisma.InputEventGetPayload<Record<string, never>>,
) {
  checkAdminEndOrigin(world, checkReplayOrigin, hashState);
  if (event.worldId !== world.id || event.kind !== ADMIN_END_KIND || event.status !== 'APPLIED')
    throw new Error('월드 종료 입력의 출처가 다릅니다.');
  validateAdminEndRecord({
    sequence: event.sequence!,
    tick: event.tick,
    generalId: event.generalId,
    kind: event.kind,
    status: 'APPLIED',
    payload: event.payload,
    result: event.result,
  });
  const applied = adminEndAppliedSchema.parse(event.result);
  if (
    world.status !== 'ENDED' ||
    world.endedAt?.toISOString() !== applied.at ||
    world.clockTick !== applied.after.tick ||
    world.clockRevision !== applied.after.revision ||
    world.actionSequence < event.sequence!
  )
    throw new Error('월드와 관리자 종료 기록이 다릅니다.');
  return applied;
}
export async function readAdminEndTick(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
) {
  const records = await tx.inputEvent.findMany({
    where: { worldId: world.id, kind: { in: [ADMIN_END_KIND, ADMIN_RESET_KIND] }, status: 'APPLIED' },
    take: 2,
  });
  if (records.length !== 1) throw new Error('종료된 월드의 종료 기록이 없습니다.');
  return (
    records[0]!.kind === ADMIN_RESET_KIND
      ? checkedAdminResetResult(world, records[0]!)
      : checkedAdminEndResult(world, records[0]!)
  ).after.tick;
}

// 호출자가 리스와 World를 잠근 같은 트랜잭션에서만 처리한다.
export async function processAdminEnd(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  event: Prisma.InputEventGetPayload<Record<string, never>>,
) {
  const payload = adminEndPayloadSchema.parse(event.payload);
  if (event.generalId !== null || event.sequence !== null || event.tick !== null || event.result !== null)
    throw new Error('대기 중인 월드 종료 요청 기록이 다릅니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true, role: true } }),
    now = await databaseNow(tx);
  let code: AdminEndRejectCode | undefined;
  if (!actor || actor.status !== 'ACTIVE') code = 'ACTOR_INACTIVE';
  else if (actor.role !== 'ADMIN') code = 'ADMIN_REQUIRED';
  else if (
    await tx.sanction.findFirst({
      where: {
        userId: event.userId,
        worldId: null,
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    })
  )
    code = 'ACTOR_SANCTIONED';
  else {
    try {
      checkAdminEndOrigin(world, checkReplayOrigin, hashState);
    } catch {
      code = 'UNSUPPORTED_FORMAT';
    }
    if (!code) {
      if (world.status !== 'PAUSED') code = 'WORLD_STATE_CHANGED';
      else if (world.name !== payload.confirmName) code = 'WORLD_NAME_CHANGED';
      else if (world.clockRevision !== payload.expectedRevision) code = 'WORLD_REVISION_CHANGED';
      else if (
        world.endedAt ||
        (await tx.worldResult.findUnique({ where: { worldId: world.id }, select: { worldId: true } }))
      )
        code = 'WORLD_RESULT_EXISTS';
    }
  }
  const status = code ? ('REJECTED' as const) : ('APPLIED' as const);
  const result = code
    ? { code, message: adminEndRejectMessages[code] }
    : {
        version: 1 as const,
        before: { status: 'PAUSED' as const, tick: world.clockTick, revision: world.clockRevision },
        after: { status: 'ENDED' as const, tick: world.clockTick, revision: world.clockRevision + 1 },
        at: now.toISOString(),
        finalStateHash: hashState(await loadReplayState(tx, world.id)),
      };
  const sequence = await nextActionSequence(tx, world.id);
  validateAdminEndRecord({
    sequence,
    tick: world.clockTick,
    generalId: null,
    kind: event.kind,
    status,
    payload,
    result,
  });
  if (!code) {
    const saved = await tx.world.updateMany({
      where: { id: world.id, status: 'PAUSED', clockRevision: payload.expectedRevision },
      data: { status: 'ENDED', endedAt: now, clockRevision: { increment: 1 } },
    });
    if (saved.count !== 1) throw new Error('월드 상태가 바뀌어 종료를 취소했습니다.');
  }
  const saved = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status, result, sequence, tick: world.clockTick },
  });
  if (saved.count !== 1) throw new Error('월드 종료 요청 상태가 바뀌었습니다.');
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: event.userId,
      action: 'world.end.' + (code ? 'rejected' : 'applied'),
      targetType: 'World',
      targetId: world.id,
      worldId: world.id,
      reason: payload.reason,
      inputEventId: event.id,
      payload: { requestId: String(event.id), sequence, result },
    },
  });
  return { status: code ? world.status : ('ENDED' as const), tick: world.clockTick };
}
