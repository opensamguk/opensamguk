import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { RESOURCE_INPUTS } from './resources-sql/convert';

export interface InitializedResourceRow {
  kind: string;
  name: string;
  version: number;
  status: string;
  content: unknown;
  contentHash: string;
}

export const initialResourceKeys = RESOURCE_INPUTS.map((resource) => `${resource.kind}/${resource.name}/1`);

export class ResourceInitializationError extends Error {
  constructor(
    message: string,
    readonly keys: readonly string[],
  ) {
    super(`${message}: ${keys.join(', ')}`);
    this.name = 'ResourceInitializationError';
  }
}

export function verifyInitializedResources(rows: readonly InitializedResourceRow[]): void {
  for (const resource of RESOURCE_INPUTS) {
    const key = `${resource.kind}/${resource.name}/1`;
    const matches = rows.filter((row) => row.kind === resource.kind && row.name === resource.name && row.version === 1);
    if (matches.length !== 1 || matches[0]!.status !== 'PUBLISHED') {
      throw new ResourceInitializationError('초기화 자원 행 불일치', [key]);
    }
    const row = matches[0]!;
    let contentHash: string;
    try {
      contentHash = hashState(row.content);
    } catch {
      throw new ResourceInitializationError('초기화 자원 내용 오류', [key]);
    }
    if (contentHash !== row.contentHash || contentHash !== resource.contentHash) {
      throw new ResourceInitializationError('초기화 자원 해시 불일치', [key]);
    }
  }
  if (rows.length !== RESOURCE_INPUTS.length) {
    throw new ResourceInitializationError('초기화 자원 행 수 불일치', initialResourceKeys);
  }
}

function sqlFailure(error: unknown): ResourceInitializationError {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 20) {
    const value = pending.shift();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    for (const field of ['originalMessage', 'message']) {
      const message = fields[field];
      if (typeof message !== 'string') continue;
      for (const key of initialResourceKeys) {
        if (message.trim() === `초기화 자원 충돌: ${key}`) {
          return new ResourceInitializationError('초기화 자원 충돌', [key]);
        }
      }
    }
    for (const field of ['meta', 'cause', 'driverAdapterError']) pending.push(fields[field]);
  }
  // DB 오류의 연결 문자열·SQL 본문은 출력하지 않는다. 키를 특정할 수 없으면 대상 묶음을 적는다.
  return new ResourceInitializationError('초기화 자원 SQL 실패', initialResourceKeys);
}

const selectedRows = `SELECT "kind"::text AS kind, "name", "version", "status"::text AS status, "content", "contentHash"
  FROM "GameResource" WHERE ("kind"::text, "name", "version") IN (
    ${RESOURCE_INPUTS.map((resource) => `('${resource.kind}', '${resource.name}', 1)`).join(', ')}
  )`;

export async function initializeResources(
  db: Pick<PrismaClient, '$transaction'>,
  sql: string,
): Promise<{ inserted: number; existing: number }> {
  try {
    return await db.$transaction(async (tx) => {
      // 다른 삽입과 경합해도 삽입·기존 행 수를 정확히 센다. 잠금도 이 트랜잭션에서 풀린다.
      await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
      const before = await tx.$queryRawUnsafe<InitializedResourceRow[]>(selectedRows);
      await tx.$executeRawUnsafe(sql);
      const after = await tx.$queryRawUnsafe<InitializedResourceRow[]>(selectedRows);
      verifyInitializedResources(after);
      return { inserted: RESOURCE_INPUTS.length - before.length, existing: before.length };
    });
  } catch (error) {
    if (error instanceof ResourceInitializationError) throw error;
    throw sqlFailure(error);
  }
}

async function main(): Promise<void> {
  let db: PrismaClient | undefined;
  try {
    const { values } = parseArgs({ options: { sql: { type: 'string' } } });
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol)) {
      throw new ResourceInitializationError('초기화 DB 설정 오류', initialResourceKeys);
    }
    const source = values.sql ? resolve(values.sql) : new URL('../packages/db/sql/resources-init.sql', import.meta.url);
    const sql = await readFile(source, 'utf8');
    db = createDb(connectionString);
    const result = await initializeResources(db, sql);
    await db.$disconnect();
    db = undefined;
    console.log(`초기화 자원 저장: 삽입 ${result.inserted}, 기존 ${result.existing}`);
  } catch (error) {
    console.error(
      error instanceof ResourceInitializationError
        ? error.message
        : new ResourceInitializationError('초기화 자원 실행 실패', initialResourceKeys).message,
    );
    process.exitCode = 1;
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        console.error('초기화 DB 연결 정리 실패');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
