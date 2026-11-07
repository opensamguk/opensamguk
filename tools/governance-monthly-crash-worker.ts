import { TurnLoop } from '../apps/engine/src/turnLoop';
import { acquireLease } from '../apps/engine/src/lease';
import { createDb, type Prisma } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';

const worldId = process.argv[2],
  phase = process.argv[3];
const tick = 70_000;
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (
  !process.send ||
  !process.env.TEST_DATABASE_URL ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(url.pathname) ||
  url.searchParams.has('host') ||
  url.searchParams.has('port') ||
  !worldId ||
  (phase !== 'beforeCommit' && phase !== 'committed')
)
  throw Error('황실 정산 중단 시험의 전용 DB·월드·IPC를 확인하세요.');
process.once('disconnect', () => process.exit(2));
const db = createDb(url.href);
const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
if (
  world.name !== 'AC-P2-31 황실 HTTP' ||
  !world.ruleFeatures.includes('governance-v1') ||
  world.monthlyTick !== 60_000 ||
  world.clockTick !== tick - 1
)
  throw Error('황실 정산 중단 시험 월드가 아닙니다.');

async function reached(tx: Pick<Prisma.TransactionClient, 'yearbookSnapshot' | 'governanceMovement'>) {
  const yearbook = await tx.yearbookSnapshot.findUnique({ where: { worldId_tick: { worldId: world.id, tick } } });
  if (!yearbook) return false;
  const rows = await tx.governanceMovement.findMany({
    where: { worldId: world.id, tick, sequence: yearbook.sequence },
    select: { kind: true },
  });
  if (
    rows.length !== 4 ||
    rows.filter(({ kind }) => kind === 'TRIBUTE').length !== 2 ||
    rows.filter(({ kind }) => kind === 'STIPEND').length !== 2
  )
    throw Error('황실 정산 중단 지점의 공납·봉록 이체가 맞지 않습니다.');
  return true;
}

async function hold() {
  process.send!(phase);
  await new Promise<never>(() => {});
}

const lease = await acquireLease(db, worldId);
if (!lease) throw Error('황실 정산 중단 시험의 실행권이 없습니다.');
await new TurnLoop(
  db,
  lease,
  phase === 'beforeCommit'
    ? {
        beforeCommit: async (tx) => {
          if (await reached(tx)) await hold();
        },
      }
    : {},
).advanceTo(tick);
if (phase !== 'committed' || !(await reached(db))) throw Error('황실 정산 중단 지점을 찾지 못했습니다.');
await hold();
