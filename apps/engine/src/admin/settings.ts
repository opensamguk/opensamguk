import { nextActionSequence, type Prisma, type RealtimeSignal } from '@opensamguk/db';
import {
  adminSettingPayloadSchema,
  adminSettingRejectMessages,
  decideAdminSetting,
  applyRecordedInput,
  parsePreset,
  runtimeOptionsSchema,
  ruleRegistry,
  validateAdminSettingRecord,
  checkpointClock,
  toGameDate,
  type AdminSetting,
  type Clock,
} from '@opensamguk/rules';
import { databaseNow } from '../lease';
import { loadReplayState } from '../monthly';
import { persistEffects } from '../persist';
import type { EngineWorld, EngineInput } from '../features';

export async function processAdminSetting(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  event: EngineInput,
  minimumTick: number,
  emit?: (signal: RealtimeSignal) => void,
) {
  const payload = adminSettingPayloadSchema.parse(event.payload);
  if (
    event.kind !== payload.setting.kind ||
    event.generalId !== null ||
    event.sequence !== null ||
    event.tick !== null ||
    event.result !== null
  )
    throw Error('대기 중인 월드 설정 요청 기록이 다릅니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true, role: true } });
  const now = await databaseNow(tx);
  const sequence = await nextActionSequence(tx, world.id);
  let code: keyof typeof adminSettingRejectMessages | undefined;
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
  else if (payload.setting.kind === 'admin.world.setTurnTerm' && world.clockRevision >= 2_147_483_647)
    code = 'INVALID_VALUE';
  let status: 'APPLIED' | 'REJECTED' = 'REJECTED',
    tick = world.clockTick;
  let result: Prisma.InputJsonValue;
  if (code) result = { code, message: adminSettingRejectMessages[code] };
  else {
    const clock: Clock = { ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null };
    const checkpoint =
      payload.setting.kind === 'admin.world.setTurnTerm' ? checkpointClock(clock, now.getTime(), minimumTick) : clock;
    tick = checkpoint.clockTick;
    const before = await loadReplayState(tx, world.id);
    const outcome = decideAdminSetting(
      before,
      {
        name: world.name,
        endYear: world.endYear,
        turnTermMinutes: world.turnTermMinutes,
        startYear: world.startYear,
        preset: world.preset === null ? null : parsePreset(world.preset),
        runtimeOptions: world.runtimeOptions == null ? null : runtimeOptionsSchema.parse(world.runtimeOptions),
      },
      payload,
      { userActive: true, admin: true, sanctioned: false, replayFormat: 3, worldStatus: world.status, tick },
    );
    status = outcome.status;
    result = outcome.result;
    if (outcome.status === 'APPLIED') {
      const input = { sequence, tick, generalId: null, kind: event.kind, status, payload, result };
      const next = applyRecordedInput(before, input, ruleRegistry);
      await persistEffects(
        tx,
        world.id,
        next.state,
        [{ kind: 'world', state: next.state }],
        { tick, sequence },
        before.state,
      );
      const saved = await tx.world.updateMany({
        where: { id: world.id, clockRevision: world.clockRevision },
        data: {
          name: outcome.settings.name,
          endYear: outcome.settings.endYear,
          turnTermMinutes: outcome.settings.turnTermMinutes,
          ...(payload.setting.kind === 'admin.world.setOption'
            ? { runtimeOptions: outcome.settings.runtimeOptions! as Prisma.InputJsonValue }
            : {}),
          ...(payload.setting.kind === 'admin.world.setTurnTerm'
            ? {
                clockTick: tick,
                clockRevision: { increment: 1 },
                ...(world.status === 'RUNNING' ? { clockAnchorAt: now } : {}),
              }
            : {}),
        },
      });
      if (saved.count !== 1) throw Error('다른 명령이 먼저 시계를 바꿨습니다.');
      const date = toGameDate(world.startYear, tick);
      await tx.message.create({
        data: {
          worldId: world.id,
          scope: 'WORLD',
          fromParty: { kind: 'admin', name: '운영' },
          body: settingText(payload.setting),
          sentAt: now,
          year: date.year,
          month: date.month,
        },
      });
      emit?.({ kind: 'message.new', scope: 'WORLD', target: 'world' });
    }
  }
  validateAdminSettingRecord({ sequence, tick, generalId: null, kind: event.kind, status, payload, result });
  const saved = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status, tick, sequence, result },
  });
  if (saved.count !== 1) throw Error('월드 설정 요청 상태가 바뀌었습니다.');
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: event.userId,
      action: `world.setting.${status === 'APPLIED' ? 'applied' : 'rejected'}`,
      targetType: 'World',
      targetId: world.id,
      worldId: world.id,
      reason: payload.reason,
      inputEventId: event.id,
      payload: { kind: event.kind, sequence, result },
    },
  });
  return { status: world.status, tick: status === 'APPLIED' ? tick : world.clockTick };
}

function settingText(setting: AdminSetting): string {
  switch (setting.kind) {
    case 'admin.world.rename':
      return `월드 이름을 ${setting.name}(으)로 변경했습니다.`;
    case 'admin.world.setEndYear':
      return setting.endYear === null
        ? '월드의 종료 연도 제한을 해제했습니다.'
        : `월드 종료 연도를 ${setting.endYear}년으로 변경했습니다.`;
    case 'admin.world.setTurnTerm':
      return `턴 간격을 ${setting.turnTermMinutes}분으로 변경했습니다.`;
    case 'admin.world.setOption': {
      switch (setting.key) {
        case 'entry.generalCreation':
          return setting.value === 'open' ? '새 장수 생성을 다시 받습니다.' : '새 장수 생성을 닫았습니다.';
        case 'protection.foundUntilMonths':
          return `건국 보호 기간을 ${setting.value}개월로 변경했습니다.`;
        case 'protection.peaceMonths':
          return `평화 보호 기간을 ${setting.value}개월로 변경했습니다.`;
        case 'npc.aggression':
          return `NPC 공격성을 ${setting.value}(으)로 변경했습니다.`;
        case 'boost.smallWorld':
          return setting.value === null
            ? '인원 보정을 사용하지 않습니다.'
            : `인원 보정을 ${setting.value.map((row) => `${row.below}명 미만 ${row.multiplier}배`).join(', ')}로 변경했습니다.`;
        case 'boost.lateJoin':
          return setting.value === null
            ? '늦은 참가 보정을 사용하지 않습니다.'
            : `늦은 참가 보정을 ${setting.value.fromYear}년부터 최대 ${setting.value.maxYears}년으로 변경했습니다.`;
      }
    }
  }
}
