import type { PresetRules } from './preset';
import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import { mapSchema, portraitMapSchema, scenarioSchema, statRulesSchema, unitSetSchema } from './resources';
import type { StatRules, UnitSetResource } from './resources';
import type { WorldState, WorldExt } from '../model/world';
import { operationalMapSchema, type OperationalMapResource } from './map/operational';
import { operationalAnchors } from './map/anchors';
import { validateMap } from './validate/map';

export interface InitialCity {
  kind?: 'CITY' | 'PASS';
  cityKey: number;
  name: string;
  level: number;
  region: number;
  x: number;
  y: number;
  connections: number[];
  nationId: number | null;
  population: number;
  populationMax: number;
  agriculture: number;
  agricultureMax: number;
  commerce: number;
  commerceMax: number;
  security: number;
  securityMax: number;
  defence: number;
  defenceMax: number;
  wall: number;
  wallMax: number;
  trust: number;
  supplied: boolean;
}

export interface InitialNation {
  id: number;
  name: string;
  color: string;
  gold: number;
  rice: number;
  description: string;
  tech: number;
  philosophy: string;
  level: number;
  capitalCityKey: number;
  isNpc: boolean;
}

export interface InitialGeneral {
  id: number;
  userId: string | null;
  affinity: number;
  name: string;
  portraitId: number | null;
  nationId: number | null;
  cityKey: number;
  leadership: number;
  strength: number;
  intel: number;
  politics?: number;
  charm?: number;
  officerLevel: number;
  birthYear: number;
  deathYear: number;
  activeFromYear: number;
  personality: string | null;
  special: string | null;
  gold: number;
  rice: number;
  crew: number;
  crewType: number;
  train: number;
  atmos: number;
  experience: number;
  dedication: number;
  age: number;
  injury: number;
  nextTurnTick: number;
}

export interface InitialDiplomacy {
  nationA: number;
  nationB: number;
  state: 'WAR' | 'DECLARED' | 'NON_AGGRESSION';
  untilTick: number;
}

export interface WorldInit {
  operationalMap?: OperationalMapResource;
  presetRules?: PresetRules;
  ruleFeatures?: string[];
  ext?: WorldExt;
  commandMeta?: WorldState['commandMeta'];
  nationTurns?: WorldState['nationTurns'];
  seed: string;
  scenarioKey: string;
  mapKey: string;
  unitSetKey: string;
  startYear: number;
  statRules: StatRules;
  unitSet: UnitSetResource;
  cities: InitialCity[];
  nations: InitialNation[];
  generals: InitialGeneral[];
  diplomacies: InitialDiplomacy[];
}

