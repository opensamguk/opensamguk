import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { providedRuleKeys } from '../../packages/rules/src/providedRules';
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
import { rngFor } from '../../packages/shared/src/rng';
import { commandWorld, testUnits } from '../../packages/rules/test/commandFixture';
import { applyEffects } from '../../packages/rules/src/commands/effects';
import { emptyCampaignState } from '../../packages/rules/src/campaign/state';
import { emptyCityResourcesState } from '../../packages/rules/src/cityResources/state';
import { campaignAttack } from '../../packages/rules/src/campaign/attack';
import { buildSupplyLedger, previewMarchSupply } from '../../packages/rules/src/campaign/supply';
import { tacticalMap } from '../../packages/rules/src/tactical/map';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const map = operationalMapSchema.parse(read('resources/map/san10-expanded.json'));
const materials = {
  map,
  scenario: { ...read('resources/scenario/san10-empty.json'), requiredMap: map.id },
  unitSet: read('resources/unitset/expanded.json'),
  statRules: read('resources/scenario/five-stats.json'),
  portraitMap: { portraits: {} },
};

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
  expect(validateWorldResources(materials).status).toBe('pass');
  const initial = buildInitialWorld({ ...materials, seed: 'int27-map', mapKey: 'san10-expanded@3' });
  checkOperationalProfile(initial);
  expect(initial.cities).toHaveLength(323);
  expect(providedRuleKeys).toContain('capturable-field-v1');
  const wrongAnchors = { ...initial, cities: initial.cities.slice(1) };
  expect(() => checkOperationalProfile(wrongAnchors)).toThrow('앵커 수');
  const wrongMap = {
    ...map,
    sites: map.sites.map((site, index) => (index === 0 ? { ...site, name: '다른 이름' } : site)),
  };
  expect(() => readOperationalMap(wrongMap, { initial })).toThrow('생성 기록');
  expect(initial.cities.every((city) => city.nationId === null)).toBe(true);
  expect(attachOperationalKinds(initial.cities, map)).toEqual(initial.cities);
  expect(readOperationalMap(JSON.parse(JSON.stringify(initial.operationalMap)), { initial })).toEqual(
    initial.operationalMap,
  );
  expect(publicGeographySchema.parse(operationalMapDisplay(initial.operationalMap!)).territory).toEqual(
    initial.operationalMap!.territory,
  );
  expect(hashState(initial)).toBe(
    hashState(buildInitialWorld({ ...materials, seed: 'int27-map', mapKey: 'san10-expanded@3' })),
  );
  // The world creation path resolves the sex ledger before building the replay state.
  for (const general of initial.generals) general.sex = 'UNKNOWN';
  const replay = initialReplayState(initial);
  const reloaded = initialReplayState(JSON.parse(JSON.stringify(initial)));
  expect(settleReplayMonth(replay, initial.seed, TICKS_PER_MONTH)).toEqual(
    settleReplayMonth(reloaded, initial.seed, TICKS_PER_MONTH),
  );
});

function expandedCampaign(supplyMap = map) {
  const initial = buildInitialWorld({ ...materials, map: supplyMap, seed: 'int28-supply' });
  const world = commandWorld();
  world.cities = Object.fromEntries(initial.cities.map((city) => [city.cityKey, city]));
  world.generals = { 1: { ...world.generals[1]!, rice: 100_000, crew: 0 } };
  world.campaign = emptyCampaignState(world, initial.seed, initial.scenarioKey);
  world.campaign.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 100, atmos: 100 }];
  world.campaign.nextUnitId = 2;
  world.campaign.supplyLedger = buildSupplyLedger(initial.operationalMap!);
  world.cityResources = emptyCityResourcesState(world);
  return { world, grid: initial.operationalMap!.territory! };
}

