// 순위 E2E가 만든 월드를 지운다 (T2-23). e2e/rankingSeed.ts remove와 e2e/rankingCleanup.spec.ts가 쓴다.
// 이 파일은 불러오기만 해서는 DB에 닿지 않는다.
//
// 감독이 띄운 엔진은 한 턴 트랜잭션에서 EngineLease 행을 먼저 잠그고 World 행을 잠근다. 월드 삭제는 World 행을
// 먼저 지우고 cascade로 EngineLease 행을 지우므로 둘이 겹치면 PostgreSQL이 교착(40P01)으로 한쪽을 끊는다.
// 끊긴 쪽이 삭제면 Prisma는 P2034를 던지고 삭제는 통째로 되돌려진다. 그때만 같은 삭제를 다시 한다.
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '../packages/db/src/index';

const ATTEMPTS = 3;
// 1회 실패 뒤 100ms, 2회 실패 뒤 200ms를 기다린다. 3회째 실패는 그대로 던진다.
const WAITS_MS = [100, 200];

type WorldDb = { world: Pick<PrismaClient['world'], 'deleteMany' | 'count'> };
interface Options {
  sleep?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
}

function isWriteConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'PrismaClientKnownRequestError' &&
    (error as { code?: unknown }).code === 'P2034'
  );
}

export async function removeWorlds(db: WorldDb, worldIds: string[], options: Options = {}) {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const log = options.log ?? ((line: string) => console.error(line));
  const where = { id: { in: worldIds } };
  let removed: number | undefined;
  for (let attempt = 1; removed === undefined; attempt++) {
    try {
      removed = (await db.world.deleteMany({ where })).count;
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= ATTEMPTS) throw error;
      const ms = WAITS_MS[attempt - 1]!;
      log(`[rankingCleanup] 월드 삭제 ${attempt}회째가 쓰기 충돌(P2034)로 되돌려졌습니다. ${ms}ms 뒤 다시 지웁니다.`);
      await sleep(ms);
    }
  }
  const remaining = await db.world.count({ where });
  if (remaining !== 0) throw new Error(`지운 뒤에도 월드 ${remaining}개가 남았습니다.`);
  return { removed };
}
