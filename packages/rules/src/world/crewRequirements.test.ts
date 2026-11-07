import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { militaryCommands } from '../commands/military';
import { commandStatPreview } from '../commands/statPreview';
import { applyCampaignPreparation } from '../campaign/preparation';
import { emptyCampaignState } from '../campaign/state';
import { applyCampaignUnitInput } from '../campaign/unitInputs';
import { replayCampaignUnit } from '../campaign/record';
import { createCommandResolver } from '../commands/resolve';
import { createCampaignCommandResolver } from '../campaign/commands';
import { createCityResourceCommandResolver } from '../cityResources/commands';
import { applyCityPreparation } from '../cityResources/preparation';
import { emptyCityResourcesState } from '../cityResources/state';
import { cityNpcPreparation } from '../cityResources/npc';
import { chooseGeneralTurn } from '../npc';
import { deepFreeze } from '../personnel/testFixture';
import { unitSetSchema, type UnitSetResource } from './resources';
import { crewContext, crewTypeFailure, type CrewContext } from './crewRequirements';

type Requirement = NonNullable<UnitSetResource['crewTypes'][number]['requirements']>[number];
const blocked: [Requirement, string][] = [
  [{ kind: 'impossible' }, '모집할 수 없는 병종입니다.'],
  [{ kind: 'tech', min: 1 }, '기술 1이 필요합니다.'],
  [{ kind: 'regions', regions: [16] }, '이민족 도시가 필요합니다.'],
  [{ kind: 'cities', cityKeys: [2] }, '도시2 거점이 필요합니다.'],
  [{ kind: 'citiesWithLevel', cityKeys: [1], level: 8 }, '규모 8 이상의 도시1 거점이 필요합니다.'],
  [{ kind: 'minRelYear', min: 1 }, '시작 1년 뒤부터 쓸 수 있습니다.'],
  [{ kind: 'research', name: 'greatsword' }, '대검병 연구가 필요합니다.'],
  [{ kind: 'scorched', min: 1 }, '초토화를 한 국가만 모집할 수 있습니다.'],
  [{ kind: 'chief' }, '수뇌만 모집할 수 있습니다.'],
];
const resolver = createCityResourceCommandResolver(createCampaignCommandResolver(createCommandResolver(null)));

function fixture(requirements: Requirement[]) {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'campaign-v1', 'city-resources-v1'];
  for (const general of Object.values(world.generals)) Object.assign(general, { crew: 0, politics: 60, charm: 55 });
  Object.assign(world.generals[1]!, { userId: 'owner', officerLevel: 1, gold: 100_000, rice: 100_000 });
  world.campaign = emptyCampaignState(world, 'crew-requirements', 'source-fixture');
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.gold = 100_000;
  const unitSet = structuredClone(testUnits);
  unitSet.crewTypes.find((row) => row.id === 1100)!.requirements = requirements;
  return { world, unitSet, actor: { generalId: 1, tick: 0, unitSet } };
}

