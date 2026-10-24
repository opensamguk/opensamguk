import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { type WorldInit } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { featureRegistry } from '../test/replayFeaturesFixture';
import { saveInitialWorld, readWorldState } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, lockLease, releaseLease, renewLease, type Lease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive, replayToEnd, type ReplayArchiveV2 } from './replay';
import { processInputs } from './inputs';
import type { EngineRegistry, QueuedInputHandler } from './features';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
const users: string[] = [];
const leases: Lease[] = [];
afterAll(async () => {
  for (const lease of leases) await releaseLease(db, lease);
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function user(id = `t226-${randomUUID()}`) {
  await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only' } });
  users.push(id);
  return id;
}
async function create(format: 1 | 3 = 3, initial?: WorldInit) {
  const state = initial ?? (await monthlyFixture());
  const { worldId } = await saveInitialWorld(db, state, {
    replayFormat: format,
    name: '재생 기능 통합',
    turnTermMinutes: 60,
    endYear: null,
  });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId, undefined, 120000))!;
  leases.push(lease);
  return { worldId, lease, loop: new TurnLoop(db, lease), initial: state };
}
const payload = { name: '새장수', leadership: 55, strength: 55, intel: 55, portraitId: null };
async function enqueue(
  worldId: string,
  userId: string,
  kind = 'general.create',
  value: Prisma.InputJsonValue = payload,
) {
  return db.inputEvent.create({ data: { worldId, userId, kind, payload: value, idempotencyKey: randomUUID() } });
}
async function fenced(lease: Lease, fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  return db.$transaction(async (tx) => {
    await lockLease(tx, lease);
    await tx.$queryRaw`SELECT id FROM "World" WHERE id=${lease.worldId} FOR UPDATE`;
    await fn(tx);
  });
}

