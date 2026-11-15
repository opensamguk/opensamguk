import { providedRuleKeys } from '@opensamguk/rules';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  compileOperationalGraph,
  isStrategicSite,
  operationalMapSchema,
} from '../../packages/rules/src/world/map/operational';
import { operationalAnchors } from '../../packages/rules/src/world/map/anchors';
import {
  attachOperationalKinds,
  operationalMapDisplay,
  readOperationalMap,
} from '../../packages/rules/src/world/map/stored';
import { publicGeographySchema } from '../../packages/shared/src/publicGeography';
import { buildInitialWorld } from '../../packages/rules/src/world/bootstrap';
import { checkOperationalProfile } from '../../packages/rules/src/world/map/profile';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { hashState } from '../../packages/shared/src/node/hashState';
import { initialReplayState, settleReplayMonth } from '../../packages/rules/src/replay';
import { TICKS_PER_MONTH } from '../../packages/rules/src/clock/constants';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const map = operationalMapSchema.parse(read('resources/map/san10-expanded.json'));

it('AC-INT-27: 323거점·585길·설명 정본과 D-096의 비소유 분류를 읽는다', () => {
  expect(map.sites).toHaveLength(323);
  expect(map.routes).toHaveLength(585);
  expect(Object.fromEntries(map.sites.map((site) => [site.id, site.description]))).toEqual(
    read('resources/map/san10-expanded-descriptions.json').descriptions,
  );
  expect(map.sites.every((site) => (site.description?.length ?? 0) <= 600)).toBe(true);
  expect(map.sites.filter((site) => site.kind === 'FIELD')).toHaveLength(38);
  expect(operationalAnchors(map)).toHaveLength(323);
  expect(
    operationalAnchors(map).every((site) => site.kind !== 'CITY' || [1, 2, 4, 5, 6, 7, 8, 9].includes(site.level)),
  ).toBe(true);
  const publicMap = publicGeographySchema.parse(operationalMapDisplay(map));
  for (const site of publicMap.sites) {
    expect(site).not.toHaveProperty('initial');
    expect(site).not.toHaveProperty('max');
    expect(site).not.toHaveProperty('nationId');
    if (site.siteLevel !== undefined && [0, 3].includes(site.siteLevel)) expect(site).not.toHaveProperty('anchorKey');
  }
  expect(publicMap.sites.find((site) => site.name === '강유')).toMatchObject({ kind: 'FIELD' });
  for (const name of ['역양', '주제', '합포', '주천', '오원', '음평', '남안'])
    expect(map.sites.find((site) => site.name === name)).toMatchObject({ kind: 'CITY', level: 5 });
  expect(map.sites.find((site) => site.name === '한가')).toMatchObject({ level: 2 });
  expect(map.sites.find((site) => site.name === '이주')).toMatchObject({ level: 4, region: 16 });
  for (const rename of read('resources/map/san10-expanded-site-edits.json').renames) {
    expect(map.sites.some((site) => site.name === rename.from)).toBe(false);
    expect(map.sites.some((site) => site.name === rename.to)).toBe(true);
  }
  for (const move of read('resources/map/san10-expanded-site-moves.json').moves)
    expect(map.sites.find((site) => site.id === move.id)?.position).toEqual(move.to);
});

it('AC-INT-27: 전체 전략 거점을 양방향으로 연결하고 육로와 물길을 따로 보존한다', () => {
  const graph = compileOperationalGraph(map);
  const byKey = new Map(graph.map((row) => [row.cityKey, row]));
  for (const origin of graph) {
    const seen = new Set([origin.cityKey]),
      queue = [origin.cityKey];
    for (let i = 0; i < queue.length; i++)
      for (const key of byKey.get(queue[i]!)!.connections)
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(key);
        }
    expect(seen.size).toBe(graph.length);
    for (const key of origin.connections) expect(byKey.get(key)!.connections).toContain(origin.cityKey);
  }
  expect(new Set(map.routes.map((route) => route.mode))).toEqual(new Set(['LAND', 'FORD', 'RIVER', 'SEA']));
  const pairs = new Map<string, Set<string>>();
  for (const route of map.routes) {
    const key = [route.from, route.to].sort().join('|');
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key)!.add(route.mode);
  }
  expect([...pairs.values()].some((modes) => modes.has('LAND') && modes.has('RIVER'))).toBe(true);
  const names = new Map(map.sites.map((site) => [site.name, site.id]));
  for (const [from, to] of [
    ['음평', '음평 샛길'],
    ['음평 샛길', '강유'],
    ['강유', '면죽관'],
    ['음평', '검각'],
  ])
    expect(
      map.routes.some(
        (route) =>
          [route.from, route.to].includes(names.get(from!)!) && [route.from, route.to].includes(names.get(to!)!),
      ),
    ).toBe(true);
});

