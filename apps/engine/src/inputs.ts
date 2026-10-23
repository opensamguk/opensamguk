import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  buildCreatedGeneral,
  lateJoinBonus,
  parsePreset,
  monthlyDate,
  TICKS_PER_MONTH,
  creationFailure,
  creationBlock,
  emptyTurns,
  emptyQueue,
  isPolicyMode,
  setPolicyPayloadSchema,
  activityPayloadSchema,
  policyMarkerPayloadSchema,
  policyMarkerResultSchema,
  assertSlotSet,
  validateGeneralCreation,
  TREATY_INPUTS,
  selectWorldCapabilities,
  type CreationCode,
} from '@opensamguk/rules';
import { processTreatyInput } from './treatyInput';

// 호출자가 리스와 World를 잠근 뒤 같은 펜싱 트랜잭션에서 실행한다.
// null이면 직접 호출에서 활동 기준을 넘기지 않은 경우이며 게임 행동도 실행하지 않는다.
export async function processPendingInput(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  tick: number,
  baselineActiveTick?: number,
): Promise<boolean | null> {
  const event = await tx.inputEvent.findFirst({
    where: {
      worldId: world.id,
      status: 'PENDING',
    },
    orderBy: { id: 'asc' },
  });
  if (!event) return false;
  if (Object.hasOwn(TREATY_INPUTS, event.kind)) {
    if (selectWorldCapabilities(world).kind !== 'caps') throw new Error('조약을 끈 월드의 조약 입력입니다.');
    await processTreatyInput(tx, world, event, tick);
    return true;
  }
  if (!['system.policy.enable', 'general.setPolicy', 'general.active', 'general.create'].includes(event.kind))
    throw new Error('처리할 수 없는 대기 입력입니다.');
  const modern = isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence });
  if (event.kind === 'system.policy.enable') {
    if (world.status === 'ENDED' || world.policyFromSequence !== null)
      throw new Error('전환 표지의 월드 상태가 올바르지 않습니다.');
    if (world.status === 'PREOPEN') return null;
    if (
      event.status !== 'PENDING' ||
      event.sequence !== null ||
      event.result !== null ||
      event.userId !== 'system:policy' ||
      event.generalId !== null ||
      event.idempotencyKey !== 'system.policy.enable:5'
    )
      throw new Error('전환 표지의 출처가 올바르지 않습니다.');
    const payload = policyMarkerPayloadSchema.parse(event.payload);
    const generals = await tx.general.findMany({ where: { worldId: world.id }, orderBy: { id: 'asc' } });
    const slots = await tx.generalTurn.findMany({ where: { worldId: world.id } });
    const emptyIds: number[] = [];
    for (const general of generals) {
      const queue = slots.filter((slot) => slot.generalId === general.id);
      assertSlotSet(queue);
      const empty = queue.filter((slot) => !slot.explicit);
      if (empty.length !== 0 && empty.length !== 30) throw new Error('전환 전 빈칸 집합이 올바르지 않습니다.');
      if (empty.length) {
        if (empty.some((slot) => slot.commandKey !== 'rest' || JSON.stringify(slot.args) !== '{}'))
          throw new Error('전환 전 빈칸이 올바르지 않습니다.');
        emptyIds.push(general.id);
      }
    }
    if (JSON.stringify(emptyIds) !== JSON.stringify(payload.emptySlots))
      throw new Error('전환 표지와 빈칸 집합이 다릅니다.');
    // 앞선 생성 입력이 사람 장수를 더한 경우도 현재 상태로 판정한다.
    const hasHuman = generals.some((general) => general.userId !== null);
    let appliedBaseline: number | null = null;
    if (hasHuman) {
      // 정상 엔진은 잠근 월드 tick을 넘기며 직접 호출에서 인자가 없으면 기다린다.
      if (baselineActiveTick === undefined) return null;
      if (
        !Number.isSafeInteger(baselineActiveTick) ||
        (baselineActiveTick !== 0 && baselineActiveTick !== world.clockTick)
      )
        throw new Error('명시 활동 기준은 0 또는 잠근 월드 tick이어야 합니다.');
      appliedBaseline = baselineActiveTick;
    } else if (baselineActiveTick !== undefined) {
      throw new Error('사람 장수가 없는 전환에는 활동 기준을 넣지 않습니다.');
    }
    if (world.actionSequence >= 2_147_483_647) throw new Error('전환 순서 저장 범위를 넘었습니다.');
    const fromSequence = await nextActionSequence(tx, world.id);
    const result = policyMarkerResultSchema.parse({
      fromSequence,
      emptySlots: payload.emptySlots,
      clockTick: world.clockTick,
      turnTermMinutes: world.turnTermMinutes,
      baselineActiveTick: appliedBaseline,
    });
    const savedWorld = await tx.world.updateMany({
      where: { id: world.id, policyFromSequence: null },
      data: { policyFromSequence: fromSequence },
    });
    if (savedWorld.count !== 1) throw new Error('전환 표지의 월드가 변경됐습니다.');
    await tx.general.updateMany({
      where: { worldId: world.id },
      data: { defaultPolicy: 'none', lastActiveTick: null, lastActiveAt: null },
    });
    if (appliedBaseline !== null)
      await tx.general.updateMany({
        where: { worldId: world.id, userId: { not: null } },
        data: { lastActiveTick: appliedBaseline },
      });
    const savedMarker = await tx.inputEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'APPLIED', sequence: fromSequence, result },
    });
    if (savedMarker.count !== 1) throw new Error('전환 표지가 변경됐습니다.');
    return true;
  }
  if (event.kind !== 'general.create') {
    const rejectInput = async (code: string, message: string) => {
      await tx.inputEvent.update({
        where: { id: event.id },
        data: {
          status: 'REJECTED',
          sequence: await nextActionSequence(tx, world.id),
          result: { code, message },
        },
      });
      return true;
    };
    if (world.status === 'ENDED') return rejectInput('WORLD_CLOSED', '종료된 월드입니다.');
    if (!modern) throw new Error('전환 전 방침 입력입니다.');
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
    const user = await tx.user.findUnique({ where: { id: event.userId } });
    if (!user || user.status !== 'ACTIVE') return rejectInput('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
    if (event.generalId === null) return rejectInput('NO_GENERAL', '장수가 없습니다.');
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${event.generalId} FOR UPDATE`;
    const general = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: event.generalId } } });
    if (!general || general.userId !== event.userId) return rejectInput('NO_GENERAL', '내 장수가 아닙니다.');
    const parsed = (event.kind === 'general.setPolicy' ? setPolicyPayloadSchema : activityPayloadSchema).safeParse(
      event.payload,
    );
    if (!parsed.success) return rejectInput('BAD_POLICY', '활동·기본 방침 입력이 올바르지 않습니다.');
    const policy = event.kind === 'general.setPolicy' ? setPolicyPayloadSchema.parse(event.payload).policy : null;
    await tx.general.update({
      where: { worldId_id: { worldId: world.id, id: general.id } },
      data: {
        ...(policy ? { defaultPolicy: policy } : {}),
        lastActiveTick: Math.max(general.lastActiveTick ?? 0, tick),
        lastActiveAt: event.createdAt,
      },
    });
    await tx.inputEvent.update({
      where: { id: event.id },
      data: {
        status: 'APPLIED',
        sequence: await nextActionSequence(tx, world.id),
        result: { ...(policy ? { policy } : {}), activeTick: tick },
      },
    });
    return true;
  }
  const reject = async (code: CreationCode) => {
    await tx.inputEvent.update({
      where: { id: event.id },
      data: {
        status: 'REJECTED',
        sequence: await nextActionSequence(tx, world.id),
        result: creationFailure(code),
      },
    });
    return true;
  };
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const existing = await tx.general.findMany({
    where: { worldId: world.id },
    select: { id: true, userId: true, name: true },
  });
  const block = creationBlock({
    status: world.status,
    hasGeneral: existing.some((g) => g.userId === event.userId),
    hasPending: false,
  });
  if (block && block.code !== 'PENDING') return reject(block.code);
  const actor = await tx.user.findUnique({ where: { id: event.userId } });
  if (!actor || actor.status !== 'ACTIVE') return reject('ACTOR_INACTIVE');
  const parsed = validateGeneralCreation(event.payload, world.statRules);
  if (!parsed.ok) return reject(parsed.code);
  if (existing.some((g) => g.name.normalize('NFC').trim() === parsed.value.name)) return reject('NAME_TAKEN');
  const cities = await tx.city.findMany({
    where: { worldId: world.id },
    select: { cityKey: true },
    orderBy: { cityKey: 'asc' },
  });
  const preset = world.preset ? parsePreset(world.preset) : null;
  const bonus = preset?.boost.lateJoin
    ? lateJoinBonus(
        preset.boost.lateJoin,
        monthlyDate(world.startYear, world.monthlyTick + TICKS_PER_MONTH).year - world.startYear,
        await tx.general.findMany({
          where: { worldId: world.id },
          select: { id: true, nationId: true, experience: true },
        }),
      )
    : undefined;
  const general = buildCreatedGeneral({
    ...(bonus ? { bonus } : {}),
    payload: parsed.value,
    seed: world.seed,
    userId: event.userId,
    id: Math.max(0, ...existing.map((g) => g.id)) + 1,
    startYear: world.startYear,
    monthlyTick: world.monthlyTick,
    tick,
    cityKeys: cities.map((c) => c.cityKey),
    unitSet: world.unitSet,
  });
  await tx.general.create({
    data: {
      ...general,
      worldId: world.id,
      ...(modern ? { defaultPolicy: 'none', lastActiveTick: tick, lastActiveAt: event.createdAt } : {}),
    },
  });
  await tx.generalTurn.createMany({
    data: (modern ? emptyQueue() : emptyTurns()).map((turn, slot) => ({
      ...turn,
      explicit: modern ? false : true,
      args: {},
      worldId: world.id,
      generalId: general.id,
      slot,
    })),
  });
  await tx.inputEvent.update({
    where: { id: event.id },
    data: {
      status: 'APPLIED',
      generalId: general.id,
      sequence: await nextActionSequence(tx, world.id),
      result: { general, ...(modern ? { activeTick: tick } : {}) } as unknown as Prisma.InputJsonValue,
    },
  });
  return true;
}
