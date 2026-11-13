import { nextActionSequence, type Prisma, type RealtimeSignal } from '@opensamguk/db';
import {
  adminGamePayloadSchema,
  adminGameRejectMessages,
  applyRecordedInput,
  completePersonnelStep,
  decideAdminGameAction,
  ruleRegistry,
  validateAdminGameRecord,
  type AdminGameRejectCode,
} from '@opensamguk/rules';
import { databaseNow } from '../lease';
import { loadReplayState } from '../monthly';
import { checkWorldReplay, type EngineInput, type EngineWorld } from '../features';
import { persistExt } from '../extState';
import { persistEffects } from '../persist';
import { persistPersonnelPacket } from '../ruleFeatures';
import { persistAdminRecord } from './records';

// 리스→World 잠금 아래에서 기존 운영 입력과 같은 줄을 처리한다.
export async function processAdminGame(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  event: EngineInput,
  emit?: (signal: RealtimeSignal) => void,
) {
  const payload = adminGamePayloadSchema.parse(event.payload);
  if (
    event.kind !== payload.action.kind ||
    event.generalId !== null ||
    event.sequence !== null ||
    event.tick !== null ||
    event.result !== null
  )
    throw Error('대기 중인 관리자 게임 요청 기록이 다릅니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true, role: true } });
  const now = await databaseNow(tx);
  let code: AdminGameRejectCode | undefined;
  if (actor?.status !== 'ACTIVE') code = 'ACTOR_INACTIVE';
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
  else if (!['RUNNING', 'PAUSED'].includes(world.status)) code = 'WORLD_STATE_CHANGED';

  const sequence = await nextActionSequence(tx, world.id);
  let status: 'APPLIED' | 'REJECTED' = 'REJECTED';
  let result: Prisma.InputJsonValue;
  if (code) result = { code, message: adminGameRejectMessages[code] };
  else {
    const origin = checkWorldReplay(world);
    if (origin?.version !== 3) throw Error('관리자 게임 조치의 원생성 기록이 없습니다.');
    const before = await loadReplayState(tx, world.id);
    const outcome = decideAdminGameAction(before, payload, {
      userActive: true,
      admin: true,
      sanctioned: false,
      replayFormat: 3,
      worldStatus: world.status,
      tick: world.clockTick,
      unitSet: origin.initial.unitSet,
    });
    status = outcome.status;
    result = outcome.result;
    if (outcome.status === 'APPLIED') {
      const input = { sequence, tick: world.clockTick, generalId: null, kind: event.kind, status, payload, result };
      // 실제 엔진도 재생과 같은 등록부·공통 후처리를 지난 상태만 저장한다.
      const next = applyRecordedInput(before, input, ruleRegistry, { unitSet: origin.initial.unitSet });
      const packet = before.offices
        ? completePersonnelStep(
            before.state,
            before.offices,
            { state: outcome.replay.state, offices: before.offices, closedOffers: [], logs: [] },
            world.clockTick,
          )
        : undefined;
      await persistEffects(
        tx,
        world.id,
        next.state,
        [{ kind: 'world', state: next.state }],
        { tick: world.clockTick, sequence },
        before.state,
        async () => {
          if (packet)
            await persistPersonnelPacket(tx, world.id, before, packet, next.residenceAnchors!, {
              tick: world.clockTick,
              sequence,
            });
        },
      );
      await persistExt(tx, world.id, before.state.ext, next.state.ext);
      const action = payload.action;
      if (action.kind === 'admin.general.clearTurns') {
        await tx.generalTurn.deleteMany({ where: { worldId: world.id, generalId: action.generalId } });
        await tx.generalTurn.createMany({
          data: next.turns[action.generalId]!.map((turn, slot) => ({
            worldId: world.id,
            generalId: action.generalId,
            slot,
            commandKey: turn.commandKey,
            args: turn.args as Prisma.InputJsonValue,
            explicit: turn.explicit ?? true,
          })),
        });
        const saved = await tx.general.updateMany({
          where: { worldId: world.id, id: action.generalId, turnRevision: before.revisions[action.generalId]! },
          data: { turnRevision: next.revisions[action.generalId]! },
        });
        if (saved.count !== 1) throw Error('장수의 예턴 revision이 바뀌었습니다.');
      }
      if (action.kind === 'admin.general.release' || action.kind === 'admin.general.remove')
        await tx.general.update({
          where: { worldId_id: { worldId: world.id, id: action.generalId } },
          data: { lastActiveTick: null, lastActiveAt: null },
        });
      const signal = await persistAdminRecord(tx, world, before.state, action, outcome.result, sequence, now);
      if (signal) emit?.(signal);
    }
  }
  validateAdminGameRecord({
    sequence,
    tick: world.clockTick,
    generalId: null,
    kind: event.kind,
    status,
    payload,
    result,
  });
  const saved = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status, sequence, tick: world.clockTick, result },
  });
  if (saved.count !== 1) throw Error('관리자 게임 요청 상태가 바뀌었습니다.');
  const action = payload.action;
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: event.userId,
      action: 'game.' + (status === 'APPLIED' ? 'applied' : 'rejected'),
      targetType:
        'cityKey' in action
          ? 'City'
          : 'generalId' in action && action.generalId !== undefined
            ? 'General'
            : 'nationId' in action
              ? 'Nation'
              : 'World',
      targetId: String(
        'cityKey' in action
          ? action.cityKey
          : 'generalId' in action && action.generalId !== undefined
            ? action.generalId
            : 'nationId' in action
              ? action.nationId
              : world.id,
      ),
      worldId: world.id,
      reason: payload.reason,
      inputEventId: event.id,
      payload: { kind: event.kind, sequence, result },
    },
  });
  return { status: world.status, tick: world.clockTick };
}
