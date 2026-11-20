import { cityUpgradeInfo } from '../cityUpgrade/upgrade';
import { castleStyle, cityLandSlots, cityGrade, CITY_LAND } from '@opensamguk/shared';
import { z } from 'zod';
import type { WorldView, WorldState } from '../model/world';
import type { Actor, CommandDef, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import { checkCityGoods, consumeCityGoods } from '../logistics/consumption';
import {
  BUILDINGS,
  buildingSpec,
  BUILDING_KEYS,
  cityLandStateSchema,
  type BuildingKey,
  type LandField,
  type CityLandState,
} from './catalog';

export function readCityLand(world: WorldView): CityLandState {
  const land = cityLandStateSchema.parse(world.campaign?.land ?? { version: 1, cities: {}, managed: {} });
  for (const [key, rows] of Object.entries(land.cities)) {
    const city = world.cities[Number(key)];
    if (!city) throw new Error('건설 거점이 없습니다.');
    const slots = cityLandSlots(city.kind, city.level);
    if (new Set(rows.map((row) => row.slotId)).size !== rows.length) throw new Error('건설 자리가 중복됐습니다.');
    const promotion = world.campaign?.cityUpgrade?.completed[key];
    for (const row of rows) {
      const spec = BUILDINGS.find((spec) => spec.key === row.building)!;
      if (
        !slots.some(
          (slot) => slot.id === row.slotId && (slot.zone === spec.zone || promotion?.outsideSlots.includes(slot.id)),
        ) ||
        (row.remainingTurns > 0 && row.score !== 0)
      )
        throw new Error('건설 자리·점수가 잘못됐습니다.');
      if (
        buildingSpec(row.building).limit &&
        rows.filter((other) => other.building === row.building).length > buildingSpec(row.building).limit!
      )
        throw new Error('건물 개수 상한을 넘었습니다.');
      if (spec.unique && rows.filter((other) => other.building === row.building).length > 1)
        throw new Error('단일 건물이 중복됐습니다.');
    }
  }
  if (
    Object.keys(land.managed).some(
      (key) => !land.cities[key] || new Set(land.managed[key]).size !== land.managed[key]!.length,
    )
  )
    throw new Error('시설 합산 분야가 잘못됐습니다.');
  return land;
}
const military = (key: BuildingKey) => buildingSpec(key).military;
const trap = (key: BuildingKey) => ['fire_seed', 'fire_ball', 'fire_ship', 'rockfall', 'dam'].includes(key);
const distance = (a: { i: number; j: number }, b: { i: number; j: number }) =>
  Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j));
