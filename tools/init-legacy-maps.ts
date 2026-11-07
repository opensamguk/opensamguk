import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type PrismaClient } from '../packages/db/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { ResourceInitializationError, verifyInitializedResources } from './init-resources';
import { RESOURCE_INPUTS } from './resources-sql/convert';
import { LEGACY_MAP_SQL, legacyMapPublications, legacyMapsSql } from './resources-sql/legacy-maps';

export async function initializeLegacyMaps(db: Pick<PrismaClient, '$transaction'>, testSql?: string) {
  const expected = await legacyMapPublications();
  const sql = testSql ?? (await readFile(LEGACY_MAP_SQL, 'utf8'));
  if (testSql === undefined && sql !== legacyMapsSql(expected)) throw new Error('원작 지도 초기화 SQL이 다릅니다.');
  const required = expected.map(({ kind, name, version }) => ({ kind, name, version }));
  const builtins = RESOURCE_INPUTS.map(({ kind, name }) => ({ kind, name, version: 1 }));
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
    verifyInitializedResources(await tx.gameResource.findMany({ where: { OR: builtins } }));
    const existing = await tx.gameResource.count({ where: { OR: required } });
    await tx.$executeRawUnsafe(sql);
    const saved = await tx.gameResource.findMany({ where: { OR: required } });
    for (const { kind, name, version, source, contentHash } of expected) {
      const row = saved.find((item) => item.kind === kind && item.name === name && item.version === version);
      if (
        !row ||
        row.status !== 'PUBLISHED' ||
        row.source !== source ||
        row.contentHash !== contentHash ||
        hashState(row.content) !== contentHash
      )
        throw new ResourceInitializationError('원작 지도 자원 저장 행 불일치', [`${kind}/${name}/${version}`]);
    }
    return { inserted: expected.length - existing, existing };
  });
}

async function main() {
  let db: PrismaClient | undefined;
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw new Error('원작 지도 초기화 DB 설정 오류');
    db = createDb(connectionString);
    const { inserted, existing } = await initializeLegacyMaps(db);
    console.log(`원작 지도 자원 저장: 삽입 ${inserted}, 기존 ${existing}`);
  } catch (error) {
    console.error(error instanceof ResourceInitializationError ? error.message : '원작 지도 초기화 실행 실패');
    process.exitCode = 1;
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        console.error('원작 지도 초기화 DB 연결 정리 실패');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
