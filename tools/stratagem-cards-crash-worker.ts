import { randomUUID } from 'node:crypto';
import { createDb, type Prisma } from '../packages/db/src/index';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const worldId = process.env.CARDS_CRASH_WORLD,
  mode = process.env.CARDS_CRASH_MODE,
  boundary = process.env.CARDS_CRASH_BOUNDARY ?? 'INPUT';
if (
  !process.send ||
  !process.env.TEST_DATABASE_URL ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(url.pathname) ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !worldId ||
  !['BEFORE_COMMIT', 'AFTER_COMMIT', 'RECOVER'].includes(mode ?? '') ||
  !['INPUT', 'MONTHLY', 'BATTLE'].includes(boundary)
)
  throw Error('계략 패 중단 시험의 전용 DB·월드·IPC를 확인하세요.');
if (mode !== 'RECOVER') process.once('disconnect', () => process.exit(2));
const db = createDb(url.href),
  world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
if (
  world.name !== '계략 패 실제 처리 검증' ||
  world.scenarioKey !== 'command-test' ||
  !world.seed.startsWith('cards-pg-') ||
  !world.ruleFeatures.includes('stratagem-cards-v1')
)
  throw Error('계략 패 중단 시험 월드가 아닙니다.');
const tick = process.env.CARDS_CRASH_TICK ? Number(process.env.CARDS_CRASH_TICK) : world.clockTick;
if (!Number.isSafeInteger(tick) || tick < world.clockTick || tick > world.clockTick + 10000)
  throw Error('계략 패 중단 시험의 처리 시각이 아닙니다.');
async function reached(tx: Pick<Prisma.TransactionClient, 'world' | 'inputEvent' | 'generalLog'>) {
  if (boundary === 'MONTHLY')
    return !!(await tx.world.findFirst({ where: { id: world.id, monthlyTick: tick }, select: { id: true } }));
  if (boundary === 'BATTLE')
    return !!(await tx.generalLog.findFirst({
      where: { worldId: world.id, tick, commandKey: 'attack', text: { contains: '함정' } },
      select: { generalId: true },
    }));
  return !!(await tx.inputEvent.findFirst({
    where: { worldId: world.id, kind: 'stratagem-cards.act', status: 'APPLIED' },
    select: { id: true },
  }));
}
const lease = await acquireLease(db, worldId, randomUUID(), 1000);
if (!lease) throw Error('계략 패 중단 시험 실행권이 없습니다.');
try {
  await new TurnLoop(
    db,
    lease,
    mode === 'BEFORE_COMMIT'
      ? {
          beforeCommit: async (tx) => {
            if (!(await reached(tx))) return;
            process.send!({ phase: mode, pid: process.pid });
            await new Promise<never>(() => {});
          },
        }
      : {},
  ).advanceTo(tick);
  if (!(await reached(db))) throw Error('계략 패 중단 시험의 실제 처리 경계가 없습니다.');
} finally {
  await releaseLease(db, lease);
  await db.$disconnect();
}
if (mode === 'BEFORE_COMMIT') throw Error('계략 패 커밋 직전 중단 지점을 지나쳤습니다.');
await new Promise<void>((resolve, reject) =>
  process.send!({ phase: mode, pid: process.pid }, (error) => (error ? reject(error) : resolve())),
);
if (mode === 'RECOVER') process.disconnect!();
else await new Promise<never>(() => {});
