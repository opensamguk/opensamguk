import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorldResources } from '../../packages/rules/src/world/validate/index';
import { hashState } from '../../packages/shared/src/node/hashState';
import fixture from '../fixtures/t4-46-scenarios.json';
import { BODY_TAG, CONTENT_TAG, requirePassingReport } from './convert';
import { createDb, readPublishedResources } from '../../packages/db/src/index';

export interface ScenarioRow {
  key: string;
  path: string;
  blob: string;
  sha256: string;
  bundle: string;
  support: 'existing' | 'ready' | 'blocked' | 'unverified';
  reason: string;
  resourceKey: string | null;
  contentHash: string | null;
  source?: string;
  unitSet?: 'che';
  statRules?: string;
}

export const scenarioRows: readonly ScenarioRow[] = fixture.scenarios as ScenarioRow[];
export const SCENARIO_CONTENT_TAG = '$t4_46_content$';
export const SCENARIO_BODY_TAG = '$t4_46_init$';
export const UNIT_SET_CONTENT_TAG = '$t4_46_unitset$';
export const STAT_RULES_CONTENT_TAG = '$t4_46_stat_rules$';
const sqlTags = [
  SCENARIO_CONTENT_TAG,
  SCENARIO_BODY_TAG,
  UNIT_SET_CONTENT_TAG,
  STAT_RULES_CONTENT_TAG,
  CONTENT_TAG,
  BODY_TAG,
];
export const cheUnitSetPublication = fixture.cheUnitSet;
export type ScenarioMaterials = Omit<Parameters<typeof validateWorldResources>[0], 'scenario'> & {
  cheUnitSet: unknown;
};

function scenarioStatRulesPublication({ statRules }: Pick<ScenarioRow, 'statRules'>) {
  if (statRules === undefined) return undefined;
  const publication = fixture.statRules.find(({ name }) => name === statRules);
  if (!publication) throw new Error('시나리오 장수 생성 능력치 판을 확인하세요.');
  return publication;
}

export function requiredScenarioStatRules(rows: readonly ScenarioRow[]) {
  return new Set(rows.map(scenarioStatRulesPublication).filter((publication) => publication !== undefined));
}

export function scenarioMaterialsForRow(materials: ScenarioMaterials, row: { unitSet?: string; statRules?: string }) {
  const { cheUnitSet, ...basic } = materials;
  return {
    ...basic,
    unitSet: row.unitSet === 'che' ? cheUnitSet : basic.unitSet,
    statRules: scenarioStatRulesPublication(row)?.content ?? basic.statRules,
  };
}

export function readyScenarioRows(rows: readonly ScenarioRow[] = scenarioRows): ScenarioRow[] {
  const ready = rows.filter((row) => row.support === 'ready');
  const keys = new Set<string>();
  for (const row of ready) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(row.key) ||
      row.key === '1030' ||
      row.resourceKey !== row.key ||
      keys.has(row.key) ||
      !row.contentHash?.match(/^[0-9a-f]{64}$/) ||
      !row.source
    ) {
      throw new Error(`시나리오 판 입력을 확인하세요: SCENARIO/${row.key}/1`);
    }
    keys.add(row.key);
  }
  return [...ready].sort((a, b) => Number(a.key) - Number(b.key));
}

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).some(([key, nested]) => key.includes('\0') || hasNul(nested));
  return false;
}

function literal(value: string, key: string): string {
  if (value.includes('\0')) throw new Error(`시나리오 NUL 문자: ${key}`);
  if (sqlTags.some((tag) => value.includes(tag))) throw new Error(`시나리오 구분자 충돌: ${key}`);
  return `'${value.replaceAll("'", "''")}'`;
}

const publicationTags = {
  SCENARIO: SCENARIO_CONTENT_TAG,
  UNIT_SET: UNIT_SET_CONTENT_TAG,
  STAT_RULES: STAT_RULES_CONTENT_TAG,
};

function publicationSql(kind: keyof typeof publicationTags, name: string, raw: string, hash: string, source: string) {
  const key = `${kind}/${name}/1`;
  const tag = publicationTags[kind];
  const sqlName = literal(name, key);
  const sqlSource = literal(source, key);
  const contentHash = literal(hash, key);
  if (sqlTags.some((value) => raw.includes(value))) throw new Error(`시나리오 구분자 충돌: ${key}`);
  return `  resource_content := ${tag}${raw}${tag}::jsonb;
  INSERT INTO "GameResource"
    ("id", "kind", "name", "version", "status", "content", "contentHash", "source", "createdBy", "publishedAt")
  VALUES
    (gen_random_uuid()::text, '${kind}', ${sqlName}, 1, 'PUBLISHED', resource_content, ${contentHash}, ${sqlSource}, NULL, now())
  ON CONFLICT ("kind", "name", "version") DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM "GameResource"
    WHERE "kind" = '${kind}' AND "name" = ${sqlName} AND "version" = 1
      AND "content" = resource_content AND "contentHash" = ${contentHash}
      AND "status" = 'PUBLISHED' AND "source" = ${sqlSource}
  ) THEN
    RAISE EXCEPTION '시나리오 자원 충돌: ${key}';
  END IF;`;
}

