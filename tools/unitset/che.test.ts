import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulateBattle } from '../../packages/rules/src/battle/simulate';
import { campaignAttack } from '../../packages/rules/src/campaign/attack';
import { emptyCampaignState } from '../../packages/rules/src/campaign/state';
import { emptyCityResourcesState } from '../../packages/rules/src/cityResources/state';
import { attack } from '../../packages/rules/src/commands/attack';
import { commandWorld } from '../../packages/rules/test/commandFixture';
import { rngFor } from '../../packages/shared/src/index';
import { buildInitialWorld } from '../../packages/rules/src/world/bootstrap';
import { crewTypeFailure, type CrewContext } from '../../packages/rules/src/world/crewRequirements';
import { mapSchema, unitSetSchema } from '../../packages/rules/src/world/resources';
import { validateWorldResources } from '../../packages/rules/src/world/validate/world';
import { projectCheUnitSet } from './che';
import { readCheSource } from './source';

const sql = readFileSync(new URL('../../packages/db/sql/resources-init.sql', import.meta.url), 'utf8').split(
  '$t4_77_content$',
);
function published(kind: string, name: string): unknown {
  const index = sql.findIndex((block) => block.includes(`'${kind}', '${name}', 1, 'PUBLISHED', resource_content`));
  if (index < 1) throw Error(`게시 원본을 확인하세요. ${kind}/${name}/1`);
  return JSON.parse(sql[index - 1]!);
}
const map = mapSchema.parse(published('MAP', 'che'));
const source = await readCheSource();
const { unitSet, specials } = projectCheUnitSet(source, map);
const unit = (id: number) => unitSet.crewTypes.find((row) => row.id === id)!;

