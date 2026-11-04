import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { buildInitialWorld } from '../packages/rules/src/world/bootstrap';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { acquireLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { dispatchNotificationBatch, startNotificationDispatcher } from '../apps/server/src/notifications/dispatcher';
import { testDatabaseUrl } from './test-database';
import { listenLegalHttp } from '../e2e/legalFixturePorts';

type Pg = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
const source = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(source.hostname) || source.search)
  throw Error('loopback 시험 DB가 필요합니다.');
const database = `notification_events_${randomUUID().replaceAll('-', '')}_test`;
const target = new URL(source),
  maintenance = new URL(source);
target.pathname = '/' + database;
maintenance.pathname = '/postgres';
const requireDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = createRequire(requireDb.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (options: { connectionString: string }) => Pg;
};
const admin = new Client({ connectionString: maintenance.href }),
  sql = new Client({ connectionString: target.href });
const db = createDb(target.href),
  leases: Lease[] = [];
const workers: ReturnType<typeof startNotificationDispatcher>[] = [];
let created = false,
  oid: unknown,
  receiverOrigin: string,
  status = 204;
let drop = false;
const received: Array<{ content: string; allowed_mentions: { parse: string[] } }> = [];
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof received)[number]);
  if (drop) {
    request.socket.destroy();
    return;
  }
  response.writeHead(status).end();
});
const transport = (_url: string, init: RequestInit) => fetch(receiverOrigin + '/events', init);
const publicOrigin = 'http://127.0.0.1:5173';
const pump = () => dispatchNotificationBatch(db, { publicOrigin, transport });
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  oid = (await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [database])).rows[0]?.oid;
  await sql.connect();
  const directory = new URL('../packages/db/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => /^\d{14}_/.test(name)).sort())
    await sql.query(await readFile(new URL(name + '/migration.sql', directory), 'utf8'));
  await sql.end();
  await listenLegalHttp(receiver);
  receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  received.length = 0;
  status = 204;
  drop = false;
  await db.notificationOutbox.deleteMany();
  await db.notificationDispatchGate.update({ where: { id: 'discord' }, data: { blockedUntil: null } });
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
});
afterAll(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const lease of leases) await releaseLease(db, lease);
  receiver.closeAllConnections();
  if (receiver.listening)
    await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  await db.$disconnect();
  try {
    if (created) {
      expect((await admin.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [database])).rows).toEqual(
        [{ oid }],
      );
      expect(
        (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database])).rows,
      ).toEqual([{ count: 0 }]);
      await admin.query(`DROP DATABASE "${database}"`);
      expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [database])).rows).toEqual([]);
    }
  } finally {
    await admin.end();
  }
});
type Initial = ReturnType<typeof commandInitial>;
async function fixture(
  setup: (initial: Initial) => void = () => {},
  existingUsers?: string[],
  build: () => Initial = commandInitial,
) {
  const users =
    existingUsers ??
    (await Promise.all(
      Array.from({ length: 4 }, async () => {
        const user = await db.user.create({
          data: { email: `${randomUUID()}@example.test`, passwordHash: 'unused-notification-fixture' },
        });
        await db.notificationTarget.create({
          data: {
            userId: user.id,
            endpoint: 'https://discord.com/api/webhooks/100000000000000001/events-fake-token_ab12',
            last4: 'ab12',
            events: ['turn.failed', 'attacked', 'diplomacy.offer', 'turns.low'],
            verifiedAt: new Date(),
          },
        });
        return user.id;
      }),
    ));
  const initial = build();
  initial.generals.forEach((general, index) => {
    general.userId = users[index]!;
    general.nextTurnTick = index === 0 ? 100 : 5000;
  });
  setup(initial);
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '알림 사건 시험',
    turnTermMinutes: 30,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: initial.ruleFeatures ?? ['policy', 'treaty'],
  });
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date() } });
  const lease = await acquireLease(db, worldId);
  if (!lease) throw Error('시험 실행권이 필요합니다.');
  leases.push(lease);
  return { worldId, users, lease, loop: new TurnLoop(db, lease) };
}
async function schedule(
  worldId: string,
  generalId: number,
  commandKey: string,
  args: Record<string, number> = {},
  explicit = 0,
) {
  await db.generalTurn.updateMany({
    where: { worldId, generalId },
    data: { commandKey: 'rest', args: {}, explicit: false },
  });
  if (explicit)
    await db.generalTurn.updateMany({
      where: { worldId, generalId, slot: { lt: explicit } },
      data: { explicit: true },
    });
  await db.generalTurn.update({
    where: { worldId_generalId_slot: { worldId, generalId, slot: 0 } },
    data: { commandKey, args },
  });
}
const rows = (worldId: string, event?: string) =>
  db.notificationOutbox.findMany({
    where: { worldId, ...(event ? { event } : {}) },
    orderBy: [{ userId: 'asc' }, { dedupeKey: 'asc' }],
  });
