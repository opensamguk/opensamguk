// core2026 df6c926 nation/che_증축·che_감축, MIT © 2025 devsam (resources/NOTICE.md).
// AC-INT-30 / D-109: 모든 자기 도시·경까지, 금만 소비·환급하며 같은 예턴 다섯 칸째 실행한다.
import { buildingSpec, type BuildingKey, LAND_FIELDS } from '../construction/catalog';
import { applyLandScore, sumLandCity } from '../construction/land';
import { cityGrade, cityLandSlots } from '@opensamguk/shared';
import { z } from 'zod';
import { BALANCE } from '../balance';
import type { Actor, CommandDef, Failure } from '../commands/types';
import type { WorldView, WorldState } from '../model/world';
import type { QueuedTurn } from '../replay';
import { cloneWorld } from '../model/clone';
import { CITY_SCALE_FIELDS } from '../world/map/cityScale';
import { refreshSupply } from '../supply';
import { withPrepare } from '../preparedTurns/withPrepare';
import { CITY_CHANGING_COMMANDS } from '../commands/movement';

export const CITY_UPGRADE_RULES = Object.freeze({
  turns: 5,
  baseGold: 0, // 원작 reservedTurnCommands의 DEFAULT_BASE_GOLD.
  cost: BALANCE.DEVEL_COST * 500 + 60000,
  refund: BALANCE.DEVEL_COST * 500 + 30000,
  increase: { population: 100000, agriculture: 2000, commerce: 2000, security: 2000, defence: 2000, wall: 2000 },
});
export type CityResize = { cityKey: number; fromLevel: number; nextLevel: number };
export function canExecuteCityUpgradeCommand(_view: object, level: number, key: string) {
  return Number.isInteger(level) && level >= 5 && level <= 12 && ['nation_expand', 'nation_shrink'].includes(key);
}
export function shiftedLandSlot(slotId: string, from: number, to: number) {
  const a = cityLandSlots('CITY', from)[0]!,
    b = cityLandSlots('CITY', to)[0]!;
  const delta = Number.isInteger(a.i) === Number.isInteger(b.i) ? 0 : to > from ? 0.5 : -0.5;
  const [i, j] = slotId.split(',').map(Number);
  if (!Number.isFinite(i) || !Number.isFinite(j)) throw new Error('영지 칸 좌표가 잘못됐습니다.');
  return `${i! + delta},${j! + delta}`;
}
export function shiftCityLandTurns<T extends QueuedTurn>(queue: T[], change: CityResize): boolean {
  const oldSlots = new Set(cityLandSlots('CITY', change.fromLevel).map((slot) => slot.id));
  let changed = false;
  for (const turn of queue) {
    if (CITY_CHANGING_COMMANDS.has(turn.commandKey)) break;
    if (!['build', 'demolish'].includes(turn.commandKey) || !turn.args || typeof turn.args !== 'object') continue;
    const args = turn.args as Record<string, unknown>;
    if (typeof args.slotId !== 'string' || !oldSlots.has(args.slotId)) continue;
    const slotId = shiftedLandSlot(args.slotId, change.fromLevel, change.nextLevel);
    if (slotId === args.slotId) continue;
    turn.args = { ...args, slotId };
    changed = true;
  }
  return changed;
}
export function cityUpgradeInfo(world: WorldView, cityKey: number, actor: Actor) {
  const city = world.cities[cityKey],
    upgrade = world.campaign?.cityUpgrade;
  const general = world.generals[actor.generalId];
  const isChief =
    !!general &&
    general.removedAt === undefined &&
    canExecuteCityUpgradeCommand(world, general.officerLevel, 'nation_expand');
  const nationId = general?.nationId;
  const nation = nationId == null ? undefined : world.nations[nationId];
  const originalLevel = upgrade?.originalLevels[String(cityKey)];
  const eligible = !!city && !['PASS', 'PORT', 'FIELD'].includes(city.kind ?? '') && city.level > 0;
  const nextLevel = eligible && city.level < 9 ? Math.max(5, city.level + 1) : null;
  const previousLevel =
    eligible && originalLevel !== undefined && city.level > Math.max(4, originalLevel)
      ? city.level === 5
        ? originalLevel
        : city.level - 1
      : null;
  const demolished: { slotId: string; building: BuildingKey }[] = [];
  if (previousLevel !== null) {
    const slots = new Set(cityLandSlots('CITY', previousLevel).map((slot) => slot.id));
    for (const row of world.campaign?.land?.cities[String(cityKey)] ?? [])
      if (!slots.has(shiftedLandSlot(row.slotId, city!.level, previousLevel)))
        demolished.push({ slotId: row.slotId, building: row.building });
  }
  const common = (): Failure | null => {
    if (!upgrade?.enabled) return { code: 'COMMAND_DISABLED', message: '이 월드는 증축과 감축을 쓰지 않습니다.' };
    if (!general || general.removedAt !== undefined) return { code: 'NO_ACTOR', message: '행동할 장수가 없습니다.' };
    if (!nation) return { code: 'NOT_NATION', message: '국가에 소속되어야 합니다.' };
    if (!isChief) return { code: 'NOT_RULER', message: '수뇌만 증축과 감축을 할 수 있습니다.' };
    if (!eligible) return { code: 'BAD_TARGET', message: '증축하거나 감축할 수 없는 거점입니다.' };
    if (city!.nationId !== nationId)
      return { code: 'NOT_OWN_CITY', message: '자기 국가 도시만 증축하거나 감축할 수 있습니다.' };
    if (!city!.supplied) return { code: 'NO_SUPPLY', message: '보급이 끊긴 도시입니다.' };
    if (world.cityRuins?.cities.some((row) => row.cityKey === cityKey))
      return { code: 'BAD_STATE', message: '폐허를 복구한 뒤 증축하거나 감축할 수 있습니다.' };
    return null;
  };
  let expandFailure = common(),
    shrinkFailure = common();
  if (!expandFailure && nextLevel === null) expandFailure = { code: 'AT_MAX', message: '더 이상 증축할 수 없습니다.' };
  if (!expandFailure && nation!.gold < CITY_UPGRADE_RULES.baseGold + CITY_UPGRADE_RULES.cost)
    expandFailure = { code: 'NO_GOLD', message: '증축할 국고 금이 부족합니다.' };
  if (
    !expandFailure &&
    CITY_SCALE_FIELDS.some((field) => city![`${field}Max`] + CITY_UPGRADE_RULES.increase[field] > 2_147_483_647)
  )
    expandFailure = { code: 'BAD_STATE', message: '증축 최대치가 저장 범위를 벗어납니다.' };
  if (!shrinkFailure && previousLevel === null)
    shrinkFailure = { code: 'BAD_TARGET', message: '지도 원래 규모보다 작게 감축할 수 없습니다.' };
  if (!shrinkFailure && nation!.gold + CITY_UPGRADE_RULES.refund > 2_147_483_647)
    shrinkFailure = { code: 'BAD_STATE', message: '감축 환급금이 저장 범위를 벗어납니다.' };
  const preparing = Object.entries(world.preparedTurns?.nations[city?.nationId ?? 0] ?? {}).flatMap(
    ([level, record]) => {
      const args = record.args;
      return ['nation_expand', 'nation_shrink'].includes(record.commandKey) &&
        args &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        'cityKey' in args &&
        args.cityKey === cityKey
        ? [
            {
              commandKey: record.commandKey,
              officerLevel: Number(level),
              remainingTurns: Math.max(0, CITY_UPGRADE_RULES.turns - record.term),
            },
          ]
        : [];
    },
  );
  return {
    enabled: upgrade?.enabled === true,
    isChief,
    turns: CITY_UPGRADE_RULES.turns,
    expand: {
      nextLevel,
      nextGrade: nextLevel === null ? null : cityGrade('CITY', nextLevel),
      cost: CITY_UPGRADE_RULES.cost,
      canStart: expandFailure === null,
      failure: expandFailure,
    },
    shrink: {
      previousLevel,
      previousGrade: previousLevel === null ? null : cityGrade('CITY', previousLevel),
      refund: CITY_UPGRADE_RULES.refund,
      canStart: shrinkFailure === null,
      failure: shrinkFailure,
      demolished,
    },
    preparing,
  };
}
const args = z.strictObject({ cityKey: z.number().int().positive().max(2_147_483_647) });
function defineResize(commandKey: 'nation_expand' | 'nation_shrink'): CommandDef {
  const expanding = commandKey === 'nation_expand',
    name = expanding ? '증축' : '감축';
  const check = (world: WorldView, actor: Actor, raw: unknown) => {
    const input = args.parse(raw),
      info = cityUpgradeInfo(world, input.cityKey, actor);
    return expanding ? info.expand.failure : info.shrink.failure;
  };
  const prepared = withPrepare(
    {
      key: commandKey,
      name,
      target: 'nation',
      category: 'nation',
      args,
      precheck: check,
      check,
      execute(world, actor, raw) {
        const input = args.parse(raw),
          denied = check(world, actor, input);
        if (denied) throw new Error(denied.message);
        const state = cloneWorld(world),
          city = state.cities[input.cityKey]!;
        const info = cityUpgradeInfo(world, input.cityKey, actor);
        const nextLevel = expanding ? info.expand.nextLevel! : info.shrink.previousLevel!;
        const cityResize = { cityKey: input.cityKey, fromLevel: city.level, nextLevel };
        completeCityUpgrade(state, input.cityKey, nextLevel);
        const nation = state.nations[state.generals[actor.generalId]!.nationId!]!;
        nation.gold += expanding ? -CITY_UPGRADE_RULES.cost : CITY_UPGRADE_RULES.refund;
        const text = `${city.name} ${name} 완료`;
        return {
          effects: [{ kind: 'world', state }],
          cityResize,
          logs: [{ kind: 'success', text }],
          history: [{ nationId: nation.id, text }],
        };
      },
    },
    { preReqTurn: CITY_UPGRADE_RULES.turns - 1 },
  );
  return {
    ...prepared,
    check(world, actor, raw) {
      const input = args.parse(raw),
        general = world.generals[actor.generalId],
        record = world.preparedTurns?.nations[general?.nationId ?? 0]?.[general?.officerLevel ?? 0];
      if (
        record?.commandKey === commandKey &&
        record.term >= CITY_UPGRADE_RULES.turns - 1 &&
        record.args &&
        typeof record.args === 'object' &&
        !Array.isArray(record.args) &&
        'cityKey' in record.args &&
        record.args.cityKey === input.cityKey &&
        record.cityLevel !== undefined &&
        world.cities[input.cityKey]?.level !== record.cityLevel
      )
        return { code: 'BAD_STATE', message: '준비하는 동안 이 도시 규모가 바뀌었습니다.', clearPreparation: true };
      return check(world, actor, input);
    },
    execute(world, actor, raw, rng) {
      const input = args.parse(raw),
        general = world.generals[actor.generalId]!,
        previous = world.preparedTurns?.nations[general.nationId!]?.[general.officerLevel],
        result = prepared.execute(world, actor, input, rng);
      for (const effect of result.effects) {
        if (effect.kind !== 'world') continue;
        const record = effect.state.preparedTurns?.nations[general.nationId!]?.[general.officerLevel];
        if (record)
          record.cityLevel =
            record.term > 1
              ? (previous?.cityLevel ?? world.cities[input.cityKey]!.level)
              : world.cities[input.cityKey]!.level;
      }
      return result;
    },
  };
}
export const cityUpgradeCommands = [defineResize('nation_expand'), defineResize('nation_shrink')];

