import { readFile } from 'node:fs/promises';
import type { Prisma, PrismaClient } from '../packages/db/src/index';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { hashState } from '../packages/shared/src/node/hashState';
import { initializeSan10Resources, san10ResourceRows } from './san10-resources';

const root = new URL('../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

export async function expandedScenarioRow() {
  const manifest = await read('resources/expanded-manifest.json');
  if (!Array.isArray(manifest) || manifest.length !== 1) throw Error('확장 게시 명세를 확인하세요.');
  const row = manifest[0];
  if (
    row.kind !== 'SCENARIO' ||
    row.name !== 'san10-191' ||
    row.version !== 2 ||
    row.path !== 'resources/scenario/san10-191-v2.json' ||
    typeof row.source !== 'string' ||
    !row.source.trim()
  )
    throw Error('확장 시나리오 판을 확인하세요.');
  const content: Prisma.InputJsonValue = await read(row.path);
  if (hashState(content) !== row.contentHash) throw Error('확장 시나리오 해시가 다릅니다.');
  const rows = await san10ResourceRows();
  if (
    validateWorldResources({
      map: rows[0]!.content,
      scenario: content,
      unitSet: rows[3]!.content,
      statRules: await read('resources/scenario/five-stats.json'),
      portraitMap: await read('resources/portraits/191-map.json'),
    }).status !== 'pass'
  )
    throw Error('확장 시나리오 검증에 실패했습니다.');
  return {
    kind: 'SCENARIO' as const,
    name: 'san10-191',
    version: 2,
    content,
    contentHash: hashState(content),
    source: row.source as string,
  };
}

export async function initializeExpandedResources(db: Pick<PrismaClient, '$transaction'>) {
  const row = await expandedScenarioRow();
  await initializeSan10Resources(db);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
    const key = { kind: row.kind, name: row.name, version: row.version };
    const previous = await tx.gameResource.findUnique({ where: { kind_name_version: key } });
    if (previous) {
      if (
        previous.status !== 'PUBLISHED' ||
        previous.source !== row.source ||
        previous.contentHash !== row.contentHash ||
        hashState(previous.content) !== row.contentHash
      )
        throw Error('기존 확장 게시 시나리오와 다릅니다.');
      return { inserted: 0, existing: 1 };
    }
    await tx.gameResource.create({ data: { ...row, status: 'PUBLISHED', publishedAt: new Date() } });
    return { inserted: 1, existing: 0 };
  });
}
