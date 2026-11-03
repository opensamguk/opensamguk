import { z } from 'zod';
import { CITY_RESOURCE_MAX, readCityResourcesState } from '../cityResources/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { assertLogisticsConserved, type LogisticsMovement } from './ledger';
import {
  LOGISTICS_GOODS,
  LOGISTICS_MAX_CONVOYS,
  logisticsGoodsSchema,
  logisticsQuantity,
  logisticsTotal,
  logisticsCapacity,
  readLogisticsState,
  type LogisticsConvoy,
  type LogisticsGood,
} from './state';

const identifier = logisticsQuantity.min(1);
export const logisticsInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('dispatch'),
    fromCityKey: identifier,
    toCityKey: identifier,
    goods: logisticsGoodsSchema,
  }),
  z.strictObject({ type: z.literal('cancel'), convoyId: identifier }),
  z.strictObject({ type: z.literal('upgrade'), cityKey: identifier }),
  z.strictObject({
    type: z.literal('trade'),
    cityKey: identifier,
    good: z.enum(LOGISTICS_GOODS),
    side: z.enum(['buy', 'sell']),
    amount: identifier,
  }),
]);
export type LogisticsInput = z.infer<typeof logisticsInputSchema>;
const deny = (code: string, message: string) => ({ ok: false as const, code, message });

// 지도 연결의 순서가 달라도 같은 최단 경로를 고른다.
export function findLogisticsPath(
  world: WorldView,
  from: number,
  to: number,
  nationId: number,
  maxHops: number,
): number[] | null {
  const usable = (key: number) => world.cities[key]?.nationId === nationId && world.cities[key]!.supplied;
  if (from === to || !usable(from) || !usable(to)) return null;
  const queue = [[from]],
    visited = new Set([from]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    if (path.length - 1 >= maxHops) continue;
    for (const key of [...world.cities[path.at(-1)!]!.connections].sort((a, b) => a - b)) {
      if (!usable(key) || visited.has(key)) continue;
      const next = [...path, key];
      if (key === to) return next;
      visited.add(key);
      queue.push(next);
    }
  }
  return null;
}

function change(
  rows: LogisticsMovement[],
  holder: 'city' | 'convoy',
  id: number,
  good: LogisticsGood,
  delta: number,
  reason: LogisticsMovement['reason'],
) {
  if (delta !== 0) rows.push({ holder, id, good, delta, reason });
}

function receive(
  state: WorldState,
  convoy: LogisticsConvoy,
  cityKey: number,
  reason: 'ARRIVE' | 'RETURN' | 'CAPTURE',
  lossBp: number,
  rows: LogisticsMovement[],
) {
  const city = state.logistics!.cities[String(cityKey)]!;
  let room = logisticsCapacity(state.logistics!.config, city.level) - logisticsTotal(city);
  for (const good of LOGISTICS_GOODS) {
    const amount = convoy.goods[good];
    const loss = Number((BigInt(amount) * BigInt(lossBp)) / 10_000n);
    const accepted = Math.min(amount - loss, room);
    const overflow = amount - loss - accepted;
    city[good] += accepted;
    room -= accepted;
    change(rows, 'convoy', convoy.id, good, -loss, 'LOSS_TRANSIT');
    change(rows, 'convoy', convoy.id, good, -overflow, 'LOSS_OVERFLOW');
    change(rows, 'convoy', convoy.id, good, -accepted, reason);
    change(rows, 'city', cityKey, good, accepted, reason);
  }
}

function complete(
  world: WorldView,
  state: WorldState,
  rows: LogisticsMovement[],
  tick: number,
  action: LogisticsInput['type'],
  extra: { convoyId?: number; arriveTick?: number; path?: number[] } = {},
) {
  state.logistics!.revision++;
  state.logistics = readLogisticsState(state.logistics, state);
  assertLogisticsConserved(world.logistics!, state.logistics, rows);
  return {
    ok: true as const,
    state,
    result: { action, revision: state.logistics.revision, tick, ...extra, movements: rows },
  };
}

