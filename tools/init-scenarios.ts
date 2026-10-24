import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { initialResourceKeys, verifyInitializedResources, type InitializedResourceRow } from './init-resources';
import { readyScenarioRows, scenarioRows, type ScenarioRow } from './resources-sql/generate-scenarios';

export class ScenarioInitializationError extends Error {
  constructor(
    message: string,
    readonly keys: readonly string[],
  ) {
    super(`${message}: ${keys.join(', ')}`);
    this.name = 'ScenarioInitializationError';
  }
}

interface ScenarioResourceRow extends InitializedResourceRow {
  source: string;
}
const builtinRows = `SELECT "kind"::text AS kind, "name", "version", "status"::text AS status, "content", "contentHash"
  FROM "GameResource" WHERE ("kind"::text, "name", "version") IN (
    ('MAP', 'che', 1), ('SCENARIO', '1030', 1), ('UNIT_SET', 'basic', 1),
    ('STAT_RULES', 'default', 1), ('PORTRAIT_MAP', 'rtk14-map', 1)
  )`;

function sqlFailure(error: unknown, keys: readonly string[]): ScenarioInitializationError {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 20) {
    const value = pending.shift();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    for (const field of ['originalMessage', 'message']) {
      if (typeof fields[field] !== 'string') continue;
      for (const key of keys) {
        if (fields[field].trim() === `시나리오 자원 충돌: ${key}`)
          return new ScenarioInitializationError('시나리오 자원 충돌', [key]);
      }
    }
    for (const field of ['meta', 'cause', 'driverAdapterError']) pending.push(fields[field]);
  }
  return new ScenarioInitializationError('시나리오 SQL 실패', keys);
}

export async function initializeScenarios(
  db: Pick<PrismaClient, '$transaction'>,
  sql: string,
  rows: readonly ScenarioRow[] = scenarioRows,
): Promise<{ inserted: number; existing: number }> {
  const ready = readyScenarioRows(rows);
  const keys = ready.map(({ key }) => `SCENARIO/${key}/1`);
  const selected = `SELECT "kind"::text AS kind, "name", "version", "status"::text AS status, "content", "contentHash", "source"
    FROM "GameResource" WHERE "kind" = 'SCENARIO' AND "version" = 1
      AND "name" IN (${ready.map(({ key }) => `'${key}'`).join(', ')})`;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
      try {
        verifyInitializedResources(await tx.$queryRawUnsafe<InitializedResourceRow[]>(builtinRows));
      } catch {
        throw new ScenarioInitializationError('내장 자원 초기화를 먼저 실행하세요', initialResourceKeys);
      }
      const before = await tx.$queryRawUnsafe<ScenarioResourceRow[]>(selected);
      await tx.$executeRawUnsafe(sql);
      const after = await tx.$queryRawUnsafe<ScenarioResourceRow[]>(selected);
      for (const row of ready) {
        const matches = after.filter((saved) => saved.name === row.key);
        const saved = matches[0];
        if (
          matches.length !== 1 ||
          saved!.status !== 'PUBLISHED' ||
          saved!.source !== row.source ||
          saved!.contentHash !== row.contentHash ||
          hashState(saved!.content) !== row.contentHash
        )
          throw new ScenarioInitializationError('시나리오 저장 행 불일치', [`SCENARIO/${row.key}/1`]);
      }
      return { inserted: ready.length - before.length, existing: before.length };
    });
  } catch (error) {
    if (error instanceof ScenarioInitializationError) throw error;
    throw sqlFailure(error, keys);
  }
}

async function main(): Promise<void> {
  let db: PrismaClient | undefined;
  const keys = readyScenarioRows().map(({ key }) => `SCENARIO/${key}/1`);
  try {
    const { values } = parseArgs({ options: { sql: { type: 'string' } } });
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw new ScenarioInitializationError('시나리오 초기화 DB 설정 오류', keys);
    const source = values.sql
      ? resolve(values.sql)
      : new URL('../packages/db/sql/resources-scenarios.sql', import.meta.url);
    const sql = await readFile(source, 'utf8');
    db = createDb(connectionString);
    const result = await initializeScenarios(db, sql);
    console.log(`시나리오 자원 저장: 삽입 ${result.inserted}, 기존 ${result.existing}`);
  } catch (error) {
    console.error(
      error instanceof ScenarioInitializationError
        ? error.message
        : new ScenarioInitializationError('시나리오 초기화 실행 실패', keys).message,
    );
    process.exitCode = 1;
  } finally {
    try {
      await db?.$disconnect();
    } catch {
      console.error('시나리오 초기화 DB 연결 정리 실패');
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
