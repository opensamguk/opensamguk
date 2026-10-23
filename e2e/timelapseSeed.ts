// 영토 재생 E2E 준비 (T4-36). 실제 DB에 월드를 만들고 e2e/timelapse.spec.ts가 실행한다.
// DB는 .env의 DATABASE_URL이고 dev 서버와 같은 E2E 전용 DB(_test)여야 한다.
//   create              월드 다섯 개를 만들고 ID와 엔진이 저장한 값을 JSON으로 낸다
//   remove <월드 ID…>   만든 월드와 이 스크립트가 만든 계정을 지운다
//
// P는 엔진 경로를 끝까지 탄다. 턴 루프가 월간 정산으로 프레임과 국가 표시값을 저장하고, 미리 넣은 출병 예턴을
// 엔진이 실행해 마지막 도시를 잃은 국가가 실제로 멸망한다(T4-56 R1/S3와 같은 장면). 나머지 월드는 정산 없이
// 프레임 행을 바로 넣는 DB 준비다. 응답을 지어내는 mock이 아니며 서버는 그 행을 그대로 읽는다.
import { randomUUID } from 'node:crypto';
import { createDb, nextActionSequence, type Prisma } from '../packages/db/src/index';
import { emptyTurns, monthlyDate, TICKS_PER_MONTH, type Yearbook } from '../packages/rules/src/index';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { warFixture } from '../apps/engine/test/warFixture';
import { removeWorlds } from './rankingCleanup';

const url = process.env.DATABASE_URL;
if (!url || !decodeURIComponent(new URL(url).pathname.slice(1)).endsWith('_test')) {
  throw new Error('E2E는 이름이 _test로 끝나는 전용 DB에서만 돌립니다. DATABASE_URL의 DB 이름을 확인하세요.');
}
const db = createDb(url);
const [command, ...args] = process.argv.slice(2);
// 이 스크립트가 만든 계정. remove가 이 접두어로 지운다.
const USER_PREFIX = 'e2e-timelapse-';

type Owners = Array<number | null>;

// 정산 없이 프레임을 넣을 월드. 도시 네 개, 국가 두 개(warFixture)이고 PREOPEN이라 엔진이 가져가지 않는다.
async function staticWorld(name: string, frames: Owners[], skipStored: (k: number, nationId: number) => boolean) {
  const initial = await warFixture();
  const { worldId } = await saveInitialWorld(db, initial, { name, turnTermMinutes: 60, endYear: null });
  const nations = await db.nation.findMany({ where: { worldId }, select: { id: true, name: true, color: true } });
  for (const [k, owners] of frames.entries()) {
    const tick = TICKS_PER_MONTH * (k + 1);
    const cities = owners.map((nationId, i) => ({ cityKey: i + 1, nationId }));
    const owning = [...new Set(owners.filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const data: Yearbook = {
      nations: owning.map((nationId) => ({
        nationId,
        cities: owners.filter((id) => id === nationId).length,
        generals: 0,
        power: 0,
        gold: 0,
        rice: 0,
      })),
      cities,
    };
    await db.yearbookSnapshot.create({
      data: {
        worldId,
        tick,
        ...monthlyDate(initial.startYear, tick),
        sequence: 0,
        data: data as unknown as Prisma.InputJsonValue,
        stateHash: 'e2e-timelapse',
        nations: {
          create: nations
            .filter(({ id }) => owning.includes(id) && !skipStored(k, id))
            .map(({ id, name: nationName, color }) => ({ nationId: id, name: nationName, color })),
        },
      },
    });
  }
  return worldId;
}

// 장수 예턴 첫 칸을 바꾸고 예턴 API가 남기는 입력 기록을 같이 넣는다 (nationArchive.integration.test.ts의 queue와 같다).
async function queue(worldId: string, generalId: number, commandKey: string, turnArgs: Prisma.InputJsonValue) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    const turns = emptyTurns();
    turns[0] = { commandKey, args: turnArgs };
    await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({
        ...turn,
        worldId,
        generalId,
        slot,
        args: turn.args as Prisma.InputJsonValue,
      })),
    });
    await tx.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: { turnRevision: { increment: 1 } },
    });
    const sequence = await nextActionSequence(tx, worldId);
    await tx.inputEvent.create({
      data: {
        worldId,
        userId: actor.userId!,
        generalId,
        kind: 'turns.set',
        idempotencyKey: `${USER_PREFIX}${sequence}-${randomUUID()}`,
        status: 'APPLIED',
        sequence,
        payload: { turns, revision: actor.turnRevision } as unknown as Prisma.InputJsonValue,
        result: { revision: actor.turnRevision + 1 },
      },
    });
  });
}

