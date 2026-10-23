import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  initialReplayState,
  settleDiplomacy,
  settleTreaties,
  type TreatyInput,
  type WorldState,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadWorld } from './worldLoader';
import { loadTreaties, persistTreatyClosures } from './treatyState';
import { processTreatyInput } from './treatyInput';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds = new Set<string>();
const users = new Set<string>();
const clauses = [{ kind: 'peace' as const }, { kind: 'nonAggression' as const, months: 1 }];
type Event = Prisma.InputEventGetPayload<Record<string, never>>;

afterAll(async () => {
  try {
    if (worlds.size) await db.world.deleteMany({ where: { id: { in: [...worlds] } } });
    if (users.size) await db.user.deleteMany({ where: { id: { in: [...users] } } });
  } finally {
    await db.$disconnect();
  }
});

// 원시 DB 저장 경계 fixture다. cap6 선택·origin 생성·CLI·리스·loop 검증이 아니다.
async function fixture(npc = false) {
  const initial = await monthlyFixture();
  const worldId = randomUUID();
  const userIds = [randomUUID(), randomUUID(), randomUUID()];
  worlds.add(worldId);
  userIds.forEach((id) => users.add(id));
  initial.nations = initial.nations.map((nation) => ({ ...nation, gold: 1000, isNpc: npc && nation.id === 2 }));
  initial.generals = initial.generals.map((general, index) => ({
    ...general,
    userId: npc && index === 1 ? null : userIds[index]!,
    officerLevel: index < 2 ? 12 : 1,
  }));
  await db.$transaction(async (tx) => {
    await tx.user.createMany({
      data: userIds
        .filter((_, index) => !npc || index !== 1)
        .map((id) => ({ id, email: `${id}@example.invalid`, passwordHash: 'test-only' })),
    });
    await tx.world.create({
      data: {
        id: worldId,
        name: '조약 저장 경계',
        scenarioKey: initial.scenarioKey,
        mapKey: initial.mapKey,
        unitSetKey: initial.unitSetKey,
        seed: initial.seed,
        startYear: initial.startYear,
        turnTermMinutes: 60,
        status: 'RUNNING',
        treatyFormat: 1,
        initialStateHash: hashState(initialReplayState(initial)),
        statRules: initial.statRules,
        unitSet: initial.unitSet as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.nation.createMany({
      data: initial.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
    });
    await tx.city.createMany({ data: initial.cities.map((city) => ({ ...city, worldId })) });
    for (const nation of initial.nations)
      await tx.nation.update({
        where: { worldId_id: { worldId, id: nation.id } },
        data: { capitalCityKey: nation.capitalCityKey },
      });
    await tx.general.createMany({ data: initial.generals.map((general) => ({ ...general, worldId })) });
    await tx.diplomacy.createMany({ data: initial.diplomacies.map((relation) => ({ ...relation, worldId })) });
  });
  return { worldId, userIds };
}

async function enqueue(worldId: string, userId: string, generalId: number, input: TreatyInput) {
  return db.inputEvent.create({
    data: {
      worldId,
      userId,
      generalId,
      kind: input.kind,
      idempotencyKey: `${input.kind}:${randomUUID()}`,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}
async function run(event: Event, tick = 1500, after?: (tx: Prisma.TransactionClient) => Promise<void>) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${event.worldId} FOR UPDATE`;
    const world = await tx.world.findUniqueOrThrow({ where: { id: event.worldId } });
    const selected = await tx.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    await processTreatyInput(tx, world, selected, tick);
    await after?.(tx);
  });
  return db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
}
async function proposal(
  worldId: string,
  userId: string,
  clauseSet: TreatyInput & { kind: 'treaty.propose' } = { kind: 'treaty.propose', payload: { toNationId: 2, clauses } },
) {
  const event = await enqueue(worldId, userId, 1, clauseSet);
  const saved = await run(event);
  if (saved.status !== 'APPLIED' || saved.sequence === null) throw new Error('제안 준비 실패');
  return String(saved.sequence);
}
async function response(worldId: string, userId: string, treatyId: string, accept = true) {
  return enqueue(worldId, userId, 2, { kind: 'treaty.respond', payload: { treatyId, accept } });
}
async function snapshot(worldId: string) {
  return {
    world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
    nations: await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    relations: await db.diplomacy.findMany({ where: { worldId } }),
    treaties: await db.treaty.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
    events: await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
  };
}

describe('T2-07 / AC-M2-06 실제 PostgreSQL 조약 저장 component', () => {
  it('사람 제안·수락 때 비용을 다시 계산하고 상태와 완료 입력을 함께 저장한다', async () => {
    const { worldId, userIds } = await fixture();
    const nation = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const otherNation = await db.nation.create({ data: { ...nation, id: 3, name: '보존 국가' } });
    const otherPair = await db.diplomacy.create({
      data: { worldId, nationA: 1, nationB: 3, state: 'NON_AGGRESSION', untilTick: 90000 },
    });
    const otherTreaty = await db.treaty.create({
      data: {
        worldId,
        id: 100,
        fromNationId: 1,
        toNationId: 3,
        clauses: [{ kind: 'note', text: '보존' }],
        status: 'ACTIVE',
        proposedTick: 1000,
        respondByTick: 61000,
        startTick: 1001,
        endTick: null,
        costFrom: 0,
        costTo: 0,
      },
    });
    const generals = await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
    const id = await proposal(worldId, userIds[0]!);
    expect((await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } })).map((n) => n.gold)).toEqual([
      1000, 1000, 1000,
    ]);
    await db.city.update({ where: { worldId_cityKey: { worldId, cityKey: 3 } }, data: { nationId: 2 } });
    const accepted = await run(await response(worldId, userIds[1]!, id), 1501);
    expect(accepted).toMatchObject({
      status: 'APPLIED',
      sequence: 2,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', tick: 1501, cost: { from: 9, to: 25 }, endTick: 11501 },
    });
    expect(
      await db.nation.findMany({
        where: { worldId, id: { in: [1, 2] } },
        orderBy: { id: 'asc' },
        select: { gold: true },
      }),
    ).toEqual([{ gold: 991 }, { gold: 975 }]);
    expect(
      await db.diplomacy.findMany({ where: { worldId }, orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }] }),
    ).toEqual([{ worldId, nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 11501 }, otherPair]);
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 3 } } })).toEqual(otherNation);
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 100 } } })).toEqual(otherTreaty);
    expect(await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } })).toEqual(generals);
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: Number(id) } } })).toMatchObject({
      status: 'ACTIVE',
      costFrom: 9,
      costTo: 25,
      startTick: 1501,
      endTick: 11501,
      closedSequence: null,
    });
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence).toBe(2);
  });

  it('원시 저장 세계를 enabled-world나 origin6 생성 증거로 삼지 않는다', async () => {
    const { worldId } = await fixture();
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(world.treatyFormat).toBe(1);
    expect(world.replayOrigin).toBeNull();
    expect(await db.$transaction((tx) => loadTreaties(tx, worldId))).toEqual({});
  });

  it.each([false, true])(
    'NPC는 같은 이벤트에서 응답하며 별도 NPC user를 만들지 않는다 (부족 %s)',
    async (insufficient) => {
      const { worldId, userIds } = await fixture(true);
      await db.nation.update({ where: { worldId_id: { worldId, id: 2 } }, data: { gold: insufficient ? 16 : 17 } });
      const event = await enqueue(worldId, userIds[0]!, 1, {
        kind: 'treaty.propose',
        payload: { toNationId: 2, clauses },
      });
      const saved = await run(event);
      expect(saved).toMatchObject({
        userId: userIds[0],
        generalId: 1,
        status: 'APPLIED',
        sequence: 1,
        result: { outcome: insufficient ? 'DECLINED' : 'ACCEPTED', by: 'NPC', treatyId: '1' },
      });
      const row = await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
      expect(row).toMatchObject({
        status: insufficient ? 'REJECTED' : 'ACTIVE',
        proposedTick: 1500,
        respondByTick: 61500,
        closedSequence: insufficient ? 1 : null,
        costFrom: insufficient ? null : 17,
        costTo: insufficient ? null : 17,
      });
      expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
      expect(
        await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' }, select: { userId: true } }),
      ).toEqual(userIds.map((userId, index) => ({ userId: index === 1 ? null : userId })));
      expect(await db.user.findUnique({ where: { id: userIds[1]! } })).toBeNull();
      const loaded = await db.$transaction((tx) => loadTreaties(tx, worldId));
      if (insufficient) expect(loaded).toEqual({});
      else expect(loaded.treaties?.[0]).not.toHaveProperty('costFrom');
    },
  );

  it('열린 행만 정렬해 읽고 비용·마감 기록을 canonical 상태에서 뺀다', async () => {
    const { worldId, userIds } = await fixture();
    const first = await proposal(worldId, userIds[0]!, {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }] },
    });
    await run(await response(worldId, userIds[1]!, first), 1501);
    expect(await db.diplomacy.count({ where: { worldId } })).toBe(0);
    expect(await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' }, select: { gold: true } })).toEqual([
      { gold: 1000 },
      { gold: 1000 },
    ]);
    const followup: TreatyInput & { kind: 'treaty.propose' } = {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 1 }] },
    };
    const second = await proposal(worldId, userIds[0]!, followup);
    const third = await proposal(worldId, userIds[0]!, followup);
    await run(await response(worldId, userIds[1]!, third, false));
    await db.$transaction(async (tx) => {
      const rows = await tx.treaty.findMany({
        where: { worldId, status: { in: ['PROPOSED', 'ACTIVE'] } },
        orderBy: { id: 'desc' },
      });
      await tx.treaty.deleteMany({ where: { worldId, id: { in: rows.map((row) => row.id) } } });
      for (const row of rows)
        await tx.treaty.create({ data: { ...row, clauses: row.clauses as Prisma.InputJsonValue } });
    });
    const loaded = await db.$transaction((tx) => loadTreaties(tx, worldId));
    expect(loaded.treaties?.map((entry) => entry.id)).toEqual([Number(first), Number(second)]);
    expect(loaded.treaties?.[0]).toMatchObject({ status: 'ACTIVE', endTick: null });
    for (const row of loaded.treaties ?? [])
      expect(Object.keys(row).sort()).toEqual([
        'clauses',
        'endTick',
        'fromNationId',
        'id',
        'proposedTick',
        'respondByTick',
        'startTick',
        'status',
        'toNationId',
      ]);
  });

  it('저장된 순서나 metadata 파손을 정상화하지 않고 throw한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = Number(await proposal(worldId, userIds[0]!));
    await db.treaty.update({
      where: { worldId_id: { worldId, id } },
      data: { clauses: [{ kind: 'note', text: '기록' }, { kind: 'peace' }] },
    });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow();
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { clauses, closedSequence: 1 } });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow();
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { closedSequence: null, costFrom: 0 } });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow();
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { costFrom: null, startTick: 1500 } });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow();
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { startTick: null, respondByTick: 61501 } });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow();
  });

  it.each([null, -1])('ACTIVE 납부 기록이 파손되면 throw한다 (cost %s)', async (costFrom) => {
    const { worldId, userIds } = await fixture();
    const id = Number(await proposal(worldId, userIds[0]!));
    await run(await response(worldId, userIds[1]!, String(id)));
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { costFrom } });
    await expect(db.$transaction((tx) => loadTreaties(tx, worldId))).rejects.toThrow('납부 기록');
  });

  it.each([61499, 61500])('응답 기한 직전과 기한에서 판정하고 만료 행은 월간에만 닫는다 (tick %i)', async (tick) => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    const saved = await run(await response(worldId, userIds[1]!, id), tick);
    if (tick === 61499) {
      expect(saved).toMatchObject({ status: 'APPLIED', result: { outcome: 'ACCEPTED', endTick: 71499 } });
      return;
    }
    expect(saved).toMatchObject({ status: 'REJECTED', result: { code: 'EXPIRED' } });
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: Number(id) } } })).toMatchObject({
      status: 'PROPOSED',
      closedSequence: null,
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const before: WorldState = { ...(await loadWorld(tx, worldId)), ...(await loadTreaties(tx, worldId)) };
      const sequence = await nextActionSequence(tx, worldId);
      await persistTreatyClosures(tx, worldId, before, settleTreaties(settleDiplomacy(before, 70000), 70000), {
        tick: 70000,
        sequence,
      });
    });
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: Number(id) } } })).toMatchObject({
      status: 'EXPIRED',
      closedSequence: 3,
      costFrom: null,
      costTo: null,
    });
  });

  it('사라진 당사자의 열린 행을 읽고 월간 정산에서 닫는다', async () => {
    const { worldId, userIds } = await fixture();
    const id = Number(await proposal(worldId, userIds[0]!));
    await db.treaty.update({ where: { worldId_id: { worldId, id } }, data: { toNationId: 99 } });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const before: WorldState = { ...(await loadWorld(tx, worldId)), ...(await loadTreaties(tx, worldId)) };
      expect(before.treaties?.[0]?.toNationId).toBe(99);
      const sequence = await nextActionSequence(tx, worldId);
      await persistTreatyClosures(tx, worldId, before, settleTreaties(settleDiplomacy(before, 10000), 10000), {
        tick: 10000,
        sequence,
      });
    });
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } })).toMatchObject({
      status: 'EXPIRED',
      closedSequence: 2,
    });
  });

  it('연결하지 않은 조항은 이벤트만 거절한다', async () => {
    const { worldId, userIds } = await fixture();
    const event = await enqueue(worldId, userIds[0]!, 1, {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 1 }] },
    });
    const before = await snapshot(worldId);
    expect(await run(event)).toMatchObject({ status: 'REJECTED', result: { code: 'CLAUSE_NOT_CONNECTED' } });
    const next = await snapshot(worldId);
    expect(next.nations).toEqual(before.nations);
    expect(next.relations).toEqual(before.relations);
    expect(next.treaties).toEqual(before.treaties);
  });

  it('수락 국고 부족이면 이벤트만 거절하고 열린 제안과 양국 값을 보존한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    await db.nation.update({ where: { worldId_id: { worldId, id: 2 } }, data: { gold: 16 } });
    const event = await response(worldId, userIds[1]!, id);
    const before = await snapshot(worldId);
    expect(await run(event)).toMatchObject({
      status: 'REJECTED',
      sequence: 2,
      result: { code: 'INSUFFICIENT_GOLD', tick: 1500 },
    });
    const next = await snapshot(worldId);
    expect(next.nations).toEqual(before.nations);
    expect(next.relations).toEqual(before.relations);
    expect(next.treaties).toEqual(before.treaties);
  });

  it.each(['permission', 'owner', 'sanction'] as const)(
    '집행 때 권한·소유·계정을 다시 확인한다 (%s)',
    async (condition) => {
      const { worldId, userIds } = await fixture();
      const generalId = condition === 'owner' ? 2 : 1;
      const event = await enqueue(worldId, userIds[0]!, generalId, {
        kind: 'treaty.propose',
        payload: { toNationId: 2, clauses },
      });
      if (condition === 'permission')
        await db.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { officerLevel: 1 } });
      if (condition === 'sanction')
        await db.user.update({ where: { id: userIds[0]! }, data: { status: 'SANCTIONED' } });
      const saved = await run(event);
      expect(saved).toMatchObject({
        status: 'REJECTED',
        sequence: 1,
        result: {
          code: condition === 'permission' ? 'NO_PERMISSION' : condition === 'owner' ? 'NO_GENERAL' : 'ACTOR_INACTIVE',
        },
      });
      expect(await db.treaty.count({ where: { worldId } })).toBe(0);
    },
  );

  it('파손 payload와 off 월드는 sequence도 증가시키지 않고 롤백한다', async () => {
    const { worldId, userIds } = await fixture();
    const event = await enqueue(worldId, userIds[0]!, 1, {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses },
    });
    await db.inputEvent.update({
      where: { id: event.id },
      data: { payload: { toNationId: 2, clauses: [], actorId: 1 } },
    });
    const before = await snapshot(worldId);
    await expect(run(event)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(before);
    await db.inputEvent.update({
      where: { id: event.id },
      data: { payload: { toNationId: 2, clauses }, idempotencyKey: 'treaty.respond:wrong-kind' },
    });
    const wrongKey = await snapshot(worldId);
    await expect(run(event)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(wrongKey);
    await db.inputEvent.update({ where: { id: event.id }, data: { idempotencyKey: `treaty.propose:${randomUUID()}` } });
    await db.world.update({ where: { id: worldId }, data: { treatyFormat: null } });
    const off = await snapshot(worldId);
    await expect(run(event)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(off);
  });

  it('PAUSED·ENDED는 WORLD_CLOSED이고 종료 기록 시각을 지킨다', async () => {
    const { worldId, userIds } = await fixture();
    await db.world.update({ where: { id: worldId }, data: { status: 'PAUSED' } });
    const paused = await enqueue(worldId, userIds[0]!, 1, {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses },
    });
    expect(await run(paused)).toMatchObject({ status: 'REJECTED', sequence: 1, result: { code: 'WORLD_CLOSED' } });
    await db.world.update({ where: { id: worldId }, data: { status: 'ENDED', clockTick: 20000 } });
    await db.worldResult.create({
      data: {
        worldId,
        reason: 'END_YEAR',
        endedYear: 191,
        endedMonth: 2,
        endedTick: 20000,
        endedSequence: 1,
        remainingNations: 2,
        finalStateHash: 'storage-component',
        endedAt: new Date(0),
      },
    });
    const ended = await enqueue(worldId, userIds[0]!, 1, {
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses },
    });
    const before = await snapshot(worldId);
    await expect(run(ended, 19999)).rejects.toThrow();
    expect(await snapshot(worldId)).toEqual(before);
    expect(await run(ended, 20000)).toMatchObject({
      status: 'REJECTED',
      sequence: 2,
      result: { code: 'WORLD_CLOSED', tick: 20000 },
    });
  });

  it('commit 직전 실패는 비용·관계·조약·완료 입력·sequence를 모두 롤백한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    const event = await response(worldId, userIds[1]!, id);
    const before = await snapshot(worldId);
    await expect(
      run(event, 1501, async () => {
        throw new Error('저장 취소');
      }),
    ).rejects.toThrow('저장 취소');
    expect(await snapshot(worldId)).toEqual(before);
    expect(await run(event, 1501)).toMatchObject({ status: 'APPLIED', sequence: 2 });
  });

  it('InputEvent count 0이면 이미 쓴 게임 상태와 sequence도 롤백한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    const event = await response(worldId, userIds[1]!, id);
    const before = await snapshot(worldId);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        const selected = await tx.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
        await tx.inputEvent.delete({ where: { id: event.id } });
        await processTreatyInput(tx, world, selected, 1501);
      }),
    ).rejects.toThrow('대기 입력이 변경');
    expect(await snapshot(worldId)).toEqual(before);
  });

  it('같은 제안의 두 응답을 World 잠금으로 직렬화해 한 번만 차감한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    const events = await Promise.all([response(worldId, userIds[1]!, id), response(worldId, userIds[1]!, id)]);
    const results = await Promise.all(events.map((event) => run(event, 1501)));
    expect(results.filter((event) => event.status === 'APPLIED')).toHaveLength(1);
    expect(results.find((event) => event.status === 'REJECTED')).toMatchObject({
      result: { code: 'TREATY_NOT_PROPOSED' },
    });
    expect(await db.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' }, select: { gold: true } })).toEqual([
      { gold: 983 },
      { gold: 983 },
    ]);
    expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).actionSequence).toBe(3);
  });

  it('월간 caller의 sequence로 닫고 비용을 보존하며 count 0은 롤백한다', async () => {
    const { worldId, userIds } = await fixture();
    const id = await proposal(worldId, userIds[0]!);
    await run(await response(worldId, userIds[1]!, id), 1500);
    const { beforeState, afterState } = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const beforeState: WorldState = { ...(await loadWorld(tx, worldId)), ...(await loadTreaties(tx, worldId)) };
      const afterState = settleTreaties(settleDiplomacy(beforeState, 20000), 20000);
      const sequence = await nextActionSequence(tx, worldId);
      await persistTreatyClosures(tx, worldId, beforeState, afterState, { tick: 20000, sequence });
      return { beforeState, afterState };
    });
    expect(await db.treaty.findUniqueOrThrow({ where: { worldId_id: { worldId, id: Number(id) } } })).toMatchObject({
      status: 'ENDED',
      closedSequence: 3,
      costFrom: 17,
      costTo: 17,
    });
    expect(await db.$transaction((tx) => loadTreaties(tx, worldId))).toEqual({});
    const before = await snapshot(worldId);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const sequence = await nextActionSequence(tx, worldId);
        await persistTreatyClosures(tx, worldId, beforeState, afterState, { tick: 20000, sequence });
      }),
    ).rejects.toThrow('마감 대상');
    expect(await snapshot(worldId)).toEqual(before);
  });
});
