import type { Prisma } from '@opensamguk/db';
import {
  readLogisticsOriginConfig,
  readLogisticsState,
  logisticsMovementSchema,
  LOGISTICS_GOODS,
  attachOperationalKinds,
  readOperationalMap,
  type LogisticsConfig,
  type WorldView,
  type LogisticsMovement,
} from '@opensamguk/rules';
import { z } from 'zod';

type World = Prisma.WorldGetPayload<Record<string, never>>;

export { readLogisticsOriginConfig } from '@opensamguk/rules';

export function readStoredLogistics(
  value: unknown,
  state: Pick<WorldView, 'cities' | 'ruleFeatures'>,
  config?: LogisticsConfig,
) {
  if (!state.ruleFeatures?.includes('logistics-v1')) {
    if (value !== null && value !== undefined) throw new Error('물류 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  if (!state.ruleFeatures.includes('city-resources-v1') || !config)
    throw new Error('물류의 의존 기능·생성 설정이 없습니다.');
  const stored = readLogisticsState(value, state);
  if (JSON.stringify(stored.config) !== JSON.stringify(config)) throw new Error('물류 설정이 원생성과 다릅니다.');
  return stored;
}

export async function assertStoredLogistics(tx: Prisma.TransactionClient, world: World): Promise<void> {
  if (!world.ruleFeatures.includes('logistics-v1')) {
    readStoredLogistics(world.logisticsState, { cities: {}, ruleFeatures: world.ruleFeatures });
    return;
  }
  const cities = await tx.city.findMany({ where: { worldId: world.id } });
  const attached = attachOperationalKinds(
    cities,
    readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin),
  );
  const state = {
    cities: Object.fromEntries(attached.map((city) => [city.cityKey, city])),
    ruleFeatures: world.ruleFeatures,
  };
  const stored = readStoredLogistics(world.logisticsState, state, readLogisticsOriginConfig(world, state));
  if (stored!.monthlyTick !== world.monthlyTick) throw new Error('저장된 물류와 월 정산 tick이 다릅니다.');
  const totals = await tx.logisticsMovement.groupBy({
    by: ['holder', 'holderId', 'good'],
    where: { worldId: world.id },
    _sum: { delta: true },
  });
  const expected = new Map<string, number>();
  for (const [key, city] of Object.entries(stored!.cities))
    for (const good of LOGISTICS_GOODS) expected.set(`city:${key}:${good}`, city[good]);
  for (const convoy of stored!.convoys)
    for (const good of LOGISTICS_GOODS) expected.set(`convoy:${convoy.id}:${good}`, convoy.goods[good]);
  for (const row of totals) {
    const key = `${row.holder}:${row.holderId}:${row.good}`,
      sum = row._sum.delta ?? 0;
    if (
      !Number.isSafeInteger(sum) ||
      sum !== (expected.get(key) ?? 0) ||
      (row.holder === 'city' && !stored!.cities[String(row.holderId)]) ||
      (row.holder === 'convoy' && row.holderId >= stored!.nextConvoyId)
    )
      throw new Error('저장된 물류 원장과 보유량이 다릅니다.');
    expected.delete(key);
  }
  if ([...expected.values()].some((quantity) => quantity !== 0)) throw new Error('물류 보유량의 기록이 없습니다.');
}

// World 행 잠금을 가진 호출자의 같은 트랜잭션에서 CAS로 쓴다.
export async function persistLogisticsState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  if (!before.logistics && !next.logistics) return;
  if (
    !before.logistics ||
    !next.logistics ||
    !before.ruleFeatures?.includes('logistics-v1') ||
    !next.ruleFeatures?.includes('logistics-v1')
  )
    throw new Error('진행 중 물류 기능을 바꿀 수 없습니다.');
  const original = readLogisticsState(before.logistics, before),
    final = readLogisticsState(next.logistics, next);
  if (JSON.stringify(original.config) !== JSON.stringify(final.config))
    throw new Error('진행 중 물류 설정을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, logisticsState: { equals: original as Prisma.InputJsonValue } },
    data: { logisticsState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('저장할 물류 상태가 바뀌었습니다.');
}

export async function appendLogisticsMovements(
  tx: Prisma.TransactionClient,
  worldId: string,
  value: readonly LogisticsMovement[],
  at: { tick: number; sequence: number },
) {
  const rows = z.array(logisticsMovementSchema).parse(value);
  if (rows.length)
    await tx.logisticsMovement.createMany({
      data: rows.map(({ id, ...row }, ordinal) => ({
        ...row,
        holderId: id,
        ordinal,
        worldId,
        tick: at.tick,
        sequence: at.sequence,
      })),
    });
}
