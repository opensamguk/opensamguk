import { createRequire } from 'node:module';
import { afterAll, expect, it } from 'vitest';
import { createDb, worldChannel, type Prisma, type RealtimeSignal } from '@opensamguk/db';
import type { TreatyInput } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { saveInitialWorld } from './world/persistence';
import { controlClock } from './world/clock';
import { acquireLease, releaseLease } from './lease';
import { TurnLoop } from './turnLoop';
import { exportReplay, replayArchive } from './replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
const users: string[] = [];
type EngineRequest =
  | TreatyInput
  | { kind: 'general.possess'; payload: { generalId: number; userId: string } }
  | {
      kind: 'admin.world.setOption';
      payload: {
        version: 1;
        reason: string;
        setting: { kind: 'admin.world.setOption'; key: 'entry.npcPlay'; value: 'on' };
      };
    };
type PgNotification = { payload?: string };
type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listen: (notification: PgNotification) => void): void;
};
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const { Client } = createRequire(dbRequire.resolve('@prisma/adapter-pg'))('pg') as {
  Client: new (config: { connectionString: string }) => PgClient;
};
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it.each(['만료', '파기'] as const)(
  'AC-M2-06 PostgreSQL 이양·보급·정기 원조·귀환·재생 %s',
  async (closure) => {
    const personnel = closure === '파기';
    const rulerA = await db.user.create({
      data: { email: crypto.randomUUID() + '@example.test', passwordHash: 'fixture-only', role: 'ADMIN' },
    });
    const rulerB = await db.user.create({
      data: { email: crypto.randomUUID() + '@example.test', passwordHash: 'fixture-only' },
    });
    users.push(rulerA.id, rulerB.id);
    const initial = await monthlyFixture();
    initial.ruleFeatures = [
      ...(personnel ? ['personnel'] : []),
      ...(personnel ? ['diplomatic-cooldown-v1', 'ranked-aid-v1'] : []),
      'treaty',
      'treaty-break',
      'treaty-expanded',
      'treaty-trade',
    ].sort();
    initial.nations.forEach((nation) => {
      nation.isNpc = false;
    });
    initial.nations[0]!.rice = 8;
    Object.assign(initial.nations[0]!, { capitalCityKey: 1, gold: 10000, ...(personnel ? { level: 1 } : {}) });
    Object.assign(initial.nations[1]!, { capitalCityKey: 2, gold: 10000, rice: 10000 });
    Object.assign(initial.generals[0]!, {
      userId: personnel ? null : rulerA.id,
      cityKey: 1,
      nationId: 1,
      officerLevel: 12,
    });
    Object.assign(initial.generals[1]!, {
      userId: personnel ? null : rulerB.id,
      cityKey: 2,
      nationId: 2,
      officerLevel: 12,
    });
    const visitor = initial.generals[2]!;
    Object.assign(visitor, { cityKey: 1, nationId: 2, officerLevel: 1, activeFromYear: initial.startYear });
    initial.generals.push(
      { ...visitor, id: 4, name: '이양 도시 원주민', cityKey: 4, nationId: 1 },
      { ...visitor, id: 5, name: '이양 도시 방문자', cityKey: 4 },
    );
    initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    initial.generals.forEach((general) => {
      general.nextTurnTick = 30000;
    });
    initial.cities.forEach((city) => {
      city.commerce = 0;
      city.agriculture = 0;
    });
    Object.assign(initial.cities[0]!, { connections: [2], nationId: 1, supplied: true });
    Object.assign(initial.cities[1]!, { connections: [1, 4], nationId: 2, supplied: true });
    Object.assign(initial.cities[2]!, { connections: [], nationId: null, supplied: false });
    Object.assign(initial.cities[3]!, { connections: [2], nationId: 1, supplied: false });
    const { worldId } = await saveInitialWorld(db, initial, {
      name: '확장 조약 PG 검증',
      turnTermMinutes: 60,
      endYear: null,
    });
    worlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const lease = await acquireLease(db, worldId);
    if (!lease) throw Error('격리 월드 실행권이 없습니다.');
    const loop = new TurnLoop(db, lease);
    const listener = new Client({ connectionString: url });
    await listener.connect();
    const signals: RealtimeSignal[] = [];
    listener.on('notification', ({ payload }) => {
      if (payload) signals.push(JSON.parse(payload) as RealtimeSignal);
    });
    await listener.query('LISTEN "' + worldChannel(worldId) + '"');
    async function queue(actor: { id: string }, generalId: number | null, input: EngineRequest, tick: number) {
      const event = await db.inputEvent.create({
        data: {
          worldId,
          userId: actor.id,
          generalId,
          kind: input.kind,
          payload: input.payload as Prisma.InputJsonValue,
          idempotencyKey: input.kind + ':' + crypto.randomUUID(),
          status: 'PENDING',
        },
      });
      await loop.advanceTo(tick);
      const result = await db.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(result.status).toBe('APPLIED');
      return result;
    }
    const city = (cityKey: number) => db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey } } });
    const general = (id: number) => db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } });
    const nation = (id: number) => db.nation.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } });
    try {
      if (personnel) {
        const residents = await Promise.all(
          Array.from({ length: 2 }, () =>
            db.user.create({
              data: { email: crypto.randomUUID() + '@example.test', passwordHash: 'fixture-only' },
            }),
          ),
        );
        users.push(...residents.map(({ id }) => id));
        await queue(
          rulerA,
          null,
          {
            kind: 'admin.world.setOption',
            payload: {
              version: 1,
              reason: '조약 거주 검증',
              setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
            },
          },
          0,
        );
        const actors = [rulerA, rulerB, ...residents];
        for (const [index, actor] of actors.entries()) {
          await queue(actor, null, { kind: 'general.possess', payload: { generalId: index + 1, userId: actor.id } }, 0);
        }
        expect(await general(4)).toMatchObject({ cityKey: 4, residenceTick: 0 });
        expect(await general(3)).toMatchObject({ cityKey: 1, residenceTick: 0 });
      }
      const proposal = await queue(
        rulerA,
        1,
        {
          kind: 'treaty.propose',
          payload: {
            toNationId: 2,
            clauses: [
              { kind: 'peace' },
              { kind: 'nonAggression', months: 3 },
              { kind: 'passage', cityKeys: [1], months: personnel ? 3 : 1 },
              { kind: 'tribute', payerNationId: 1, gold: 100, rice: 20, months: 2 },
              { kind: 'trade', months: 1 },
              { kind: 'cityTransfer', cityKey: 4, giverNationId: 1 },
            ],
          },
        },
        0,
      );
      const treatyId = String(proposal.sequence);
      expect(proposal.result).toMatchObject({ outcome: 'PROPOSED', treatyId });
      expect(await city(4)).toMatchObject({ nationId: 1, supplied: false });
      expect(await general(4)).toMatchObject({ nationId: 1, cityKey: 4 });
      const response = await queue(rulerB, 2, { kind: 'treaty.respond', payload: { treatyId, accept: true } }, 100);
      expect(response.result).toMatchObject({ outcome: 'ACCEPTED', endTick: 30100, cost: { from: 50, to: 25 } });
      expect(await city(4)).toMatchObject({ nationId: 2, supplied: true });
      expect(await general(4)).toMatchObject({ nationId: 1, cityKey: 1, ...(personnel ? { residenceTick: 100 } : {}) });
      expect(await general(5)).toMatchObject({ nationId: 2, cityKey: 4 });
      expect(await general(3)).toMatchObject({ nationId: 2, cityKey: 1 });
      expect(await db.diplomacy.findFirst({ where: { worldId, nationA: 1, nationB: 2 } })).toMatchObject({
        state: 'NON_AGGRESSION',
        untilTick: 30100,
      });
      const acceptedA = await nation(1),
        acceptedB = await nation(2);
      expect(acceptedA.diplomaticAidUntilMonth).toBe(personnel ? 12 : null);
      expect(acceptedB.diplomaticAidUntilMonth).toBeNull();
      await loop.advanceTo(10000);
      expect(await nation(1)).toMatchObject({ gold: acceptedA.gold - 100, rice: 8 });
      expect(await nation(2)).toMatchObject({ gold: acceptedB.gold + 100, rice: acceptedB.rice });
      const expectedAidFailure = '조약 ' + treatyId + ' 월 원조 실패 · 쌀 20 · 지급국의 국고 부족';
      async function expectAidFailure(tick: number) {
        for (const nationId of [1, 2]) {
          const { data } = await db.nationHistory.findUniqueOrThrow({
            where: { worldId_tick_nationId: { worldId, nationId, tick } },
          });
          const events = (data as { events: string[] }).events;
          expect(events.filter((event) => event.includes('월 원조 실패'))).toEqual([expectedAidFailure]);
        }
      }
      await expectAidFailure(10000);
      await loop.advanceTo(10000);
      expect(await nation(1)).toMatchObject({ gold: acceptedA.gold - 100, rice: 8 });
      expect(await general(3)).toMatchObject({ nationId: 2, cityKey: 1 });
      if (personnel) {
        const broken = await queue(rulerA, 1, { kind: 'treaty.break', payload: { treatyId } }, 10000);
        expect(broken.result).toMatchObject({ outcome: 'BROKEN', brokenByNationId: 1 });
        expect(await general(3)).toMatchObject({ nationId: 2, cityKey: 2, residenceTick: 10000 });
        expect(
          await db.nationTrust.findUnique({ where: { worldId_nationId: { worldId, nationId: 1 } } }),
        ).toMatchObject({ brokenTreaties: 1, lastBrokenTick: 10000 });
      }
      await loop.advanceTo(20000);
      expect(await city(4)).toMatchObject({ nationId: 2, supplied: true });
      expect(await general(3)).toMatchObject({ nationId: 2, cityKey: 2 });
      const paid = personnel ? 100 : 200;
      expect(await nation(1)).toMatchObject({ gold: acceptedA.gold - paid, rice: 8 });
      expect(await nation(2)).toMatchObject({ gold: acceptedB.gold + paid, rice: acceptedB.rice });
      if (!personnel) {
        await expectAidFailure(20000);
        const where = { worldId_id: { worldId, id: Number(treatyId) } };
        expect(await db.treaty.findUniqueOrThrow({ where })).toMatchObject({ status: 'ACTIVE' });
        await loop.advanceTo(40000);
        expect(await db.treaty.findUniqueOrThrow({ where })).toMatchObject({ status: 'ENDED' });
      }
      await expect
        .poll(() => signals.filter(({ kind }) => kind === 'treaty.new'))
        .toEqual(
          Array.from({ length: personnel ? 3 : 2 }, () => ({ kind: 'treaty.new', target: { nationIds: [1, 2] } })),
        );
      const snapshots = await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
      const months = personnel ? 2 : 4;
      expect(snapshots).toHaveLength(months);
      expect(replayArchive(await exportReplay(db, worldId), months).map(({ stateHash }) => stateHash)).toEqual(
        snapshots.map(({ stateHash }) => stateHash),
      );
    } finally {
      await listener.end();
      await releaseLease(db, lease);
    }
  },
  90_000,
);