describe('INT-22 병종 조건의 공통 모집 경계', () => {
  it.each([1000, 9999])('기존 NPC의 모집 대상이 아닌 병종 %i를 새 후보로 바꾸지 않는다', (crewType) => {
    const world = commandWorld();
    Object.assign(world.generals[1]!, { userId: null, crew: 0, crewType });
    const result = chooseGeneralTurn(world, world.generals[1]!, rngFor('legacy-crew', 1), { unitSet: testUnits });
    expect(result.candidates.some((candidate) => candidate.key === 'recruit')).toBe(false);
  });
  it.each(blocked)('%o는 모든 새 모집·편성 경로에서 같은 이유로 실패한다', (requirement, reason) => {
    const { world, unitSet, actor } = fixture([requirement]);
    const before = structuredClone(world);
    deepFreeze(world);
    const args = { amount: 1, crewType: 1100 };
    const failure = { code: 'BAD_STATE', message: `현재 선택할 수 없는 병종입니다. ${reason}` };
    for (const key of ['recruit', 'conscript'] as const) {
      const command = militaryCommands.find((row) => row.key === key)!;
      expect(command.precheck(world, actor, args)).toEqual(failure);
      expect(command.check(world, actor, args)).toEqual(failure);
      expect(applyCampaignPreparation(world, actor, key, args)).toEqual({ ok: false, ...failure });
      expect(applyCityPreparation(world, actor, key, args)).toEqual({ ok: false, ...failure });
      expect(commandStatPreview(world, actor, key, args)).toBeNull();
    }
    expect(resolver.get('form_unit')!.precheck(world, actor, { crewType: 1100 })).toEqual(failure);
    expect(
      applyCampaignUnitInput(world, { type: 'form', commanderId: 1, crewType: 1100, revision: 0 }, 1, world.campaign, {
        tick: 0,
        userId: 'owner',
        userActive: true,
        armyTypes: [1100, 1200, 1300],
        unitSet,
      }),
    ).toEqual({ ok: false, ...failure });
    expect(
      cityNpcPreparation(world, 1, { unitSet, tick: 0 }).some(
        (row) => row.key === 'recruit' && row.args.crewType === 1100,
      ),
    ).toBe(false);
    const legacy = structuredClone(world);
    legacy.ruleFeatures = ['five-stats'];
    delete legacy.campaign;
    delete legacy.cityResources;
    legacy.generals[1]!.userId = null;
    const recruit = chooseGeneralTurn(legacy, legacy.generals[1]!, rngFor('crew-choice', 1), {
      unitSet,
      tick: 0,
    }).candidates.find((row) => row.key === 'recruit');
    expect(recruit?.args.crewType).toBe(1200);
    expect(world).toEqual(before);
  });

  it('부곡 재생도 생성 원본의 병종 조건을 검사해 거짓 적용 기록을 거부한다', () => {
    const { world, unitSet } = fixture([{ kind: 'impossible' }]);
    expect(() =>
      replayCampaignUnit(
        world,
        {
          sequence: 1,
          tick: 0,
          generalId: 1,
          kind: 'campaign.unit',
          status: 'APPLIED',
          payload: { type: 'form', commanderId: 1, crewType: 1100, revision: 0 },
          result: { tick: 0, unitId: 1, commanderId: 1, revision: 1 },
        },
        [1100, 1200, 1300],
        unitSet,
      ),
    ).toThrow('재현하지 못했습니다.');
  });

  it('조건을 잃어도 기존 도시·부곡 병력의 훈련·사기는 막지 않는다', () => {
    const { world, actor, unitSet } = fixture([{ kind: 'impossible' }]);
    world.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 1, crewType: 1100, troops: 100, train: 0, atmos: 0 }];
    world.campaign!.nextUnitId = 2;
    world.cityResources!.cities['1']!.garrison = [{ crewType: 1100, troops: 100, train: 0, atmos: 0 }];
    for (const key of ['train', 'morale'] as const) {
      expect(applyCampaignPreparation(deepFreeze(world), actor, key, { unitId: 1 }).ok).toBe(true);
      expect(applyCityPreparation(world, actor, key, { target: 'city', crewType: 1100 }).ok).toBe(true);
    }
    const candidates = cityNpcPreparation(world, 1, { unitSet, tick: 0 });
    expect(candidates.some((row) => row.key === 'morale')).toBe(true);
    expect(candidates.some((row) => row.key === 'recruit' || row.key === 'form_unit')).toBe(false);
  });

  it('목록을 AND로 검사하고 첫 실패만 내며 정확한 경계값은 허용한다', () => {
    const context: CrewContext = {
      nation: { id: 1, tech: 1000 },
      ownedCities: [{ cityKey: 1, region: 6, level: 8 }],
      cityNames: { 1: '낙양' },
      year: 192,
      startYear: 191,
      research: ['greatsword'],
      scorch: 1,
      isChief: true,
    };
    const requirements: Requirement[] = [
      { kind: 'tech', min: 1000 },
      { kind: 'regions', regions: [4, 6] },
      { kind: 'cities', cityKeys: [1, 2] },
      { kind: 'citiesWithLevel', cityKeys: [1], level: 8 },
      { kind: 'minRelYear', min: 1 },
      { kind: 'research', name: 'greatsword' },
      { kind: 'scorched', min: 1 },
      { kind: 'chief' },
    ];
    expect(crewTypeFailure({ requirements }, context)).toBeNull();
    expect(crewTypeFailure({ requirements }, { ...context, nation: { id: 1, tech: 999 }, isChief: false })).toEqual({
      code: 'BAD_STATE',
      message: '현재 선택할 수 없는 병종입니다. 기술 1000이 필요합니다.',
    });
    expect(
      crewTypeFailure({ requirements: [...requirements].reverse() }, { ...context, nation: null, isChief: false })
        ?.message,
    ).toBe('현재 선택할 수 없는 병종입니다. 수뇌만 모집할 수 있습니다.');
  });

  it('서버 행위자의 국가·자기 도시·연도·직책과 국가별 확장 표식을 읽는다', () => {
    const { world } = fixture([]);
    world.ruleFeatures = ['personnel', 'prepared-turns-v1', 'nation-research-v1'];
    world.nationResearch = { version: 1, nations: { '1': ['greatsword'], '2': ['halberd'] } };
    world.preparedTurns = { version: 1, nations: {} };
    world.ext = { nation_scorch: { specialScorch: { '1': 2 } } };
    world.generals[1]!.officerLevel = 5;
    const context = crewContext(deepFreeze(world), { generalId: 1, tick: 12 * TICKS_PER_MONTH });
    expect(context).toMatchObject({
      nation: { id: 1, tech: 0 },
      year: 192,
      startYear: 191,
      research: ['greatsword'],
      scorch: 2,
      isChief: true,
    });
    expect(context.ownedCities.every((city) => world.cities[city.cityKey]!.nationId === 1)).toBe(true);
    const noNation = crewContext(world, { generalId: 999, tick: 0 });
    expect(noNation).toMatchObject({ nation: null, ownedCities: [], research: [], scorch: 0, isChief: false });
  });

  it('빈 조건·효과와 없는 선택 칸은 읽은 기본 병종에 키를 추가하지 않는다', () => {
    const raw = structuredClone(testUnits);
    for (const row of raw.crewTypes) {
      row.requirements = [];
      row.effects = [];
    }
    const parsed = unitSetSchema.parse(raw);
    expect(parsed).toEqual(testUnits);
    expect(Object.hasOwn(parsed, 'coefMode')).toBe(false);
    expect(Object.hasOwn(parsed, 'regionScheme')).toBe(false);
    for (const row of parsed.crewTypes) {
      expect(Object.hasOwn(row, 'requirements')).toBe(false);
      expect(Object.hasOwn(row, 'effects')).toBe(false);
    }
  });
});