// 첫 정산(10000) 뒤 국가 1의 지금 이름·색을 바꾸고, 10100에 국가 1 장수가 출병해 국가 2의 마지막 도시를 빼앗는다.
// 다음 정산(20000)까지 돌려 멸망 뒤 프레임도 만든다. 국가 이름을 바꾸는 것은 DB 준비이며 규칙 변경이 아니다.
async function destroyedWorld() {
  const initial = await warFixture();
  initial.generals[0]!.nextTurnTick = 10100;
  // 조기 통일을 막는 빈 도시 (T4-56 시험과 같다).
  initial.cities.push({
    ...initial.cities[0]!,
    cityKey: 999,
    name: '경계 도시',
    nationId: null,
    connections: [],
    supplied: false,
  });
  // 모든 장수를 사람 장수로 두어 NPC 판단 없이 넣은 예턴만 실행되게 한다.
  const run = randomUUID();
  for (const general of initial.generals) {
    general.userId = `${USER_PREFIX}${run}-${general.id}`;
    await db.user.create({
      data: { id: general.userId, email: `${general.userId}@example.test`, passwordHash: 'fixture-only' },
    });
  }
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'E2E 영토 재생 멸망',
    turnTermMinutes: 60,
    endYear: null,
  });
  // 리스를 먼저 잡아 dev 엔진이 이 월드를 가져가지 못하게 한다.
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('엔진 리스를 얻지 못했습니다.');
  try {
    await controlClock(db, worldId, 'start');
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(TICKS_PER_MONTH);
    const settled = await db.yearbookNation.findMany({
      where: { worldId, tick: TICKS_PER_MONTH },
      orderBy: { nationId: 'asc' },
      select: { nationId: true, name: true, color: true },
    });
    const renamed = { id: 1, name: 'E2E 바뀐 국호', color: '#2f6f4f' };
    await db.nation.update({
      where: { worldId_id: { worldId, id: renamed.id } },
      data: { name: renamed.name, color: renamed.color },
    });
    await queue(worldId, 1, 'attack', { cityKey: 2 });
    await loop.advanceTo(TICKS_PER_MONTH + 100);
    if (await db.nation.findUnique({ where: { worldId_id: { worldId, id: 2 } } })) {
      throw new Error('출병 뒤에도 국가 2가 남아 있습니다.');
    }
    await loop.advanceTo(2 * TICKS_PER_MONTH);
    // 멈춰 두어 dev 엔진이 더 진행하지 않게 한다.
    await controlClock(db, worldId, 'pause');
    return { worldId, settled, renamed, removed: 2 };
  } finally {
    await releaseLease(db, lease);
  }
}

async function create() {
  // A: 프레임 35개. 도시 3은 달마다 국가 1과 2가 번갈아 가진다. 30개씩 받으므로 두 페이지다.
  const paged = await staticWorld(
    'E2E 영토 재생 35개월',
    Array.from({ length: 35 }, (_, k) => [1, 2, k % 2 === 0 ? 1 : 2, 1]),
    () => false,
  );
  // B: 프레임 3개. A와 다른 소유다.
  const other = await staticWorld(
    'E2E 영토 재생 3개월',
    [
      [2, 2, 2, null],
      [2, 2, null, null],
      [2, null, null, null],
    ],
    () => false,
  );
  // C: 프레임 0개.
  const empty = await staticWorld('E2E 영토 재생 빈 기록', [], () => false);
  // M: 둘째 프레임에만 국가 2의 저장값이 없다.
  const missing = await staticWorld(
    'E2E 영토 재생 기록 누락',
    [
      [1, 2, null, 1],
      [1, 2, null, 1],
      [1, 1, null, 1],
    ],
    (k, nationId) => k === 1 && nationId === 2,
  );
  const destroyed = await destroyedWorld();
  return { paged, other, empty, missing, destroyed };
}

// 감독 엔진의 턴과 겹친 교착(P2034)만 같은 삭제를 다시 한다 (rankingCleanup.ts).
async function remove(worldIds: string[]) {
  const result = await removeWorlds(db, worldIds);
  const users = await db.user.deleteMany({ where: { id: { startsWith: USER_PREFIX }, generals: { none: {} } } });
  return { ...result, users: users.count };
}

try {
  const result = command === 'create' ? await create() : command === 'remove' ? await remove(args) : null;
  if (!result) throw new Error('create, remove 중 하나를 주세요.');
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
