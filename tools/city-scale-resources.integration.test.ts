import { describe, expect, it } from 'vitest';
// 실제 게시 지도는 이 통합 시험만 읽는다. 순수 계산과 검증기는 파일을 읽지 않는다.
import { readFileSync } from 'node:fs';
import { mapSchema, scenarioSchema } from '../packages/rules/src/world/resources';
import { operationalMapSchema } from '../packages/rules/src/world/map/operational';
import { operationalAnchors } from '../packages/rules/src/world/map/anchors';
import { validateMap } from '../packages/rules/src/world/validate/map';
import { validateScenario } from '../packages/rules/src/world/validate/scenario';
import { validateMap as validateEditorMap } from '../packages/rules/src/world/resourceEditor/validate/map';
import { validateScenario as validateEditorScenario } from '../packages/rules/src/world/resourceEditor/validate/scenario';
import {
  CITY_SCALE_FIELDS,
  resolveCityScale,
  WASTELAND_INITIAL,
  WASTELAND_MAX,
} from '../packages/rules/src/world/map/cityScale';

import { createDb, readPublishedResources } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
const legacyResource = await (async () => {
  const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
  try {
    const [resource] = await readPublishedResources(db, [{ kind: 'MAP', name: 'che', version: 1 }]);
    return resource!;
  } finally {
    await db.$disconnect();
  }
})();
const legacy = mapSchema.parse(legacyResource.content);
const integration = operationalMapSchema.parse(
  JSON.parse(readFileSync(new URL('../resources/map/integration.json', import.meta.url), 'utf8')),
);
const san10 = operationalMapSchema.parse(
  JSON.parse(readFileSync(new URL('../resources/map/san10.json', import.meta.url), 'utf8')),
);
const maps = [
  { key: 'che', cities: legacy.cities, expected: [987314, 13627, 14444, 11778, 13979, 14570] },
  {
    key: 'integration',
    cities: operationalAnchors(operationalMapSchema.parse(integration)),
    expected: [986214, 13629, 14386, 11714, 13986, 14586],
  },
  {
    key: 'san10',
    cities: operationalAnchors(operationalMapSchema.parse(san10)),
    expected: [987925, 13660, 14367, 11778, 13979, 14592],
  },
];
const scenario = { id: 'scale', title: '도시 규모 검사', startYear: 191, nation: [], general: [], diplomacy: [] };

