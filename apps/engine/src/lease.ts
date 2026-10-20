import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@opensamguk/db';

export const LEASE_TTL_MS = 15_000;
export interface Lease {
  worldId: string;
  ownerId: string;
  fencingToken: number;
  ttlMs: number;
}
export class LeaseLostError extends Error {
  constructor() {
    super('엔진 실행권을 잃었습니다.');
    this.name = 'LeaseLostError';
  }
}

export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return row!.now;
}

export async function acquireLease(
  db: PrismaClient,
  worldId: string,
  ownerId = randomUUID(),
  ttlMs = LEASE_TTL_MS,
): Promise<Lease | null> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3) throw new Error('리스 만료 시간은 3ms 이상의 정수여야 합니다.');
  const rows = await db.$queryRaw<{ fencingToken: number }[]>`
    INSERT INTO "EngineLease" ("worldId", "ownerId", "fencingToken", "expiresAt")
    VALUES (${worldId}, ${ownerId}, 1, (clock_timestamp() AT TIME ZONE 'UTC') + ${ttlMs} * interval '1 millisecond')
    ON CONFLICT ("worldId") DO UPDATE SET "ownerId" = EXCLUDED."ownerId",
      "fencingToken" = "EngineLease"."fencingToken" + 1,
      "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + ${ttlMs} * interval '1 millisecond'
    WHERE "EngineLease"."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING "fencingToken"`;
  return rows[0] ? { worldId, ownerId, fencingToken: rows[0].fencingToken, ttlMs } : null;
}

export async function renewLease(db: PrismaClient, lease: Lease): Promise<void> {
  const count = await db.$executeRaw`
    UPDATE "EngineLease" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + ${lease.ttlMs} * interval '1 millisecond'
    WHERE "worldId" = ${lease.worldId} AND "ownerId" = ${lease.ownerId} AND "fencingToken" = ${lease.fencingToken}
      AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  if (count !== 1) throw new LeaseLostError();
}

export async function releaseLease(db: Prisma.TransactionClient, lease: Lease): Promise<void> {
  // 토큰을 지우지 않아 해제·재획득 뒤에도 이전 프로세스의 토큰을 재사용하지 않는다.
  // TIMESTAMP(3) 반올림으로 해제 시각이 미래가 되지 않게 밀리초 아래를 버린다.
  await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "worldId" = ${lease.worldId} AND "ownerId" = ${lease.ownerId} AND "fencingToken" = ${lease.fencingToken}`;
}

export async function assertLease(tx: Prisma.TransactionClient, lease: Lease): Promise<void> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "EngineLease"
    WHERE "worldId" = ${lease.worldId} AND "ownerId" = ${lease.ownerId} AND "fencingToken" = ${lease.fencingToken}
      AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  if (rows.length !== 1) throw new LeaseLostError();
}

export async function lockLease(tx: Prisma.TransactionClient, lease: Lease): Promise<void> {
  await tx.$queryRaw`SELECT "worldId" FROM "EngineLease" WHERE "worldId" = ${lease.worldId} FOR UPDATE`;
  // 잠금 대기가 끝난 뒤 현재 DB 시각으로 검사한다.
  await assertLease(tx, lease);
}