describe('T2-26 실제 DB 형식·C2', () => {
  it('형식 1·3 초기·리소스 해시와 12개월 월간 해시가 같고 CLI가 v3을 읽는다', async () => {
    const old = await create(1),
      modern = await create(3);
    const origins = await db.world.findMany({ where: { id: { in: [old.worldId, modern.worldId] } } });
    expect(origins[0]!.initialStateHash).toBe(origins[1]!.initialStateHash);
    expect((origins[0]!.replayOrigin as Prisma.JsonObject).resourceHash).toBe(
      (origins[1]!.replayOrigin as Prisma.JsonObject).resourceHash,
    );
    expect(await readWorldState(db, modern.worldId)).toEqual(modern.initial);
    for (let month = 1; month <= 12; month++)
      for (const fixture of [old, modern]) {
        await renewLease(db, fixture.lease);
        await fixture.loop.advanceTo(month * 10000);
      }
    const a = await exportReplay(db, old.worldId),
      b = await exportReplay(db, modern.worldId);
    expect(a.version).toBe(2);
    expect(b.version).toBe(3);
    expect(b.months.map((m) => m.stateHash)).toEqual(a.months.map((m) => m.stateHash));
    expect(replayArchive(b)).toEqual(replayArchive(a));
    const directory = await mkdtemp(join(process.cwd(), '.tmp-t226-'));
    try {
      const file = join(directory, 'replay.json');
      await writeFile(file, JSON.stringify(b));
      const cli = spawnSync(process.execPath, ['--import', 'tsx', 'tools/replay.ts', '--from', file], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: '' },
      });
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout.match(/일치/g)).toHaveLength(12);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([1, 3] as const)('형식 %s는 밀린 월 경계의 입력 순서를 지키고 재생된다', async (format) => {
    const value = await create(format);
    const event = await enqueue(value.worldId, await user());
    await value.loop.advanceTo(10050);
    const applied = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    const first = await db.yearbookSnapshot.findUniqueOrThrow({
      where: { worldId_tick: { worldId: value.worldId, tick: 10000 } },
    });
    expect(applied.status).toBe('APPLIED');
    if (format === 3) {
      expect(first.sequence).toBe(2);
      expect(applied.sequence).toBeGreaterThan(first.sequence);
      expect(applied.tick).toBe(10050);
    } else {
      expect(applied.sequence).toBe(1);
      expect(applied.sequence).toBeLessThan(first.sequence);
      expect(applied.tick).toBeNull();
    }
    await value.loop.advanceTo(20000);
    const archive = await exportReplay(db, value.worldId);
    expect(replayArchive(archive, 2)).toHaveLength(2);
    if (archive.version === 3) {
      archive.inputs[0]!.tick = 9999;
      expect(() => replayArchive(archive, 2)).toThrow('월 창');
    }
  });
  it('경계 밖에서 일시정지한 새 월드는 재개·정산 뒤 입력을 처리한다', async () => {
    const value = await create();
    const event = await enqueue(value.worldId, await user());
    await db.world.update({
      where: { id: value.worldId },
      data: { status: 'PAUSED', clockTick: 10050, clockAnchorAt: null },
    });
    await value.loop.advanceTo(10050);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PENDING');
    expect((await db.world.findUniqueOrThrow({ where: { id: value.worldId } })).actionSequence).toBe(0);
    await controlClock(db, value.worldId, 'resume');
    await value.loop.advanceTo(20000);
    const applied = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    // 목표 20000까지 두 달을 따라잡은 뒤 처리한다.
    expect(applied.tick).toBe(20000);
    expect(applied.sequence).toBeGreaterThan(4);
    await value.loop.advanceTo(30000);
    expect(replayArchive(await exportReplay(db, value.worldId), 3)).toHaveLength(3);
  });
  it('따라잡다가 종료되면 대기 입력을 거절하고 afterEnd에 남긴다', async () => {
    const initial = await monthlyFixture();
    initial.nations = initial.nations.slice(0, 1);
    initial.cities.forEach((c) => {
      c.nationId = 1;
    });
    initial.generals.forEach((g) => {
      g.nationId = 1;
    });
    initial.diplomacies = [];
    const value = await create(3, initial);
    await enqueue(value.worldId, await user());
    await value.loop.advanceTo(10050);
    expect(await db.inputEvent.count({ where: { worldId: value.worldId, status: 'PENDING' } })).toBe(0);
    const archive = await exportReplay(db, value.worldId);
    expect(archive.afterEnd).toHaveLength(1);
    expect(archive.afterEnd[0]!.result).toMatchObject({ code: 'WORLD_CLOSED' });
    expect(replayToEnd(archive)).toEqual(archive.end);
  });
  it('archive 2 고정 수출 바이트를 실제 DB에서도 유지한다', async () => {
    const archive: ReplayArchiveV2 = JSON.parse(
      await readFile(new URL('../test/fixtures/replay-v2-53dd348.json', import.meta.url), 'utf8'),
    );
    for (const userId of new Set(
      archive.origin.initial.generals.flatMap((general) => (general.userId ? [general.userId] : [])),
    ))
      await user(userId);
    const actor = await user();
    const value = await create(1, archive.origin.initial);
    await db.$transaction(async (tx) => {
      for (const input of [...archive.inputs, ...archive.afterEnd])
        await tx.inputEvent.create({
          data: {
            ...input,
            payload: input.payload as Prisma.InputJsonValue,
            result: input.result as Prisma.InputJsonValue,
            worldId: value.worldId,
            userId: actor,
            idempotencyKey: `baseline-${input.sequence}`,
          },
        });
      for (const month of archive.months)
        await tx.yearbookSnapshot.create({
          data: { ...month, worldId: value.worldId, data: month.data as unknown as Prisma.InputJsonValue },
        });
      const end = archive.end!;
      await tx.worldResult.create({
        data: {
          worldId: value.worldId,
          reason: end.reason,
          winnerNationId: end.winnerNationId,
          endedTick: end.tick,
          endedSequence: end.sequence,
          endedYear: end.year,
          endedMonth: end.month,
          finalStateHash: end.finalStateHash,
          remainingNations: 1,
          endedAt: new Date(),
        },
      });
    });
    expect(JSON.stringify(await exportReplay(db, value.worldId))).toBe(JSON.stringify(archive));
  });
});