export function buildInitialWorld(input: {
  map: unknown;
  scenario: unknown;
  unitSet: unknown;
  statRules: unknown;
  seed: string;
  portraitMap?: unknown;
}): WorldInit {
  if (typeof input.seed !== 'string' || input.seed.length === 0) throw new Error('시드가 비어 있습니다.');
  const operational =
    typeof input.map === 'object' && input.map !== null && 'version' in input.map && input.map.version === 3
      ? operationalMapSchema.parse(input.map)
      : undefined;
  if (operational && validateMap(operational, { scenarios: [] }).status !== 'pass')
    throw new Error('운영 지도의 연결망을 확인하세요.');
  const map = operational ? { ...operational, cities: operationalAnchors(operational) } : mapSchema.parse(input.map);
  const scenario = scenarioSchema.parse(input.scenario);
  const unitSet = unitSetSchema.parse(input.unitSet);
  const statRules = statRulesSchema.parse(input.statRules).stat;
  const five = statRules.count === 5;
  if (operational && !five) throw new Error('운영 지도는 5능력치 프로필이 필요합니다.');
  const historicalStats = new Map(scenario.generalStats?.map((row) => [row.generalId, row]));
  if (
    five
      ? historicalStats.size !== scenario.general.length ||
        historicalStats.size !== scenario.generalStats?.length ||
        [...historicalStats.keys()].some((id) => id > scenario.general.length)
      : scenario.generalStats !== undefined
  )
    throw new Error('시나리오의 5능력치 인물·출처 대응을 확인하세요.');
  const portraits = portraitMapSchema.parse(input.portraitMap ?? { portraits: {} }).portraits;
  const mapCities = [...map.cities].sort((a, b) => a.id - b.id);
  const byId = new Map(mapCities.map((city) => [city.id, city]));
  const byName = new Map(mapCities.map((city) => [city.name, city]));
  if (byId.size !== mapCities.length || byName.size !== mapCities.length)
    throw new Error('도시 ID 또는 이름이 중복됩니다.');

  for (const city of mapCities) {
    if (new Set(city.connections).size !== city.connections.length) throw new Error(`${city.name}: 연결이 중복됩니다.`);
    for (const connection of city.connections) {
      const other = byId.get(connection);
      if (!other || connection === city.id || (!operational && !other.connections.includes(city.id))) {
        throw new Error(`${city.name} ↔ ${connection}: 연결은 존재하는 다른 도시와 양방향이어야 합니다.`);
      }
    }
    for (const field of ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const) {
      if (city.initial[field] > city.max[field]) throw new Error(`${city.name}: ${field} 초기값이 최대치를 넘습니다.`);
    }
  }
  const unitIds = new Set(unitSet.crewTypes.map((unit) => unit.id));
  if (unitIds.size !== unitSet.crewTypes.length || !unitIds.has(unitSet.defaultCrewTypeId)) {
    throw new Error('병종 ID가 중복되거나 기본 병종이 없습니다.');
  }

  const ownerByCity = new Map<number, number>();
  const ownedCities = new Map<number, number[]>();
  const nations: InitialNation[] = scenario.nation.map((row, i) => {
    const [name, color, gold, rice, description, tech, philosophy, level, cityNames] = row;
    const id = i + 1;
    const cityKeys = cityNames.map((cityName) => {
      const city = byName.get(cityName);
      if (!city) throw new Error(`${name}: 지도에 없는 도시 ${cityName}`);
      if (ownerByCity.has(city.id)) throw new Error(`${cityName}: 도시 소유 국가가 중복됩니다.`);
      ownerByCity.set(city.id, id);
      return city.id;
    });
    if (operational && !mapCities.some((city) => city.name === cityNames[0] && 'kind' in city && city.kind === 'CITY'))
      throw new Error(`${name}: 수도는 도시여야 합니다.`);
    ownedCities.set(id, cityKeys);
    return {
      id,
      name,
      color,
      gold,
      rice,
      description,
      tech,
      philosophy,
      level,
      capitalCityKey: cityKeys[0]!,
      isNpc: true,
    };
  });

  const cities: InitialCity[] = mapCities.map((city) => ({
    ...(operational
      ? {
          kind: operational.sites.find((site) => 'anchorKey' in site && site.anchorKey === city.id)!.kind as
            'CITY' | 'PASS',
        }
      : {}),
    cityKey: city.id,
    name: city.name,
    level: city.level,
    region: city.region,
    x: city.position.x,
    y: city.position.y,
    connections: [...city.connections].sort((a, b) => a - b),
    nationId: ownerByCity.get(city.id) ?? null,
    population: city.initial.population,
    populationMax: city.max.population,
    agriculture: city.initial.agriculture,
    agricultureMax: city.max.agriculture,
    commerce: city.initial.commerce,
    commerceMax: city.max.commerce,
    security: city.initial.security,
    securityMax: city.max.security,
    defence: city.initial.defence,
    defenceMax: city.max.defence,
    wall: city.initial.wall,
    wallMax: city.max.wall,
    trust: map.defaults.trust,
    supplied: map.defaults.supplyState === 1,
  }));

  // 배치만 bootstrap 스트림을 소비한다. DB ID·시각은 규칙 상태에 넣지 않는다.
  const rng = rngFor(input.seed, 'bootstrap');
  const allCities = cities.filter((city) => city.kind !== 'PASS').map((city) => city.cityKey);
  const generals: InitialGeneral[] = scenario.general.map((row, i) => {
    const [
      affinity,
      name,
      ,
      nationNumber,
      cityName,
      leadership,
      strength,
      intel,
      officerLevel,
      birthYear,
      deathYear,
      personality,
      special,
    ] = row;
    const nationId = nationNumber === 0 ? null : nationNumber;
    if (nationId !== null && !ownedCities.has(nationId)) throw new Error(`${name}: 없는 국가 ${nationId}`);
    if (birthYear > deathYear) throw new Error(`${name}: 생년이 몰년보다 늦습니다.`);
    const explicitCity = cityName === null ? undefined : byName.get(cityName);
    if (cityName !== null && !explicitCity) throw new Error(`${name}: 지도에 없는 도시 ${cityName}`);
    const cityKey = explicitCity?.id ?? rng.pick(nationId === null ? allCities : ownedCities.get(nationId)!);
    return {
      id: i + 1,
      userId: null,
      affinity,
      name,
      portraitId: Object.hasOwn(portraits, name) ? portraits[name]! : null,
      nationId,
      cityKey,
      leadership,
      strength,
      intel,
      officerLevel,
      birthYear,
      deathYear,
      activeFromYear: birthYear + 15,
      personality,
      special,
      // core2026 df6c926 bootstrap의 초기 금·쌀을 참고. resources/NOTICE.md.
      gold: 1000,
      rice: 1000,
      crew: 0,
      crewType: unitSet.defaultCrewTypeId,
      train: 0,
      atmos: 0,
      experience: 0,
      dedication: 0,
      age: Math.max(0, scenario.startYear - birthYear),
      injury: 0,
      nextTurnTick: rngFor(input.seed, 'turn-offset', i + 1).int(0, TICKS_PER_MONTH - 1),
      ...(five ? historicalStats.get(i + 1)!.stats : {}),
    };
  });

  const diplomacyByPair = new Map<string, InitialDiplomacy>();
  for (const [a, b, kind, months] of scenario.diplomacy) {
    if (a === b || !ownedCities.has(a) || !ownedCities.has(b))
      throw new Error(`외교 국가 쌍이 올바르지 않습니다: ${a}, ${b}`);
    const nationA = Math.min(a, b);
    const nationB = Math.max(a, b);
    diplomacyByPair.set(`${nationA}:${nationB}`, {
      nationA,
      nationB,
      state: kind === 0 ? 'WAR' : kind === 1 ? 'DECLARED' : 'NON_AGGRESSION',
      untilTick: months * TICKS_PER_MONTH,
    });
  }
  return {
    ...(five || operational
      ? { ruleFeatures: [...(five ? ['five-stats'] : []), ...(operational ? ['operational-map'] : [])] }
      : {}),
    ...(operational ? { operationalMap: operational } : {}),
    seed: input.seed,
    scenarioKey: scenario.id,
    mapKey: map.id,
    unitSetKey: unitSet.id,
    startYear: scenario.startYear,
    statRules,
    unitSet,
    cities,
    nations,
    generals,
    diplomacies: [...diplomacyByPair.values()].sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB),
  };
}
