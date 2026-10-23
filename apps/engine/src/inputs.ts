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
  policyKeySchema,
  policyMarkerPayloadSchema,
  assertSlotSet,
  validateGeneralCreation,
  type CreationCode,
} from '@opensamguk/rules';

// 호출자가 리스와 World를 잠근 뒤 같은 펜싱 트랜잭션에서 실행한다.
// null이면 미확정인 기존 활동 기준을 기다리므로 게임 행동도 실행하지 않는다.
export async function processPendingInput(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  tick: number,
): Promise<boolean | null> {
  const event = await tx.inputEvent.findFirst({
    where: {
      worldId: world.id,
      kind: { in: ['general.create', 'general.setPolicy', 'general.active', 'system.policy.enable'] },
      status: 'PENDING',
    },
    orderBy: { id: 'asc' },
  });
  if (!event) return false;
  const modern = isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence });
  if (event.kind === 'system.policy.enable') {
    if (world.status === 'ENDED' || modern) throw new Error('전환 표지의 월드 상태가 올바르지 않습니다.');
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
    // 기존 사람 장수의 기준 T/0은 사용자 결정 전이다. 값을 선택해 APPLIED로 만들지 않는다.
    return null;
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
    const payload = event.payload as { policy?: unknown };
    const policy = event.kind === 'general.setPolicy' ? policyKeySchema.safeParse(payload?.policy) : null;
    if (policy && !policy.success) return rejectInput('BAD_POLICY', '기본 방침이 올바르지 않습니다.');
    await tx.general.update({
      where: { worldId_id: { worldId: world.id, id: general.id } },
      data: {
        ...(policy?.success ? { defaultPolicy: policy.data } : {}),
        lastActiveTick: Math.max(general.lastActiveTick ?? 0, tick),
        lastActiveAt: event.createdAt,
      },
    });
    await tx.inputEvent.update({
      where: { id: event.id },
      data: {
        status: 'APPLIED',
        sequence: await nextActionSequence(tx, world.id),
        result: { ...(policy?.success ? { policy: policy.data } : {}), activeTick: tick },
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
