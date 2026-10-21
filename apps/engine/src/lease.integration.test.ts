import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { acquireLease, assertLease, LeaseLostError, releaseLease, renewLease } from './lease';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worldIds: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.$disconnect();
});

async function create(ownerId = randomUUID()) {
  const world = await db.world.create({
    data: {
      name: '리스 정밀도 회귀',
      scenarioKey: '1030',
      mapKey: 'che',
      unitSetKey: 'test',
      seed: 'lease-precision',
      startYear: 200,
      turnTermMinutes: 10,
      initialStateHash: 'lease-test',
      statRules: {},
      unitSet: {},
    },
  });
  worldIds.push(world.id);
  const lease = await acquireLease(db, world.id, ownerId);
  if (!lease) throw new Error('테스트 리스 획득 실패');
  return lease;
}

describe('AC-M1-11 리스 해제 정밀도, 실제 PostgreSQL', () => {
  it('해제 SQL 안에서 관측해도 저장된 만료 시각이 미래가 되지 않는다', async () => {
    const lease = await create();
    await db.$transaction(async (tx) => {
      // 클라이언트 왕복 전에 마이크로초 정밀도로 검사한다. 실제 해제 함수와 DB 시계를 그대로 쓴다.
      await tx.$executeRaw`CREATE TEMP TABLE lease_release_samples (
        expires_at timestamp(3), observed_at timestamp(6)
      ) ON COMMIT DROP`;
      await tx.$executeRaw`CREATE FUNCTION pg_temp.record_lease_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO pg_temp.lease_release_samples VALUES (NEW."expiresAt", clock_timestamp() AT TIME ZONE 'UTC');
          RETURN NEW;
        END
      $$`;
      await tx.$executeRaw`CREATE TRIGGER record_lease_release AFTER UPDATE ON "EngineLease"
        FOR EACH ROW EXECUTE FUNCTION pg_temp.record_lease_release()`;
      for (let i = 0; i < 256; i++) await releaseLease(tx, lease);
      const [sample] = await tx.$queryRaw<{ count: number; future: number }[]>`
        SELECT count(*)::int AS count, count(*) FILTER (WHERE expires_at > observed_at)::int AS future
        FROM pg_temp.lease_release_samples`;
      expect(sample).toEqual({ count: 256, future: 0 });
      await tx.$executeRaw`DROP TRIGGER record_lease_release ON "EngineLease"`;
      await tx.$executeRaw`DROP FUNCTION pg_temp.record_lease_release()`;
    });
    await expect(assertLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(renewLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('대기 없이 64번 재획득해도 한 엔진만 성공하고 낡은 토큰은 새 리스를 바꾸지 못한다', async () => {
    let lease = await create();
    for (let i = 0; i < 64; i++) {
      await releaseLease(db, lease);
      const contenders = await Promise.all([acquireLease(db, lease.worldId), acquireLease(db, lease.worldId)]);
      const acquired = contenders.filter((value) => value !== null);
      expect(acquired).toHaveLength(1);
      const next = acquired[0]!;
      expect(next.fencingToken).toBe(lease.fencingToken + 1);
      const before = await db.engineLease.findUniqueOrThrow({ where: { worldId: lease.worldId } });
      await releaseLease(db, lease);
      await expect(renewLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
      await expect(assertLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await db.engineLease.findUniqueOrThrow({ where: { worldId: lease.worldId } })).toEqual(before);
      await assertLease(db, next);
      lease = next;
    }
  });

  it('다른 소유자는 해제·갱신하지 못하고 만료한 토큰은 되살릴 수 없다', async () => {
    const ownerId = randomUUID();
    const lease = await create(ownerId);
    const other = { ...lease, ownerId: 'other-owner' };
    const before = await db.engineLease.findUniqueOrThrow({ where: { worldId: lease.worldId } });
    await releaseLease(db, other);
    await expect(renewLease(db, other)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(assertLease(db, other)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await db.engineLease.findUniqueOrThrow({ where: { worldId: lease.worldId } })).toEqual(before);
    await renewLease(db, lease);
    await assertLease(db, lease);
    await db.$executeRaw`UPDATE "EngineLease" SET "expiresAt" = timestamp '2000-01-01' WHERE "worldId" = ${lease.worldId}`;
    await expect(renewLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(assertLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    // 같은 소유자가 다시 잡아도 이전 토큰은 거부한다.
    const next = await acquireLease(db, lease.worldId, ownerId);
    expect(next?.fencingToken).toBe(lease.fencingToken + 1);
    await releaseLease(db, lease);
    await expect(renewLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(assertLease(db, lease)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await acquireLease(db, lease.worldId)).toBeNull();
  });
});
