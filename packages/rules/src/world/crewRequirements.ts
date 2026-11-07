import { TICKS_PER_MONTH } from '../clock/constants';
import type { Actor, Failure } from '../commands/types';
import type { DeepReadonly, WorldView } from '../model/world';
import { canUseNationTurns } from '../personnel/permissions';
import { readNationResearch } from '../nationResearch/state';
import type { UnitSetResource } from './resources';
import { LEGACY_CHE_REGION_NAMES } from './crewRegions';

const provinces = [
  '',
  '사예',
  '예주',
  '기주',
  '연주',
  '서주',
  '청주',
  '형주',
  '양주',
  '익주',
  '남중',
  '양주(涼州)',
  '병주',
  '유주',
  '교주',
  '동이',
  '이민족',
];
const researchNames = {
  greatsword: '대검병',
  halberd: '극병',
  fire_arrow: '화시병',
  repeater: '원융노병',
  mountain: '산저병',
  elephant: '상병',
  fire_wheel: '화륜차',
};
export interface CrewContext {
  nation: { id: number; tech: number } | null;
  ownedCities: readonly { cityKey: number; region: number; level: number }[];
  cityNames: Readonly<Record<number, string>>;
  year: number;
  startYear: number;
  research: readonly string[];
  scorch: number;
  isChief: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('병종 조건의 확장 상태를 확인하세요.');
  return value as Record<string, unknown>;
}

export function crewContext(view: WorldView, actor: Pick<Actor, 'generalId' | 'tick'>): CrewContext {
  const general = view.generals[actor.generalId];
  const nation = general?.nationId == null ? undefined : view.nations[general.nationId];
  const key = String(nation?.id);
  const research = readNationResearch(view.nationResearch, view)?.nations[Number(key)] ?? [];
  const scorch = record(record(view.ext?.nation_scorch).specialScorch)[key] ?? 0;
  if (
    !Array.isArray(research) ||
    !research.every((name) => typeof name === 'string') ||
    typeof scorch !== 'number' ||
    !Number.isSafeInteger(scorch) ||
    scorch < 0
  )
    throw new Error('병종 조건의 국가 연구·초토화 상태를 확인하세요.');
  const cities = Object.values(view.cities);
  return {
    nation: nation ? { id: nation.id, tech: nation.tech } : null,
    ownedCities: nation ? cities.filter((city) => city.nationId === nation.id) : [],
    cityNames: Object.fromEntries(cities.map((city) => [city.cityKey, city.name])),
    year: view.startYear + Math.floor((actor.tick ?? 0) / (12 * TICKS_PER_MONTH)),
    startYear: view.startYear,
    research,
    scorch,
    isChief: !!nation && canUseNationTurns(general?.officerLevel),
  };
}

// 조건 순서가 곧 첫 실패 이유의 순서다. 기존 병력의 배속·훈련은 이 검사를 부르지 않는다.
export function crewTypeFailure(
  unit: Pick<DeepReadonly<UnitSetResource['crewTypes'][number]>, 'requirements'>,
  context: CrewContext,
): (Failure & { code: 'BAD_STATE' }) | null {
  const cityNames = (keys: readonly number[]) => keys.map((key) => context.cityNames[key] ?? `도시 ${key}`).join('·');
  for (const requirement of unit.requirements ?? []) {
    let reason: string | null = null;
    switch (requirement.kind) {
      case 'impossible':
        reason = '모집할 수 없는 병종입니다.';
        break;
      case 'tech':
        if (!context.nation || context.nation.tech < requirement.min) reason = `기술 ${requirement.min}이 필요합니다.`;
        break;
      case 'regions':
      case 'legacyCheRegions': {
        if (!context.ownedCities.some((city) => requirement.regions.includes(city.region))) {
          const names =
            requirement.kind === 'legacyCheRegions'
              ? requirement.regions.map((region) => LEGACY_CHE_REGION_NAMES[region])
              : (requirement.names ?? requirement.regions.map((region) => provinces[region]));
          reason = `${names.join('·')} 도시가 필요합니다.`;
        }
        break;
      }
      case 'cities':
        if (!context.ownedCities.some((city) => requirement.cityKeys.includes(city.cityKey)))
          reason = `${cityNames(requirement.cityKeys)} 거점이 필요합니다.`;
        break;
      case 'citiesWithLevel':
        if (
          !context.ownedCities.some(
            (city) => requirement.cityKeys.includes(city.cityKey) && city.level >= requirement.level,
          )
        )
          reason = `규모 ${requirement.level} 이상의 ${cityNames(requirement.cityKeys)} 거점이 필요합니다.`;
        break;
      case 'minRelYear':
        if (context.year - context.startYear < requirement.min)
          reason = `시작 ${requirement.min}년 뒤부터 쓸 수 있습니다.`;
        break;
      case 'research':
        if (!context.nation || !context.research.includes(requirement.name))
          reason = `${researchNames[requirement.name]} 연구가 필요합니다.`;
        break;
      case 'scorched':
        if (!context.nation || context.scorch < requirement.min) reason = '초토화를 한 국가만 모집할 수 있습니다.';
        break;
      case 'chief':
        if (!context.isChief) reason = '수뇌만 모집할 수 있습니다.';
        break;
    }
    if (reason) return { code: 'BAD_STATE', message: `현재 선택할 수 없는 병종입니다. ${reason}` };
  }
  return null;
}
