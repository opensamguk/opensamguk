import { hashState } from '@opensamguk/shared/node';
import type { Prisma, PrismaClient } from './generated/prisma/client';

export type GameResourceKind = 'MAP' | 'SCENARIO' | 'UNIT_SET' | 'STAT_RULES' | 'PORTRAIT_MAP';

export interface GameResourceRef {
  kind: GameResourceKind;
  name: string;
  version: number;
}

export interface PublishedResource extends GameResourceRef {
  content: unknown;
  contentHash: string;
  source: string;
}

function resourceKey(ref: GameResourceRef): string {
  return `${ref.kind}/${ref.name}/${ref.version}`;
}

export async function readPublishedResources(
  db: Pick<PrismaClient, 'gameResource'> | Prisma.TransactionClient,
  refs: readonly GameResourceRef[],
): Promise<PublishedResource[]> {
  for (const ref of refs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(ref.name) || !Number.isInteger(ref.version) || ref.version <= 0) {
      throw new Error(`자원 이름과 양의 정수 판 번호를 확인하세요: ${resourceKey(ref)}`);
    }
  }
  const rows = await db.gameResource.findMany({
    where: { status: 'PUBLISHED', OR: refs.map(({ kind, name, version }) => ({ kind, name, version })) },
    select: { kind: true, name: true, version: true, content: true, contentHash: true, source: true },
  });
  const byKey = new Map<string, PublishedResource>(rows.map((row) => [resourceKey(row), row]));
  const missing = refs.filter((ref) => !byKey.has(resourceKey(ref))).map(resourceKey);
  if (missing.length) {
    throw new Error(`게시 자원이 없습니다: ${missing.join(', ')}. pnpm db:init-resources로 초기화하세요.`);
  }
  for (const row of rows) {
    if (hashState(row.content) !== row.contentHash) {
      throw new Error(`자원 내용 해시가 다릅니다: ${resourceKey(row)}`);
    }
  }
  return refs.map((ref) => byKey.get(resourceKey(ref))!);
}