export function convertScenariosToSql(
  input: Readonly<Record<string, string>>,
  notice: string,
  materials: ScenarioMaterials,
  rows: readonly ScenarioRow[] = scenarioRows,
): string {
  for (const key of Object.keys(input)) {
    if (['1030', 'che', 'basic', 'default', 'rtk14-map'].includes(key))
      throw new Error(`내장 자원은 추가 SQL에 넣을 수 없습니다: ${key}`);
  }
  const ready = readyScenarioRows(rows);
  const statements = ready.map((row) => {
    const key = `SCENARIO/${row.key}/1`;
    const raw = input[row.key]?.replaceAll('\r\n', '\n');
    if (raw === undefined) throw new Error(`시나리오 원문이 없습니다: ${key}`);
    if (sqlTags.some((tag) => raw.includes(tag))) throw new Error(`시나리오 구분자 충돌: ${key}`);
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      throw new Error(`시나리오 JSON 오류: ${key}`);
    }
    if (hasNul(content)) throw new Error(`시나리오 NUL 문자: ${key}`);
    try {
      requirePassingReport(validateWorldResources({ ...scenarioMaterialsForRow(materials, row), scenario: content }));
    } catch {
      throw new Error(`시나리오 자원 검증 실패: ${key}`);
    }
    if (hashState(content) !== row.contentHash) throw new Error(`시나리오 상수 해시 불일치: ${key}`);
    if ((content as { id?: unknown }).id !== row.resourceKey) throw new Error(`시나리오 내용의 id가 다릅니다: ${key}`);
    return publicationSql('SCENARIO', row.key, raw, row.contentHash!, row.source!);
  });
  if (ready.some(({ unitSet }) => unitSet === 'che')) {
    const { name, contentHash, source } = cheUnitSetPublication;
    const content = materials.cheUnitSet;
    if (hasNul(content) || hashState(content) !== contentHash)
      throw new Error(`병종 판 내용과 해시를 확인하세요: UNIT_SET/${name}/1`);
    statements.push(publicationSql('UNIT_SET', name, `${JSON.stringify(content, null, 2)}\n`, contentHash, source));
  }
  for (const { name, source, contentHash, content } of requiredScenarioStatRules(ready)) {
    if (hasNul(content) || hashState(content) !== contentHash)
      throw new Error(`능력치 판 내용과 해시를 확인하세요: STAT_RULES/${name}/1`);
    statements.push(publicationSql('STAT_RULES', name, JSON.stringify(content, null, 2) + '\n', contentHash, source));
  }
  const normalizedNotice = notice.replaceAll('\r\n', '\n');
  if (normalizedNotice.includes('\0')) throw new Error('시나리오 출처에 NUL 문자가 있습니다.');
  const header = normalizedNotice
    .split('\n')
    .map((line) => (line ? `-- ${line}` : '--'))
    .join('\n');
  return `-- Generated by tools/resources-sql/generate-scenarios.ts; source: resources/NOTICE.md.
${header}

DO ${SCENARIO_BODY_TAG}
DECLARE
  resource_content jsonb;
BEGIN
${statements.join('\n\n')}
END;
${SCENARIO_BODY_TAG};
`;
}

export async function readScenarioMaterials(
  db: Parameters<typeof readPublishedResources>[0],
): Promise<ScenarioMaterials> {
  const [map, unitSet, statRules, portraitMap] = await readPublishedResources(db, [
    { kind: 'MAP', name: 'che', version: 1 },
    { kind: 'UNIT_SET', name: 'basic', version: 1 },
    { kind: 'STAT_RULES', name: 'default', version: 1 },
    { kind: 'PORTRAIT_MAP', name: 'rtk14-map', version: 1 },
  ]);
  return {
    map: map!.content,
    unitSet: unitSet!.content,
    statRules: statRules!.content,
    portraitMap: portraitMap!.content,
    cheUnitSet: JSON.parse(await readFile(new URL('../../resources/unitset/che.json', import.meta.url), 'utf8')),
  };
}

async function main(): Promise<void> {
  const root = new URL('../../', import.meta.url);
  const input = Object.fromEntries(
    await Promise.all(
      readyScenarioRows().map(async ({ key }) => [
        key,
        await readFile(new URL(`resources/scenario/${key}.json`, root), 'utf8'),
      ]),
    ),
  );
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
  const db = createDb(process.env.DATABASE_URL);
  let materials: ScenarioMaterials;
  try {
    materials = await readScenarioMaterials(db);
  } finally {
    await db.$disconnect();
  }
  const sql = convertScenariosToSql(input, await readFile(new URL('resources/NOTICE.md', root), 'utf8'), materials);
  const output = new URL('packages/db/sql/resources-scenarios.sql', root);
  await mkdir(new URL('./', output), { recursive: true });
  await writeFile(output, sql, 'utf8');
  console.log(`시나리오 SQL 생성: ${fileURLToPath(output)} (시나리오 ${readyScenarioRows().length})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
