import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildSan10Map, buildSan10MapV2, buildSan10Scenarios } from './san10';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { hashState } from '../../packages/shared/src/node/hashState';
import { buildExpandedUnitSet } from '../unitset/expanded';
import { readExpandedSource } from '../unitset/source';
import { createDb, readPublishedResources } from '../../packages/db/src/index';

const root = new URL('../../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const write = async (path: string, value: unknown) => {
  const output = new URL(path, root);
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  // 시나리오 두 파일은 저장소의 기존 줄 배치를 유지한다.
  const text = path.startsWith('resources/scenario/')
    ? await format(raw, { ...(await resolveConfig(fileURLToPath(output))), parser: 'json' })
    : raw;
  await writeFile(output, text);
};
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
const db = createDb(process.env.DATABASE_URL);
let original1030: unknown;
try {
  const [row] = await readPublishedResources(db, [{ kind: 'SCENARIO', name: '1030', version: 1 }]);
  original1030 = row!.content;
} finally {
  await db.$disconnect();
}
const gis = await readFile(new URL('apps/web/src/main/san10-basemap.json', root));
const map = buildSan10Map(createHash('sha256').update(gis).digest('hex'));
const unitSet = buildExpandedUnitSet(await readExpandedSource(), map);
await write('resources/unitset/expanded.json', unitSet);
const scenarios = buildSan10Scenarios(map, original1030);
const materials = {
  map,
  unitSet,
  statRules: await read('resources/scenario/five-stats.json'),
  portraitMap: await read('resources/portraits/191-map.json'),
};
for (const scenario of Object.values(scenarios)) {
  const report = validateWorldResources({ ...materials, scenario });
  if (report.status !== 'pass') throw Error(JSON.stringify(report));
  await write(`resources/scenario/${scenario.id}.json`, scenario);
}
await write('resources/map/san10.json', map);
const mapV2 = buildSan10MapV2(map);
await write('resources/map/san10-v2.json', mapV2);
const source =
  'D-045/D-056; SAN10 user survey / core2026 df6c926 MIT / Natural Earth v5.1.2 public domain; resources/map-drafts/san10/NOTICE.md';
await write('resources/san10-manifest.json', [
  { kind: 'MAP', name: map.id, path: 'resources/map/san10.json', version: 1, contentHash: hashState(map), source },
  ...Object.values(scenarios).map((scenario) => ({
    kind: 'SCENARIO',
    name: scenario.id,
    path: `resources/scenario/${scenario.id}.json`,
    version: 1,
    contentHash: hashState(scenario),
    source,
  })),
  {
    kind: 'UNIT_SET',
    name: 'expanded',
    path: 'resources/unitset/expanded.json',
    version: 1,
    contentHash: hashState(unitSet),
    source,
  },
  {
    kind: 'MAP',
    name: mapV2.id,
    path: 'resources/map/san10-v2.json',
    version: 2,
    contentHash: hashState(mapV2),
    source: 'D-082; core2026 df6c926 MIT; resources/map-drafts/san10/NOTICE.md',
  },
]);
await writeFile(
  new URL('apps/web/src/main/san10-gis-hash.ts', root),
  `// Generated from san10-basemap.json by build-san10-resources.ts.\nexport const SAN10_GIS_SHA256 = '${map.basemap.sha256}';\n`,
);
console.log(`SAN10: ${map.sites.length}표식, ${map.routes.length}도로, 역사·공백지 2종`);
