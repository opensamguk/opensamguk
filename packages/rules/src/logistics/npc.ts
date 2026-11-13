import { CITY_RESOURCE_MAX } from '../cityResources/state';
import { cityNpcRecruitPlan } from '../cityResources/npc';
import { TICKS_PER_MONTH } from '../clock/constants';
import { affordableRecruits, recruitCost } from '../commands/statScores';
import { cloneWorld } from '../model/clone';
import type { WorldState } from '../model/world';
import type { NpcContext } from '../npc';
import { frontier } from '../npc/frontier';
import { recruitGoods } from './costs';
import { assertLogisticsConserved, type LogisticsMovement } from './ledger';
import { findLogisticsPath, runLogisticsAction, type LogisticsInput } from './operations';
import {
  LOGISTICS_GOODS,
  logisticsCapacity,
  logisticsTotal,
  readLogisticsState,
  type LogisticsGood,
  type LogisticsGoods,
} from './state';

const zero = (): LogisticsGoods => ({ iron: 0, wood: 0, horses: 0 });
const fraction = (amount: number, bp: number) => Number((BigInt(amount) * BigInt(bp)) / 10_000n);
function rotate<T>(values: readonly T[], month: number): T[] {
  const offset = values.length ? month % values.length : 0;
  return [...values.slice(offset), ...values.slice(0, offset)];
}
type Demand = { cityKey: number; need: LogisticsGoods; budget: number; recruitGold: number };
type NpcAction = Exclude<LogisticsInput, { type: 'cancel' }>;

// base 정산 뒤의 금만 대조한다. 이번 달 세입·생산·도착을 NPC의 지출이나 수입으로 세지 않는다.
function assertNpcFunds(before: WorldState, after: WorldState, rows: LogisticsMovement[]) {
  const config = before.logistics!.config;
  const cash = new Map<number, bigint>(),
    upgrades = new Map<number, number>();
  for (const row of rows) {
    if (row.reason === 'DEPART') continue;
    if (row.holder !== 'city') throw new Error('NPC 물류 지출의 보유자가 도시가 아닙니다.');
    if (row.reason === 'TRADE') {
      const price = config.trade[row.good][row.delta > 0 ? 'buy' : 'sell'];
      cash.set(row.id, (cash.get(row.id) ?? 0n) - BigInt(row.delta) * BigInt(price));
    } else if (row.reason === 'UPGRADE' && row.good === 'wood' && row.delta === -config.upgrade.wood) {
      cash.set(row.id, (cash.get(row.id) ?? 0n) - BigInt(config.upgrade.gold));
      upgrades.set(row.id, (upgrades.get(row.id) ?? 0) + 1);
    } else throw new Error('NPC 월 물류에 허용되지 않은 원장 행이 있습니다.');
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'logistics' || key === 'cityResources') continue;
    if (JSON.stringify(before[key as keyof WorldState]) !== JSON.stringify(after[key as keyof WorldState]))
      throw new Error('NPC 물류가 다른 월드 상태를 바꿨습니다.');
  }
  if (
    JSON.stringify({ ...before.cityResources, cities: null }) !==
    JSON.stringify({ ...after.cityResources, cities: null })
  )
    throw new Error('NPC 물류가 도시 재정 설정을 바꿨습니다.');
  for (const [key, prev] of Object.entries(before.cityResources!.cities)) {
    const next = after.cityResources!.cities[key]!;
    if (
      BigInt(next.gold) - BigInt(prev.gold) !== (cash.get(Number(key)) ?? 0n) ||
      JSON.stringify({ ...prev, gold: next.gold }) !== JSON.stringify(next) ||
      after.logistics!.cities[key]!.level - before.logistics!.cities[key]!.level !== (upgrades.get(Number(key)) ?? 0)
    )
      throw new Error('NPC 물류의 도시 금·등급·원장이 다릅니다.');
  }
  const oldConvoys = after.logistics!.convoys.filter((row) => row.id < before.logistics!.nextConvoyId);
  const added = after.logistics!.convoys.filter((row) => row.id >= before.logistics!.nextConvoyId);
  if (
    JSON.stringify(before.logistics!.convoys) !== JSON.stringify(oldConvoys) ||
    added.some((row, index) => row.id !== before.logistics!.nextConvoyId + index) ||
    after.logistics!.nextConvoyId !== before.logistics!.nextConvoyId + added.length ||
    after.logistics!.monthlyTick !== before.logistics!.monthlyTick ||
    after.logistics!.revision !== before.logistics!.revision + 1 ||
    JSON.stringify(config) !== JSON.stringify(after.logistics!.config)
  )
    throw new Error('NPC 물류의 수송대·정산 번호·설정이 다릅니다.');
}