async function receiveNormally(action: () => Promise<unknown>, count: number) {
  const started = Date.now();
  workers.push(
    startNotificationDispatcher(db, { publicOrigin, transport }, () => {
      throw Error('실제 발송 작업이 실패했습니다.');
    }),
  );
  await action();
  await expect.poll(() => received.length, { timeout: 20000 }).toBe(count);
  await expect.poll(() => db.notificationOutbox.count({ where: { status: 'SENT' } })).toBe(count);
  expect(Date.now() - started).toBeLessThan(60000);
}

it('실제 예턴 실패가 정상 발송 작업을 거쳐 1분 안에 도착한다', async () => {
  const f = await fixture();
  await schedule(f.worldId, 1, 'attack', { cityKey: 1 }, 1);
  await receiveNormally(() => f.loop.advanceTo(100), 1);
  expect(await rows(f.worldId)).toMatchObject([{ userId: f.users[0], event: 'turn.failed', status: 'SENT' }]);
  await f.loop.advanceTo(100);
  await pump();
  expect(received).toHaveLength(1);
});
it('실제 explicit 4→3 경계만 1분 안에 알리고 3→2는 다시 알리지 않는다', async () => {
  const f = await fixture();
  await schedule(f.worldId, 1, 'rest', {}, 4);
  await receiveNormally(() => f.loop.advanceTo(100), 1);
  expect(await rows(f.worldId)).toMatchObject([
    { event: 'turns.low', dedupeKey: `turns-low:${f.worldId}:1:1`, status: 'SENT' },
  ]);
  await f.loop.advanceTo(10100);
  await pump();
  expect(received).toHaveLength(1);
});
it('성벽·수비가 없는 도시를 점령해 상대 국가가 살아남아도 원 소속에 1분 안에 도착한다', async () => {
  const f = await fixture((initial) => {
    initial.cities[1]!.wall = 0;
    initial.cities[2]!.nationId = 2;
    initial.generals[1]!.crew = 0;
    initial.generals[2]!.crew = 0;
  });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await receiveNormally(() => f.loop.advanceTo(100), 2);
  expect((await rows(f.worldId, 'attacked')).map((row) => row.userId).sort()).toEqual([f.users[1], f.users[2]].sort());
  expect(await db.nation.count({ where: { worldId: f.worldId, id: 2 } })).toBe(1);
  expect(
    (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } })).nationId,
  ).toBe(1);
  expect(await db.battleLog.count({ where: { worldId: f.worldId } })).toBe(0);
});
it('실제 외교 제안은 받는 나라 군주·참모만 정상 발송 작업으로 1분 안에 받는다', async () => {
  const f = await fixture((initial) => {
    initial.generals[2]!.officerLevel = 11;
    initial.diplomacies = [];
  });
  await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.users[0]!,
      generalId: 1,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'note', text: '제안' }] },
      idempotencyKey: `treaty.propose:${randomUUID()}`,
    },
  });
  await receiveNormally(() => f.loop.advanceTo(0), 2);
  expect((await rows(f.worldId)).map((row) => [row.userId, row.event]).sort()).toEqual(
    [
      [f.users[1], 'diplomacy.offer'],
      [f.users[2], 'diplomacy.offer'],
    ].sort(),
  );
});