export function applyLogisticsInput(
  world: WorldView,
  value: unknown,
  actorId: number,
  context: { tick: number; userId: string; userActive: boolean },
) {
  if (!world.ruleFeatures?.includes('logistics-v1'))
    return deny('FEATURE_DISABLED', '이 월드는 물류 기능을 쓰지 않습니다.');
  logisticsQuantity.parse(context.tick);
  const actor = world.generals[actorId];
  if (
    !context.userActive ||
    !actor ||
    !context.userId ||
    actor.userId !== context.userId ||
    actor.activeFromYear > world.startYear + Math.floor(context.tick / (12 * TICKS_PER_MONTH))
  )
    return deny('ACTOR_INACTIVE', '활성 계정의 등장한 자기 장수만 물류를 지시할 수 있습니다.');
  if (
    actor.nationId === null ||
    !world.nations[actor.nationId] ||
    !Number.isInteger(actor.officerLevel) ||
    actor.officerLevel < 5 ||
    actor.officerLevel > 12
  )
    return deny('NO_PERMISSION', '국가 수뇌만 물류를 지시할 수 있습니다.');
  const parsed = logisticsInputSchema.safeParse(value);
  if (!parsed.success) return deny('BAD_INPUT', '수송·창고·교역 입력을 확인하세요.');
  const original = readLogisticsState(world.logistics, world);
  if (context.tick < original.monthlyTick || context.tick >= original.monthlyTick + TICKS_PER_MONTH)
    throw new Error('물류 입력 tick과 현재 월이 다릅니다.');
  if (original.revision === CITY_RESOURCE_MAX) return deny('LIMIT', '물류 변경 번호 한도를 넘었습니다.');
  const state = cloneWorld(world),
    rows: LogisticsMovement[] = [];
  state.logistics = original;
  const outcome = runLogisticsAction(state, actor.nationId, parsed.data, context.tick, rows);
  if (!outcome.ok) return outcome;
  return complete(world, state, rows, context.tick, parsed.data.type, outcome.extra);
}

// 사람 입력은 위에서 세션·직책을 검사한다. NPC는 월 정산에서 군주와 예산을 검사한 뒤에만 이 전이를 쓴다.
export function runLogisticsAction(
  state: WorldState,
  nationId: number,
  args: LogisticsInput,
  tick: number,
  rows: LogisticsMovement[],
) {
  const original = state.logistics!,
    config = original.config;
  const owned = (key: number) => state.cities[key]?.nationId === nationId && state.cities[key]!.supplied;
  if (args.type === 'dispatch') {
    const total = logisticsTotal(args.goods),
      stock = original.cities[String(args.fromCityKey)];
    if (total < 1 || total > config.transport.maxPerOrder) return deny('BAD_INPUT', '한 번에 보낼 수량을 확인하세요.');
    const path = findLogisticsPath(state, args.fromCityKey, args.toCityKey, nationId, config.transport.maxHops);
    if (!path) return deny('NO_ROUTE', '보급이 이어진 자기 국가 거점 사이에서만 수송할 수 있습니다.');
    if (!stock || LOGISTICS_GOODS.some((good) => stock[good] < args.goods[good]))
      return deny('NO_GOODS', '보낼 재고가 부족합니다.');
    if (
      original.convoys.length >= LOGISTICS_MAX_CONVOYS ||
      original.convoys.filter((convoy) => convoy.nationId === nationId).length >= config.transport.maxActivePerNation ||
      original.nextConvoyId === CITY_RESOURCE_MAX
    )
      return deny('LIMIT', '수송대 한도를 넘었습니다.');
    const arriveTick =
      (Math.floor(tick / TICKS_PER_MONTH) + Math.ceil((path.length - 1) / config.transport.hopsPerMonth)) *
      TICKS_PER_MONTH;
    if (arriveTick > CITY_RESOURCE_MAX) return deny('LIMIT', '수송 도착 tick 한도를 넘었습니다.');
    const convoyId = original.nextConvoyId++;
    original.convoys.push({
      id: convoyId,
      nationId,
      fromCityKey: args.fromCityKey,
      toCityKey: args.toCityKey,
      path,
      goods: args.goods,
      departTick: tick,
      arriveTick,
    });
    for (const good of LOGISTICS_GOODS) {
      stock[good] -= args.goods[good];
      change(rows, 'city', args.fromCityKey, good, -args.goods[good], 'DEPART');
      change(rows, 'convoy', convoyId, good, args.goods[good], 'DEPART');
    }
    return { ok: true as const, extra: { convoyId, arriveTick, path } };
  }
  if (args.type === 'cancel') {
    const convoy = original.convoys.find((row) => row.id === args.convoyId);
    if (!convoy || convoy.nationId !== nationId || !owned(convoy.fromCityKey))
      return deny('BAD_TARGET', '자기 국가 출발지로 돌릴 수 있는 수송대가 없습니다.');
    receive(state, convoy, convoy.fromCityKey, 'RETURN', 0, rows);
    original.convoys = original.convoys.filter((row) => row.id !== convoy.id);
    return { ok: true as const, extra: { convoyId: convoy.id } };
  }
  if (!owned(args.cityKey)) return deny('NOT_OWN_CITY', '보급이 이어진 자기 국가 거점만 관리할 수 있습니다.');
  state.cityResources = readCityResourcesState(state.cityResources, state);
  const city = original.cities[String(args.cityKey)]!,
    funds = state.cityResources.cities[String(args.cityKey)]!;
  if (args.type === 'upgrade') {
    if (city.level >= config.capacity.maxLevel) return deny('LIMIT', '창고가 최대 등급입니다.');
    if (funds.gold < config.upgrade.gold || city.wood < config.upgrade.wood)
      return deny('NO_GOODS', '창고 증축에 쓸 금·목재가 부족합니다.');
    funds.gold -= config.upgrade.gold;
    city.wood -= config.upgrade.wood;
    city.level++;
    change(rows, 'city', args.cityKey, 'wood', -config.upgrade.wood, 'UPGRADE');
  } else {
    const price = BigInt(config.trade[args.good][args.side]) * BigInt(args.amount);
    if (args.side === 'buy') {
      if (price > BigInt(funds.gold)) return deny('NO_GOLD', '교역에 쓸 도시 금이 부족합니다.');
      if (args.amount > logisticsCapacity(config, city.level) - logisticsTotal(city))
        return deny('NO_CAPACITY', '창고 공간이 부족합니다.');
      funds.gold -= Number(price);
      city[args.good] += args.amount;
      change(rows, 'city', args.cityKey, args.good, args.amount, 'TRADE');
    } else {
      if (city[args.good] < args.amount) return deny('NO_GOODS', '팔 재고가 부족합니다.');
      if (price > BigInt(CITY_RESOURCE_MAX - funds.gold)) return deny('LIMIT', '도시 금의 저장 한도를 넘었습니다.');
      funds.gold += Number(price);
      city[args.good] -= args.amount;
      change(rows, 'city', args.cityKey, args.good, -args.amount, 'TRADE');
    }
  }
  return { ok: true as const, extra: {} };
}

