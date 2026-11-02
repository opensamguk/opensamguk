import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { buildSan10Map, buildSan10Scenarios } from './san10';
import { validateWorldResources } from '../../packages/rules/src/world/validate';
import { hashState } from '../../packages/shared/src/node/hashState';

const root = new URL('../../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const write = async (path: string, value: unknown) =>
  writeFile(new URL(path, root), `${JSON.stringify(value, null, 2)}\n`);
const gis = await readFile(new URL('apps/web/src/main/san10-basemap.json', root));
const map = buildSan10Map(createHash('sha256').update(gis).digest('hex'));
const scenarios = buildSan10Scenarios(map);
const materials = {
  map,
  unitSet: await read('resources/unitset/basic.json'),
  statRules: await read('resources/scenario/five-stats.json'),
  portraitMap: await read('resources/portraits/191-map.json'),
};
for (const scenario of Object.values(scenarios)) {
  const report = validateWorldResources({ ...materials, scenario });
  if (report.status !== 'pass') throw Error(JSON.stringify(report));
  await write(`resources/scenario/${scenario.id}.json`, scenario);
}
await write('resources/map/san10.json', map);
const source =
  'D-045; SAN10 user survey / core2026 df6c926 MIT / Natural Earth v5.1.2 public domain; resources/map-drafts/san10/NOTICE.md';
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
]);
await writeFile(
  new URL('apps/web/src/main/san10-gis-hash.ts', root),
  `// Generated from san10-basemap.json by build-san10-resources.ts.\nexport const SAN10_GIS_SHA256 = '${map.basemap.sha256}';\n`,
);
console.log(`SAN10: ${map.sites.length}표식, ${map.routes.length}도로, 역사·공백지 2종`);