it('같은 도시·tick의 두 공격은 서로 다른 전투 알림이며 다시 처리하지 않는다', async () => {
  const f = await fixture((initial) => {
    initial.generals[0]!.crew = 100;
    initial.generals[1]!.crew = 10000;
    Object.assign(initial.generals[2]!, { nationId: 1, cityKey: 1, crew: 100, nextTurnTick: 100 });
  });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await schedule(f.worldId, 3, 'attack', { cityKey: 2 }, 1);
  await f.loop.advanceTo(100);
  await pump();
  const messages = await rows(f.worldId, 'attacked');
  expect(messages.map((row) => row.dedupeKey).sort()).toEqual(
    [1, 3].map((id) => `attacked:${f.worldId}:${f.users[1]}:100:${id}`),
  );
  expect(received).toHaveLength(2);
  await f.loop.advanceTo(100);
  await pump();
  expect(received).toHaveLength(2);
});
it('국가가 멸망해 장수가 재야가 돼도 점령 전 소속 사용자에게 기록한다', async () => {
  const f = await fixture((initial) => {
    initial.cities[1]!.wall = 0;
    initial.generals[1]!.crew = 0;
    initial.generals[2]!.crew = 0;
  });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await f.loop.advanceTo(100);
  await pump();
  expect(await db.nation.count({ where: { worldId: f.worldId, id: 2 } })).toBe(0);
  expect((await rows(f.worldId, 'attacked')).map((row) => row.userId).sort()).toEqual([f.users[1], f.users[2]].sort());
  expect(
    (await db.general.findMany({ where: { worldId: f.worldId, id: { in: [2, 3] } } })).every(
      (general) => general.nationId === null,
    ),
  ).toBe(true);
  expect(received).toHaveLength(2);
});
it('중립 도시 공격은 도시 안 재야 사용자의 공격 알림을 만들지 않는다', async () => {
  const f = await fixture((initial) => {
    initial.cities[1]!.nationId = null;
    initial.cities[2]!.nationId = 2;
    initial.nations[1]!.capitalCityKey = 3;
    initial.generals[1]!.cityKey = 3;
    initial.generals[2]!.cityKey = 3;
    initial.generals[3]!.cityKey = 2;
  });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await f.loop.advanceTo(100);
  await pump();
  expect(await rows(f.worldId)).toEqual([]);
  expect(received).toHaveLength(0);
  expect(
    (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } })).nationId,
  ).toBe(1);
});
it('외교 제안은 다른 국가와 권한 없는 수뇌에게 전달하지 않는다', async () => {
  const f = await fixture((initial) => {
    initial.diplomacies = [];
    initial.generals[2]!.officerLevel = 10;
    Object.assign(initial.generals[3]!, { nationId: 1, officerLevel: 11 });
  });
  await offer(f);
  await f.loop.advanceTo(0);
  await pump();
  expect((await rows(f.worldId)).map((row) => row.userId)).toEqual([f.users[1]]);
  expect(received).toHaveLength(1);
});
it('미등록·꺼진 사건은 실제 공격에서도 저장하지 않는다', async () => {
  const f = await fixture();
  await db.notificationTarget.update({ where: { userId: f.users[1]! }, data: { events: [] } });
  await db.notificationTarget.delete({ where: { userId: f.users[2]! } });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await f.loop.advanceTo(100);
  await pump();
  expect(await rows(f.worldId)).toEqual([]);
  expect(received).toHaveLength(0);
});
it('CAS 뒤 대기열을 만든 턴의 commit 실패도 게임 행과 함께 롤백한다', async () => {
  const f = await fixture();
  await schedule(f.worldId, 1, 'attack', { cityKey: 1 }, 1);
  const failed = new TurnLoop(db, f.lease, {
    beforeCommit: async (tx) => {
      if (await tx.notificationOutbox.count({ where: { worldId: f.worldId } })) throw Error('알림 포함 commit 중단');
    },
  });
  await expect(failed.advanceTo(100)).rejects.toThrow('알림 포함 commit 중단');
  expect(await rows(f.worldId)).toEqual([]);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).nextTurnTick,
  ).toBe(100);
  await pump();
  expect(received).toHaveLength(0);
  await new TurnLoop(db, f.lease).advanceTo(100);
  await pump();
  expect(received).toHaveLength(1);
});
it('실제 HTTP500은 이미 완료한 게임 상태를 바꾸거나 다시 전송하지 않는다', async () => {
  const f = await fixture();
  await schedule(f.worldId, 1, 'attack', { cityKey: 1 }, 1);
  await f.loop.advanceTo(100);
  const before = await loadReplayState(db, f.worldId);
  status = 500;
  await pump();
  await pump();
  expect(await rows(f.worldId)).toMatchObject([{ status: 'UNKNOWN', attempts: 1 }]);
  expect(received).toHaveLength(1);
  expect(await loadReplayState(db, f.worldId)).toEqual(before);
  expect(
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: 1 } } })).nextTurnTick,
  ).toBe(10100);
});
it('implicit 휴식은 세지 않고 네 칸 재저장 뒤 새 revision 경계에서 다시 알린다', async () => {
  const f = await fixture();
  await f.loop.advanceTo(100);
  await pump();
  expect(received).toHaveLength(0);
  await schedule(f.worldId, 1, 'rest', {}, 4);
  await f.loop.advanceTo(10100);
  await pump();
  expect(received).toHaveLength(1);
  await schedule(f.worldId, 1, 'rest', {}, 4);
  await f.loop.advanceTo(20100);
  await pump();
  const low = await rows(f.worldId, 'turns.low');
  expect(low).toHaveLength(2);
  expect(new Set(low.map((row) => row.dedupeKey)).size).toBe(2);
  expect(received).toHaveLength(2);
});
async function offer(f: Awaited<ReturnType<typeof fixture>>) {
  await db.inputEvent.create({
    data: {
      worldId: f.worldId,
      userId: f.users[0]!,
      generalId: 1,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'note', text: '제안' }] },
      idempotencyKey: `treaty.propose:${randomUUID()}`,
    },
  });
}
it('알림 설정은 실제 게임 상태 해시와 기록한 입력의 월말 재생을 바꾸지 않는다', async () => {
  const setup = (initial: Initial) => {
    initial.diplomacies = [];
  };
  const enabled = await fixture(setup);
  await offer(enabled);
  await enabled.loop.advanceTo(10000);
  expect(await rows(enabled.worldId, 'diplomacy.offer')).toHaveLength(1);
  await db.notificationTarget.updateMany({ where: { userId: { in: enabled.users } }, data: { events: [] } });
  const disabled = await fixture(setup, enabled.users);
  await offer(disabled);
  await disabled.loop.advanceTo(10000);
  expect(await rows(disabled.worldId)).toEqual([]);
  expect(hashState((await loadReplayState(db, enabled.worldId)).state)).toBe(
    hashState((await loadReplayState(db, disabled.worldId)).state),
  );
  for (const f of [enabled, disabled]) {
    const archive = await exportReplay(db, f.worldId);
    expect(replayArchive(archive, 1)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  }
});

it('NPC의 실제 rest→attack 선택은 원 슬롯 args 없이 실제 국가에 기록한다', async () => {
  const f = await fixture((initial) => {
    initial.generals[0]!.userId = null;
    initial.generals[0]!.injury = 0;
  });
  await f.loop.advanceTo(100);
  await pump();
  expect(
    (await db.generalLog.findFirstOrThrow({ where: { worldId: f.worldId, generalId: 1, tick: 100 } })).commandKey,
  ).toBe('attack');
  expect((await rows(f.worldId, 'attacked')).map((row) => row.userId).sort()).toEqual([f.users[1], f.users[2]].sort());
  expect(received).toHaveLength(2);
});
it.each([true, false])('긴 도시·월드 이름은 원문을 보존하고 알림 켬=%s에도 공격을 저장한다', async (enabled) => {
  const cityName = '𠀀'.repeat(300) + '성',
    worldName = '🌕'.repeat(150);
  const f = await fixture((initial) => {
    initial.cities[1]!.name = cityName;
    initial.cities[1]!.wall = 0;
    initial.generals[1]!.crew = 0;
    initial.generals[2]!.crew = 0;
  });
  await db.world.update({ where: { id: f.worldId }, data: { name: worldName } });
  if (!enabled) await db.notificationTarget.updateMany({ where: { userId: { in: f.users } }, data: { events: [] } });
  await schedule(f.worldId, 1, 'attack', { cityKey: 2 }, 1);
  await f.loop.advanceTo(100);
  await pump();
  expect(
    (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } })).name,
  ).toBe(cityName);
  expect(
    (await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId: f.worldId, cityKey: 2 } } })).nationId,
  ).toBe(1);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.worldId } })).name).toBe(worldName);
  const queued = await rows(f.worldId);
  expect(queued).toHaveLength(enabled ? 2 : 0);
  for (const row of queued) {
    const payload = row.payload as { worldName: string; text: string };
    expect(payload.worldName.length).toBeLessThanOrEqual(200);
    expect(payload.text.length).toBeLessThanOrEqual(600);
    expect(Buffer.from(payload.worldName).toString('utf8')).toBe(payload.worldName);
    expect(Buffer.from(payload.text).toString('utf8')).toBe(payload.text);
  }
  expect(received).toHaveLength(enabled ? 2 : 0);
});
it.each(['rest', 'attack'])('개인 %s와 국가 명령의 실패는 장수 턴 사건 하나로 기록한다', async (personal) => {
  const f = await fixture((initial) => {
    initial.nationTurns = { 1: Array.from({ length: 30 }, () => ({ commandKey: 'nation_rest', args: {} })) };
  });
  await schedule(f.worldId, 1, personal, personal === 'attack' ? { cityKey: 1 } : {}, 1);
  await db.nationTurn.update({
    where: { worldId_nationId_slot: { worldId: f.worldId, nationId: 1, slot: 0 } },
    data: { commandKey: 'nation_capital', args: { cityKey: 999999 } },
  });
  await f.loop.advanceTo(100);
  await pump();
  expect(await rows(f.worldId)).toMatchObject([
    { event: 'turn.failed', userId: f.users[0], dedupeKey: `turn-failed:${f.worldId}:1:100`, status: 'SENT' },
  ]);
  expect(received).toHaveLength(1);
});
it('사건 전송 응답이 끊겨도 완료한 턴과 상태 해시는 유지하고 다시 보내지 않는다', async () => {
  const f = await fixture();
  await schedule(f.worldId, 1, 'attack', { cityKey: 1 }, 1);
  await f.loop.advanceTo(100);
  const before = await loadReplayState(db, f.worldId);
  drop = true;
  await pump();
  await pump();
  expect(await rows(f.worldId)).toMatchObject([{ status: 'UNKNOWN', attempts: 1 }]);
  expect(received).toHaveLength(1);
  expect(await loadReplayState(db, f.worldId)).toEqual(before);
});

