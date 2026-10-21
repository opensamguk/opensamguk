// 순위 E2E 준비 (T2-23). 실제 DB에 월드를 만들고 엔진의 턴 루프로 첫 월간 정산을 돌려 순위 캐시를 만든다.
// e2e/ranking.spec.ts가 실행한다. DB는 .env의 DATABASE_URL이고 dev 서버와 같은 DB여야 한다.
//   fresh                                정산 전 월드
//   settled <위 계정> <밖 계정> <새 계정>  첫 정산을 마친 월드. 위 계정은 공헌 1위, 밖 계정은 꼴찌,
//                                        새 계정은 정산 뒤 장수 생성 입력을 엔진이 처리해 장수가 생긴다.
//   remove <월드 ID…>                    만든 월드를 지운다
import { randomUUID } from 'node:crypto';
import { createDb } from '../packages/db/src/index';
import { statRulesSchema, TICKS_PER_MONTH, validateGeneralCreation } from '../packages/rules/src/index';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorld } from '../apps/engine/src/world/resources';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL이 없습니다.');
const db = createDb(url);
const [command, ...args] = process.argv.slice(2);

async function fresh() {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'e2e-ranking-fresh' });
  const { worldId } = await saveInitialWorld(db, initial, { name: 'E2E 순위 정산 전', turnTermMinutes: 60 });
  return { worldId };
}

async function settled(emails: string[]) {
  const [top, outside, newcomer] = await Promise.all(
    emails.map((email) => db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })),
  );
  if (!top || !outside || !newcomer) throw new Error('계정 세 개가 필요합니다.');
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 'e2e-ranking' });
  // 130명만 등장시켜 상위 100명 밖이 생기게 한다. 정산은 바뀐 장수를 한 명씩 저장하므로 수를 줄여
  // 부하가 큰 기계에서도 정산 트랜잭션 제한(30초) 안에 들게 한다. 나머지는 50년 뒤 등장이라 순위에 없다.
  // 첫 정산 전에는 차례가 오지 않게 해 정산만 돌린다.
  // 시나리오의 공헌·경험은 모두 0이라 기준마다 순서가 달라지도록 지력·통솔에서 값을 준다.
  const ids = initial.generals.map((g) => g.id).sort((a, b) => a - b);
  const [firstId, lastId] = [ids[0]!, ids.at(-1)!];
  const appearing = new Set([...ids.slice(0, 129), lastId]);
  initial.generals = initial.generals.map((g) => ({
    ...g,
    activeFromYear: appearing.has(g.id) ? initial.startYear : initial.startYear + 50,
    nextTurnTick: TICKS_PER_MONTH + 1,
    dedication: g.intel * 100,
    experience: g.leadership * 100,
    ...(g.id === firstId ? { userId: top.id, dedication: 999_999 } : {}),
    // 같은 값이면 ID 순이라 가장 큰 ID에 0을 주면 꼴찌다.
    ...(g.id === lastId ? { userId: outside.id, dedication: 0, experience: 0 } : {}),
  }));
  const { worldId } = await saveInitialWorld(db, initial, { name: 'E2E 순위', turnTermMinutes: 60 });
  // 리스를 먼저 잡아 dev 엔진이 이 월드를 가져가지 못하게 한다.
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('엔진 리스를 얻지 못했습니다.');
  try {
    await controlClock(db, worldId, 'start');
    // [PROBE] 진단 전용: RUNNING 창을 넓혀 dev 엔진 폴링(1초)이 반드시 이 월드를 보게 한다.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const loop = new TurnLoop(db, lease);
    await loop.advanceTo(TICKS_PER_MONTH);
    // 정산 뒤에 생긴 장수. 장수 생성 API가 넣는 입력과 같은 모양을 넣고 엔진이 처리한다.
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const { total } = statRulesSchema.parse({ stat: world.statRules }).stat;
    const third = Math.floor(total / 3);
    const checked = validateGeneralCreation(
      { name: '새장수', leadership: total - 2 * third, strength: third, intel: third, portraitId: null },
      world.statRules,
    );
    if (!checked.ok) throw new Error(checked.message);
    const event = await db.inputEvent.create({
      data: {
        worldId,
        userId: newcomer.id,
        kind: 'general.create',
        idempotencyKey: `general.create:${randomUUID()}`,
        payload: checked.value,
        status: 'PENDING',
        sequence: null,
      },
    });
    await loop.advanceTo(TICKS_PER_MONTH);
    const applied = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    if (applied.status !== 'APPLIED') throw new Error(`장수 생성이 처리되지 않았습니다: ${applied.status}`);
    // 멈춰 두어 dev 엔진이 더 진행하지 않게 한다.
    await controlClock(db, worldId, 'pause');
  } finally {
    await releaseLease(db, lease);
  }
  return { worldId, generals: appearing.size };
}

async function remove(worldIds: string[]) {
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  return { removed: worldIds.length };
}

try {
  const result =
    command === 'fresh'
      ? await fresh()
      : command === 'settled'
        ? await settled(args)
        : command === 'remove'
          ? await remove(args)
          : null;
  if (!result) throw new Error('fresh, settled, remove 중 하나를 주세요.');
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