describe('T4-46 AC-P2-24 원작 che 병종 수치와 모집 조건', () => {
  it('병종 34종의 원본 수치와 모집 조건 57개를 보존하고 전투 특수 목록을 따로 보관한다', () => {
    const before = JSON.stringify(source);
    expect(projectCheUnitSet(source, map)).toEqual({ unitSet, specials });
    expect(JSON.parse(readFileSync(new URL('../../resources/unitset/che.json', import.meta.url), 'utf8'))).toEqual(
      unitSet,
    );
    expect(JSON.stringify(source)).toBe(before);
    expect(unitSet).toMatchObject({
      id: 'che',
      defaultCrewTypeId: 1100,
      coefMode: 'multiply',
      firstVolleyScope: 'sortie',
    });
    expect(unitSet.crewTypes).toHaveLength(34);
    const canonicalNumbers = unitSetSchema.parse({
      ...(source as { crewTypes: Record<string, unknown>[] }),
      crewTypes: (source as { crewTypes: Record<string, unknown>[] }).crewTypes.map((row) => ({
        ...row,
        requirements: undefined,
        effects: undefined,
      })),
    });
    const projectedNumbers = unitSetSchema.parse({
      ...unitSet,
      crewTypes: unitSet.crewTypes.map((row) => ({ ...row, requirements: undefined, effects: undefined })),
    });
    expect(projectedNumbers.crewTypes).toEqual(canonicalNumbers.crewTypes);
    expect(unitSet.crewTypes.flatMap((row) => row.requirements ?? [])).toHaveLength(57);
    expect(unit(1000).requirements).toEqual([{ kind: 'impossible' }]);
    expect(unit(1101).requirements).toEqual([
      { kind: 'tech', min: 1000 },
      { kind: 'legacyCheRegions', regions: [2] },
    ]);
    expect(unit(1500).requirements).toEqual([{ kind: 'minRelYear', min: 3 }]);
    expect(unitSet.crewTypes.filter((row) => row.effects?.includes('firstVolley')).map(({ id }) => id)).toEqual([
      1000, 1200, 1201, 1202, 1203, 1204, 1500, 1502,
    ]);
    expect(unitSet.crewTypes.filter((row) => row.effects?.includes('guard5')).map(({ id }) => id)).toEqual([
      1100, 1101, 1102, 1103, 1104, 1105, 1106,
    ]);
    expect(unitSet.crewTypes.filter((row) => row.effects?.includes('cavalryClash')).map(({ id }) => id)).toEqual([
      1300, 1301, 1302, 1303, 1304, 1305, 1306, 1307,
    ]);
    expect(unitSet.crewTypes.filter((row) => row.effects?.includes('wallFirst')).map(({ id }) => id)).toEqual([
      1500, 1502,
    ]);
    expect(unitSet.crewTypes.filter((row) => row.effects?.includes('hold')).map(({ id }) => id)).toEqual([1503]);
    expect(specials.find(({ id }) => id === 1500)).toEqual({
      id: 1500,
      initSkillTrigger: ['che_성벽부상무효'],
      phaseSkillTrigger: ['che_선제사격시도', 'che_선제사격발동'],
      iActionList: ['che_성벽선제'],
    });
  });

  it('소유 거점과 원작 지역 이름을 기준으로 같은 지역 제한을 판정한다', () => {
    const context: CrewContext = {
      nation: { id: 1, tech: 3000 },
      ownedCities: [],
      cityNames: Object.fromEntries(map.cities.map(({ id, name }) => [id, name])),
      year: 191,
      startYear: 191,
      research: [],
      scorch: 0,
      isChief: true,
    };
    const regions = [
      [1101, '중원', 2],
      [1102, '오월', 7],
      [1105, '남중', 5],
      [1201, '동이', 8],
      [1202, '서촉', 4],
      [1301, '하북', 1],
      [1302, '서북', 3],
      [1401, '초', 6],
    ] as const;
    for (const [id, label, region] of regions) {
      expect(crewTypeFailure(unit(id), context)?.message).toContain(`${label} 도시`);
      const { id: cityKey, level } = map.cities.find((city) => city.region === region)!;
      expect(crewTypeFailure(unit(id), { ...context, ownedCities: [{ cityKey, region, level }] })).toBeNull();
    }
    expect(crewTypeFailure(unit(1103), context)?.message).toContain('저 거점');
    const ju = map.cities.find(({ name }) => name === '저')!;
    expect(
      crewTypeFailure(unit(1103), {
        ...context,
        ownedCities: [{ cityKey: ju.id, region: ju.region, level: ju.level }],
      }),
    ).toBeNull();
  });

  it('거점이나 지역 대응을 잃은 원본은 변환할 수 없다', () => {
    const noCity = { ...map, cities: map.cities.filter(({ name }) => name !== '저') };
    expect(() => projectCheUnitSet(source, noCity)).toThrow('거점 대응');
    const noRegion = {
      ...map,
      cities: map.cities.map((row) => ({ ...row, region: row.region === 2 ? 16 : row.region })),
    };
    expect(() => projectCheUnitSet(source, noRegion)).toThrow('지역 대응');
    expect(() => projectCheUnitSet(source, { ...map, id: 'other' })).toThrow('che 지도');
  });

  it('공개 che 조합에서 생성되고 다른 지역 기준의 지도와 조합할 수 없다', () => {
    const input = {
      map,
      unitSet,
      scenario: published('SCENARIO', '1030'),
      statRules: published('STAT_RULES', 'default'),
      seed: 't4-46-che-unit-numbers',
    };
    expect(validateWorldResources(input).status).toBe('pass');
    expect(buildInitialWorld(input).unitSet).toEqual(unitSet);
    expect(buildInitialWorld(input)).not.toHaveProperty('commandMeta');
    const legacyScenario = {
      ...(input.scenario as object),
      lastNationRecruitmentLockYear: 195,
      requiredUnitSet: 'che',
    };
    const withLock = buildInitialWorld({ ...input, scenario: legacyScenario });
    expect(withLock.commandMeta).toEqual({
      nextNationId: withLock.nations.length + 1,
      offers: {},
      lastNationRecruitmentLock: { fromYear: 195 },
    });
    const wrongUnitSet = { ...input, scenario: legacyScenario, unitSet: published('UNIT_SET', 'basic') };
    expect(validateWorldResources(wrongUnitSet).unitSet.status).toBe('fail');
    expect(() => buildInitialWorld(wrongUnitSet)).toThrow('che 병종 판');
    const otherMap = { ...input, map: { ...map, id: 'other' } };
    expect(validateWorldResources(otherMap).status).toBe('fail');
    expect(() => buildInitialWorld(otherMap)).toThrow('지역 기준');
    const missingRegion = {
      ...input,
      map: { ...map, cities: map.cities.map((city) => ({ ...city, region: city.region === 2 ? 16 : city.region })) },
    };
    expect(validateWorldResources(missingRegion).status).toBe('fail');
    expect(() => buildInitialWorld(missingRegion)).toThrow('지역 기준');

    const [luoyang, beiping] = ['낙양', '북평'].map((name) => map.cities.find((city) => city.name === name)!);
    const swappedRegions = {
      ...input,
      map: {
        ...map,
        cities: map.cities.map((city) => ({
          ...city,
          region: city.id === luoyang!.id ? beiping!.region : city.id === beiping!.id ? luoyang!.region : city.region,
        })),
      },
    };
    expect(validateWorldResources(swappedRegions).status).toBe('fail');
    expect(() => buildInitialWorld(swappedRegions)).toThrow('지역 기준');

    const reordered = { ...input, map: { ...map, cities: [...map.cities].reverse() } };
    expect(validateWorldResources(reordered).status).toBe('pass');
    expect(buildInitialWorld(reordered).unitSet).toEqual(unitSet);
  });
});