it.each(['ACCEPTED', 'DECLINED', 'REJECTED'] as const)(
  'NPC 외교 %s는 실제 적용 여부에 맞춰 제안 도착을 기록한다',
  async (outcome) => {
    const f = await fixture((initial) => {
      initial.diplomacies = [];
      initial.generals[2]!.officerLevel = 11;
      if (outcome === 'DECLINED') initial.nations[1]!.gold = 0;
    });
    const event = await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId: f.users[0]!,
        generalId: 1,
        kind: 'treaty.propose',
        payload: {
          toNationId: outcome === 'REJECTED' ? 1 : 2,
          clauses: outcome === 'DECLINED' ? [{ kind: 'nonAggression', months: 12 }] : [{ kind: 'note', text: '제안' }],
        },
        idempotencyKey: `treaty.propose:${randomUUID()}`,
      },
    });
    await f.loop.advanceTo(0);
    await pump();
    const stored = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
    if (outcome === 'REJECTED') {
      expect(stored).toMatchObject({ status: 'REJECTED' });
      expect(await rows(f.worldId)).toEqual([]);
      expect(received).toHaveLength(0);
    } else {
      expect(stored).toMatchObject({ status: 'APPLIED', result: { outcome, by: 'NPC' } });
      expect((await rows(f.worldId)).map((row) => row.userId).sort()).toEqual([f.users[1], f.users[2]].sort());
      expect(received).toHaveLength(2);
    }
  },
);

