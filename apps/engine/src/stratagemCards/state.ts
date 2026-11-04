import type { Prisma } from '@opensamguk/db';
import {
  readStratagemCardsState,
  readStratagemCardsStorage,
  reconcileStratagemCards,
  stratagemCardsStateSchema,
  type WorldState,
  type WorldView,
  type StratagemCardsState,
} from '@opensamguk/rules';

async function save(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: StratagemCardsState,
  next: StratagemCardsState,
) {
  if (JSON.stringify(before) === JSON.stringify(next)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, stratagemCardsState: { equals: before as Prisma.InputJsonValue } },
    data: { stratagemCardsState: next as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw Error('계략 패 상태가 바뀌어 저장을 취소했습니다.');
}

export async function persistStratagemCardsState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldState,
  monthlyTick?: number,
) {
  if (!before.ruleFeatures?.includes('stratagem-cards-v1') && !next.ruleFeatures?.includes('stratagem-cards-v1')) {
    if (before.stratagemCards !== undefined || next.stratagemCards !== undefined)
      throw Error('계략 패를 끈 월드에 상태가 있습니다.');
    return;
  }
  if (!before.ruleFeatures?.includes('stratagem-cards-v1') || !next.ruleFeatures?.includes('stratagem-cards-v1'))
    throw Error('진행 중 계략 패 기능을 바꿀 수 없습니다.');
  const original = readStratagemCardsState(before.stratagemCards, before),
    candidate = stratagemCardsStateSchema.parse(next.stratagemCards);
  if (JSON.stringify(original.config) !== JSON.stringify(candidate.config) || original.seed !== candidate.seed)
    throw Error('진행 중 계략 패 설정·시드를 바꿀 수 없습니다.');
  if (candidate.monthlyTick !== (monthlyTick ?? original.monthlyTick)) throw Error('계략 패 월 정산 시각이 다릅니다.');
  if (candidate.revision < original.revision) throw Error('계략 패 변경 번호가 되돌아갔습니다.');
  // queued 결과의 새 소유 관계를 먼저 정리해야 다음 기능도 엄격한 적재를 할 수 있다.
  next.stratagemCards = reconcileStratagemCards(next, candidate, candidate.monthlyTick);
  await save(tx, worldId, original, next.stratagemCards);
}

export async function reconcileQueuedStratagemCards(tx: Prisma.TransactionClient, worldId: string) {
  const world = await tx.world.findUniqueOrThrow({
      where: { id: worldId },
      select: {
        replayFormat: true,
        ruleFeatures: true,
        replayOrigin: true,
        monthlyTick: true,
        stratagemCardsState: true,
      },
    }),
    original = readStratagemCardsStorage(world);
  if (!original) return;
  const nations = await tx.nation.findMany({ where: { worldId }, select: { id: true } }),
    cities = await tx.city.findMany({ where: { worldId }, select: { cityKey: true, nationId: true } });
  const next = reconcileStratagemCards(
    {
      nations: Object.fromEntries(nations.map((nation) => [nation.id, nation])),
      cities: Object.fromEntries(cities.map((city) => [city.cityKey, city])),
    },
    original,
    world.monthlyTick,
  );
  await save(tx, worldId, original, next);
}