it('AC-INT-28: 확장 지도의 실제 산악 구간에 3 SP를 적용하고 해상에는 산·오지를 적용하지 않는다', () => {
  const { world } = expandedCampaign();
  const ledger = world.campaign!.supplyLedger!;
  expect(ledger.cellSize).toBe(8);
  const route = ledger.routes.find(
    ({ segments: [s] }) =>
      s?.mode === 'LAND' && s.cells.length >= 3 && s.cells.slice(1).some((c) => c.mountain && !c.remote),
  )!;
  Object.assign(world.generals[1]!, { cityKey: route.from, nationId: 1 });
  world.cities[route.from]!.nationId = 1;
  const preview = previewMarchSupply(world, world.campaign!.units[0]!, route.to, {})!;
  const board = tacticalMap(world, route, route.to, 1);
  expect(board.cells.some((cell) => cell.sourceTileId && cell.spCost === 3)).toBe(true);
  expect(preview.estimatedCost).toBeGreaterThan(route.segments[0]!.cells.length - 1);
  expect(
    ledger.routes
      .flatMap(({ segments }) => segments)
      .filter(({ mode }) => mode === 'SEA')
      .every(({ cells }) => cells.every((cell) => !cell.remote && !cell.mountain)),
  ).toBe(true);
});

it('AC-INT-28: 거점에서 멀리 떨어진 내륙 길에서 오지 비용이 붙고 진입 전에 보급이 고갈된다', () => {
  const sites = map.sites.filter((site) => ['장안', '북평'].includes(site.name));
  expect(sites).toHaveLength(2);
  const routes = [
    {
      id: 'route:remote-test',
      mode: 'LAND' as const,
      from: sites[0]!.id,
      to: sites[1]!.id,
      direction: 'BOTH' as const,
      enabled: true,
    },
  ];
  const { world } = expandedCampaign({ ...map, sites, routes });
  const route = world.campaign!.supplyLedger!.routes[0]!;
  const cells = route.segments[0]!.cells.slice(1);
  const index = cells.findIndex((cell) => cell.remote);
  expect(index).toBeGreaterThan(0);
  const supplyLoad = cells
    .slice(0, index)
    .reduce((sp, cell) => sp + (cell.mountain ? 3 : 1) * (cell.remote ? 2 : 1), 0);
  Object.assign(world.generals[1]!, { cityKey: route.from, nationId: 1 });
  world.cities[route.from]!.nationId = 1;
  const preview = previewMarchSupply(world, world.campaign!.units[0]!, route.to, { supplyLoad })!;
  expect(preview.exhaustedAt).toMatchObject({
    cellId: cells[index]!.cellId,
    required: cells[index]!.mountain ? 6 : 2,
    available: 0,
  });
});

it('AC-INT-28: 실지도 전장 38곳 각각에서 출병해 점령하고 주변 영지는 그대로 둔다', () => {
  const { world, grid } = expandedCampaign();
  const fields = Object.values(world.cities).filter((city) => city.kind === 'FIELD');
  expect(fields).toHaveLength(38);
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  for (const field of fields) {
    expect(field.nationId).toBeNull();
    expect(grid.owner).not.toContain(field.cityKey);
    const inbound = world.campaign!.supplyLedger!.routes.filter((route) => route.to === field.cityKey);
    let occupied = false;
    for (const route of inbound) {
      const from = world.cities[route.from]!;
      from.nationId = 1;
      from.supplied = true;
      world.nations[1]!.capitalCityKey = from.cityKey;
      world.generals[1]!.cityKey = from.cityKey;
      world.cityResources!.cities[String(from.cityKey)]!.rice = 100_000;
      const input = { cityKey: field.cityKey, supplyLoad: 100 };
      if (campaignAttack.check(world, actor, input) === null) {
        const preview = previewMarchSupply(world, world.campaign!.units[0]!, field.cityKey, input)!;
        if (preview.reachable) {
          const result = campaignAttack.execute(world, actor, input, rngFor('expanded-field', field.cityKey));
          const captured = applyEffects(world, result.effects);
          expect(captured.cities[field.cityKey]!.nationId, field.name).toBe(1);
          expect(captured.campaign!.units[0]!.supply?.remaining).toBe(preview.estimatedRemaining);
          expect(
            Object.values(captured.cities)
              .filter((city) => city.nationId === 1)
              .map((city) => city.cityKey)
              .sort(),
          ).toEqual([from.cityKey, field.cityKey].sort());
          occupied = true;
        }
      }
      from.nationId = null;
      if (occupied) break;
    }
    expect(occupied, field.name).toBe(true);
  }
}, 20_000);

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
