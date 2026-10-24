import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  buildCreatedGeneral,
  lateJoinBonus,
  parsePreset,
  monthlyDate,
  TICKS_PER_MONTH,
  creationFailure,
  emptyTurns,
  validateGeneralCreation,
  type CreationCode,
} from '@opensamguk/rules';

import { engineRegistry, type EngineRegistry, type QueuedInputHandler } from './features';

// 호출자가 리스와 World를 잠근 뒤 같은 펜싱 트랜잭션에서 실행한다.
export function queuedInputHandlers(registry: EngineRegistry = engineRegistry): Record<string, QueuedInputHandler> {
  const handlers: Record<string, QueuedInputHandler> = { 'general.create': processGeneralCreation };
  const kinds = registry.rules.inputKinds;
  for (const feature of registry.features) {
    if (!registry.rules.features.some((definition) => definition.key === feature.key))
      throw new Error('엔진 기능이 규칙 목록에 없습니다.');
    for (const [kind, handler] of Object.entries(feature.queuedInputs ?? {})) {
      if (
        Object.hasOwn(handlers, kind) ||
        !kinds.some(
          (definition) =>
            definition.kind === kind && definition.feature === feature.key && definition.route === 'queued',
        )
      )
        throw new Error('대기 입력 처리기가 중복되거나 규칙 목록과 다릅니다.');
      handlers[kind] = handler;
    }
  }
  if (
    Object.keys(handlers).some(
      (kind) => kinds.filter((definition) => definition.kind === kind && definition.route === 'queued').length !== 1,
    ) ||
    kinds.some((definition) => definition.route === 'queued' && !Object.hasOwn(handlers, definition.kind))
  )
    throw new Error('대기 입력 처리기가 없습니다.');
  return handlers;
}

export async function processInputs(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  tick: number,
  registry: EngineRegistry = engineRegistry,
): Promise<boolean> {
  const event = await tx.inputEvent.findFirst({
    where: { worldId: world.id, status: 'PENDING' },
    orderBy: { id: 'asc' },
  });
  if (!event) return false;
  const kind = registry.rules.inputKinds.find((definition) => definition.kind === event.kind);
  if (!kind || kind.route !== 'queued') throw new Error('등록되지 않은 대기 입력 종류입니다.');
  const handlers = queuedInputHandlers(registry);
  const sequence = await nextActionSequence(tx, world.id);
  const outcome =
    kind.feature !== null && !world.ruleFeatures.includes(kind.feature)
      ? {
          status: 'REJECTED' as const,
          result: { code: 'FEATURE_DISABLED', message: '이 월드에서 켜지 않은 기능입니다.' },
        }
      : await handlers[event.kind]!(tx, world, event, { tick, sequence });
  const updated = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { ...outcome, sequence, tick: world.replayFormat === 3 ? tick : null },
  });
  if (updated.count !== 1) throw new Error('입력 상태가 바뀌어 저장을 취소했습니다.');
  return true;
}

const processGeneralCreation: QueuedInputHandler = async (tx, world, event, { tick }) => {
  const reject = (code: CreationCode) => ({ status: 'REJECTED' as const, result: creationFailure(code) });
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED');
  const actor = await tx.user.findUnique({ where: { id: event.userId } });
  if (!actor || actor.status !== 'ACTIVE') return reject('ACTOR_INACTIVE');
  const parsed = validateGeneralCreation(event.payload, world.statRules);
  if (!parsed.ok) return reject(parsed.code);
  const existing = await tx.general.findMany({
    where: { worldId: world.id },
    select: { id: true, userId: true, name: true },
  });
  if (existing.some((g) => g.userId === event.userId)) return reject('ALREADY_EXISTS');
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
  await tx.general.create({ data: { ...general, worldId: world.id } });
  await tx.generalTurn.createMany({
    data: emptyTurns().map((turn, slot) => ({
      ...turn,
      args: {},
      worldId: world.id,
      generalId: general.id,
      slot,
    })),
  });
  return { status: 'APPLIED', generalId: general.id, result: { general } as unknown as Prisma.InputJsonValue };
};
