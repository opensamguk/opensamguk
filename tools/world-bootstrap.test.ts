import { describe, expect, it } from 'vitest';
import map from '../resources/map/che.json';
import scenario from '../resources/scenario/1030.json';
import unitSet from '../resources/unitset/basic.json';
import statRules from '../resources/scenario/default.json';
import { buildInitialWorld, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';

const input = { map, scenario, unitSet, statRules, seed: 'test-world' };

describe('AC-M1-03 시나리오 합성', () => {
  it('도시 94·국가 21·장수 491·중복을 합친 외교 7쌍과 조조 수도를 만든다', () => {
    const world = buildInitialWorld(input);
    expect([world.cities.length, world.nations.length, world.generals.length, world.diplomacies.length]).toEqual([
      94, 21, 491, 7,
    ]);
    const cao = world.nations.find((nation) => nation.name === '조조')!;
    expect(world.cities.find((city) => city.cityKey === cao.capitalCityKey)?.name).toBe('진류');
    expect(world.generals.every((general) => general.userId === null && general.portraitId === null)).toBe(true);
    expect(world.unitSet.crewTypes.map((unit) => unit.name)).toEqual(['성벽', '보병', '궁병', '기병']);
    expect(world.statRules).toEqual({ total: 165, min: 15, max: 80 });
  });

  it('같은 시드는 같은 상태, 다른 시드는 다른 배치를 만든다', () => {
    const first = buildInitialWorld(input);
    expect(hashState(buildInitialWorld(input))).toBe(hashState(first));
    const different = buildInitialWorld({ ...input, seed: 'another-world' });
    expect(first.generals.map((g) => g.cityKey)).not.toEqual(different.generals.map((g) => g.cityKey));
    expect(hashState(different)).not.toBe(hashState(first));
  });

  it('국가 소속 장수는 자기 국가 도시에, 재야는 지도 안에 배치한다', () => {
    const world = buildInitialWorld(input);
    for (const general of world.generals) {
      const city = world.cities.find((city) => city.cityKey === general.cityKey)!;
      expect(city).toBeDefined();
      if (general.nationId !== null) expect(city.nationId).toBe(general.nationId);
    }
  });

  it('AC-M1-10 장수 턴은 첫 달 안에 흩어지고 도시 배치 RNG 소비와 독립적이다', () => {
    const world = buildInitialWorld(input);
    const offsets = world.generals.map((general) => general.nextTurnTick);
    expect(offsets.every((tick) => Number.isInteger(tick) && tick >= 0 && tick < TICKS_PER_MONTH)).toBe(true);
    expect(new Set(offsets).size).toBeGreaterThan(1);
    const changed = structuredClone(scenario);
    for (const row of changed.general) row[4] = null;
    expect(buildInitialWorld({ ...input, scenario: changed }).generals.map((general) => general.nextTurnTick)).toEqual(
      offsets,
    );
  });

  it('15세 미만도 만들고 행동 가능 연도와 관직 원본을 보존한다', () => {
    const world = buildInitialWorld(input);
    const young = world.generals.find((general) => general.birthYear + 15 > world.startYear)!;
    expect(young.activeFromYear).toBe(young.birthYear + 15);
    expect(world.generals.map((general) => general.officerLevel)).toEqual(scenario.general.map((row) => row[8]));
  });

  it('도시 초기값·최대치·민심을 보존하고 입력을 변경하지 않는다', () => {
    const original = JSON.stringify(input);
    const world = buildInitialWorld(input);
    expect(world.cities[0]).toMatchObject({
      population: map.cities[0]!.initial.population,
      populationMax: map.cities[0]!.max.population,
      trust: 50,
    });
    expect(JSON.stringify(input)).toBe(original);
  });

  it('국가 쌍은 순서를 정규화하고 마지막 외교 줄을 쓴다', () => {
    const changed = structuredClone(scenario);
    changed.diplomacy.push([10, 2, 0, 5]);
    expect(
      buildInitialWorld({ ...input, scenario: changed }).diplomacies.find((d) => d.nationA === 2 && d.nationB === 10),
    ).toEqual({ nationA: 2, nationB: 10, state: 'WAR', untilTick: 5 * TICKS_PER_MONTH });
  });

  it('단방향 연결과 중복 도시 ID를 거부한다', () => {
    const oneWay = structuredClone(map);
    oneWay.cities[0]!.connections.pop();
    expect(() => buildInitialWorld({ ...input, map: oneWay })).toThrow('양방향');
    const duplicate = structuredClone(map);
    duplicate.cities[1]!.id = duplicate.cities[0]!.id;
    expect(() => buildInitialWorld({ ...input, map: duplicate })).toThrow('중복');
  });

  it('없는 국가 도시와 중복 소유를 거부한다', () => {
    const missing = structuredClone(scenario);
    (missing.nation[0]![8] as string[]).push('없는도시');
    expect(() => buildInitialWorld({ ...input, scenario: missing })).toThrow('없는 도시');
    const duplicate = structuredClone(scenario);
    (duplicate.nation[1]![8] as string[]).push('진류');
    expect(() => buildInitialWorld({ ...input, scenario: duplicate })).toThrow('소유 국가가 중복');
  });

  it('잘못된 장수 국가·도시와 외교 국가 참조를 거부한다', () => {
    const invalid = structuredClone(scenario);
    invalid.general[0]![3] = 999;
    expect(() => buildInitialWorld({ ...input, scenario: invalid })).toThrow('없는 국가');
    invalid.general[0]![3] = 0;
    invalid.general[0]![4] = '없는도시';
    expect(() => buildInitialWorld({ ...input, scenario: invalid })).toThrow('없는 도시');
    const diplomacy = structuredClone(scenario);
    diplomacy.diplomacy.push([1, 99, 0, 0]);
    expect(() => buildInitialWorld({ ...input, scenario: diplomacy })).toThrow('외교 국가');
  });

  it('잘못된 튜플과 없는 기본 병종을 거부한다', () => {
    expect(() => buildInitialWorld({ ...input, scenario: { ...scenario, nation: [['불완전']] } })).toThrow();
    expect(() => buildInitialWorld({ ...input, unitSet: { ...unitSet, defaultCrewTypeId: 9999 } })).toThrow(
      '기본 병종',
    );
  });
});
