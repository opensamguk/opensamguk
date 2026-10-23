import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, type Prisma, type PrismaClient } from '@opensamguk/db';

type Display = { id: number; name: string; color: string };
function object(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('저장 형식을 확인하세요.');
  return value;
}
function array(value: Prisma.JsonValue | undefined): Prisma.JsonValue[] {
  if (!Array.isArray(value)) throw new Error('저장 형식을 확인하세요.');
  return value;
}
function integer(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('저장 형식을 확인하세요.');
  return value;
}
function initialDisplays(value: Prisma.JsonValue): Display[] {
  return array(object(object(value).initial).nations).map((value) => {
    const row = object(value);
    if (typeof row.name !== 'string' || typeof row.color !== 'string') throw new Error('저장 형식을 확인하세요.');
    return { id: integer(row.id), name: row.name, color: row.color };
  });
}
type Evidence = { source: string; name: string; color: string };
type Pair = { tick: number; nationId: number };
export type BackfillReport = {
  worldId: string;
  apply: boolean;
  status: 'ok' | 'conflict' | 'error';
  frames: number;
  inserted: number;
  wouldInsert: number;
  existing: number;
  missing: Pair[];
  partialFrames: number;
  conflict?: Pair & { sources: string[] };
};
class Conflict extends Error {
  constructor(
    readonly pair: Pair,
    readonly sources: string[],
  ) {
    super('국가 표시값의 근거가 다릅니다.');
  }
}
const same = (a: Pick<Display, 'name' | 'color'>, b: Pick<Display, 'name' | 'color'>) =>
  a.name === b.name && a.color === b.color;

// 이름·색 변경 경로를 넣는 T4-16에서 이 CLI와 package script를 함께 지운다.
export async function backfillWorld(db: PrismaClient, worldId: string, apply = false): Promise<BackfillReport> {
  const report: BackfillReport = {
    worldId,
    apply,
    status: 'ok',
    frames: 0,
    inserted: 0,
    wouldInsert: 0,
    existing: 0,
    missing: [],
    partialFrames: 0,
  };
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId }, select: { replayOrigin: true } });
        const frames = await tx.yearbookSnapshot.findMany({
          where: { worldId },
          orderBy: { tick: 'asc' },
          select: { tick: true, data: true },
        });
        report.frames = frames.length;
        const evidence = new Map<number, Evidence[]>();
        const add = (row: Display, source: string) =>
          evidence.set(row.id, [...(evidence.get(row.id) ?? []), { source, name: row.name, color: row.color }]);
        for (const row of await tx.nation.findMany({
          where: { worldId },
          select: { id: true, name: true, color: true },
        }))
          add(row, 'Nation');
        for (const row of await tx.removedNation.findMany({
          where: { worldId },
          select: { nationId: true, name: true, color: true },
        }))
          add({ ...row, id: row.nationId }, 'RemovedNation');
        if (world.replayOrigin !== null)
          for (const row of initialDisplays(world.replayOrigin)) add(row, 'replayOrigin.initial.nations');
        const agree = (pair: Pair) => {
          const entries = evidence.get(pair.nationId) ?? [];
          if (entries.some((entry) => !same(entry, entries[0]!)))
            throw new Conflict(
              pair,
              entries.map(({ source }) => source),
            );
          return entries[0];
        };
        const stored = await tx.yearbookNation.findMany({
          where: { worldId },
          orderBy: [{ tick: 'asc' }, { nationId: 'asc' }],
        });
        const existing = new Map(stored.map((row) => [`${row.tick}:${row.nationId}`, row]));
        for (const row of stored) {
          const known = agree(row);
          if (known && !same(known, row))
            throw new Conflict(row, [
              'YearbookNation',
              ...(evidence.get(row.nationId) ?? []).map(({ source }) => source),
            ]);
        }
        const pending: Array<{ worldId: string; tick: number; nationId: number; name: string; color: string }> = [];
        for (const frame of frames) {
          let partial = false;
          for (const nationId of new Set(
            array(object(frame.data).nations).map((row) => integer(object(row).nationId)),
          )) {
            const pair = { tick: frame.tick, nationId };
            const known = agree(pair);
            if (existing.has(`${frame.tick}:${nationId}`)) {
              report.existing++;
            } else if (known) {
              pending.push({ worldId, ...pair, name: known.name, color: known.color });
            } else {
              report.missing.push(pair);
              partial = true;
            }
          }
          if (partial) report.partialFrames++;
        }
        report.wouldInsert = pending.length;
        if (apply && pending.length) {
          await tx.yearbookNation.createMany({ data: pending });
          report.inserted = pending.length;
        }
        return report;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    return {
      ...report,
      status: error instanceof Conflict ? 'conflict' : 'error',
      inserted: 0,
      wouldInsert: 0,
      ...(error instanceof Conflict
        ? { conflict: { tick: error.pair.tick, nationId: error.pair.nationId, sources: error.sources } }
        : {}),
    };
  }
}

export async function backfillWorlds(db: PrismaClient, apply = false, worldId?: string) {
  const worlds = await db.world.findMany({
    where: worldId ? { id: worldId } : {},
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const reports: BackfillReport[] = [];
  for (const world of worlds) reports.push(await backfillWorld(db, world.id, apply));
  return reports;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false }, world: { type: 'string' } } });
  if (
    values.world !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.world)
  )
    throw new Error('월드 ID를 확인하세요.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
  const db = createDb(process.env.DATABASE_URL);
  try {
    const reports = await backfillWorlds(db, values.apply, values.world);
    for (const report of reports) console.log(JSON.stringify(report));
    if (reports.some(({ status }) => status !== 'ok')) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('국가 표시값 백필에 실패했습니다. 입력과 DB 연결을 확인하세요.');
    process.exitCode = 1;
  });