describe('AC-INT-21 지도·시나리오 도시 규모', () => {
  it.each(maps)('$key의 낙양 고유 최대치와 여섯 항목의 대→특 평균 차이를 보존한다', ({ cities, expected }) => {
    const before = structuredClone(cities);
    const result = resolveCityScale(cities, [{ city: '낙양', level: 9 }]);
    const city = result.cities.find((row) => row.name === '낙양')!;
    expect(CITY_SCALE_FIELDS.map((field) => city.max[field])).toEqual(expected);
    expect(city.initial).toEqual(cities.find((row) => row.name === '낙양')!.initial);
    expect(result.record?.cities).toEqual([{ cityKey: city.id, level: 9, max: city.max }]);
    expect(cities).toEqual(before);
  });

  it('SAN10 장안의 경 수치도 도시 고유 최대치에서 계산한다', () => {
    const result = resolveCityScale(maps[2]!.cities, [{ city: '장안', level: 9 }]);
    expect(CITY_SCALE_FIELDS.map((field) => result.cities.find((city) => city.name === '장안')!.max[field])).toEqual([
      744525, 13560, 14667, 11778, 13879, 13992,
    ]);
  });

  it.each([
    { special: [2, 1, 1], large: [1, 1, 1, 1, 1, 0], expected: 3 },
    { special: [3, 2, 2], large: [1, 1, 1, 1, 1, 0], expected: 5 },
    { special: [1, 1, 0], large: [2, 1, 1, 1, 1, 1], expected: 1 },
    { special: [1, 1, 0], large: [3, 2, 2, 2, 2, 2], expected: 0 },
  ])('경 평균 차이의 양·음 반 정수를 정확하게 반올림한다: $expected', ({ special, large, expected }) => {
    const values = [...special, ...large];
    const source = values.map((value, index) => ({
      ...structuredClone(legacy.cities[0]!),
      id: index + 1,
      name: index === 0 ? '낙양' : `표본${index}`,
      level: index < special.length ? 8 : 7,
      max: Object.fromEntries(
        CITY_SCALE_FIELDS.map((field) => [field, value]),
      ) as (typeof legacy.cities)[number]['max'],
      initial: { population: 0, agriculture: 0, commerce: 0, security: 0, defence: 0, wall: 0 },
    }));
    const city = resolveCityScale(source, [{ city: '낙양', level: 9 }]).cities[0]!;
    expect(CITY_SCALE_FIELDS.map((field) => city.max[field])).toEqual(Array(6).fill(expected));
  });

  it.each([5, 6, 7, 8])('목표 규모 %i의 원판 평균을 쓰고 상한을 넘는 시작값만 낮춘다', (level) => {
    const source = structuredClone(legacy.cities);
    const target = source.find((city) => city.name === '낙양')!;
    target.level = 4;
    target.initial.population = target.max.population;
    const sample = source.filter((city) => city.level === level);
    const result = resolveCityScale(source, [{ city: target.name, level }]);
    const city = result.cities.find((row) => row.id === target.id)!;
    for (const field of CITY_SCALE_FIELDS) {
      const expected = Math.round(sample.reduce((sum, row) => sum + row.max[field], 0) / sample.length);
      expect(city.max[field]).toBe(expected);
      expect(city.initial[field]).toBe(Math.min(target.initial[field], expected));
    }
  });

  it('같은 규모·변경 없는 원판은 고유 최대치를 유지하고 새 생성 키를 만들지 않는다', () => {
    for (const { cities } of maps) {
      const result = resolveCityScale(cities, [{ city: '낙양', level: 8 }]);
      expect(result).toEqual({ cities });
      expect(result).not.toHaveProperty('record');
    }
  });

  it('여러 변경은 변경 전 지도만 읽으므로 요청 순서가 결과를 바꾸지 않는다', () => {
    const requests = [
      { city: '낙양', level: 7 },
      { city: '장안', level: 9 },
    ];
    expect(resolveCityScale(legacy.cities, requests)).toEqual(resolveCityScale(legacy.cities, [...requests].reverse()));
  });

  it('무의 고정값과 폐허 10%를 순서대로 적용하고 원래 규모·100% 최대치를 남긴다', () => {
    const result = resolveCityScale(legacy.cities, [{ city: '낙양', level: 0, ruin: true }]);
    const city = result.cities.find((row) => row.name === '낙양')!;
    expect(city).toMatchObject({
      level: 0,
      max: { population: 1000, agriculture: 20 },
      initial: { population: 1000, defence: 20, wall: 20 },
    });
    expect(result.record?.cities).toEqual([{ cityKey: city.id, level: 0, max: WASTELAND_MAX, ruin: true }]);
    const normal = resolveCityScale(legacy.cities, [{ city: '낙양', level: 0 }]).cities.find(
      (row) => row.name === '낙양',
    )!;
    expect(normal.max).toEqual(WASTELAND_MAX);
    expect(normal.initial).toEqual(WASTELAND_INITIAL);
  });

  it('원판의 CITY 무·경을 받으며 PASS의 내부 0은 무로 기록하지 않는다', () => {
    const source = operationalAnchors(operationalMapSchema.parse(integration));
    const luoyang = source.find((city) => city.name === '낙양')!;
    luoyang.level = 9;
    const village = source.find((city) => city.kind === 'CITY' && city.name !== '낙양')!;
    Object.assign(village, { level: 0, max: { ...WASTELAND_MAX }, initial: { ...WASTELAND_INITIAL } });
    const result = resolveCityScale(source);
    expect(result.record?.cities).toHaveLength(2);
    expect(result.cities.find((city) => city.id === luoyang.id)!.max).toEqual(luoyang.max);
    expect(result.record?.cities.some((row) => source.find((city) => city.id === row.cityKey)!.kind === 'PASS')).toBe(
      false,
    );
    const map = operationalMapSchema.parse(integration);
    for (const site of map.sites) {
      if (site.kind !== 'CITY') continue;
      const anchor = source.find((city) => city.id === site.anchorKey)!;
      Object.assign(site, { level: anchor.level, max: anchor.max, initial: anchor.initial });
    }
    expect(validateMap(map, { scenarios: [] }).status).toBe('pass');
  });

  it.each([
    [{ city: '없는 도시', level: 5 }],
    [
      { city: '낙양', level: 9 },
      { city: '낙양', level: 9 },
    ],
    [{ city: '업', level: 9 }],
    [{ city: '낙양', level: 10 }],
  ])('잘못된 대상·중복·경 도시·범위를 거부한다: %j', (...requests) => {
    expect(() => resolveCityScale(legacy.cities, requests)).toThrow();
  });

  it('PASS 덮어쓰기·표본 누락·고정값이 다른 원판 무를 거부한다', () => {
    const source = operationalAnchors(operationalMapSchema.parse(integration));
    expect(() =>
      resolveCityScale(source, [{ city: source.find((city) => city.kind === 'PASS')!.name, level: 0 }]),
    ).toThrow('도시');
    expect(() =>
      resolveCityScale(
        legacy.cities.filter((city) => city.level !== 7),
        [{ city: '낙양', level: 7 }],
      ),
    ).toThrow('표본');
    expect(() => resolveCityScale([{ ...legacy.cities[0]!, level: 0 }])).toThrow('무 규모');
  });

  it('두 지도·시나리오 검증기가 같은 도시 규모 오류를 거부한다', () => {
    const bad = { ...scenario, cityScale: { cities: [{ city: '없는 도시', level: 5 }] } };
    expect(validateMap(legacy, { scenarios: [bad] }).status).toBe('fail');
    expect(validateScenario(bad, { map: legacy }).status).toBe('fail');
    expect(validateEditorMap(legacy, { scenarios: [{ key: 'scale', content: bad }] }).ok).toBe(false);
    expect(validateEditorScenario(bad, { map: legacy }).ok).toBe(false);
    const good = { ...scenario, cityScale: { cities: [{ city: '낙양', level: 9, ruin: true }] } };
    expect(validateMap(legacy, { scenarios: [good] }).status).toBe('pass');
    expect(validateEditorScenario(good, { map: legacy }).ok).toBe(true);
  });

  it('시나리오는 빈 지정·중복·알 수 없는 칸을 거부하고 기존 입력에는 새 키를 넣지 않는다', () => {
    expect(scenarioSchema.parse(scenario)).toEqual(scenario);
    for (const cities of [
      [{ city: '낙양' }],
      [{ city: '낙양', ruin: false }],
      [{ city: '낙양', level: 5, extra: true }],
      [
        { city: '낙양', level: 5 },
        { city: '낙양', ruin: true },
      ],
    ])
      expect(scenarioSchema.safeParse({ ...scenario, cityScale: { cities } }).success).toBe(false);
  });
});