describe('T2-26 실제 DB 입력 원자성', () => {
  it('두 시험 종류와 생성을 id 순으로 처리하고 모두 sequence·tick 하나를 남긴다', async () => {
    const value = await create();
    const actor = await user();
    // 운영 목록은 비어 있다. 시험 월드와 처리기에만 기능을 주입한다.
    await db.world.update({ where: { id: value.worldId }, data: { ruleFeatures: ['test-a', 'test-b'] } });
    const handler: QueuedInputHandler = async (tx, world, event) => {
      await tx.nation.update({
        where: { worldId_id: { worldId: world.id, id: 1 } },
        data: { gold: { increment: event.kind === 'test-a.queued' ? 1 : 2 } },
      });
      return { status: 'APPLIED', result: { kind: event.kind } };
    };
    const registry: EngineRegistry = {
      rules: featureRegistry,
      features: featureRegistry.features.map((feature) => ({
        key: feature.key,
        queuedInputs: { [`${feature.key}.queued`]: handler },
      })),
    };
    const events = [];
    for (const kind of ['test-a.queued', 'general.create', 'test-b.queued', 'general.create'])
      events.push(await enqueue(value.worldId, actor, kind));
    for (let i = 0; i < events.length; i++)
      await fenced(value.lease, async (tx) => {
        const world = await tx.world.findUniqueOrThrow({ where: { id: value.worldId } });
        expect(await processInputs(tx, world, 50, registry)).toBe(true);
      });
    const results = await db.inputEvent.findMany({ where: { worldId: value.worldId }, orderBy: { id: 'asc' } });
    expect(results.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(results.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(results.map((e) => e.tick)).toEqual([50, 50, 50, 50]);
    expect(results.map((e) => e.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'REJECTED']);
    expect(results[3]!.result).toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await db.generalTurn.count({ where: { worldId: value.worldId, generalId: results[1]!.generalId! } })).toBe(
      30,
    );
    await db.world.update({ where: { id: value.worldId }, data: { ruleFeatures: [] } });
    const disabled = await enqueue(value.worldId, actor, 'test-a.queued');
    await fenced(value.lease, async (tx) => {
      await processInputs(tx, await tx.world.findUniqueOrThrow({ where: { id: value.worldId } }), 50, registry);
    });
    expect(await db.inputEvent.findUnique({ where: { id: disabled.id } })).toMatchObject({
      status: 'REJECTED',
      sequence: 5,
      tick: 50,
      result: { code: 'FEATURE_DISABLED' },
    });
  });
  it('beforeCommit 실패는 장수·30칸·입력·sequence를 모두 되돌린다', async () => {
    const value = await create();
    const event = await enqueue(value.worldId, await user());
    const before = await db.general.count({ where: { worldId: value.worldId } });
    const broken = new TurnLoop(db, value.lease, {
      beforeCommit: async () => {
        throw new Error('입력 롤백 탐침');
      },
    });
    await expect(broken.advanceTo(50)).rejects.toThrow('롤백');
    expect((await db.world.findUniqueOrThrow({ where: { id: value.worldId } })).actionSequence).toBe(0);
    expect(await db.general.count({ where: { worldId: value.worldId } })).toBe(before);
    expect(await db.generalTurn.count({ where: { worldId: value.worldId } })).toBe(0);
    expect(await db.inputEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
      tick: null,
      result: null,
    });
    await value.loop.advanceTo(50);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('APPLIED');
  });
  it('한 트랜잭션에서 여러 종류를 처리해도 실패하면 모두 PENDING이다', async () => {
    const value = await create();
    const actor = await user();
    await db.world.update({ where: { id: value.worldId }, data: { ruleFeatures: ['test-a', 'test-b'] } });
    const before = await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: value.worldId, id: 1 } } });
    for (const kind of ['test-a.queued', 'general.create', 'test-b.queued']) await enqueue(value.worldId, actor, kind);
    const handler: QueuedInputHandler = async (tx, world) => {
      await tx.nation.update({ where: { worldId_id: { worldId: world.id, id: 1 } }, data: { gold: { increment: 1 } } });
      return { status: 'APPLIED', result: {} };
    };
    const registry: EngineRegistry = {
      rules: featureRegistry,
      features: featureRegistry.features.map((f) => ({ key: f.key, queuedInputs: { [`${f.key}.queued`]: handler } })),
    };
    await expect(
      fenced(value.lease, async (tx) => {
        const world = await tx.world.findUniqueOrThrow({ where: { id: value.worldId } });
        for (let i = 0; i < 3; i++) await processInputs(tx, world, 50, registry);
        throw new Error('묶음 롤백');
      }),
    ).rejects.toThrow('롤백');
    expect(
      await db.inputEvent.count({ where: { worldId: value.worldId, status: 'PENDING', sequence: null, tick: null } }),
    ).toBe(3);
    expect((await db.world.findUniqueOrThrow({ where: { id: value.worldId } })).actionSequence).toBe(0);
    expect(await db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId: value.worldId, id: 1 } } })).toEqual(
      before,
    );
    expect(await db.general.count({ where: { worldId: value.worldId } })).toBe(value.initial.generals.length);
    expect(await db.generalTurn.count({ where: { worldId: value.worldId } })).toBe(0);
  });
  it.each(['unknown', 'turns.set'])('등록되지 않은 대기 종류 %s는 DB를 바꾸지 않는다', async (kind) => {
    const value = await create();
    const event = await enqueue(value.worldId, await user(), kind);
    const before = await db.world.findUniqueOrThrow({ where: { id: value.worldId } });
    await expect(value.loop.advanceTo(50)).rejects.toThrow('종류');
    expect(await db.world.findUniqueOrThrow({ where: { id: value.worldId } })).toEqual(before);
    expect(await db.inputEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
      tick: null,
    });
  });
});

