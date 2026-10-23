import type { Prisma, PrismaClient } from '@opensamguk/db';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

export const ENGINE_STALE_AGE_MS = 120_000;
export const ENGINE_STALE_LAG_MS = 300_000;
export type EngineHealthRow = Prisma.WorldGetPayload<{
  select: { engineHeartbeat: { select: { at: true; lagMs: true } } };
}>;
type Counts = { worlds: number; stale: number };

export function countEngineHealth(nowMs: number, rows: readonly EngineHealthRow[]): Counts | null {
  if (!Number.isFinite(nowMs) || !Number.isInteger(nowMs) || !Array.isArray(rows)) return null;
  let stale = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') return null;
    const heartbeat = row.engineHeartbeat;
    if (heartbeat === null) {
      stale++;
      continue;
    }
    if (
      !heartbeat ||
      !(heartbeat.at instanceof Date) ||
      !Number.isFinite(heartbeat.at.getTime()) ||
      !Number.isInteger(heartbeat.lagMs)
    )
      return null;
    if (nowMs - heartbeat.at.getTime() > ENGINE_STALE_AGE_MS || heartbeat.lagMs > ENGINE_STALE_LAG_MS) stale++;
  }
  return { worlds: rows.length, stale };
}

export async function readEngineHealth(db: PrismaClient): Promise<Counts | null> {
  try {
    const read = await db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`;
        const rows = await tx.world.findMany({
          where: { status: { in: ['RUNNING', 'PAUSED'] } },
          select: { engineHeartbeat: { select: { at: true, lagMs: true } } },
        });
        return { now: row?.now, rows };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    if (!(read.now instanceof Date)) return null;
    const nowMs = read.now.getTime();
    return countEngineHealth(nowMs, read.rows);
  } catch {
    return null;
  }
}

export function registerOpsHealth<L extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    L
  >,
  db: PrismaClient,
): void {
  server.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await db.$queryRaw`SELECT 1`;
      return reply.code(200).send({ ok: true });
    } catch {
      server.log.warn('서버 상태 확인이 실패했습니다.');
      return reply.code(503).send({ ok: false });
    }
  });
  server.get('/healthz/engine', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const counts = await readEngineHealth(db);
    if (counts === null) {
      server.log.warn('엔진 상태 확인이 실패했습니다.');
      return reply.code(503).send({ ok: false, worlds: null, stale: null });
    }
    const ok = counts.stale === 0;
    if (!ok) server.log.warn('엔진 상태 확인이 실패했습니다.');
    return reply.code(ok ? 200 : 503).send({ ok, ...counts });
  });
}
