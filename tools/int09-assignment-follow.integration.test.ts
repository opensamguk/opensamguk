import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildInitialWorld, monthlyDate, runMonthly, settleMonthlyFeatures } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { rngFor } from '../packages/shared/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState, persistMonthly } from '../apps/engine/src/monthly';
import { acquireLease, assertLease, lockLease, releaseLease } from '../apps/engine/src/lease';

// AC-INT-09 월 정산의 위치·앵커·발령 종료 저장만 검사하는 4인 통제 고정물이다.
// 원생성 뒤 사람/휘하/발령을 준비하므로 원생성부터의 archive 재생이나 정식 한 기수 증거로 세지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
)
  throw new Error('loopback 전용 검사 DB가 필요합니다.');
const db = createDb(url);
const worldIds: string[] = [],
  userIds: string[] = [];
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
afterAll(async () => {
  try {
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});

async function fixture(corrected: boolean) {
  const source = operationalInput();
  source.scenario.nation = [source.scenario.nation[0]!];
  source.scenario.nation[0]![8] = ['도시1', '도시2', '관문'];
  source.scenario.general = [1, 2, 3, 4].map((id) => [
    0,
    `저장장수${id}`,
    '',
    1,
    '도시1',
    50,
    50,
    50,
    id === 4 ? 12 : 1,
    100,
    250,
    null,
    null,
  ]);
  source.scenario.generalStats = [1, 2, 3, 4].map((generalId) => ({
    generalId,
    stats: { leadership: 50, strength: 50, intel: 50, politics: 50, charm: 50 },
    sourceId: 'test-fixture',
    sourceRevision: 'test-fixture-v1',
    officerId: generalId,
  }));
  const initial = buildInitialWorld(source);
  initial.ruleFeatures = [
    ...(corrected ? ['campaign-assignment-v2'] : []),
    'campaign-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
  ];
  initial.nations[0]!.isNpc = false;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT09 발령 동행 저장 고정물',
    turnTermMinutes: 60,
    endYear: 201,
  });
  worldIds.push(worldId);
  for (const generalId of [1, 3]) {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid`, passwordHash: 'non-login-storage-fixture' },
    });
    userIds.push(user.id);
    await db.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: { userId: user.id, residenceTick: 0, lastActiveTick: 0 },
    });
  }
  const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const campaign = saved.campaignState as unknown as Record<string, unknown>;
  await db.world.update({
    where: { id: worldId },
    data: {
      campaignState: json({
        ...campaign,
        nextUnitId: 2,
        links: [
          { masterId: 1, personId: 2, relation: 'LIEUTENANT' },
          { masterId: 1, personId: 3, relation: 'STAFF' },
        ],
        units: [{ id: 1, ownerId: 1, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 50 }],
      }),
    },
  });
  await db.assignmentOffer.create({
    data: {
      worldId,
      id: '0-4-1',
      nationId: 1,
      issuerGeneralId: 4,
      targetGeneralId: 1,
      cityKey: 2,
      status: 'PENDING',
      createdTick: 0,
      expiresTick: 20000,
    },
  });
  return { worldId, initial, origin: saved.replayOrigin };
}

describe('AC-INT-09 실제 PostgreSQL 월간 발령 동행 저장', () => {
  it.each([false, true])('원생성의 보완판 선택=%s: 원자적 저장·롤백·재접속·월 해시 일치', async (corrected) => {
    const f = await fixture(corrected),
      other = await fixture(corrected);
    const before = await db.$transaction((tx) => loadReplayState(tx, f.worldId), { isolationLevel: 'RepeatableRead' });
    const isolated = hashState(await db.$transaction((tx) => loadReplayState(tx, other.worldId)));
    const tick = 20000,
      date = monthlyDate(before.state.startYear, tick);
    const monthly = runMonthly(before.state, tick, rngFor(f.initial.seed, 'monthly', date.year, date.month));
    const expected = settleMonthlyFeatures(before, { ...before, state: monthly.state, monthlyTick: tick }, tick).replay;
    const lease = await acquireLease(db, f.worldId);
    if (!lease) throw new Error('검사 실행권이 없습니다.');
    try {
      const write = (fail: boolean) =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${f.worldId} FOR UPDATE`;
          await lockLease(tx, lease);
          await persistMonthly(tx, f.worldId, f.initial.seed, tick, 1);
          await assertLease(tx, lease);
          if (fail) throw new Error('assignment-month-late-rollback');
        });
      await expect(write(true)).rejects.toThrow('assignment-month-late-rollback');
      expect(hashState(await db.$transaction((tx) => loadReplayState(tx, f.worldId)))).toBe(hashState(before));
      expect(await db.yearbookSnapshot.count({ where: { worldId: f.worldId } })).toBe(0);
      expect(
        (await db.assignmentOffer.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: '0-4-1' } } }))
          .status,
      ).toBe('PENDING');
      await write(false);
    } finally {
      await releaseLease(db, lease);
    }
    const reopened = createDb(url);
    try {
      const after = await reopened.$transaction((tx) => loadReplayState(tx, f.worldId), {
        isolationLevel: 'RepeatableRead',
      });
      expect(after).toEqual(expected);
      expect([1, 2, 3].map((id) => after.state.generals[id]!.cityKey)).toEqual([2, corrected ? 2 : 1, 1]);
      expect(after.residenceAnchors).toEqual({ 1: tick, 3: 0 });
      expect(after.turns).toEqual(before.turns);
      expect(after.state.campaign).toEqual(before.state.campaign);
      expect(
        await reopened.assignmentOffer.findUniqueOrThrow({
          where: { worldId_id: { worldId: f.worldId, id: '0-4-1' } },
        }),
      ).toMatchObject({ status: 'ACCEPTED', resolvedBy: 'EXPIRY', resolvedTick: tick });
      expect(
        (await reopened.yearbookSnapshot.findUniqueOrThrow({ where: { worldId_tick: { worldId: f.worldId, tick } } }))
          .stateHash,
      ).toBe(hashState(expected));
      expect((await reopened.world.findUniqueOrThrow({ where: { id: f.worldId } })).replayOrigin).toEqual(f.origin);
      expect(hashState(await reopened.$transaction((tx) => loadReplayState(tx, other.worldId)))).toBe(isolated);
    } finally {
      await reopened.$disconnect();
    }
  });
});
