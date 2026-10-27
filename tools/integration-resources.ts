import { readFile } from 'node:fs/promises';
import { validateWorldResources } from '../packages/rules/src/world/validate';
import { hashState } from '../packages/shared/src/node/hashState';
import type { GameResourceKind, Prisma, PrismaClient } from '../packages/db/src/index';

const root = new URL('../', import.meta.url);
export const INTEGRATION_RESOURCE_FILES = [
  {
    kind: 'MAP',
    name: 'integration',
    path: 'resources/map/integration.json',
    source: 'INT-03; core2026 df6c926 MIT / Natural Earth 5.1.2 public domain; resources/NOTICE.md',
  },
  {
    kind: 'SCENARIO',
    name: 'integration191',
    path: 'resources/scenario/integration191.json',
    source: 'INT-04; main 1030 core2026 df6c926 MIT / INT-16 sourced491; resources/NOTICE.md',
  },
  {
    kind: 'STAT_RULES',
    name: 'five-stats',
    path: 'resources/scenario/five-stats.json',
    source: 'OpenSamguk D-038; docs/product/five-stats.md; MIT',
  },
  {
    kind: 'PORTRAIT_MAP',
    name: '191-map',
    path: 'resources/portraits/191-map.json',
    source: 'INT-16 portraits metadata; KOEI private development only; resources/NOTICE.md',
  },
] as const;

export async function integrationResourceRows() {
  return Promise.all(
    INTEGRATION_RESOURCE_FILES.map(async (file) => {
      const content: Prisma.InputJsonValue = JSON.parse(await readFile(new URL(file.path, root), 'utf8'));
      return { ...file, version: 1, content, contentHash: hashState(content) };
    }),
  );
}

export async function initializeIntegrationResources(db: Pick<PrismaClient, '$transaction'>) {
  const rows = await integrationResourceRows();
  const expected: unknown = JSON.parse(await readFile(new URL('resources/integration-manifest.json', root), 'utf8'));
  if (
    JSON.stringify(expected) !==
    JSON.stringify(
      rows.map(({ kind, name, version, contentHash, source }) => ({ kind, name, version, contentHash, source })),
    )
  )
    throw new Error('통합판 게시 자원의 고정 명세가 다릅니다.');
  const unitSet: Prisma.InputJsonValue = JSON.parse(
    await readFile(new URL('resources/unitset/basic.json', root), 'utf8'),
  );
  const content = Object.fromEntries(rows.map((row) => [row.kind, row.content]));
  const report = validateWorldResources({
    map: content.MAP,
    scenario: content.SCENARIO,
    unitSet,
    statRules: content.STAT_RULES,
    portraitMap: content.PORTRAIT_MAP,
  });
  if (report.status !== 'pass') throw new Error('통합판 자원 간 참조 검증을 통과하지 못했습니다.');
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "GameResource" IN SHARE ROW EXCLUSIVE MODE');
    const basic = await tx.gameResource.findUnique({
      where: { kind_name_version: { kind: 'UNIT_SET', name: 'basic', version: 1 } },
    });
    if (
      !basic ||
      basic.status !== 'PUBLISHED' ||
      basic.contentHash !== hashState(unitSet) ||
      hashState(basic.content) !== basic.contentHash
    )
      throw new Error('기본 병종 게시 자원을 먼저 확인하세요.');
    let inserted = 0;
    for (const row of rows) {
      const kind: GameResourceKind = row.kind;
      const ref = { kind, name: row.name, version: row.version };
      const old = await tx.gameResource.findUnique({ where: { kind_name_version: ref } });
      if (old) {
        if (
          old.status !== 'PUBLISHED' ||
          old.source !== row.source ||
          old.contentHash !== row.contentHash ||
          hashState(old.content) !== row.contentHash
        )
          throw new Error(`기존 통합판 게시 자원과 다릅니다: ${kind}/${row.name}/1`);
      } else {
        await tx.gameResource.create({
          data: {
            ...ref,
            status: 'PUBLISHED',
            content: row.content,
            contentHash: row.contentHash,
            source: row.source,
            publishedAt: new Date(),
          },
        });
        inserted++;
      }
    }
    return { inserted, existing: rows.length - inserted };
  });
}
