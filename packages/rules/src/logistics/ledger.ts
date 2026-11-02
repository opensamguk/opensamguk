import { z } from 'zod';
import { CITY_RESOURCE_MAX } from '../cityResources/state';
import type { DeepReadonly } from '../model/world';
import { LOGISTICS_GOODS, logisticsQuantity, type LogisticsState } from './state';

export const logisticsMovementSchema = z.strictObject({
  holder: z.enum(['city', 'convoy']),
  id: logisticsQuantity.min(1),
  good: z.enum(LOGISTICS_GOODS),
  delta: z
    .number()
    .int()
    .min(-CITY_RESOURCE_MAX)
    .max(CITY_RESOURCE_MAX)
    .refine((value) => value !== 0),
  reason: z.enum([
    'PRODUCE',
    'CONSUME',
    'DEPART',
    'ARRIVE',
    'RETURN',
    'CAPTURE',
    'LOSS_TRANSIT',
    'LOSS_OVERFLOW',
    'TRADE',
    'UPGRADE',
  ]),
});
export type LogisticsMovement = z.infer<typeof logisticsMovementSchema>;

// 도시와 수송대의 각 보유량까지 대조해 총량이 맞는 보유처 간 유실도 찾는다.
export function assertLogisticsConserved(
  before: DeepReadonly<LogisticsState>,
  after: DeepReadonly<LogisticsState>,
  value: unknown,
): asserts value is LogisticsMovement[] {
  const rows = z.array(logisticsMovementSchema).parse(value);
  const changes = new Map<string, bigint>();
  const add = (key: string, delta: bigint) => changes.set(key, (changes.get(key) ?? 0n) + delta);
  for (const [state, sign] of [
    [before, -1n],
    [after, 1n],
  ] as const) {
    for (const [key, city] of Object.entries(state.cities))
      for (const good of LOGISTICS_GOODS) add(`city:${key}:${good}`, BigInt(city[good]) * sign);
    for (const convoy of state.convoys)
      for (const good of LOGISTICS_GOODS) add(`convoy:${convoy.id}:${good}`, BigInt(convoy.goods[good]) * sign);
  }
  const transfers = new Map<string, bigint>();
  for (const row of rows) {
    const exists =
      row.holder === 'city'
        ? before.cities[String(row.id)] || after.cities[String(row.id)]
        : before.convoys.some((convoy) => convoy.id === row.id) || after.convoys.some((convoy) => convoy.id === row.id);
    if (!exists) throw new Error('물류 변동의 보유처가 없습니다.');
    const delta = BigInt(row.delta);
    if (
      (row.reason === 'DEPART' && (row.holder === 'city' ? row.delta > 0 : row.delta < 0)) ||
      (['ARRIVE', 'RETURN', 'CAPTURE'].includes(row.reason) && (row.holder === 'city' ? row.delta < 0 : row.delta > 0))
    )
      throw new Error('물류 이동의 보유처와 방향이 다릅니다.');
    if (
      (row.reason === 'PRODUCE' && row.delta < 0) ||
      (['CONSUME', 'LOSS_TRANSIT', 'LOSS_OVERFLOW', 'UPGRADE'].includes(row.reason) && row.delta > 0)
    )
      throw new Error('물류 생산·소비·손실의 부호가 다릅니다.');
    add(`${row.holder}:${row.id}:${row.good}`, -delta);
    if (['DEPART', 'ARRIVE', 'RETURN', 'CAPTURE'].includes(row.reason)) {
      const key = `${row.reason}:${row.good}`;
      transfers.set(key, (transfers.get(key) ?? 0n) + delta);
    }
  }
  if ([...changes.values(), ...transfers.values()].some((delta) => delta !== 0n))
    throw new Error('물류 재고와 생산·소비·수송·손실 기록이 보존되지 않았습니다.');
}
