import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { tacticalFixture } from '../packages/rules/test/tacticalFixture';
import { closeCouncil } from '../packages/rules/src/index';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { testDatabaseUrl } from './test-database';

// AC-M1-06·09·10, AC-INT-28: 실제 PG와 HTTP에서 세션 행위자·제안·전투 권한을 기록한다.
// 네 장수 고정물만 쓰며 월 진행이나 엔진 적용 결과를 권한 증거로 대신하지 않는다.
const db = createDb(testDatabaseUrl(process.env).href);
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, publicOrigin: origin, logging: false });
const paths = [
  'commands.moveTargets',
  'commands.attackTargets',
  'proposals.history',
  'proposals.commands',
  'proposals.create',
  'proposals.list',
  'proposals.respond',
  'proposals.cancel',
  'battle.council.get',
  'battle.council.set',
  'battle.plan.set',
  'battle.presence.heartbeat',
  'battle.turn.get',
  'battle.turn.submit',
  'battle.receipt.get',
  'battle.replay.get',
] as const;
type Path = (typeof paths)[number];
const users: { id: string; cookie: string }[] = [];
let base: string;
let worldId: string | undefined;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

beforeAll(async () => {
  for (let index = 0; index < 4; index++) {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid`, passwordHash: 'not-a-login-hash', emailVerifiedAt: new Date() },
    });
    const session = newSession(Date.now());
    await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
    users.push({ id: user.id, cookie: `sid=${session.token}` });
  }
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await db.user.updateMany({ where: { id: { in: users.map((u) => u.id) } }, data: { status: 'ACTIVE' } });
  if (worldId) await db.world.delete({ where: { id: worldId } });
  worldId = undefined;
});
afterAll(async () => {
  await app.close();
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

async function rpc(path: Path, input: unknown, actor: number | null) {
  const mutation = [
    'proposals.create',
    'proposals.respond',
    'proposals.cancel',
    'battle.council.set',
    'battle.plan.set',
    'battle.presence.heartbeat',
    'battle.turn.submit',
  ].includes(path);
  const encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : '&input=' + encodeURIComponent(encoded)}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin,
        ...(actor === null ? {} : { cookie: users[actor]!.cookie }),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const raw = await response.text();
  expect(users.some((u) => raw.includes(u.cookie.slice(4)))).toBe(false);
  expect(/passwordHash|sessionId|not-a-login-hash/.test(raw)).toBe(false);
  const [body] = JSON.parse(raw) as { result?: { data: unknown }; error?: { data: { code: string } } }[];
  return { status: response.status, data: body?.result?.data, code: body?.error?.data.code };
}

async function fixture(path: Path) {
  const initial = commandInitial();
  initial.seed = randomUUID();
  initial.generals[2]!.nationId = 1;
  initial.generals[2]!.cityKey = 1;
  initial.generals[3]!.nationId = 2;
  initial.generals[3]!.cityKey = 2;
  ({ worldId } = await saveInitialWorld(db, initial, { name: 'INT-27 HTTP 권한', turnTermMinutes: 60, endYear: null }));
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING' } });
  for (const [id, user] of [
    [3, 0],
    [1, 1],
    [4, 2],
  ] as const)
    await db.general.update({ where: { worldId_id: { worldId, id } }, data: { userId: users[user]!.id } });

  if (path.startsWith('battle.')) {
    const { world, battle } = tacticalFixture();
    if (path === 'battle.turn.submit') {
      closeCouncil(battle);
      battle.mode = 'LIVE';
    }
    battle.deadlineAt = Date.now() + 600_000;
    battle.hardDeadlineAt = battle.deadlineAt;
    const stored = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    await db.world.update({
      where: { id: worldId },
      data: {
        campaignState: json({
          ...(stored.campaignState as Prisma.JsonObject),
          units: world.campaign!.units,
          nextUnitId: world.campaign!.nextUnitId,
          tactical: world.campaign!.tactical,
        }),
      },
    });
    await db.battle.create({
      data: {
        worldId,
        id: battle.id,
        revision: battle.revision,
        phase: battle.phase,
        deadlineAt: new Date(battle.deadlineAt),
        state: json(battle),
      },
    });
    const identity = { worldId, battleId: battle.id };
    const envelope = {
      ...identity,
      expectedRevision: battle.revision,
      windowNo: battle.windowNo,
      mapHash: battle.mapHash,
      idempotencyKey: randomUUID(),
    };
    const unitId = battle.units.find((u) => u.ownerId === 1)!.id;
    let input: unknown = identity;
    if (path === 'battle.council.set') input = { ...envelope, route: 'front', ready: true };
    if (path === 'battle.plan.set')
      input = { ...envelope, units: [{ unitId, path: [], rules: [], fallback: { kind: 'hold' } }] };
    if (path === 'battle.turn.submit')
      input = { ...envelope, turnNo: battle.turn + 1, unitId, expectedUnitOrderRevision: 0, action: { kind: 'hold' } };
    if (path === 'battle.receipt.get') {
      const accepted = await rpc('battle.council.set', { ...envelope, ready: true }, 1);
      expect(accepted.status).toBe(200);
      input = { worldId, receiptId: (accepted.data as { receiptId: string }).receiptId };
    }
    return { input, actor: 1 };
  }
  if (path.startsWith('proposals.')) {
    const created = await rpc('proposals.create', { worldId, commandKey: 'nation_rest', note: 'private-proposal' }, 0);
    expect(created.status).toBe(200);
    const proposalId = (created.data as { proposalId: string }).proposalId;
    // 다른 국가의 기록이 섞이지 않는지도 실제 SQL 조회에서 확인한다.
    await db.nationHistory.createMany({
      data: [1, 2].map((nationId) => ({
        worldId: worldId!,
        nationId,
        tick: 0,
        data: { proposals: [{ text: `nation-${nationId}-private` }] },
      })),
    });
    const input =
      path === 'proposals.list'
        ? { worldId, box: 'sent' }
        : path === 'proposals.create'
          ? { worldId, commandKey: 'nation_rest', args: {}, note: 'second-proposal' }
          : path === 'proposals.respond'
            ? { proposalId, decision: 'reject' }
            : path === 'proposals.cancel'
              ? { proposalId }
              : { worldId };
    // create는 중복 제안 거절과 혼동하지 않게 준비 제안을 닫는다.
    if (path === 'proposals.create')
      await db.commandProposal.update({ where: { id: proposalId }, data: { status: 'CANCELLED' } });
    return { input, actor: path === 'proposals.respond' ? 1 : 0 };
  }
  return { input: { worldId }, actor: 1 };
}

async function snapshot() {
  return {
    proposals: await db.commandProposal.findMany({ where: { worldId: worldId! }, orderBy: { id: 'asc' } }),
    inputs: await db.inputEvent.findMany({ where: { worldId: worldId! }, orderBy: { id: 'asc' } }),
    presence: await db.battlePresence.findMany({ where: { worldId: worldId! } }),
    battles: await db.battle.findMany({ where: { worldId: worldId! } }),
    generals: await db.general.findMany({ where: { worldId: worldId! }, orderBy: { id: 'asc' } }),
    offices: await db.nationOffice.findMany({ where: { worldId: worldId! } }),
    turns: await db.nationOfficeTurn.findMany({ where: { worldId: worldId! } }),
  };
}

for (const path of paths)
  for (const category of categories) {
    it(
      `${path}: ${category}`,
      authzCase(path, category, async () => {
        const f = await fixture(path);
        const before = await snapshot();
        let actor: number | null = f.actor;
        let input: unknown = f.input;
        if (category === 'unauthenticated') actor = null;
        if (category === 'sanctioned')
          await db.user.update({ where: { id: users[actor!]!.id }, data: { status: 'SANCTIONED' } });
        if (category === 'invalidInput') input = {};
        if (category === 'otherUser')
          actor = path.startsWith('commands.') || ['proposals.commands', 'proposals.create'].includes(path) ? 3 : 2;
        const result = await rpc(path, input, actor);
        if (category === 'success') {
          expect(result.status).toBe(200);
          expect(result.code).toBeUndefined();
          if (path === 'proposals.history')
            expect(result.data).toEqual([{ tick: 0, kind: 'proposal', text: 'nation-1-private' }]);
          else if (path === 'proposals.list') expect(result.data).toMatchObject([{ note: 'private-proposal' }]);
          else if (path === 'proposals.create') expect(result.data).toMatchObject({ proposalId: expect.any(String) });
          else if (path === 'proposals.respond') expect(result.data).toEqual({ ok: true, status: 'REJECTED' });
          else if (path === 'proposals.cancel') expect(result.data).toEqual({ ok: true, status: 'CANCELLED' });
          else if (['battle.council.set', 'battle.plan.set', 'battle.turn.submit'].includes(path)) {
            expect(result.data).toMatchObject({ receiptId: expect.any(String), status: 'PENDING' });
            expect(await db.inputEvent.count({ where: { worldId: worldId!, userId: users[f.actor]!.id } })).toBe(1);
          } else if (path === 'battle.presence.heartbeat')
            expect(await db.battlePresence.count({ where: { worldId: worldId! } })).toBe(1);
          else if (path === 'battle.receipt.get') expect(result.data).toMatchObject({ status: 'PENDING' });
          else if (path.startsWith('battle.'))
            expect(result.data).toMatchObject({ ownSide: 'attack', battleId: expect.any(String) });
          else expect(Array.isArray(result.data)).toBe(true);
        } else {
          if (category === 'otherUser' && ['proposals.history', 'proposals.list'].includes(path)) {
            expect(result.status).toBe(200);
            expect(result.data).toEqual(
              path === 'proposals.history' ? [{ tick: 0, kind: 'proposal', text: 'nation-2-private' }] : [],
            );
          } else {
            expect(result.status).toBe(category === 'invalidInput' ? 400 : category === 'otherUser' ? 404 : 401);
            expect(result.code).toBe(
              category === 'invalidInput' ? 'BAD_REQUEST' : category === 'otherUser' ? 'NOT_FOUND' : 'UNAUTHORIZED',
            );
          }
          if (category === 'otherUser' && path.startsWith('commands.')) {
            expect(await rpc(path, { worldId, generalId: 1, userId: users[1]!.id }, 3)).toMatchObject({
              status: 400,
              code: 'BAD_REQUEST',
            });
          }
          if (category === 'otherUser' && ['proposals.respond', 'proposals.cancel'].includes(path)) {
            // 같은 국가라도 제안자는 승인할 수 없고 군주는 타인의 제안을 취소할 수 없다.
            expect(await rpc(path, f.input, path === 'proposals.respond' ? 0 : 1)).toMatchObject({
              status: 403,
              code: 'FORBIDDEN',
            });
          }
          expect(await snapshot()).toEqual(before);
        }
      }),
    );
  }
