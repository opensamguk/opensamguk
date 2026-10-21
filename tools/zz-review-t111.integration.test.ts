// 리뷰 전용 임시 탐침. 커밋하지 않는다.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { commands } from '../packages/rules/src/index';

const url = process.env.TEST_DATABASE_URL!;
const db = createDb(url);
let logs = '';
const stream = new Writable({
  write(chunk, _enc, done) {
    logs += chunk.toString();
    done();
  },
});
const app = await buildServer({ db, logStream: stream });
const worlds: string[] = [];
const users: string[] = [];
const tokens: string[] = [];
const payload = { name: '새장수', leadership: 55, strength: 55, intel: 55, portraitId: null };
const mutations = new Set(['general.create', 'turns.set', 'turns.edit']);
async function request(path: string, input: unknown, cookie?: string) {
  const mutation = mutations.has(path);
  const res = await app.inject({
    method: mutation ? 'POST' : 'GET',
    url: `/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`}`,
    headers: cookie ? { cookie } : {},
    ...(mutation ? { payload: { 0: input } } : {}),
  });
  const body = res.json()[0];
  return {
    data: body.result?.data,
    code: body.error?.data.code,
    text: res.body,
    setCookie: res.headers['set-cookie'],
  };
}
async function identity() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, passwordHash: 'probe-hash' } });
  users.push(user.id);
  const session = newSession(Date.now());
  tokens.push(session.token);
  await db.session.create({ data: { id: session.id, userId: user.id, expiresAt: session.expiresAt } });
  return { id: user.id, cookie: `sid=${session.token}` };
}
async function world() {
  const initial = await monthlyFixture();
  const { worldId } = await saveInitialWorld(db, initial, { name: '리뷰 탐침', turnTermMinutes: 60 });
  worlds.push(worldId);
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId))!;
  return { worldId, loop: new TurnLoop(db, lease), initial };
}
beforeAll(() => app.ready());
afterAll(async () => {
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('리뷰 탐침 T1-11', () => {
  it('서로 다른 사용자가 같은 이름(NFD 포함)을 동시에 접수하면 하나만 생성된다', async () => {
    const { worldId, loop } = await world();
    const a = await identity();
    const b = await identity();
    const ra = request('general.create', { worldId, ...payload }, a.cookie);
    const rb = request('general.create', { worldId, ...payload, name: '새장수'.normalize('NFD') }, b.cookie);
    while ((await db.inputEvent.count({ where: { worldId, status: 'PENDING' } })) < 2)
      await new Promise((r) => setTimeout(r, 10));
    await loop.advanceTo(0);
    const [x, y] = await Promise.all([ra, rb]);
    expect(x.data?.status).toBe('created');
    expect(y.code).toBe('CONFLICT');
    expect(await db.general.count({ where: { worldId, name: '새장수' } })).toBe(1);
    const mineB = await request('general.mine', { worldId }, b.cookie);
    expect(mineB.data).toMatchObject({ general: null, creation: { status: 'rejected', code: 'NAME_TAKEN' } });
    const events = await db.inputEvent.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
    expect(events.map((e) => [e.status, e.sequence])).toEqual([
      ['APPLIED', 1],
      ['REJECTED', 2],
    ]);
  });
  it('같은 사용자의 동시 접수는 입력 하나로 합쳐지고 생성 뒤 예턴·실행·재생이 이어진다', async () => {
    const { worldId, loop } = await world();
    const a = await identity();
    const calls = Array.from({ length: 4 }, () => request('general.create', { worldId, ...payload }, a.cookie));
    while ((await db.inputEvent.count({ where: { worldId } })) < 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300));
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
    await loop.advanceTo(0);
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.data?.status === 'created').length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(r.data?.status === 'created' || r.code === 'CONFLICT').toBe(true);
    const mine = await request('general.mine', { worldId }, a.cookie);
    expect(mine.data.creation).toBeNull();
    const created = mine.data.general;
    // 엔진이 만든 장수는 main의 조회 home.get에서도 같은 공개 필드로 보인다.
    const home = await request('home.get', { worldId }, a.cookie);
    expect(home.code).toBeUndefined();
    expect(home.data.general).toEqual(created);
    const turns = await request('turns.get', { worldId }, a.cookie);
    expect(turns.data.revision).toBe(0);
    expect(turns.data.slots.every((s: { commandKey: string }) => s.commandKey === 'rest')).toBe(true);
    // 재야라 내정 사전 검사는 NOT_NATION 경고이지만 저장은 된다.
    expect((await request('turns.precheck', { worldId, commandKey: 'farm' }, a.cookie)).data).toMatchObject({
      ok: false,
      code: 'NOT_NATION',
    });
    const saved = await request(
      'turns.edit',
      { worldId, revision: 0, op: { put: { from: 0, to: 0, commandKey: 'farm' } } },
      a.cookie,
    );
    expect(saved.data).toMatchObject({ ok: true, revision: 1 });
    const executions = await loop.advanceTo(created.nextTurnTick);
    expect(executions).toContainEqual({ generalId: created.id, tick: created.nextTurnTick, commandKey: 'farm' });
    const log = await db.generalLog.findUniqueOrThrow({
      where: { worldId_generalId_tick: { worldId, generalId: created.id, tick: created.nextTurnTick } },
    });
    expect(log.kind).toBe('failure');
    expect(log.text).toContain('NOT_NATION');
    expect((await request('turns.get', { worldId }, a.cookie)).data.revision).toBe(2);
    await loop.advanceTo(30000);
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, archive.months.length).map((m) => m.stateHash)).toEqual(
      archive.months.map((m) => m.stateHash),
    );
  });
  it('strict 입력: put의 name·여분 args, slot name, 생성의 누락 portraitId를 거부한다', async () => {
    const { worldId, initial } = await world();
    const a = await identity();
    await db.general.update({
      where: { worldId_id: { worldId, id: initial.generals[0]!.id } },
      data: { userId: a.id },
    });
    const before = await db.inputEvent.count({ where: { worldId } });
    for (const op of [
      { put: { from: 0, to: 0, commandKey: 'farm', name: '농업' } },
      { put: { from: 0, to: 0, commandKey: 'farm', args: { x: 1 } } },
      { put: { from: 0, to: 0, commandKey: 'farm', generalId: 2 } },
    ])
      expect((await request('turns.edit', { worldId, revision: 0, op }, a.cookie)).code).toBe('BAD_REQUEST');
    const slots = Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {}, name: '휴식' }));
    expect((await request('turns.set', { worldId, revision: 0, slots }, a.cookie)).code).toBe('BAD_REQUEST');
    const { portraitId, ...noPortrait } = payload;
    void portraitId;
    const b = await identity();
    expect((await request('general.create', { worldId, ...noPortrait }, b.cookie)).code).toBe('BAD_REQUEST');
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(before);
  });
  it('보호 API 일반 요청은 Set-Cookie를 보내지 않고 응답·로그에 비밀이 없다', async () => {
    const { worldId, initial } = await world();
    const a = await identity();
    await db.general.update({
      where: { worldId_id: { worldId, id: initial.generals[0]!.id } },
      data: { userId: a.id },
    });
    for (const [path, input] of [
      ['turns.get', { worldId }],
      ['commands.list', { worldId }],
      ['general.mine', { worldId }],
      ['home.get', { worldId }],
      ['turns.precheck', { worldId, commandKey: 'missing' }],
      ['turns.set', { worldId, revision: 9, slots: [] }],
    ] as const) {
      const res = await request(path, input, a.cookie);
      expect(res.setCookie, path).toBeUndefined();
      expect(res.text).not.toContain('probe-hash');
      expect(res.text).not.toContain('"stack"');
      expect(res.text).not.toContain(a.id);
      expect(res.text).not.toContain('@test.invalid');
    }
    const list = (await request('commands.list', { worldId }, a.cookie)).data;
    expect(list.map((c: { key: string; category: string }) => [c.key, c.category])).toEqual(
      commands.filter((d) => d.target === 'general').map((d) => [d.key, d.category]),
    );
    expect(list).toHaveLength(27);
    expect(list.some((c: { key: string }) => c.key.startsWith('nation_'))).toBe(false);
    for (const token of tokens) expect(logs).not.toContain(token);
    expect(logs).not.toContain('probe-hash');
    expect(logs).not.toContain('sid=');
  });
  it('등용 수락 사전 검사는 서버 세션 장수의 제안만 보고 tick·commandMeta 삽입을 거부한다', async () => {
    const initial = await monthlyFixture();
    const a = await identity();
    initial.generals[0]!.userId = a.id;
    initial.generals[0]!.nationId = null;
    initial.generals[2]!.nationId = null;
    // 제안은 다른 재야 장수(3)에게만 있다.
    initial.commandMeta = { nextNationId: 3, offers: { 3: 2 } };
    const { worldId } = await saveInitialWorld(db, initial, { name: '리뷰 탐침 제안', turnTermMinutes: 60 });
    worlds.push(worldId);
    await controlClock(db, worldId, 'start');
    const res = await request('turns.precheck', { worldId, commandKey: 'accept_invite' }, a.cookie);
    expect(res.data).toMatchObject({ ok: false, code: 'NO_OFFER' });
    for (const extra of [{ tick: 0 }, { commandMeta: { offers: { 1: 2 } } }, { generalId: 3 }])
      expect((await request('turns.precheck', { worldId, commandKey: 'accept_invite', ...extra }, a.cookie)).code).toBe(
        'BAD_REQUEST',
      );
    await db.world.update({ where: { id: worldId }, data: { commandMeta: { nextNationId: 3, offers: { 1: 2 } } } });
    expect((await request('turns.precheck', { worldId, commandKey: 'accept_invite' }, a.cookie)).data).toEqual({
      ok: true,
    });
  });
  it('저장 병종이 깨지면 내부 오류만 알리고 zod 상세·stack·병종 정보를 노출하지 않는다', async () => {
    const { worldId, initial } = await world();
    const a = await identity();
    await db.general.update({
      where: { worldId_id: { worldId, id: initial.generals[0]!.id } },
      data: { userId: a.id },
    });
    await db.world.update({ where: { id: worldId }, data: { unitSet: { crewTypes: 'broken' } } });
    const before = await db.inputEvent.count({ where: { worldId } });
    const res = await request(
      'turns.precheck',
      { worldId, commandKey: 'recruit', args: { amount: 10, crewType: 1100 } },
      a.cookie,
    );
    expect(res.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.text).toContain('요청을 처리하지 못했습니다.');
    for (const leak of ['"stack"', 'ZodError', 'crewTypes', 'invalid_type', 'broken'])
      expect(res.text).not.toContain(leak);
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(before);
  });
});
