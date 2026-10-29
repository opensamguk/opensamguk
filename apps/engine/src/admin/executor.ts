import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  ADMIN_CLOCK_KINDS,
  ADMIN_END_KIND,
  adminClockPayloadSchema,
  adminClockExpectedStatus,
  adminClockRejectMessages,
  type AdminClockAction,
  type AdminClockRejectCode,
} from '@opensamguk/rules';
import { databaseNow } from '../lease';
import { controlClockInTransaction } from '../world/clock';
import { processAdminEnd } from './end';

// TurnLoop가 리스→World를 잠근 같은 트랜잭션에서만 호출한다.
export async function processAdminClock(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  minimumTick: number,
) {
  const event = await tx.inputEvent.findFirst({
    where: { worldId: world.id, status: 'PENDING', kind: { in: [...ADMIN_CLOCK_KINDS, ADMIN_END_KIND] } },
    orderBy: { id: 'asc' },
  });
  if (!event) return null;
  if (event.kind === ADMIN_END_KIND) return processAdminEnd(tx, world, event);
  const payload = adminClockPayloadSchema.parse(event.payload),
    action = event.kind.slice('admin.world.'.length) as AdminClockAction;
  if (event.generalId !== null || event.sequence !== null || event.tick !== null || event.result !== null)
    throw new Error('대기 중인 월드 시계 요청 기록이 다릅니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true, role: true } }),
    now = await databaseNow(tx);
  let code: AdminClockRejectCode | undefined;
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
  else if (world.replayFormat !== 3) code = 'UNSUPPORTED_FORMAT';
  else if (world.status !== adminClockExpectedStatus[action]) code = 'WORLD_STATE_CHANGED';
  let after = { status: world.status, tick: world.clockTick, revision: world.clockRevision };
  let result: Prisma.InputJsonValue;
  if (code) result = { code, message: adminClockRejectMessages[code] };
  else {
    const saved = await controlClockInTransaction(tx, world.id, action, now.getTime(), minimumTick);
    after = { status: saved.status, tick: saved.tick, revision: world.clockRevision + 1 };
    result = {
      version: 1,
      before: { status: world.status, tick: world.clockTick, revision: world.clockRevision },
      after,
      at: now.toISOString(),
    };
  }
  const status = code ? ('REJECTED' as const) : ('APPLIED' as const),
    sequence = await nextActionSequence(tx, world.id);
  const updated = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status, result, sequence, tick: after.tick },
  });
  if (updated.count !== 1) throw new Error('월드 요청 상태가 바뀌어 저장을 취소했습니다.');
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: event.userId,
      action: event.kind.slice('admin.'.length) + (code ? '.rejected' : '.applied'),
      targetType: 'World',
      targetId: world.id,
      worldId: world.id,
      reason: payload.reason,
      inputEventId: event.id,
      payload: { requestId: String(event.id), sequence, result },
    },
  });
  return { status: after.status, tick: after.tick };
}
