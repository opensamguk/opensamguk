import type { Failure } from '../commands/types';
import type { DeepReadonly, WorldView } from '../model/world';
import { assertLogisticsConserved, type LogisticsMovement } from './ledger';
import {
  LOGISTICS_GOODS,
  logisticsQuantity,
  readLogisticsState,
  type LogisticsGoods,
  type LogisticsState,
} from './state';

export { recruitGoods } from './costs';

export function affordableByGoods(
  stock: Readonly<LogisticsGoods>,
  per100: Readonly<LogisticsGoods>,
  limit: number,
): number {
  for (const good of LOGISTICS_GOODS) {
    logisticsQuantity.parse(stock[good]);
    logisticsQuantity.parse(per100[good]);
  }
  logisticsQuantity.max(1_000_000).parse(limit);
  return LOGISTICS_GOODS.reduce(
    (amount, good) => (per100[good] === 0 ? amount : Math.min(amount, Math.floor(stock[good] / per100[good]) * 100)),
    limit,
  );
}

function current(view: WorldView): LogisticsState {
  if (!view.ruleFeatures?.includes('logistics-v1')) throw new Error('물류 판이 아닙니다.');
  return readLogisticsState(view.logistics, view);
}

function costFailure(
  state: DeepReadonly<LogisticsState>,
  cityKey: number,
  cost: Readonly<LogisticsGoods>,
): Failure | null {
  if (LOGISTICS_GOODS.some((good) => !Number.isSafeInteger(cost[good]) || cost[good] < 0))
    throw new Error('물류 소비 비용은 음수가 아닌 안전 정수여야 합니다.');
  const stock = state.cities[String(cityKey)];
  if (!stock) throw new Error('물류 소비 거점이 없습니다.');
  if (LOGISTICS_GOODS.some((good) => stock[good] < cost[good]))
    return { code: 'NO_GOODS', message: '도시의 철·목재·말이 부족합니다.' };
  if (LOGISTICS_GOODS.some((good) => cost[good] > 0) && !logisticsQuantity.safeParse(state.revision + 1).success)
    return { code: 'BAD_STATE', message: '물류 변경 횟수의 한도에 도달했습니다.' };
  return null;
}

export function checkCityGoods(view: WorldView, cityKey: number, cost: Readonly<LogisticsGoods>): Failure | null {
  return costFailure(current(view), cityKey, cost);
}

export function consumeCityGoods(view: WorldView, cityKey: number, cost: Readonly<LogisticsGoods>) {
  const logistics = current(view);
  const failure = costFailure(logistics, cityKey, cost);
  if (failure) return { ok: false as const, ...failure };
  if (LOGISTICS_GOODS.some((good) => cost[good] > 0)) {
    for (const good of LOGISTICS_GOODS) logistics.cities[String(cityKey)]![good] -= cost[good];
    logistics.revision++;
  }
  return { ok: true as const, logistics };
}

// 한 차례의 개인·국가 명령을 모두 반영한 뒤 한 번 기록한다. 이동·교역은 별도 입력 경로다.
export function logisticsCommandMovements(before: WorldView, after: WorldView): LogisticsMovement[] {
  if (!before.logistics && !after.logistics) {
    if (before.ruleFeatures?.includes('logistics-v1') || after.ruleFeatures?.includes('logistics-v1'))
      throw new Error('물류 판의 재고가 없습니다.');
    return [];
  }
  const prior = current(before),
    next = current(after);
  const metadata = (state: LogisticsState) => ({
    ...state,
    revision: 0,
    cities: Object.fromEntries(Object.entries(state.cities).map(([key, city]) => [key, { level: city.level }])),
  });
  if (JSON.stringify(metadata(prior)) !== JSON.stringify(metadata(next)))
    throw new Error('일반 명령이 물류 소비 밖의 상태를 바꿨습니다.');
  const rows: LogisticsMovement[] = [];
  for (const key of Object.keys(prior.cities).sort((a, b) => Number(a) - Number(b))) {
    for (const good of LOGISTICS_GOODS) {
      const delta = next.cities[key]![good] - prior.cities[key]![good];
      if (delta > 0) throw new Error('일반 명령은 원자재를 생산할 수 없습니다.');
      if (delta < 0) rows.push({ holder: 'city', id: Number(key), good, delta, reason: 'CONSUME' });
    }
  }
  if (rows.length ? next.revision <= prior.revision : next.revision !== prior.revision)
    throw new Error('물류 소비와 변경 횟수가 다릅니다.');
  assertLogisticsConserved(prior, next, rows);
  return rows;
}