function landTerrain(world: WorldView, cityKey: number) {
  const city = world.cities[cityKey]!;
  const routes =
    world.campaign?.supplyLedger?.routes.filter((route) => route.from === cityKey || route.to === cityKey) ?? [];
  const edges = routes.map((route) =>
    route.from === cityKey
      ? { segment: route.segments[0]!, cell: route.segments[0]!.cells[0]! }
      : { segment: route.segments.at(-1)!, cell: route.segments.at(-1)!.cells.at(-1)! },
  );
  const waterside =
    city.level === 1 ||
    edges.some(
      ({ segment, cell }) =>
        ['RIVER', 'SEA', 'FORD', 'BRIDGE'].includes(segment.mode) ||
        ['RIVER', 'SEA', 'FORD'].includes(cell.terrain ?? ''),
    );
  return {
    waterside,
    sea: edges.some(({ segment }) => segment.mode === 'SEA'),
    mountain: edges.some(({ cell }) => cell.mountain),
  };
}
export function buildingFailure(
  world: WorldView,
  cityKey: number,
  slotId: string,
  building: BuildingKey,
): Failure | null {
  const deny = (message: string): Failure => ({ code: 'BAD_TARGET', message });
  const city = world.cities[cityKey];
  if (!city) return deny('없는 거점입니다.');
  const slots = cityLandSlots(city.kind, city.level),
    slot = slots.find((slot) => slot.id === slotId);
  const spec = buildingSpec(building);
  if (spec.styles && !spec.styles.includes(castleStyle(city))) return deny('이 지역에서만 지을 수 있는 건물입니다.');
  if (!slot || slot.zone !== spec.zone) return deny('성 안팎의 건설 자리가 맞지 않습니다.');
  const rows = readCityLand(world).cities[String(cityKey)] ?? [];
  if (rows.some((row) => row.slotId === slotId)) return deny('이미 건물 또는 공사가 있는 자리입니다.');
  if (spec.unique && rows.some((row) => row.building === building)) return deny('도시당 하나만 지을 수 있습니다.');
  if (spec.limit && rows.filter((row) => row.building === building).length >= spec.limit)
    return deny(`도시당 ${spec.limit}개까지 지을 수 있습니다.`);
  if (
    (building === 'black_market' && rows.some((row) => row.building === 'daewae_market')) ||
    (building === 'daewae_market' && rows.some((row) => row.building === 'black_market'))
  )
    return deny('감시 시장과 암시장은 함께 지을 수 없습니다.');
  if (
    rows.some(
      (row) =>
        ((building === 'sodo' && military(row.building)) || (military(building) && row.building === 'sodo')) &&
        distance(
          slot,
          slots.find((other) => other.id === row.slotId)!,
        ) <= 2,
    )
  )
    return deny('솟대 별읍 둘레 두 칸에는 군사 시설을 지을 수 없습니다.');
  if (building === 'grand_market' && (city.kind === 'PASS' || city.kind === 'FIELD' || city.level < 7))
    return deny('대 이상 도시에만 지을 수 있습니다.');
  if (building === 'bronze_terrace' && city.name !== '업') return deny('동작대는 업에만 지을 수 있습니다.');
  const { waterside, sea, mountain } = landTerrain(world, cityKey);
  const edge = Math.max(...slots.map((slot) => Math.abs(slot.i)));
  if (
    [
      'irrigation',
      'fish_market',
      'shipyard',
      'fire_ship',
      'dam',
      'bridge',
      'ferry',
      'canal_depot',
      'ruxu_dock',
      'net_fishery',
    ].includes(building) &&
    (!waterside || Math.max(Math.abs(slot.i), Math.abs(slot.j)) !== edge)
  )
    return deny('물가 거점의 바깥 가장자리에 지을 수 있습니다.');
  if (
    ['saltworks', 'sea_drying_rack'].includes(building) &&
    (!sea || Math.max(Math.abs(slot.i), Math.abs(slot.j)) !== edge)
  )
    return deny('바닷가 자료가 필요합니다.');
  if (
    ['ironworks', 'rockfall', 'cinnabar_lacquer', 'mountain_forge', 'cliff_stronghold'].includes(building) &&
    !mountain
  )
    return deny('산·구릉 자료가 필요합니다.');
  if (building === 'iron_ingot_forge' && !mountain && !waterside) return deny('산 또는 물가 자료가 필요합니다.');
  if (military(building)) {
    if (slots.some((other) => other.zone === 'inside' && distance(slot, other) <= 2))
      return deny('성·관문 둘레 두 칸에는 군사 시설을 지을 수 없습니다.');
    if (
      !trap(building) &&
      rows.some(
        (row) =>
          military(row.building) &&
          !trap(row.building) &&
          distance(
            slot,
            slots.find((other) => other.id === row.slotId)!,
          ) < 2,
      )
    )
      return deny('군사 시설은 두 칸 간격을 둡니다.');
  }
  return null;
}
export function sumLandCity(state: WorldState, cityKey: number) {
  const rows = state.campaign?.land?.cities[String(cityKey)];
  if (!rows) return;
  const city = state.cities[cityKey]!;
  for (const field of state.campaign!.land!.managed[String(cityKey)] ?? []) {
    const completed = rows.filter(
      (row) => !row.remainingTurns && BUILDINGS.find((spec) => spec.key === row.building)!.field === field,
    );
    for (const row of completed)
      row.score = Math.min(row.score, facilityCapacity(state, cityKey, row.slotId, row.building));
    city[field] = completed.reduce((sum, row) => sum + row.score, 0);
    city[`${field}Max`] =
      (state.campaign?.cityUpgrade?.completed[String(cityKey)]?.increase[field] ?? 0) +
      completed.reduce((sum, row) => sum + facilityCapacity(state, cityKey, row.slotId, row.building), 0);
  }
}
// 내정 효과를 가장 덜 찬 시설부터 채우고 감소 효과도 같은 순서로 분배한다.
export function applyLandScore(state: WorldState, cityKey: number, field: LandField, op: 'set' | 'add', value: number) {
  const rows = state.campaign?.land?.cities[String(cityKey)];
  if (!rows || !state.campaign!.land!.managed[String(cityKey)]?.includes(field)) return false;
  let delta = Math.round(op === 'set' ? value - state.cities[cityKey]![field] : value);
  const matching = rows
    .filter((row) => !row.remainingTurns && BUILDINGS.find((spec) => spec.key === row.building)!.field === field)
    .sort((a, b) => a.score - b.score || a.slotId.localeCompare(b.slotId, 'en'));
  for (const row of matching) {
    const cap = facilityCapacity(state, cityKey, row.slotId, row.building);
    const change = delta >= 0 ? Math.min(delta, cap - row.score) : Math.max(delta, -row.score);
    row.score += change;
    delta -= change;
  }
  sumLandCity(state, cityKey);
  return true;
}
const CAPACITY_SUPPORT: readonly {
  source: BuildingKey;
  targets: readonly BuildingKey[];
  radius: number;
  factor: number;
  group: string;
}[] = [
  { source: 'granary', targets: ['farm', 'dongqiang_field'], radius: 1, factor: 1.5, group: 'storage' },
  { source: 'bugyeong', targets: ['farm'], radius: 1, factor: 1.3, group: 'storage' },
  { source: 'raised_storehouse', targets: ['farm'], radius: 2, factor: 1.5, group: 'storage' },
  { source: 'irrigation', targets: ['farm'], radius: 1, factor: 1.2, group: 'water' },
  { source: 'pond_weir', targets: ['farm'], radius: 1, factor: 1.3, group: 'water' },
  { source: 'mint', targets: ['market', 'border_market'], radius: 1, factor: 1.5, group: 'currency' },
  { source: 'bead_workshop', targets: ['market'], radius: 1, factor: 1.3, group: 'currency' },
  { source: 'silk_loom', targets: ['market'], radius: 1, factor: 1.2, group: 'cloth' },
  { source: 'yue_cloth', targets: ['market'], radius: 1, factor: 1.2, group: 'cloth' },
  { source: 'granary', targets: ['canal_depot'], radius: 1, factor: 1.2, group: 'storage' },
];
export function facilityCapacity(world: WorldView, cityKey: number, slotId: string, building: BuildingKey): number {
  const spec = buildingSpec(building);
  if (building === 'military_farm') {
    const troops =
      (world.campaign?.units
        .filter((unit) => world.generals[unit.commanderId]?.cityKey === cityKey)
        .reduce((sum, unit) => sum + unit.troops, 0) ?? 0) +
      (world.cityResources?.cities[String(cityKey)]?.garrison.reduce((sum, row) => sum + row.troops, 0) ?? 0);
    return Math.min(300, Math.floor(troops / 100));
  }
  const city = world.cities[cityKey]!,
    slots = cityLandSlots(city.kind, city.level),
    slot = slots.find((slot) => slot.id === slotId)!;
  const mountain = landTerrain(world, cityKey).mountain;
  const base = spec.capacity + (mountain ? (building === 'salt_well' ? 30 : building === 'celadon_kiln' ? 20 : 0) : 0);
  const neighbors =
    world.campaign?.land?.cities[String(cityKey)]?.filter((row) => !row.remainingTurns && row.slotId !== slotId) ?? [];
  const nearby = (source: string, radius: number) =>
    neighbors.some(
      (row) =>
        row.building === source &&
        distance(
          slot,
          slots.find((other) => other.id === row.slotId)!,
        ) <= radius,
    );
  const same = ['farm', 'market'].includes(building)
    ? neighbors.filter(
        (row) =>
          row.building === building &&
          distance(
            slot,
            slots.find((other) => other.id === row.slotId)!,
          ) <= 1,
      ).length
    : 0;
  const groups = new Map<string, number>();
  for (const help of CAPACITY_SUPPORT) {
    if (help.targets.includes(building) && nearby(help.source, help.radius))
      groups.set(help.group, Math.max(groups.get(help.group) ?? 1, help.factor));
  }
  return Math.round(base * (same >= 3 ? 1.5 : same >= 1 ? 1.2 : 1) * [...groups.values()].reduce((a, b) => a * b, 1));
}
export function syncLandScores(state: WorldState) {
  for (const [key, fields] of Object.entries(state.campaign?.land?.managed ?? {})) {
    const city = state.cities[Number(key)];
    if (!city) continue;
    for (const field of fields) {
      const rows = state.campaign!.land!.cities[key] ?? [];
      const sum = rows
        .filter((row) => !row.remainingTurns && BUILDINGS.find((spec) => spec.key === row.building)!.field === field)
        .reduce((sum, row) => sum + row.score, 0);
      const current = city[field];
      if (sum !== current) {
        city[field] = sum;
        applyLandScore(state, Number(key), field, 'set', current);
      }
    }
    sumLandCity(state, Number(key));
  }
}
const argsSchema = z.strictObject({ slotId: z.string().min(1).max(32), building: z.enum(BUILDING_KEYS) });
function actorFailure(world: WorldView, actor: Actor): Failure | null {
  const general = world.generals[actor.generalId];
  if (!general || general.removedAt !== undefined) return { code: 'NO_ACTOR', message: '행동할 장수가 없습니다.' };
  if (general.nationId === null || world.cities[general.cityKey]?.nationId !== general.nationId)
    return { code: 'NOT_OWN_CITY', message: '자기 국가 거점에서만 건설할 수 있습니다.' };
  if (!world.cities[general.cityKey]!.supplied) return { code: 'NO_SUPPLY', message: '보급이 끊겼습니다.' };
  if (!world.campaign || !world.logistics) return { code: 'BAD_STATE', message: '건설 원장과 물류가 필요합니다.' };
  return null;
}
export const build: CommandDef<z.infer<typeof argsSchema>> = {
  key: 'build',
  name: '건설',
  target: 'general',
  category: 'domestic',
  args: argsSchema,
  precheck: (world, actor, args) => build.check(world, actor, args),
  check(world, actor, args) {
    const denied = actorFailure(world, actor);
    if (denied) return denied;
    const general = world.generals[actor.generalId]!,
      spec = BUILDINGS.find((spec) => spec.key === args.building)!;
    const failure = buildingFailure(world, general.cityKey, args.slotId, args.building);
    if (failure) return failure;
    if (general.gold < spec.gold) return { code: 'NO_GOLD', message: '금이 부족합니다.' };
    return checkCityGoods(world, general.cityKey, { iron: 0, wood: spec.wood, horses: 0 });
  },
  execute(world, actor, args) {
    const denied = build.check(world, actor, args);
    if (denied) throw new Error(denied.message);
    const state = cloneWorld(world),
      general = state.generals[actor.generalId]!,
      spec = BUILDINGS.find((spec) => spec.key === args.building)!;
    const spent = consumeCityGoods(world, general.cityKey, { iron: 0, wood: spec.wood, horses: 0 });
    if (!spent.ok) throw new Error(spent.message);
    state.logistics = spent.logistics;
    general.gold -= spec.gold;
    state.campaign!.land = readCityLand(world);
    (state.campaign!.land.cities[String(general.cityKey)] ??= []).push({
      slotId: args.slotId,
      building: args.building,
      remainingTurns: spec.turns,
      score: 0,
    });
    const managed = (state.campaign!.land.managed[String(general.cityKey)] ??= []);
    if (spec.field && !managed.includes(spec.field)) managed.push(spec.field);
    sumLandCity(state, general.cityKey);
    return {
      effects: [{ kind: 'world', state }],
      logs: [{ kind: 'success', text: `${spec.name} 공사를 시작했습니다.` }],
    };
  },
};
const demolishArgs = z.strictObject({ slotId: z.string().min(1).max(32) });
export const demolish: CommandDef<z.infer<typeof demolishArgs>> = {
  key: 'demolish',
  name: '철거',
  target: 'general',
  category: 'domestic',
  args: demolishArgs,
  precheck: (world, actor, args) => demolish.check(world, actor, args),
  check(world, actor, args) {
    const denied = actorFailure(world, actor);
    if (denied) return denied;
    return readCityLand(world).cities[String(world.generals[actor.generalId]!.cityKey)]?.some(
      (row) => row.slotId === args.slotId,
    )
      ? null
      : { code: 'BAD_TARGET', message: '철거할 건물이나 공사가 없습니다.' };
  },
  execute(world, actor, args) {
    const denied = demolish.check(world, actor, args);
    if (denied) throw new Error(denied.message);
    const state = cloneWorld(world),
      key = state.generals[actor.generalId]!.cityKey;
    state.campaign!.land = readCityLand(world);
    const removed = state.campaign!.land.cities[String(key)]!.find((row) => row.slotId === args.slotId)!;
    if (!removed.remainingTurns) {
      state.cities[key]!.populationMax = Math.max(
        0,
        state.cities[key]!.populationMax - (buildingSpec(removed.building).population ?? 0),
      );
      state.cities[key]!.population = Math.min(state.cities[key]!.population, state.cities[key]!.populationMax);
    }
    state.campaign!.land.cities[String(key)] = state.campaign!.land.cities[String(key)]!.filter(
      (row) => row.slotId !== args.slotId,
    );
    sumLandCity(state, key);
    return {
      effects: [{ kind: 'world', state }],
      logs: [{ kind: 'success', text: '건물을 철거했습니다. 자원은 돌려주지 않습니다.' }],
    };
  },
};
export function cityLandInfo(world: WorldView, cityKey: number, actor: Actor) {
  const city = world.cities[cityKey]!,
    rows = readCityLand(world).cities[String(cityKey)] ?? [];
  const grade = cityGrade(city.kind, city.level);
  return {
    cityKey,
    upgrade: cityUpgradeInfo(world, cityKey, actor),
    style: castleStyle(city),
    grade,
    core: grade ? CITY_LAND[grade].core : 0,
    slots: cityLandSlots(city.kind, city.level).map((slot) => ({
      ...slot,
      building: rows.find((row) => row.slotId === slot.id) ?? null,
      capacity: rows.some((row) => row.slotId === slot.id)
        ? facilityCapacity(world, cityKey, slot.id, rows.find((row) => row.slotId === slot.id)!.building)
        : null,
    })),
    buildings: BUILDINGS.filter(
      (spec) => !buildingSpec(spec.key).styles || buildingSpec(spec.key).styles!.includes(castleStyle(city)),
    ).map((spec) => ({
      ...spec,
      style: castleStyle(city),
      slots: cityLandSlots(city.kind, city.level)
        .filter((slot) => slot.zone === spec.zone)
        .map((slot) => ({
          slotId: slot.id,
          capacity: facilityCapacity(world, cityKey, slot.id, spec.key),
          failure:
            actorFailure(world, actor) ??
            buildingFailure(world, cityKey, slot.id, spec.key) ??
            (world.generals[actor.generalId]!.gold < spec.gold
              ? { code: 'NO_GOLD', message: '금이 부족합니다.' }
              : checkCityGoods(world, cityKey, { iron: 0, wood: spec.wood, horses: 0 })),
        })),
    })),
  };
}