export function settleLogisticsMonthly(world: WorldView, tick: number) {
  const original = readLogisticsState(world.logistics, world);
  logisticsQuantity.parse(tick);
  if (tick !== original.monthlyTick + TICKS_PER_MONTH) throw new Error('물류 월 정산이 중복됐거나 순서가 다릅니다.');
  if (original.revision === CITY_RESOURCE_MAX) throw new Error('물류 변경 번호 한도를 넘었습니다.');
  const state = cloneWorld(world),
    rows: LogisticsMovement[] = [];
  state.logistics = original;
  for (const convoy of original.convoys) {
    if (convoy.arriveTick > tick) continue;
    const destination = world.cities[convoy.toCityKey]!,
      source = world.cities[convoy.fromCityKey]!;
    const connected = convoy.path.every(
      (key) => world.cities[key]!.nationId === convoy.nationId && world.cities[key]!.supplied,
    );
    const war =
      destination.nationId !== null &&
      world.diplomacies.some(
        (entry) =>
          entry.state === 'WAR' &&
          ((entry.nationA === convoy.nationId && entry.nationB === destination.nationId) ||
            (entry.nationB === convoy.nationId && entry.nationA === destination.nationId)),
      );
    if (connected)
      receive(
        state,
        convoy,
        destination.cityKey,
        'ARRIVE',
        Math.min(10_000, original.config.transport.lossBpPerHop * (convoy.path.length - 1)),
        rows,
      );
    else if (war) receive(state, convoy, destination.cityKey, 'CAPTURE', 0, rows);
    else if (source.nationId === convoy.nationId) receive(state, convoy, source.cityKey, 'RETURN', 0, rows);
    else
      for (const good of LOGISTICS_GOODS) change(rows, 'convoy', convoy.id, good, -convoy.goods[good], 'LOSS_TRANSIT');
  }
  original.convoys = original.convoys.filter((convoy) => convoy.arriveTick > tick);
  for (const specialty of original.config.specialties) {
    const city = world.cities[specialty.cityKey]!;
    if (
      city.nationId === null ||
      !world.nations[city.nationId] ||
      !city.supplied ||
      city.kind === 'PASS' ||
      city.populationMax <= 0
    )
      continue;
    logisticsQuantity.parse(city.population);
    logisticsQuantity.parse(city.populationMax);
    const amount = Number(
      (BigInt(specialty.perMonth) * BigInt(Math.min(city.population, city.populationMax))) / BigInt(city.populationMax),
    );
    const stock = original.cities[String(city.cityKey)]!;
    const accepted = Math.min(amount, logisticsCapacity(original.config, stock.level) - logisticsTotal(stock));
    stock[specialty.good] += accepted;
    change(rows, 'city', city.cityKey, specialty.good, amount, 'PRODUCE');
    change(rows, 'city', city.cityKey, specialty.good, accepted - amount, 'LOSS_OVERFLOW');
  }
  original.monthlyTick = tick;
  original.revision++;
  state.logistics = readLogisticsState(original, state);
  assertLogisticsConserved(world.logistics!, state.logistics, rows);
  return { state, movements: rows };
}
