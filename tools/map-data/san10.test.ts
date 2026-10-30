import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildSan10Map, buildSan10Scenarios } from './san10';
import { buildInitialWorld } from '../../packages/rules/src/world/bootstrap';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { operationalMapSchema } from '../../packages/rules/src/world/map/operational';
import { publicGeographySchema } from '../../packages/shared/src/publicGeography';
import { hashState } from '../../packages/shared/src/node/hashState';
import { loadInitialWorld, loadPreset, resolveWorldResourceSelection } from '../../apps/engine/src/world/resources';
import { san10ResourceRows } from '../san10-resources';
import { prepareInitialWorld } from '../../apps/engine/src/world/persistence';
import { toWorldState } from '../../packages/rules/src/model/world';
import { emptyCityResourcesState, readCityResourcesState } from '../../packages/rules/src/cityResources/state';

const root = new URL('../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const hash = createHash('sha256')
  .update(readFileSync(new URL('apps/web/src/main/san10-basemap.json', root)))
  .digest('hex');
const map = buildSan10Map(hash);
const { historical, empty } = buildSan10Scenarios(map);
const materials = {
  map,
  unitSet: read('resources/unitset/basic.json'),
  statRules: read('resources/scenario/five-stats.json'),
  portraitMap: read('resources/portraits/191-map.json'),
};

it('D-045: 159표식·152전략 거점에 제안 45개를 포함한 200도로가 양방향 활성화된다', () => {
  expect(map).toEqual(read('resources/map/san10.json'));
  expect(map.sites).toHaveLength(159);
  expect(map.sites.filter((site) => 'anchorKey' in site)).toHaveLength(152);
  expect(map.routes).toHaveLength(200);
  expect(map.routes.every((route) => route.enabled && route.mode === 'LAND' && route.direction === 'BOTH')).toBe(true);
  expect(new Set(map.routes.map((route) => [route.from, route.to].sort().join('/'))).size).toBe(200);
  for (const scenario of [historical, empty])
    expect(validateWorldResources({ ...materials, scenario }).status).toBe('pass');
  const byName = new Map(map.sites.map((site) => [site.name, site.id]));
  for (const [from, to] of [
    ['상용', '영안'],
    ['경구', '부춘'],
  ])
    expect(
      map.routes.some(
        (route) =>
          [route.from, route.to].includes(byName.get(from!)!) && [route.from, route.to].includes(byName.get(to!)!),
      ),
    ).toBe(false);
  expect(map.routes.some((route) => route.from === byName.get('구야국') && route.to === byName.get('대마국'))).toBe(
    true,
  );
});

it('두 시나리오는 동일한 지리·도로를 쓰고 역사는21국491명, 공백지는180년 전원 재야다', async () => {
  const a = await loadInitialWorld({ map: 'san10', scenario: 'san10-191', seed: 'san10-deterministic' });
  const b = await loadInitialWorld({ map: 'san10', scenario: 'san10-empty', seed: 'san10-deterministic' });
  expect([a.startYear, a.nations.length, a.generals.length, a.cities.length]).toEqual([191, 21, 491, 152]);
  expect([b.startYear, b.nations.length, b.generals.length, b.cities.length]).toEqual([180, 0, 491, 152]);
  expect(b.diplomacies).toEqual([]);
  expect(b.cities.every((city) => city.nationId === null)).toBe(true);
  expect(b.generals.every((general) => general.nationId === null)).toBe(true);
  expect(b.generals.every((general) => general.officerLevel === 0)).toBe(true);
  expect(a.operationalMap).toEqual(b.operationalMap);
  expect(a.cities.map(({ cityKey, x, y, connections }) => ({ cityKey, x, y, connections }))).toEqual(
    b.cities.map(({ cityKey, x, y, connections }) => ({ cityKey, x, y, connections })),
  );
  expect(
    a.generals.map((general) => [general.id, general.name, general.nationId, general.leadership, general.politics]),
  ).toEqual(
    buildInitialWorld({ ...materials, scenario: historical, seed: 'san10-deterministic' }).generals.map((general) => [
      general.id,
      general.name,
      general.nationId,
      general.leadership,
      general.politics,
    ]),
  );
  expect(hashState(b)).toBe(
    hashState(await loadInitialWorld({ map: 'san10', scenario: 'san10-empty', seed: 'san10-deterministic' })),
  );
  expect((await loadPreset('regular')).map).toBe('san10');
  expect((await loadPreset('empty')).scenario).toBe('san10-empty');
  expect((await san10ResourceRows()).map((row) => row.contentHash)).toEqual([map, historical, empty].map(hashState));
});

it('가변 캔버스도 실제 범위를 넘는 점·잘못된 GIS 범위·과대 면적을 거부한다', () => {
  const outside = structuredClone(map);
  outside.sites[0]!.position.x = map.canvas.width + 1;
  expect(operationalMapSchema.safeParse(outside).success).toBe(false);
  expect(publicGeographySchema.safeParse(outside).success).toBe(false);
  const oversized = structuredClone(map);
  oversized.canvas = { width: 4096, height: 4096 };
  expect(operationalMapSchema.safeParse(oversized).success).toBe(false);
  expect(
    operationalMapSchema.safeParse({ ...map, basemap: { ...map.basemap, bounds: [140, 50, 94, 20] } }).success,
  ).toBe(false);
});

it('SAN10 파일·게시·생성·재생 추론은 같은 기본 자원 선택을 쓰고 구판·명시값을 보존한다', () => {
  expect(resolveWorldResourceSelection({ map: 'san10', scenario: 'san10-191' })).toEqual({
    map: 'san10',
    scenario: 'san10-191',
    unitSet: 'basic',
    statRules: 'five-stats',
    portraitMap: '191-map',
  });
  expect(resolveWorldResourceSelection({ map: 'san10', scenario: 'san10-empty' }).statRules).toBe('five-stats');
  expect(resolveWorldResourceSelection({ map: 'che', scenario: '1030' })).toEqual({
    map: 'che',
    scenario: '1030',
    unitSet: 'basic',
    statRules: 'default',
    portraitMap: 'rtk14-map',
  });
  expect(
    resolveWorldResourceSelection({
      map: 'san10',
      scenario: 'san10-191',
      statRules: 'default',
      portraitMap: 'rtk14-map',
      unitSet: 'custom',
    }),
  ).toEqual({ map: 'san10', scenario: 'san10-191', statRules: 'default', portraitMap: 'rtk14-map', unitSet: 'custom' });
  expect(() => resolveWorldResourceSelection({ map: '../san10', scenario: 'san10-191' })).toThrow();
});

it('역사491명의 ID·소속·5능력치·초상은 기존191정본과 같고 공백지에서도 ID·능력치를 보존한다', async () => {
  const original = await loadInitialWorld({
    map: 'integration',
    scenario: 'integration191',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'san10-identity',
  });
  const historical = await loadInitialWorld({ map: 'san10', scenario: 'san10-191', seed: 'san10-identity' });
  const empty = await loadInitialWorld({ map: 'san10', scenario: 'san10-empty', seed: 'san10-identity' });
  const identity = ({
    id,
    name,
    leadership,
    strength,
    intel,
    politics,
    charm,
    portraitId,
  }: (typeof original.generals)[number]) => ({ id, name, leadership, strength, intel, politics, charm, portraitId });
  expect(historical.generals.map(identity)).toEqual(original.generals.map(identity));
  expect(empty.generals.map(identity)).toEqual(original.generals.map(identity));
  expect(historical.generals.map(({ id, nationId }) => ({ id, nationId }))).toEqual(
    original.generals.map(({ id, nationId }) => ({ id, nationId })),
  );
  expect(historical.nations.map(({ id, name }) => ({ id, name }))).toEqual(
    original.nations.map(({ id, name }) => ({ id, name })),
  );
});

it.each(['san10-191', 'san10-empty'])('%s의 9기능 원생성은152거점 빈 원장 하나만 허용한다', async (scenario) => {
  const initial = await loadInitialWorld({ map: 'san10', scenario, seed: 'san10-ledger' });
  const features = [
    'campaign-assignment-v2',
    'campaign-v1',
    'city-resources-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
    'stratagem-basic',
    'treaty',
  ];
  initial.ruleFeatures = [...features];
  const before = hashState(initial),
    state = toWorldState(initial),
    ledger = emptyCityResourcesState(state);
  expect(Object.keys(ledger.cities).sort()).toEqual(initial.cities.map((city) => String(city.cityKey)).sort());
  expect(Object.values(ledger.cities)).toHaveLength(152);
  expect(
    Object.values(ledger.cities).every((city) => city.gold === 0 && city.rice === 0 && city.garrison.length === 0),
  ).toBe(true);
  expect(() =>
    prepareInitialWorld(initial, { name: '새 지도 정본', turnTermMinutes: 60, endYear: 300, ruleFeatures: features }),
  ).not.toThrow();
  const missing = structuredClone(ledger);
  delete missing.cities[Object.keys(missing.cities)[0]!];
  expect(() => readCityResourcesState(missing, state)).toThrow();
  expect(() =>
    readCityResourcesState(
      { ...ledger, cities: { ...ledger.cities, '999999': { gold: 0, rice: 0, garrison: [] } } },
      state,
    ),
  ).toThrow();
  expect(hashState(initial)).toBe(before);
});