describe('T2-26 실제 DB 생성·시작 거부', () => {
  it('생성 검사가 실패하면 월드 행이 없다', async () => {
    const initial = await monthlyFixture();
    const before = await db.world.count();
    for (const options of [
      { ruleFeatures: ['unknown'] },
      { replayFormat: 1 as const, ruleFeatures: ['unknown'] },
      { featureData: {} },
      { featureData: { unknown: true } },
    ]) {
      await expect(
        saveInitialWorld(db, initial, { name: '거부', turnTermMinutes: 60, endYear: null, ...options }),
      ).rejects.toThrow();
      expect(await db.world.count()).toBe(before);
    }
  });
  it.each(['S1', 'S2', 'S3', 'S4', 'S5'])('%s 대조 실패는 sequence·시계·입력을 바꾸지 않는다', async (code) => {
    const value = await create();
    const event = await enqueue(value.worldId, await user());
    const world = await db.world.findUniqueOrThrow({ where: { id: value.worldId } });
    const origin = world.replayOrigin as Prisma.JsonObject;
    if (code === 'S1') await db.$executeRaw`UPDATE "World" SET "replayOrigin"=NULL WHERE id=${value.worldId}`;
    if (code === 'S2') await db.world.update({ where: { id: value.worldId }, data: { replayFormat: 1 } });
    if (code === 'S3')
      await db.world.update({
        where: { id: value.worldId },
        data: { replayFormat: 1, ruleFeatures: ['test-a'], replayOrigin: { ...origin, version: 1 } },
      });
    if (code === 'S4') await db.world.update({ where: { id: value.worldId }, data: { ruleFeatures: ['test-a'] } });
    if (code === 'S5')
      await db.world.update({
        where: { id: value.worldId },
        data: {
          ruleFeatures: ['unknown'],
          replayOrigin: { ...origin, initial: { ...(origin.initial as Prisma.JsonObject), ruleFeatures: ['unknown'] } },
        },
      });
    const before = await db.world.findUniqueOrThrow({ where: { id: value.worldId } });
    await expect(value.loop.advanceTo(10050)).rejects.toThrow();
    expect(await db.world.findUniqueOrThrow({ where: { id: value.worldId } })).toEqual(before);
    expect(await db.inputEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      sequence: null,
      tick: null,
    });
    expect(await db.generalLog.count({ where: { worldId: value.worldId } })).toBe(0);
  });
  it('기존 쓰기 경로의 새 열 기본값은 형식 1·빈 목록이다', async () => {
    const initial = await monthlyFixture();
    const world = await db.world.create({
      data: {
        name: '기존 열만 쓰기',
        scenarioKey: initial.scenarioKey,
        mapKey: initial.mapKey,
        unitSetKey: initial.unitSetKey,
        seed: initial.seed,
        startYear: initial.startYear,
        turnTermMinutes: 60,
        initialStateHash: 'legacy',
        statRules: initial.statRules,
        unitSet: initial.unitSet as Prisma.InputJsonValue,
      },
    });
    worlds.push(world.id);
    expect(world).toMatchObject({ replayFormat: 1, ruleFeatures: [], replayOrigin: null });
  });
  it('PENDING 입력의 tick 검사 제약을 DB가 적용한다', async () => {
    const value = await create();
    const actor = await user();
    await expect(
      db.inputEvent.create({
        data: {
          worldId: value.worldId,
          userId: actor,
          kind: 'general.create',
          payload,
          idempotencyKey: randomUUID(),
          tick: 1,
        },
      }),
    ).rejects.toThrow();
    expect(await db.inputEvent.count({ where: { worldId: value.worldId } })).toBe(0);
  });
});