export function settleNpcLogistics(world: WorldState, tick: number, unitSet: NpcContext['unitSet']) {
  const logistics = world.logistics!;
  const npc = 'npc' in logistics.config ? logistics.config.npc : undefined;
  const none = { state: world, movements: [] as LogisticsMovement[] };
  if (!npc || logistics.revision === CITY_RESOURCE_MAX) return none;
  if (!unitSet || !world.campaign || !world.cityResources || tick !== logistics.monthlyTick)
    throw new Error('NPC 물류 월 정산의 병종·부곡·도시 재정·tick이 없습니다.');
  const year = world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
  const active = Object.values(world.generals).filter((general) => general.activeFromYear <= year);
  const bound = new Set(
    world.campaign.links.filter((link) => link.relation === 'LIEUTENANT').map((link) => link.personId),
  );
  const rulers = new Map<number, typeof active>();
  const cityGenerals = new Map<number, (typeof active)[number]>();
  for (const general of active) {
    if (general.nationId !== null && general.officerLevel === 12) {
      const monarchs = rulers.get(general.nationId) ?? [];
      monarchs.push(general);
      rulers.set(general.nationId, monarchs);
    }
    if (
      general.userId === null &&
      !bound.has(general.id) &&
      general.nationId !== null &&
      world.cities[general.cityKey]?.nationId === general.nationId &&
      (!cityGenerals.has(general.cityKey) || general.id < cityGenerals.get(general.cityKey)!.id)
    )
      cityGenerals.set(general.cityKey, general);
  }
  const nations = Object.values(world.nations)
    .filter((nation) => {
      const monarchs = rulers.get(nation.id) ?? [];
      return nation.isNpc && monarchs.length === 1 && monarchs[0]!.userId === null;
    })
    .sort((a, b) => a.id - b.id);
  if (!nations.length) return none;
  const firstArmies = new Map<number, NonNullable<WorldState['campaign']>['units'][number]>();
  for (const unit of world.campaign.units)
    if (!firstArmies.has(unit.ownerId) || unit.id < firstArmies.get(unit.ownerId)!.id)
      firstArmies.set(unit.ownerId, unit);
  const state = cloneWorld(world),
    rows: LogisticsMovement[] = [];
  const stock = state.logistics!,
    month = tick / TICKS_PER_MONTH;
  const suppliedCities = new Map<number, WorldState['cities'][number][]>();
  for (const city of Object.values(state.cities))
    if (city.nationId !== null && city.supplied) {
      const cities = suppliedCities.get(city.nationId) ?? [];
      cities.push(city);
      suppliedCities.set(city.nationId, cities);
    }
  const incomingByCity = new Map<string, LogisticsGoods>();
  for (const convoy of stock.convoys) {
    const key = `${convoy.nationId}:${convoy.toCityKey}`,
      cargo = incomingByCity.get(key) ?? zero();
    for (const good of LOGISTICS_GOODS) cargo[good] += convoy.goods[good];
    incomingByCity.set(key, cargo);
  }
  let successes = 0;
  for (const nation of nations) {
    const cities = (suppliedCities.get(nation.id) ?? []).sort((a, b) => a.cityKey - b.cityKey);
    const demands: Demand[] = [];
    for (const city of cities) {
      const general = cityGenerals.get(city.cityKey);
      if (!general || general.nationId !== nation.id || !frontier(state, nation.id, city.cityKey)) continue;
      const resources = world.cityResources.cities[String(city.cityKey)]!;
      const plan = cityNpcRecruitPlan(world, general.id, { unitSet }, { resources, army: firstArmies.get(general.id) });
      if (!plan) continue;
      const budget = fraction(resources.gold, npc.budgetBp);
      const amount = Math.min(
        npc.recruitTarget,
        plan.limit,
        affordableRecruits(
          world,
          { ...general, gold: resources.gold - budget },
          plan.type.cost,
          plan.limit,
          plan.type.armType,
        ),
      );
      if (amount < 1) continue;
      demands.push({
        cityKey: city.cityKey,
        need: recruitGoods(stock.config, plan.type.armType, amount),
        budget,
        recruitGold: recruitCost(world, general, amount, plan.type.cost, false, plan.type.armType),
      });
    }
    const byCity = new Map(demands.map((demand) => [demand.cityKey, demand]));
    const spent = new Map<number, number>(),
      seen = new Set<string>(),
      received = new Set<string>();
    const bought = new Set<LogisticsGood>(),
      sold = new Set<LogisticsGood>();
    let attempts = 0,
      checks = 0,
      upgraded = false;
    let treasuryRemaining = npc.treasuryBudgetBp === undefined ? Infinity : fraction(nation.gold, npc.treasuryBudgetBp);
    const incoming = (cityKey: number) => incomingByCity.get(`${nation.id}:${cityKey}`) ?? zero();
    const deficit = (demand: Demand, good: LogisticsGood) =>
      Math.max(0, demand.need[good] - stock.cities[String(demand.cityKey)]![good] - incoming(demand.cityKey)[good]);
    const surplus = (cityKey: number, good: LogisticsGood) =>
      Math.max(0, stock.cities[String(cityKey)]![good] - (byCity.get(cityKey)?.need[good] ?? 0));
    const room = (cityKey: number) =>
      fraction(logisticsCapacity(stock.config, stock.cities[String(cityKey)]!.level), npc.stockCapBp) -
      logisticsTotal(stock.cities[String(cityKey)]!) -
      logisticsTotal(incoming(cityKey));
    const cash = (demand: Demand) =>
      Math.max(
        0,
        Math.min(
          demand.budget - (spent.get(demand.cityKey) ?? 0),
          state.cityResources!.cities[String(demand.cityKey)]!.gold - demand.recruitGold,
          treasuryRemaining,
        ),
      );
    const act = (args: NpcAction) => {
      if (attempts >= npc.maxActions) return false;
      const cityKey = args.type === 'dispatch' ? args.fromCityKey : args.cityKey;
      const key =
        args.type === 'trade'
          ? `${args.type}:${cityKey}:${args.good}:${args.side}`
          : args.type === 'dispatch'
            ? `${args.type}:${cityKey}:${args.toCityKey}:${LOGISTICS_GOODS.find((good) => args.goods[good] > 0)}`
            : `${args.type}:${cityKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      attempts++;
      const gold = state.cityResources!.cities[String(cityKey)]!.gold;
      const result = runLogisticsAction(state, nation.id, args, tick, rows);
      if (!result.ok) return false;
      successes++;
      const paid = gold - state.cityResources!.cities[String(cityKey)]!.gold;
      if (paid > 0) {
        if (paid > treasuryRemaining) throw new Error('NPC 물류의 국고 기준 월 예산을 넘었습니다.');
        spent.set(cityKey, (spent.get(cityKey) ?? 0) + paid);
        treasuryRemaining -= paid;
      }
      if (args.type === 'trade') (args.side === 'buy' ? bought : sold).add(args.good);
      if (args.type === 'upgrade') upgraded = true;
      if (args.type === 'dispatch') {
        const key = `${nation.id}:${args.toCityKey}`,
          cargo = incomingByCity.get(key) ?? zero();
        for (const good of LOGISTICS_GOODS)
          if (args.goods[good] > 0) {
            received.add(`${args.toCityKey}:${good}`);
            cargo[good] += args.goods[good];
          }
        incomingByCity.set(key, cargo);
      }
      return true;
    };
    // 후보 검사도 행동 상한만큼만 한다. 자금·경로가 없는 대국에서 전 거점 쌍을 훑지 않는다.
    candidate: for (const demand of rotate(demands, month)) {
      for (const good of rotate(LOGISTICS_GOODS, month)) {
        if (attempts >= npc.maxActions || checks >= npc.maxActions) break candidate;
        const missing = deficit(demand, good);
        if (missing < 1) continue;
        checks++;
        const sources = rotate(
          cities.filter(
            (city) =>
              city.cityKey !== demand.cityKey &&
              surplus(city.cityKey, good) > 0 &&
              !received.has(`${city.cityKey}:${good}`),
          ),
          month,
        )
          .slice(0, 2)
          .map((city) => ({
            city,
            path: findLogisticsPath(state, city.cityKey, demand.cityKey, nation.id, stock.config.transport.maxHops),
          }))
          .filter((entry) => entry.path !== null)
          .sort((a, b) => a.path!.length - b.path!.length || a.city.cityKey - b.city.cityKey);
        const source = sources[0];
        const buyable = sold.has(good) ? 0 : Math.floor(cash(demand) / stock.config.trade[good].buy);
        const desired = source
          ? Math.min(missing, surplus(source.city.cityKey, good), stock.config.transport.maxPerOrder)
          : Math.min(missing, buyable);
        if (desired < 1) continue;
        if (room(demand.cityKey) < desired) {
          for (const other of LOGISTICS_GOODS) {
            if (other === good || bought.has(other) || attempts >= npc.maxActions) continue;
            const reserved = demands.reduce((total, entry) => total + deficit(entry, other), 0);
            const amount = Math.min(
              desired - room(demand.cityKey),
              Math.max(0, surplus(demand.cityKey, other) - reserved),
            );
            if (amount > 0) act({ type: 'trade', cityKey: demand.cityKey, good: other, side: 'sell', amount });
            if (room(demand.cityKey) >= desired) break;
          }
          const city = stock.cities[String(demand.cityKey)]!;
          if (
            room(demand.cityKey) < desired &&
            !upgraded &&
            city.level < stock.config.capacity.maxLevel &&
            logisticsTotal(city) >= fraction(logisticsCapacity(stock.config, city.level), npc.upgradeAtBp) &&
            surplus(demand.cityKey, 'wood') >= stock.config.upgrade.wood &&
            cash(demand) >= stock.config.upgrade.gold
          )
            act({ type: 'upgrade', cityKey: demand.cityKey });
        }
        if (source && room(demand.cityKey) > 0) {
          const goods = zero();
          goods[good] = Math.min(desired, room(demand.cityKey));
          if (act({ type: 'dispatch', fromCityKey: source.city.cityKey, toCityKey: demand.cityKey, goods })) continue;
        }
        if (!sold.has(good)) {
          const amount = Math.min(
            deficit(demand, good),
            room(demand.cityKey),
            Math.floor(cash(demand) / stock.config.trade[good].buy),
          );
          if (amount > 0) act({ type: 'trade', cityKey: demand.cityKey, good, side: 'buy', amount });
        }
      }
    }
  }
  if (!successes) return none;
  stock.revision++;
  state.logistics = readLogisticsState(stock, state);
  assertLogisticsConserved(world.logistics!, state.logistics, rows);
  assertNpcFunds(world, state, rows);
  return { state, movements: rows };
}
