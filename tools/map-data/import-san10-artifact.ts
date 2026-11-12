import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildInitialWorld } from '../../packages/rules/src/world/bootstrap';
import { operationalMapSchema, type OperationalMapResource } from '../../packages/rules/src/world/map/operational';
import { scenarioSchema, type ScenarioResource } from '../../packages/rules/src/world/resources';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { hashState } from '../../packages/shared/src/node/hashState';

type Site = [string, number, number, 'C' | 'P', number, number];
type Roster = [
  number,
  string,
  string,
  number | null,
  number | null,
  string,
  number,
  string,
  [number, number, number, number, number],
  string,
];
type Entry = {
  id: string;
  type: string;
  year: number;
  month: number;
  title: string;
  desc: string;
  factions: { name: string; ruler: number | null; color: string; capital: string; cities: string[] }[];
  officers: [number, number, string][];
};
type Source = { sites: Site[]; routes: [string, string, string][]; roster: Roster[]; scenarios: Entry[] };
const sourceUrl = 'https://claude.ai/artifact/YDyLtPmfANcJ6uqj8Vpi82';
const sourceHash = '023f60bf7625f0a318ad6a9ed22224fab564c57d7bae83e5467e4ac5c5e48275';
const mapId = 'san10-expanded';
const factionColorSource = 'https://namu.wiki/w/삼국지%20시리즈/상징색';
const san10FactionColors = new Map(
  Object.entries({
    조조: '#2929ef',
    조비: '#2929ef',
    조예: '#2929ef',
    조방: '#2929ef',
    조모: '#2929ef',
    조환: '#2929ef',
    유비: '#397b00',
    유선: '#397b00',
    손견: '#d60029',
    손책: '#d60029',
    손권: '#d60029',
    손량: '#d60029',
    손휴: '#d60029',
    손호: '#d60029',
    공손찬: '#e74a00',
    도겸: '#c6ff8c',
    동탁: '#6b6b6b',
    이각: '#6b6b6b',
    여포: '#b57b8c',
    장제: '#6b6b6b',
    장수: '#6b6b6b',
    마등: '#9c6b00',
    마초: '#9c6b00',
    한수: '#e7e721',
    맹획: '#f39700',
    원소: '#ffff00',
    원상: '#ffff00',
    원술: '#ef8cf7',
    유언: '#18004a',
    유장: '#18004a',
    유표: '#5acef7',
    유기: '#5acef7',
    장각: '#f7b500',
    하진: '#524a31',
    공손도: '#c6adef',
    공손강: '#c6adef',
    공손공: '#c6adef',
    공손연: '#c6adef',
    공융: '#ce089c',
    공주: '#b5efde',
    사섭: '#c6ad6b',
    엄백호: '#9c9463',
    왕랑: '#efefce',
    유대: '#9c9cef',
    유요: '#736bef',
    유우: '#730052',
    장로: '#cee79c',
    장양: '#521800',
    장연: '#4242ad',
    정원: '#b57b8c',
    한복: '#843900',
  }),
);
const aliases = new Map(
  Object.entries({ 무위: '서량', 자동: '재동', 구원: '오원', 역경: '역현', 하동: '평양', 남창: '예장', 불이: '불내' }),
);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir || process.argv.length !== 4) throw Error('입력 JSON과 새 출력 디렉터리를 지정하세요.');
const input = await readFile(inputPath);
if (createHash('sha256').update(input).digest('hex') !== sourceHash) throw Error('아티팩트 JSON SHA-256이 다릅니다.');
const source: Source = JSON.parse(input.toString('utf8'));
const base = operationalMapSchema.parse(await read('../../resources/map/san10.json'));
const unitSet = await read('../../resources/unitset/expanded.json');
const statRules = await read('../../resources/scenario/five-stats.json');
const oldSites = new Map(base.sites.map((site) => [aliases.get(site.name) ?? site.name, site]));
const oldCities = base.sites.filter(
  (site): site is Extract<OperationalMapResource['sites'][number], { kind: 'CITY' }> => site.kind === 'CITY',
);
const sites = source.sites.map(([name, x, y, kind, level, region], i): OperationalMapResource['sites'][number] => {
  const position = { x, y };
  const old = oldSites.get(name);
  if (old) {
    if (old.kind !== (kind === 'P' ? 'PASS' : 'CITY')) throw Error(`거점 종류 불일치: ${name}`);
    oldSites.delete(name);
    return { ...old, name, position, region };
  }
  const anchorKey = 10_000 + i;
  if (kind === 'P') {
    const defense = { initial: 1000, max: 3000 };
    return {
      id: `pass:${anchorKey}`,
      name,
      position,
      kind: 'PASS',
      anchorKey,
      region,
      defence: defense,
      wall: defense,
    };
  }
  const peers = oldCities.filter((site) => site.level === level);
  const max = {
    population: level * 50_000,
    agriculture: level * 1000,
    commerce: level * 1000,
    security: 2000,
    defence: level * 2000,
    wall: level * 2000,
  };
  for (const key of Object.keys(max) as (keyof typeof max)[]) {
    const amounts = peers.map((peer) => peer.max[key]).sort((a, b) => a - b);
    if (amounts.length) max[key] = amounts[Math.floor((amounts.length - 1) / 2)]!;
  }
  const initial = {
    population: Math.min(max.population, 100_000),
    agriculture: Math.min(max.agriculture, 1000),
    commerce: Math.min(max.commerce, 1000),
    security: Math.min(max.security, 1000),
    defence: Math.min(max.defence, 3000),
    wall: Math.min(max.wall, 3000),
  };
  return { id: `city:${anchorKey}`, name, position, kind: 'CITY', anchorKey, level, region, initial, max };
});
if (oldSites.size) throw Error(`기존 거점 누락: ${[...oldSites.keys()].join(', ')}`);
const ids = new Map(sites.map((site) => [site.name, site.id]));
const edgeKey = (a: string, b: string) => [a, b].sort().join('|');
const oldRoutes = new Map(base.routes.map((route) => [edgeKey(route.from, route.to), route]));
const routes = source.routes.map(([a, b], i): OperationalMapResource['routes'][number] => {
  const from = ids.get(a);
  const to = ids.get(b);
  if (!from || !to) throw Error(`연결 거점 누락: ${a}–${b}`);
  const key = edgeKey(from, to);
  const old = oldRoutes.get(key);
  oldRoutes.delete(key);
  return old ?? { id: `route:san10-expanded-${i + 1}`, from, to, mode: 'LAND', direction: 'BOTH', enabled: true };
});
if (oldRoutes.size) throw Error(`기존 도로 누락: ${oldRoutes.size}`);
const map = operationalMapSchema.parse({ ...base, id: mapId, name: 'SAN10 확장 확정판', sites, routes });
const roster = new Map(source.roster.map((row) => [row[0], row]));
function hexColor(input: string) {
  if (/^#[\da-f]{6}$/i.test(input)) return input;
  const hsl = input.match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
  if (!hsl) throw Error(`세력 색 형식: ${input}`);
  const h = Number(hsl[1]),
    s = Number(hsl[2]) / 100,
    l = Number(hsl[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
const factionAliases = new Map([
  ['연', '공손연'],
  ['흑산', '장연'],
]);
function factionColor(faction: Entry['factions'][number]) {
  const rulerName = faction.ruler === null ? undefined : roster.get(faction.ruler)?.[1];
  if (faction.name === '유표' && rulerName === '유표(劉豹)') return hexColor(faction.color);
  return san10FactionColors.get(factionAliases.get(faction.name) ?? faction.name) ?? hexColor(faction.color);
}
function compileScenario(entry: Entry): ScenarioResource {
  const id = `san10-expanded-${entry.id}`;
  const general: ScenarioResource['general'] = [];
  const generalStats: NonNullable<ScenarioResource['generalStats']> = [];
  for (const [officerId, faction, city] of entry.officers) {
    const row = roster.get(officerId);
    if (!row) throw Error(`장수 누락: ${officerId}`);
    const [, name, , born, died, , , , [leadership, strength, intel, politics, charm], statSource] = row;
    const nation = entry.factions[faction];
    general.push([
      0,
      name,
      null,
      faction + 1,
      city || null,
      leadership,
      strength,
      intel,
      nation?.ruler === officerId ? 12 : nation ? 1 : 0,
      born ?? 0,
      died ?? 9999,
      null,
      null,
    ]);
    generalStats.push({
      generalId: general.length,
      stats: { leadership, strength, intel, politics, charm },
      sourceId: statSource,
      sourceRevision: sourceHash,
      officerId,
    });
  }
  return scenarioSchema.parse({
    id,
    title: `${entry.year}년 ${entry.title}`,
    startYear: entry.year,
    requiredMap: mapId,
    requiredUnitSet: 'expanded',
    requiredStatRules: { count: 5, total: 275, min: 15, max: 90 },
    general,
    generalStats,
    diplomacy: [],
    nation: entry.factions.map((f) => [
      f.name,
      factionColor(f),
      0,
      0,
      '',
      0,
      '',
      1,
      [f.capital, ...f.cities.filter((city) => city !== f.capital)],
    ]),
  });
}
const blank: Entry = {
  id: 'empty',
  type: '공백지',
  year: 180,
  month: 1,
  title: '공백지',
  desc: '모든 거점이 비어 있고 모든 장수가 재야로 시작합니다.',
  factions: [],
  officers: source.roster.map(([id]) => [id, -1, '']),
};
const entries = [...source.scenarios, blank];
if (
  source.sites.length !== 322 ||
  source.routes.length !== 467 ||
  source.scenarios.length !== 90 ||
  roster.size !== 3011 ||
  new Set(entries.map((e) => e.id)).size !== 91
)
  throw Error('아티팩트 항목 수가 다릅니다.');
const materials = { map, unitSet, statRules, portraitMap: { portraits: {} } };
const scenarios = entries.map((entry) => {
  const scenario = compileScenario(entry);
  const report = validateWorldResources({ ...materials, scenario });
  if (report.status !== 'pass') throw Error(`${scenario.id}: ${JSON.stringify(report).slice(0, 1000)}`);
  const initial = buildInitialWorld({ ...materials, scenario, seed: 'san10-expanded-import' });
  if (
    initial.cities.length !== 322 ||
    initial.generals.length !== entry.officers.length ||
    initial.nations.length !== entry.factions.length
  )
    throw Error(`월드 초기 자료 수 불일치: ${scenario.id}`);
  return {
    scenario,
    meta: { type: entry.type, year: entry.year, month: entry.month, title: entry.title, description: entry.desc },
    initialHash: hashState(initial),
  };
});
await mkdir(outputDir);
const write = (name: string, value: unknown) => writeFile(join(outputDir, name), JSON.stringify(value) + '\n');
await write('map.json', map);
for (const { scenario } of scenarios) await write(`${scenario.id}.json`, scenario);
await write('manifest.json', {
  sourceUrl,
  sourceHash,
  factionColorSource,
  map: { path: 'map.json', contentHash: hashState(map) },
  scenarios: scenarios.map(({ scenario, meta, initialHash }) => ({
    id: scenario.id,
    path: `${scenario.id}.json`,
    contentHash: hashState(scenario),
    initialHash,
    ...meta,
  })),
});
console.log(
  JSON.stringify({
    map: map.id,
    sites: sites.length,
    routes: routes.length,
    scenarios: scenarios.length,
    blankGenerals: blank.officers.length,
  }),
);
