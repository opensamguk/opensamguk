import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { operationalMapSchema } from '../../packages/rules/src/world/map/operational';
import { buildExpandedUnitSet } from './expanded';
import { crewTypeFailure, type CrewContext } from '../../packages/rules/src/world/crewRequirements';

const root = new URL('../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const source = read('tools/unitset/source/core2026-df6c926.json');
const map = operationalMapSchema.parse(read('resources/map/san10.json'));
const expanded = buildExpandedUnitSet(source, map);
const unit = (id: number) => expanded.crewTypes.find((row) => row.id === id)!;

it('AC-INT-22: 12귀병을 제외한 원본35종과 새10종을 같은 입력에서 똑같이 만들고 원본을 보존한다', () => {
  const before = JSON.stringify([source, map]);
  expect(buildExpandedUnitSet(source, map)).toEqual(expanded);
  expect(expanded).toEqual(read('resources/unitset/expanded.json'));
  expect(JSON.stringify([source, map])).toBe(before);
  expect(expanded.crewTypes).toHaveLength(45);
  expect(new Set(expanded.crewTypes.map((row) => row.id)).size).toBe(45);
  expect([0, 1, 2, 3, 4, 5].map((arm) => expanded.crewTypes.filter((row) => row.armType === arm).length)).toEqual([
    1, 13, 9, 12, 5, 5,
  ]);
  expect(expanded.crewTypes.some((row) => /귀병|무희/.test(row.name))).toBe(false);
  expect(expanded).toMatchObject({ coefMode: 'multiply', regionScheme: 'province-191', defaultCrewTypeId: 1100 });
});

it('시작 연도·도시 규모·연구·초토화·수뇌 조건과 丹楊郡 거점을 실제 anchorKey로 연결한다', () => {
  expect(unit(1500).requirements).toEqual([{ kind: 'minRelYear', min: 3 }]);
  expect(unit(91102).requirements).toEqual([
    { kind: 'tech', min: 5000 },
    { kind: 'citiesWithLevel', cityKeys: [1126], level: 8 },
    { kind: 'research', name: 'halberd' },
  ]);
  expect(unit(91500).requirements).toEqual([
    { kind: 'tech', min: 5000 },
    { kind: 'scorched', min: 1 },
    { kind: 'chief' },
    { kind: 'research', name: 'fire_wheel' },
  ]);
  expect(unit(1110).requirements).toEqual([
    { kind: 'tech', min: 1000 },
    { kind: 'cities', cityKeys: [7] },
  ]);
  expect(unit(1201).requirements).toContainEqual({ kind: 'cities', cityKeys: [1121, 1124] });
});

it('AC-INT-22: 呉郡 경구만 소유하면 단양병을 모집하지 못하고 丹楊郡 건업에서 열린다', () => {
  const context: CrewContext = {
    nation: { id: 1, tech: 1000 },
    ownedCities: [{ cityKey: 1113, region: 8, level: 5 }],
    cityNames: { 7: '건업', 1113: '경구' },
    year: 191,
    startYear: 191,
    research: [],
    scorch: 0,
    isChief: true,
  };
  expect(crewTypeFailure(unit(1110), context)).toMatchObject({
    code: 'BAD_STATE',
    message: expect.stringContaining('건업'),
  });
  context.ownedCities = [{ cityKey: 7, region: 8, level: 5 }];
  expect(crewTypeFailure(unit(1110), context)).toBeNull();
});

it('창극 계열과 차병의 ID 우선 예외를 함께 보존하고 회피는 원작 특화4종만 켠다', () => {
  expect(unit(91102).armType).toBe(4);
  expect(unit(91102).effects).toEqual(['pikeWall']);
  expect(unit(1400).attackCoef).toMatchObject({ '2': 0.8, '3': 1.2 });
  expect(unit(1400).defenceCoef).toMatchObject({ '2': 1.2, '3': 0.8 });
  expect(unit(1100).attackCoef).toMatchObject({ '4': 1 });
  expect(unit(1500).attackCoef).toMatchObject({ '1106': 1.112, '91300': 1.112 });
  expect(unit(1500).defenceCoef).toMatchObject({ '1106': 1.067, '91300': 1.112 });
  expect(expanded.crewTypes.filter((row) => row.effects?.includes('avoid')).map((row) => row.id)).toEqual([
    1103, 1201, 91200, 1305,
  ]);
  expect(unit(1106).info.join(' ')).toContain('창작');
  expect(unit(1110).info.join(' ')).toContain('三國志');
});

it('거점 이름이 없거나 모호하면 임의 대응하지 않고 생성을 중단한다', () => {
  const missing = structuredClone(map);
  missing.sites = missing.sites.filter((site) => site.name !== '건업');
  expect(() => buildExpandedUnitSet(source, missing)).toThrow('병종 조건 거점 대응');
  const duplicate = structuredClone(map);
  duplicate.sites.push({ ...map.sites.find((site) => site.name === '건업')!, id: 'city:99999' });
  expect(() => buildExpandedUnitSet(source, duplicate)).toThrow('병종 조건 거점 대응');
});

it('원본에 새 병종이 생겨도 조건을 빼먹은 채 게시하지 않는다', () => {
  const unknown = structuredClone(source);
  unknown.crewTypes.push({ ...unknown.crewTypes.find((row: { id: number }) => row.id === 1100), id: 1199 });
  expect(() => buildExpandedUnitSet(unknown, map)).toThrow('승인된 병종 조건이 없습니다: 1199');
});