it('휘하 지시가 원 예턴과 다른 도시를 공격하면 실제 대상 국가만 받는다', async () => {
  const f = await fixture(
    (initial) => {
      initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy', 'treaty'];
      initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
      initial.generals.forEach((general) => {
        general.userId = null;
        general.nextTurnTick = 50000;
        general.crew = 0;
      });
    },
    undefined,
    () => {
      return buildInitialWorld(operationalInput());
    },
  );
  for (const [index, userId] of f.users.slice(0, 2).entries()) {
    await db.inputEvent.create({
      data: {
        worldId: f.worldId,
        userId,
        generalId: null,
        kind: 'general.create',
        payload: {
          name: `사건장수${index}`,
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        idempotencyKey: `general.create:${randomUUID()}`,
      },
    });
    await f.loop.advanceTo(0);
    expect(
      await db.inputEvent.findFirstOrThrow({
        where: { worldId: f.worldId, userId, kind: 'general.create' },
        orderBy: { id: 'desc' },
      }),
    ).toMatchObject({ status: 'APPLIED' });
  }
  const humans = await db.general.findMany({
    where: { worldId: f.worldId, userId: { in: f.users } },
    orderBy: { id: 'asc' },
  });
  expect(humans).toHaveLength(2);
  for (const [index, human] of humans.entries())
    await schedule(f.worldId, human.id, 'join', { nationId: index + 1 }, 1);
  await f.loop.advanceTo(Math.max(...humans.map((human) => human.nextTurnTick)));
  let attacker = await db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId: f.worldId, id: humans[0]!.id } },
  });
  const defender = await db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId: f.worldId, id: humans[1]!.id } },
  });
  expect([attacker.nationId, defender.nationId]).toEqual([1, 2]);
  await schedule(f.worldId, attacker.id, 'move', { cityKey: 99 }, 1);
  await f.loop.advanceTo(attacker.nextTurnTick);
  attacker = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.worldId, id: attacker.id } } });
  expect(attacker.cityKey).toBe(99);
  const campaign = (await loadReplayState(db, f.worldId)).state.campaign!;
  campaign.units = [
    { id: 1, ownerId: attacker.id, commanderId: attacker.id, troops: 1000, crewType: 1100, train: 100, atmos: 100 },
  ];
  campaign.nextUnitId = 2;
  campaign.orders = {
    version: 1,
    nextId: 2,
    items: [
      {
        id: 1,
        issuerId: 1,
        recipientId: attacker.id,
        nationId: 1,
        authority: 'SOVEREIGN',
        command: { commandKey: 'attack', args: { cityKey: 2 } },
        status: 'READY',
        createdTick: 0,
        turnRevision: attacker.turnRevision,
        firstSlot: { commandKey: 'attack', args: { cityKey: 1 }, explicit: true },
        result: null,
        resolvedTick: null,
      },
    ],
  };
  await db.world.update({ where: { id: f.worldId }, data: { campaignState: campaign as Prisma.InputJsonValue } });
  await schedule(f.worldId, attacker.id, 'attack', { cityKey: 1 }, 1);
  await f.loop.advanceTo(attacker.nextTurnTick);
  await pump();
  const diagnosis = {
    actor: { id: attacker.id, cityKey: attacker.cityKey, officerLevel: attacker.officerLevel },
    log: await db.generalLog.findMany({
      where: { worldId: f.worldId, generalId: attacker.id },
      select: { kind: true, commandKey: true, text: true },
      orderBy: { sequence: 'desc' },
      take: 1,
    }),
    order: (await loadReplayState(db, f.worldId)).state.campaign!.orders!.items[0],
  };
  expect(
    (await rows(f.worldId, 'attacked')).map((row) => row.userId),
    JSON.stringify(diagnosis),
  ).toEqual([f.users[1]]);
  expect(received).toHaveLength(1);
  const state = (await loadReplayState(db, f.worldId)).state;
  expect(state.campaign!.orders!.items[0]).toMatchObject({ status: 'EXECUTED', recipientId: attacker.id });
});
