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
  validateGeneralCreation,
  type CreationCode,
} from '@opensamguk/rules';

// 호출자가 리스와 World를 잠근 뒤 같은 펜싱 트랜잭션에서 실행한다.
export async function processCreation(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  tick: number,
): Promise<boolean> {
  const event = await tx.inputEvent.findFirst({
    where: { worldId: world.id, kind: 'general.create', status: 'PENDING' },
    orderBy: { id: 'asc' },
  });
  if (!event) return false;
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
  await tx.inputEvent.update({
    where: { id: event.id },
    data: {
      status: 'APPLIED',
      generalId: general.id,
      sequence: await nextActionSequence(tx, world.id),
      result: { general } as unknown as Prisma.InputJsonValue,
    },
  });
  return true;
}