export function completeCityUpgrade(state: WorldState, cityKey: number, nextLevel: number) {
  const city = state.cities[cityKey]!,
    from = city.level,
    upgrade = state.campaign!.cityUpgrade!;
  const direction = nextLevel > from ? 1 : -1;
  const increase = CITY_UPGRADE_RULES.increase;
  const old = upgrade.completed[String(cityKey)];
  for (const field of CITY_SCALE_FIELDS) {
    city[`${field}Max`] = Math.max(0, city[`${field}Max`] + direction * increase[field]);
    if (direction < 0) city[field] = Math.max(field === 'population' ? 30000 : 0, city[field] - increase[field]);
  }
  const slots = cityLandSlots(city.kind, nextLevel),
    retainedSlots: string[] = [];
  const land = state.campaign!.land,
    rows = land?.cities[String(cityKey)];
  if (rows) {
    land!.cities[String(cityKey)] = rows.filter((row) => {
      row.slotId = shiftedLandSlot(row.slotId, from, nextLevel);
      const slot = slots.find((slot) => slot.id === row.slotId);
      if (!slot) {
        if (!row.remainingTurns)
          city.populationMax = Math.max(0, city.populationMax - (buildingSpec(row.building).population ?? 0));
        return false;
      }
      if (buildingSpec(row.building).zone !== slot.zone) retainedSlots.push(row.slotId);
      return true;
    });
  }
  if (direction < 0) city.population = Math.max(30000, Math.min(city.population, city.populationMax));
  upgrade.completed[String(cityKey)] = {
    outsideSlots: retainedSlots,
    fromLevel: upgrade.originalLevels[String(cityKey)]!,
    level: nextLevel,
    increase: Object.fromEntries(
      CITY_SCALE_FIELDS.map((field) => [field, (old?.increase[field] ?? 0) + direction * increase[field]]),
    ) as typeof increase,
  };
  city.level = nextLevel;
  if (from < 5 && nextLevel >= 5) {
    // 상태 없는 옛 도시는 저장 읽기와 같이 소속 키도 생략한다.
    if (city.state == null) delete city.parentCityKey;
    else city.parentCityKey = null;
  }
  if (direction < 0 && rows) {
    const current = Object.fromEntries(LAND_FIELDS.map((field) => [field, city[field]]));
    sumLandCity(state, cityKey);
    for (const field of LAND_FIELDS)
      applyLandScore(state, cityKey, field, 'set', Math.min(city[field], current[field]!));
  }
  refreshSupply(state);
}
