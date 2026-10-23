import { createDb } from '@opensamguk/db';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worldId = process.argv[2]!;
const phase = process.argv[3]!;
const lease = await acquireLease(db, worldId, undefined, 5000);
if (!lease) throw new Error('시험 실행권이 없습니다.');
const hold = () => new Promise<void>(() => {});
process.send?.({ phase: 'lease', token: lease.fencingToken });
const loop = new TurnLoop(db, lease, {
  beforeCommit: async (tx) => {
    if (phase === 'beforeCommit' && (await tx.worldResult.findUnique({ where: { worldId } }))) {
      process.send?.({ phase: 'beforeCommit', token: lease.fencingToken });
      await hold();
    }
  },
});
await loop.advanceTo(120000);
process.send?.({ phase: 'committed', token: lease.fencingToken });
await hold();
