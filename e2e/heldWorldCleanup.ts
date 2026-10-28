import { z } from 'zod';
import { assertLease, lockLease } from '../apps/engine/src/lease';
import { testDatabaseUrl } from '../tools/test-database';
import type { LeaseHold } from './game';

// 이 시험이 쥔 실행권으로 자기 UUID 월드만 정리한다. 실행권을 먼저 놓으면 감독과 경합한다.
export async function cleanupHeldWorld(hold: LeaseHold, databaseUrl: string) {
  const errors: unknown[] = [];
  try {
    hold.done.abort();
    await hold.renewal;
    const target = testDatabaseUrl({ TEST_DATABASE_URL: databaseUrl });
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !z.uuid().safeParse(hold.lease.worldId).success)
      throw new Error('자기 loopback 시험 월드만 정리할 수 있습니다.');
    const [database] = await hold.db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (database?.name !== target.pathname.slice(1) || hold.lost)
      throw new Error('시험 DB와 실행권을 확인하지 못해 월드를 보존합니다.');
    await hold.db.$transaction(async (tx) => {
      await lockLease(tx, hold.lease);
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${hold.lease.worldId} FOR UPDATE`;
      // World 잠금을 기다리는 동안에도 실행권이 만료될 수 있다.
      await assertLease(tx, hold.lease);
      await tx.world.delete({ where: { id: hold.lease.worldId } });
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await hold.db.$disconnect();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, '시험 월드와 연결 정리 실패');
}