it.each([false, true])('목우의 저지는 수비측일 때만 발동한다 (공격측 %s)', (attacking) => {
  const attacker = { crew: 1000, crewType: attacking ? 1503 : 1100, train: 100, atmos: 5 };
  const defender = { crew: 1000, crewType: attacking ? 1100 : 1503, train: 100, atmos: 5 };
  let calls = 0;
  const seed = rngFor('che-1503-hold', 1);
  const result = simulateBattle(
    { attacker, defender, attackerTech: 0, defenderTech: 0, unitSet, coefMode: 'multiply' },
    { ...seed, next: () => (calls++ === 0 ? 0.1 : 0.5) },
  );
  expect(calls).toBe(attacking ? 2 : 3);
  expect(result.attacker.crew).toBeLessThan(attacker.crew);
  expect(result.defender.crew).toBeLessThan(defender.crew);
  expect(result.attacker.atmos).toBe(0);
  expect(result.defender.atmos).toBe(0);
});

it.each(['장수', '부곡', '두 번째 부곡'] as const)('%s 출병에서 정란의 선제사격을 한 번만 적용한다', (kind) => {
  const world = commandWorld();
  world.ruleFeatures = ['battle-affinity-v2'];
  Object.assign(world.cities[2]!, { wall: 5000, wallMax: 5000, defence: 1500, defenceMax: 1500 });
  world.generals[1]!.crewType = 1500;
  world.generals[2]!.crewType = 1200;
  let calls = 0;
  const seed = rngFor('che-1500-sortie', 1);
  const rng = {
    ...seed,
    next: () => {
      calls++;
      return seed.next();
    },
  };
  const actor = { generalId: 1, tick: 100, unitSet };
  const target = { cityKey: 2 };
  if (kind !== '장수') {
    world.ruleFeatures.push('five-stats', 'city-resources-v1');
    for (const general of Object.values(world.generals)) Object.assign(general, { politics: 60, charm: 55 });
    world.campaign = emptyCampaignState(world, 'che-sortie', 'sourced-fixture');
    world.cityResources = emptyCityResourcesState(world);
    const cityResource = world.cityResources.cities['2']!;
    cityResource.rice = 100;
    cityResource.garrison = [{ crewType: 1200, troops: 10, train: 100, atmos: 100 }];
    world.campaign.units = [1, 2, 3].map((id) => {
      const general = world.generals[id]!;
      return {
        id,
        ownerId: id,
        commanderId: id,
        troops: general.crew,
        crewType: general.crewType,
        train: 100,
        atmos: 100,
      };
    });
    world.campaign.nextUnitId = 4;
    if (kind === '두 번째 부곡') {
      const first = world.campaign.units[0]!;
      world.campaign.units.push({ ...first, id: 4, troops: first.troops - 1 });
      world.campaign.nextUnitId = 5;
      first.troops = 1;
    }
    for (const general of Object.values(world.generals)) general.crew = 0;
  }
  const command = kind === '장수' ? attack : campaignAttack;
  const result = command.execute(world, actor, target, rng);
  const rounds = result.logs[0]!.text.split('\n');
  const openingCount = kind === '두 번째 부곡' ? 2 : 1;
  expect(rounds.filter((text) => text.includes('성벽 선제 교전'))).toHaveLength(openingCount);
  expect(rounds.filter((text) => text.includes('성벽 교전'))).toHaveLength(1);
  expect(result.reports?.map(({ generalId }) => generalId)).toEqual([2, 3]);
  // 양쪽 성벽 선제 2, 궁병 수비 3, 보병 수비 2, 본공성 20. 부곡은 도시 궁병 수비 3이 더해진다.
  expect(calls).toBe(openingCount * 2 + 3 + 2 + 20 + (kind === '장수' ? 0 : 3));
});