it('AC-INT-27: 표식 경유는 방향·활성 상태를 지키고 다음 전략 거점에서 멈춘다', () => {
  const sample = structuredClone(map);
  delete sample.capturableFields;
  for (const site of sample.sites)
    if (site.kind === 'FIELD') {
      delete site.anchorKey;
      delete site.region;
    }
  const [a, b, c] = sample.sites.filter((site) => isStrategicSite(sample, site));
  const marker = sample.sites.find((site) => site.kind === 'FIELD')!;
  sample.sites = [a!, b!, c!, marker];
  for (const site of sample.sites) if (site.kind === 'CITY') delete site.parentCityKey;
  sample.routes = [
    { id: 'route:a', from: a!.id, to: marker.id, mode: 'SEA', direction: 'FORWARD', enabled: true },
    { id: 'route:b', from: marker.id, to: b!.id, mode: 'LAND', direction: 'BOTH', enabled: true },
    { id: 'route:c', from: b!.id, to: c!.id, mode: 'LAND', direction: 'BOTH', enabled: true },
    { id: 'route:disabled', from: a!.id, to: c!.id, mode: 'LAND', direction: 'BOTH', enabled: false },
  ];
  const graph = new Map(compileOperationalGraph(sample).map((row) => [row.siteId, row]));
  expect(graph.get(a!.id)!.connections).toEqual([b!.anchorKey]);
  expect(graph.get(b!.id)!.connections).toEqual([c!.anchorKey]);
  expect(graph.get(c!.id)!.connections).toEqual([b!.anchorKey]);
});

it('AC-INT-27: 새 지도 월드의 재생 원장·종류 재적재와 초기 해시가 일치한다', () => {
  const scenario = { ...read('resources/scenario/san10-empty.json'), requiredMap: map.id };
  const materials = {
    map,
    scenario,
    unitSet: read('resources/unitset/expanded.json'),
    statRules: read('resources/scenario/five-stats.json'),
    portraitMap: { portraits: {} },
  };
  expect(validateWorldResources(materials).status).toBe('pass');
  const initial = buildInitialWorld({ ...materials, seed: 'int27-map', mapKey: 'san10-expanded@3' });
  checkOperationalProfile(initial);
  expect(initial.cities).toHaveLength(323);
  expect(providedRuleKeys).toContain('capturable-field-v1');
  const disabled = structuredClone(initial);
  expect(() => checkOperationalProfile(disabled)).toThrow();
  expect(() => readOperationalMap(map)).toThrow();
  expect(initial.cities.every((city) => city.nationId === null)).toBe(true);
  expect(attachOperationalKinds(initial.cities, map)).toEqual(initial.cities);
  expect(readOperationalMap(JSON.parse(JSON.stringify(map)), { initial })).toEqual(map);
  expect(hashState(initial)).toBe(
    hashState(buildInitialWorld({ ...materials, seed: 'int27-map', mapKey: 'san10-expanded@3' })),
  );
  const replay = initialReplayState(initial);
  const reloaded = initialReplayState(JSON.parse(JSON.stringify(initial)));
  expect(settleReplayMonth(replay, initial.seed, TICKS_PER_MONTH)).toEqual(
    settleReplayMonth(reloaded, initial.seed, TICKS_PER_MONTH),
  );
});

it('AC-INT-27: 구판에는 D-096을 추론하지 않고 설명 길이·없는 끝점은 거절한다', () => {
  const old = operationalMapSchema.parse(read('resources/map/san10.json'));
  expect(compileOperationalGraph(old)).toHaveLength(155);
  expect(compileOperationalGraph(old).reduce((n, row) => n + row.connections.length, 0)).toBe(382);
  expect(publicGeographySchema.parse(operationalMapDisplay(old))).toEqual(publicGeographySchema.parse(old));
  const bad = structuredClone(map);
  bad.sites[0]!.description = '가'.repeat(601);
  expect(operationalMapSchema.safeParse(bad).success).toBe(false);
  bad.sites[0]!.description = '';
  bad.routes[0]!.to = 'field:missing';
  expect(operationalMapSchema.safeParse(bad).success).toBe(false);
  const noEconomy = structuredClone(map);
  for (const site of noEconomy.sites) if (site.kind === 'CITY') site.level = 2;
  expect(operationalMapSchema.safeParse(noEconomy).success).toBe(false);
});
