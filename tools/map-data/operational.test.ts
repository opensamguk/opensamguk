import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileOperationalGraph, operationalMapSchema } from '../../packages/rules/src/world/map/operational';
import { validateMap } from '../../packages/rules/src/world/validate/map';
import { createCampaignDraft } from '../../apps/web/src/mapEditor/campaignSeed';
import { buildOperationalMap, legacyAnchorCorrespondence } from './operational';

const root = new URL('../../', import.meta.url);
function path(from: number, to: number, map = buildOperationalMap()): number[] | null {
  const graph = new Map(compileOperationalGraph(map).map((node) => [node.cityKey, node.connections]));
  const pending = [[from]],
    seen = new Set([from]);
  while (pending.length) {
    const current = pending.shift()!;
    if (current.at(-1) === to) return current;
    for (const next of graph.get(current.at(-1)!) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        pending.push([...current, next]);
      }
  }
  return null;
}

it('INT-03 정식80표식은 61운영 거점과 6항구 시설·13전장으로 분리되고 전체가 연결된다', () => {
  const map = buildOperationalMap();
  expect(
    ['CITY', 'PASS', 'PORT', 'FIELD'].map((kind) => map.sites.filter((site) => site.kind === kind).length),
  ).toEqual([53, 8, 6, 13]);
  expect(compileOperationalGraph(map)).toHaveLength(61);
  expect(compileOperationalGraph(map).every((node) => !/port|field/.test(node.siteId))).toBe(true);
  expect(validateMap(map).issues).toEqual([]);
  for (const node of compileOperationalGraph(map)) expect(path(1, node.cityKey)).not.toBeNull();
});

it('INT-03 정식 자원·대응표와 생성 결과가 같고 GIS 원본 SHA와 좌표가 일치한다', () => {
  const first = buildOperationalMap();
  expect(buildOperationalMap()).toEqual(first);
  expect(JSON.parse(readFileSync(new URL('resources/map/integration.json', root), 'utf8'))).toEqual(first);
  expect(JSON.parse(readFileSync(new URL('resources/map/integration-correspondence.json', root), 'utf8'))).toEqual(
    legacyAnchorCorrespondence(),
  );
  expect(first.basemap.sha256).toBe(
    createHash('sha256')
      .update(readFileSync(new URL('apps/web/src/mapEditor/geodata/natural-earth.json', root)))
      .digest('hex'),
  );
  for (const site of first.sites) {
    const draft = createCampaignDraft().sites.find((row) => row.id === site.id)!;
    expect(site.position).toEqual({ x: draft.x, y: draft.y });
  }
  expect(first.sites.find((site) => site.id === 'pass:75')?.name).toBe('양평관');
  expect(first.sites.find((site) => site.id === 'city:99')?.name).toBe('양평');
  expect(first.sites.find((site) => site.id === 'city:99')).not.toHaveProperty('legacyCityId');
});

it('INT-03 장안·낙양과 한중·성도는 명시한 관문을 지나고 장판은 이동 턴을 만들지 않는다', () => {
  expect(path(4, 3)).toEqual([4, 100, 42, 73, 3]);
  expect(path(24, 5)).toEqual([24, 75, 102, 44, 87, 5]);
  expect(path(6, 13)).toEqual([6, 13]);
  const edge = buildOperationalMap().routes.find((route) => route.from === 'city:6' && route.to === 'city:13');
  expect(edge?.via).toEqual(['field:89']);
});

it('INT-03 차단된 길목을 자동 우회하지 않으며 활성 연결만 그래프에 포함한다', () => {
  const map = buildOperationalMap();
  map.routes = map.routes.filter((route) =>
    ['route:land-4-100', 'route:land-100-42', 'route:land-42-73', 'route:land-73-3'].includes(route.id),
  );
  expect(path(4, 3, map)).toEqual([4, 100, 42, 73, 3]);
  map.routes.find((route) => route.id === 'route:land-42-73')!.enabled = false;
  expect(path(4, 3, map)).toBeNull();
  expect(validateMap(map).issues.length).toBeGreaterThan(0);
});

it('INT-03 모든 수로의 양끝은 해당 도시 항구이며 다른 도시 귀속과 전장 목표를 거부한다', () => {
  const map = buildOperationalMap();
  expect(map.routes.filter((route) => route.mode === 'RIVER')).toHaveLength(5);
  expect(new Set(map.routes.flatMap((route) => route.portIds ?? [])).size).toBe(6);
  const river = map.routes.find((route) => route.mode === 'RIVER')!;
  river.portIds = ['port:7', 'port:52'];
  expect(operationalMapSchema.safeParse(map).success).toBe(false);
  const target = buildOperationalMap();
  target.routes[0]!.to = 'field:90';
  expect(operationalMapSchema.safeParse(target).success).toBe(false);
});

it('INT-03 기존 도시 경제 값은 같은 원본 ID의 값을 보존한다', () => {
  const legacy = JSON.parse(readFileSync(new URL('resources/map/che.json', root), 'utf8')) as {
    cities: Array<{ id: number; level: number; region: number; initial: unknown; max: unknown }>;
  };
  for (const site of buildOperationalMap().sites) {
    if (site.kind !== 'CITY' || site.legacyCityId === undefined) continue;
    const old = legacy.cities.find((city) => city.id === site.legacyCityId)!;
    expect({ level: site.level, region: site.region, initial: site.initial, max: site.max }).toEqual({
      level: old.level,
      region: old.region,
      initial: old.initial,
      max: old.max,
    });
  }
});
