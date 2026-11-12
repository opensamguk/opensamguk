import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, readPublishedResources, type GameResourceKind, type Prisma } from '../packages/db/src/index';
import { operationalMapSchema } from '../packages/rules/src/world/map/operational';
import { scenarioSchema } from '../packages/rules/src/world/resources';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { hashState } from '../packages/shared/src/node/hashState';

const [directory, manifestSha] = process.argv.slice(2);
if (!directory || !manifestSha || !/^[a-f0-9]{64}$/.test(manifestSha) || process.argv.length !== 4)
  throw Error('데이터 저장소의 디렉터리와 고정한 manifest SHA-256을 지정하세요.');
const manifestBytes = await readFile(join(directory, 'manifest.json'));
if (createHash('sha256').update(manifestBytes).digest('hex') !== manifestSha)
  throw Error('manifest SHA-256이 다릅니다.');
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  sourceUrl: string;
  sourceHash: string;
  map: { path: string; contentHash: string };
  scenarios: { id: string; path: string; contentHash: string }[];
};
const mapName = 'san10-expanded';
const portraitMap = { portraits: {} };
const read = async (path: string) => JSON.parse(await readFile(join(directory, path), 'utf8')) as unknown;
if (
  manifest.map.path !== 'map.json' ||
  manifest.scenarios.length !== 91 ||
  new Set(manifest.scenarios.map((row) => row.id)).size !== 91
)
  throw Error('확장판 게시 명세를 확인하세요.');
const map = operationalMapSchema.parse(await read('map.json'));
if (
  map.id !== mapName ||
  map.sites.length !== 322 ||
  map.routes.length !== 467 ||
  hashState(map) !== manifest.map.contentHash
)
  throw Error('확장판 지도와 게시 명세가 일치하지 않습니다.');
const local = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as unknown;
const unitSet = await local('../resources/unitset/expanded.json');
const statRules = await local('../resources/scenario/five-stats.json');
const source = `SAN10 확장 확정판 ${manifest.sourceUrl} ${manifest.sourceHash}`;
const rows = [] as {
  kind: GameResourceKind;
  name: string;
  version: number;
  content: Prisma.InputJsonValue;
  contentHash: string;
}[];
function add(kind: GameResourceKind, name: string, content: Prisma.InputJsonValue) {
  rows.push({ kind, name, version: 1, content, contentHash: hashState(content) });
}
add('MAP', mapName, map);
add('PORTRAIT_MAP', 'san10-expanded-portraits', portraitMap);
for (const entry of manifest.scenarios) {
  if (!/^san10-expanded-[a-z0-9]+$/.test(entry.id) || entry.path !== `${entry.id}.json`)
    throw Error('시나리오 경로를 확인하세요.');
  const scenario = scenarioSchema.parse(await read(entry.path));
  if (scenario.id !== entry.id || scenario.requiredMap !== mapName || hashState(scenario) !== entry.contentHash)
    throw Error(`시나리오와 게시 명세가 일치하지 않습니다: ${entry.id}`);
  const report = validateWorldResources({ map, scenario, unitSet, statRules, portraitMap });
  if (report.status !== 'pass') throw Error(`시나리오 자원 검증에 실패했습니다: ${entry.id}`);
  if (
    entry.id === 'san10-expanded-empty' &&
    (scenario.nation.length ||
      scenario.general.length !== 3011 ||
      scenario.general.some((row) => row[3] !== 0 || row[8] !== 0))
  )
    throw Error('공백지의 재야 장수 명단을 확인하세요.');
  add('SCENARIO', entry.id, scenario);
}
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL이 필요합니다.');
const db = createDb(process.env.DATABASE_URL);
try {
  const result = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE`;
      const [dbUnitSet, dbStatRules] = await readPublishedResources(tx, [
        { kind: 'UNIT_SET', name: 'expanded', version: 1 },
        { kind: 'STAT_RULES', name: 'five-stats', version: 1 },
      ]);
      if (dbUnitSet?.contentHash !== hashState(unitSet) || dbStatRules?.contentHash !== hashState(statRules))
        throw Error('게시된 병종 또는 능력치 자원이 검증한 판과 다릅니다.');
      const inserted = [];
      for (const row of rows) {
        const { kind, name, version } = row;
        const existing = await tx.gameResource.findUnique({ where: { kind_name_version: { kind, name, version } } });
        if (!existing) inserted.push(row);
        else if (
          existing.status !== 'PUBLISHED' ||
          existing.contentHash !== row.contentHash ||
          hashState(existing.content) !== row.contentHash
        )
          throw Error(`이미 등록된 자원의 내용이 다릅니다: ${name}`);
      }
      const result = await tx.gameResource.createMany({
        data: inserted.map((row) => ({ ...row, source, status: 'PUBLISHED', publishedAt: new Date() })),
      });
      return { inserted: result.count, existing: rows.length - result.count };
    },
    { timeout: 120_000 },
  );
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
