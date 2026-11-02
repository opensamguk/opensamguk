import { readFile } from 'node:fs/promises';
import type { GameResourceKind, Prisma, PrismaClient } from '../packages/db/src/index';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { hashState } from '../packages/shared/src/node/hashState';
import { initializeIntegrationResources } from './integration-resources';

const root = new URL('../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
interface ManifestRow {
  kind: GameResourceKind;
  name: string;
  version: number;
  path: string;
  contentHash: string;
  source: string;
}

export async function san10ResourceRows() {
  const manifest: ManifestRow[] = await read('resources/san10-manifest.json');
  if (
    manifest.map((row) => `${row.kind}/${row.name}/${row.version}`).join(',') !==
    'MAP/san10/1,SCENARIO/san10-191/1,SCENARIO/san10-empty/1'
  )
    throw Error('SAN10 게시 명세를 확인하세요.');
  return Promise.all(
    manifest.map(async (row) => {
      const content: Prisma.InputJsonValue = await read(row.path);
      if (hashState(content) !== row.contentHash) throw Error(`SAN10 자원 해시 불일치: ${row.name}`);
      return { ...row, content };
    }),
  );
}

export async function initializeSan10Resources(db: Pick<PrismaClient, '$transaction'>) {
  const rows = await san10ResourceRows();
  const materials = {
    map: rows[0]!.content,
    unitSet: await read('resources/unitset/basic.json'),
    statRules: await read('resources/scenario/five-stats.json'),
    portraitMap: await read('resources/portraits/191-map.json'),
  };
  for (const scenario of rows.slice(1))
    if (validateWorldResources({ ...materials, scenario: scenario.content }).status !== 'pass')
      throw Error(`SAN10 시나리오 검증 실패: ${scenario.name}`);
  await initializeIntegrationResources(db);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
    let inserted = 0;
    for (const row of rows) {
      const key = { kind: row.kind, name: row.name, version: row.version };
      const previous = await tx.gameResource.findUnique({ where: { kind_name_version: key } });
      if (previous) {
        if (
          previous.status !== 'PUBLISHED' ||
          previous.source !== row.source ||
          previous.contentHash !== row.contentHash ||
          hashState(previous.content) !== row.contentHash
        )
          throw Error(`기존 SAN10 게시 자원과 다릅니다: ${row.name}`);
      } else {
        await tx.gameResource.create({
          data: {
            ...key,
            source: row.source,
            content: row.content,
            contentHash: row.contentHash,
            status: 'PUBLISHED',
            publishedAt: new Date(),
          },
        });
        inserted++;
      }
    }
    return { inserted, existing: rows.length - inserted };
  });
}
