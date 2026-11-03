import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import { generalCreationSchema } from '../general/create';
import { assertGeneralStatProfile, FIVE_STAT_KEYS } from '../general/fiveStats';
import { monthlyDate } from '../monthly';
import type { WorldView } from '../model/world';
import type { InitialGeneral, WorldInit } from '../world/bootstrap';
import { LINEAGE_MAX } from './config';
import { lineageActive, lineageAge, lineageFail } from './eligibility';
import { emptyLineagePerson } from './state';

export type LineageResources = {
  statRules: WorldInit['statRules'];
  unitSet: Pick<WorldInit['unitSet'], 'defaultCrewTypeId'>;
};

export function lineageBirthEligibility(world: WorldView, marriageId: number, tick: number) {
  const state = world.lineage,
    marriage = state?.marriages.find((row) => row.id === marriageId);
  if (!state || !marriage) return lineageFail('BAD_MARRIAGE', '현재 혼인을 확인하세요.');
  if (![marriage.a, marriage.b].every((id) => lineageActive(world, id, tick)))
    return lineageFail('BAD_TARGET', '생존한 부모 둘이 필요합니다.');
  const a = world.generals[marriage.a]!,
    b = world.generals[marriage.b]!;
  if (!a.sex || !b.sex || a.sex === 'UNKNOWN' || b.sex === 'UNKNOWN' || a.sex === b.sex)
    return lineageFail('SEX_PAIR', '자료가 확인된 남녀 부모가 필요합니다.');
  const { minParentAge, maxParentAge } = state.config.birth;
  if (
    [a.id, b.id].some((id) => lineageAge(world, id, tick) < minParentAge || lineageAge(world, id, tick) > maxParentAge)
  )
    return lineageFail('AGE', '출생을 위한 부모 나이 조건에 맞지 않습니다.');
  return null;
}

// 새 장수를 만들기만 한다. 등록·예약 칸·월 원장 저장은 정산 호출자가 같은 트랜잭션에서 맡는다.
export function generateLineageChild(world: WorldView, marriageId: number, tick: number, resources: LineageResources) {
  const denied = lineageBirthEligibility(world, marriageId, tick);
  if (denied) return denied;
  const state = world.lineage!,
    config = state.config.birth;
  const marriage = state.marriages.find((row) => row.id === marriageId)!;
  const host = world.generals[marriage.householdGeneralId]!;
  const other = world.generals[marriage.a === host.id ? marriage.b : marriage.a]!;
  const generals = Object.values(world.generals);
  const id = Math.max(0, ...generals.map((general) => general.id)) + 1;
  if (generals.length >= state.config.limits.maxGenerals || id > LINEAGE_MAX)
    return lineageFail('LIMIT', '가문 인원·장수 번호 상한에 닿았습니다.');
  const { year } = monthlyDate(world.startYear, tick);
  if (year > LINEAGE_MAX - Math.max(config.lifespan.max, config.comingOfAgeYears))
    return lineageFail('LIMIT', '장수의 등장·수명 연도 상한에 닿았습니다.');
  const five = resources.statRules.count === 5;
  assertGeneralStatProfile(host, five);
  assertGeneralStatProfile(other, five);
  const rng = rngFor(state.seed, 'lineage-child', id);
  const keys = five ? FIVE_STAT_KEYS : FIVE_STAT_KEYS.slice(0, 3);
  const stats: Partial<Record<(typeof FIVE_STAT_KEYS)[number], number>> = {};
  for (const key of keys)
    stats[key] = Math.max(
      resources.statRules.min,
      Math.min(
        resources.statRules.max,
        Math.round((host[key]! + other[key]!) / 2) + rng.int(-config.statSpread, config.statSpread),
      ),
    );
  const deathYear = year + rng.int(config.lifespan.min, config.lifespan.max);
  const start = rng.int(0, config.givenNames.length - 1);
  const surname =
    [...config.compoundSurnames]
      .sort((a, b) => [...b].length - [...a].length)
      .find((value) => host.name.startsWith(value)) ?? [...host.name][0]!;
  const usedNames = new Set(generals.map((general) => general.name));
  let name: string | undefined;
  for (let offset = 0; offset < config.givenNames.length; offset++) {
    const parsed = generalCreationSchema.shape.name.safeParse(
      surname + config.givenNames[(start + offset) % config.givenNames.length]!,
    );
    if (parsed.success && !usedNames.has(parsed.data)) {
      name = parsed.data;
      break;
    }
  }
  if (name === undefined) return lineageFail('NAME_EXHAUSTED', '사용할 수 있는 자녀 이름 후보가 없습니다.');
  const sex = rngFor(state.seed, 'lineage-child-sex', id).int(0, 9999) < config.femaleBp ? 'FEMALE' : 'MALE';
  const general: InitialGeneral = {
    id,
    userId: null,
    name,
    sex,
    portraitId: null,
    nationId: host.nationId,
    cityKey: host.cityKey,
    affinity: Math.max(1, Math.min(150, Math.round((host.affinity + other.affinity) / 2))),
    leadership: stats.leadership!,
    strength: stats.strength!,
    intel: stats.intel!,
    ...(five ? { politics: stats.politics!, charm: stats.charm! } : {}),
    officerLevel: host.nationId === null ? 0 : 1,
    birthYear: year,
    deathYear,
    activeFromYear: year + config.comingOfAgeYears,
    personality: null,
    special: null,
    gold: 0,
    rice: 0,
    crew: 0,
    crewType: resources.unitSet.defaultCrewTypeId,
    train: 0,
    atmos: 0,
    experience: 0,
    dedication: 0,
    age: 0,
    injury: 0,
    nextTurnTick: tick + rngFor(state.seed, 'turn-offset', id).int(0, TICKS_PER_MONTH - 1),
  };
  return {
    ok: true as const,
    general,
    person: { ...emptyLineagePerson(), parents: [host.id, other.id] as [number, number], bornTick: tick },
    source: `lineage:${tick}#general:${id}`,
  };
}
