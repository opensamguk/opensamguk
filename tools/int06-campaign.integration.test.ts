import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it as test } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { rngFor } from '../packages/shared/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { applyCampaignRelationship, type WorldInit } from '../packages/rules/src/index';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease, renewLease, LEASE_TTL_MS } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { hashPassword } from '../apps/server/src/auth/password';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import type { readCampaignBoard, readCampaignRequest } from '../apps/server/src/game/campaignApi';
import type { AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';

// AC-INT-06 실제 191년 21국·491명 원본, HTTP 세션과 펜싱 엔진을 함께 검사한다.
// 이 파일의 한 달 검사는 AC-INT-12 한 기수 인수를 대신하지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)
)
  throw new Error('loopback 전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = Date.now(),
  origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, logging: false, publicOrigin: origin, now: () => now });
const seed = 'int06-formal-http-191';
const worldIds: string[] = [],
  users: string[] = [],
  cookies: string[] = [];
type Board = Awaited<ReturnType<typeof readCampaignBoard>>;
type Receipt = Awaited<ReturnType<typeof readCampaignRequest>>;
let base: string, worldId: string, otherWorldId: string, initial: WorldInit;
let ownId: number,
  targetId: number,
  unitId: number,
  offerId: number,
  tick = 0;
let formRequest: string, offerRequest: string;
let declinedNpcId: number, lieutenantId: number;
const executions = new Set<Promise<unknown>>();
function track<T>(action: () => Promise<T>): Promise<T> {
  const execution = action();
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  return execution;
}
function it(name: string, action: () => Promise<void>) {
  test(name, () => track(action));
}
beforeEach(async () => {
  await Promise.allSettled([...executions]);
});
const paths = ['campaign.get', 'campaign.relationship', 'campaign.unit', 'campaign.request'] as const;

async function http<T = unknown>(path: string, data: unknown, session = cookies[0], mutation = false) {
  const encoded = JSON.stringify({ 0: data });
  const response = await fetch(
    `${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin,
        ...(session ? { cookie: session } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  const [body] = (await response.json()) as Array<{ result?: { data: T }; error?: { data: { code: string } } }>;
  if (!body) throw new Error('HTTP 응답이 없습니다.');
  return { data: body.result?.data, code: body.error?.data.code };
}
async function board(index = 0) {
  const response = await http<Board>('campaign.get', { worldId }, cookies[index]);
  expect(response.code).toBeUndefined();
  return response.data!;
}
async function advance(to = tick, beforeCommit?: () => Promise<void>) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('검사 실행권이 없습니다.');
  const controller = new AbortController();
  let renewalError: unknown;
  // 실제 엔진과 같은 TTL/갱신 주기를 지키며 긴 advance도 실행권을 갱신한다.
  const renewal = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(LEASE_TTL_MS / 3, undefined, { signal: controller.signal });
      } catch {
        break;
      }
      if (controller.signal.aborted) break;
      try {
        await renewLease(db, lease);
      } catch (error) {
        renewalError = error;
        controller.abort(error);
      }
    }
  })();
  try {
    const result = await new TurnLoop(db, lease, beforeCommit ? { beforeCommit } : {}).advanceTo(to, controller.signal);
    if (renewalError) throw renewalError;
    return result;
  } finally {
    controller.abort();
    await renewal;
    await releaseLease(db, lease);
  }
}
async function submit(
  path: 'campaign.unit' | 'campaign.relationship',
  payload: unknown,
  index = 0,
  requestId = randomUUID(),
) {
  const result = await http<Receipt>(path, { worldId, requestId, payload }, cookies[index], true);
  expect(result.code).toBeUndefined();
  expect(result.data?.status).toBe('pending');
  return requestId;
}
async function receipt(requestId: string, index = 0) {
  return (await http<Receipt>('campaign.request', { worldId, requestId }, cookies[index])).data!;
}
async function snapshot(id = worldId) {
  return db.$transaction((tx) => loadReplayState(tx, id), { isolationLevel: 'RepeatableRead' });
}

beforeAll(() =>
  track(async () => {
    initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed,
    });
    initial.ruleFeatures = [
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    const cityKeys = initial.cities.filter((city) => city.kind === 'CITY').map((city) => city.cityKey);
    // 동일 생성 RNG를 사용해 초반 offset인 계정 ID만 고른다. 원본 491명과 능력치·위치는 바꾸지 않는다.
    for (let index = 0; index < 2; index++) {
      for (;;) {
        const id = randomUUID(),
          rng = rngFor(seed, 'create', id);
        rng.pick(cityKeys);
        rng.int(1, 150);
        const offset = rng.int(0, 9999);
        if (offset > 0 && offset <= 10) {
          users.push(id);
          break;
        }
      }
    }
    users.push(randomUUID(), randomUUID());
    const passwordHash = await hashPassword(randomUUID());
    for (const [index, id] of users.entries()) {
      await db.user.create({
        data: { id, email: `${id}@example.invalid`, passwordHash, status: index === 3 ? 'SANCTIONED' : 'ACTIVE' },
      });
      const session = newSession(now);
      await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
      cookies.push(`sid=${session.token}`);
    }
    for (let count = 0; count < 2; count++) {
      const created = await saveInitialWorld(db, initial, {
        name: 'INT06 정식 HTTP',
        turnTermMinutes: 60,
        endYear: 201,
      });
      worldIds.push(created.worldId);
    }
    [worldId, otherWorldId] = worldIds as [string, string];
    await controlClock(db, worldId, 'start');
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }),
);
afterAll(async () => {
  await Promise.allSettled([...executions]);
  await app.close();
  await db.world.deleteMany({ where: { id: { in: worldIds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('정식 원본을 보존하고 실제 생성 입력·30칸 예약·임관으로 두 사람을 만든다', async () => {
  expect(initial.generals).toHaveLength(491);
  expect(initial.nations).toHaveLength(21);
  for (let index = 0; index < 2; index++) {
    const creating = track(() =>
      http(
        'general.create',
        {
          worldId,
          name: `휘하검사${index}`,
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        },
        cookies[index],
        true,
      ),
    );
    await expect
      .poll(() =>
        db.inputEvent.count({ where: { worldId, userId: users[index], kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    await advance(0);
    expect((await creating).data).toMatchObject({ status: 'created' });
  }
  const humans = await db.general.findMany({ where: { worldId, userId: { in: users } }, orderBy: { id: 'asc' } });
  [ownId, targetId] = humans.map((general) => general.id) as [number, number];
  for (const [index, general] of humans.entries()) {
    expect(general.nextTurnTick).toBeLessThanOrEqual(10);
    expect(
      (
        await http(
          'turns.set',
          {
            worldId,
            revision: 0,
            slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
          },
          cookies[index],
          true,
        )
      ).data,
    ).toMatchObject({ ok: true });
    expect(await db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
  }
  tick = Math.max(...humans.map((general) => general.nextTurnTick));
  await advance();
  const joined = await db.general.findMany({ where: { worldId, id: { in: [ownId, targetId] } } });
  expect(joined.every((general) => general.nationId === 1 && general.crew === 0)).toBe(true);
  expect(new Set(joined.map((general) => general.cityKey)).size).toBe(1);
  expect((await snapshot()).state.campaign!.sources[String(ownId)]).toMatch(/^input:\d+#general:492$/);
});

describe('네 휘하 API의 실제 HTTP 권한 대조', () => {
  for (const path of paths)
    for (const category of categories)
      it(
        `${path} ${category}`,
        authzCase(path, category, async () => {
          const current = await board();
          const input =
            path === 'campaign.get'
              ? { worldId }
              : path === 'campaign.request'
                ? { worldId, requestId: formRequest }
                : {
                    worldId,
                    requestId: randomUUID(),
                    payload:
                      path === 'campaign.unit'
                        ? { type: 'form', commanderId: ownId, crewType: 1100, revision: current.revision }
                        : { type: 'offer', targetId, relation: 'STAFF', revision: current.revision },
                  };
          const mutation = path === 'campaign.unit' || path === 'campaign.relationship';
          const before = hashState(await snapshot());
          if (category === 'success') {
            if (path === 'campaign.unit') {
              formRequest = (input as { requestId: string }).requestId;
              expect((await http(path, input, cookies[0], true)).data).toMatchObject({ status: 'pending' });
              expect(hashState(await snapshot())).toBe(before);
              await advance();
              const applied = await receipt(formRequest);
              expect(applied.status).toBe('applied');
              if (applied.status !== 'applied' || applied.kind !== 'campaign.unit') throw new Error('편성 실패');
              unitId = applied.result.unitId;
            } else if (path === 'campaign.relationship') {
              offerRequest = (input as { requestId: string }).requestId;
              expect((await http(path, input, cookies[0], true)).data).toMatchObject({ status: 'pending' });
              expect(hashState(await snapshot())).toBe(before);
              await advance();
              const applied = await receipt(offerRequest);
              expect(applied).toMatchObject({ status: 'applied', result: { accepted: null, cost: 0 } });
              if (
                applied.status !== 'applied' ||
                applied.kind !== 'campaign.relationship' ||
                applied.result.offerId === null
              )
                throw new Error('사람 제안 실패');
              offerId = applied.result.offerId;
            } else expect((await http(path, input)).code).toBeUndefined();
            return;
          }
          if (category === 'otherUser' && path === 'campaign.get') {
            const foreign = await board(1);
            expect(foreign.actorId).toBe(targetId);
            expect(foreign.units).toEqual([]);
            expect(JSON.stringify(foreign)).not.toContain(users[0]!);
          } else {
            const otherInput =
              path === 'campaign.unit'
                ? { ...input, payload: { type: 'disband', unitId, revision: current.revision } }
                : path === 'campaign.relationship'
                  ? { ...input, payload: { type: 'respond', offerId, accept: true, revision: current.revision } }
                  : input;
            const actual =
              category === 'invalidInput'
                ? { ...input, generalId: ownId }
                : category === 'otherUser'
                  ? otherInput
                  : input;
            // 수락권자는 두 번째 사람이다. 첫 번째가 자신의 제안에 대신 응답할 수 없다.
            const session =
              category === 'unauthenticated'
                ? ''
                : category === 'sanctioned'
                  ? cookies[3]
                  : category === 'otherUser' && path !== 'campaign.relationship'
                    ? cookies[1]
                    : cookies[0];
            expect((await http(path, actual, session, mutation)).code).toBe(
              category === 'invalidInput'
                ? 'BAD_REQUEST'
                : category === 'otherUser'
                  ? path === 'campaign.request'
                    ? 'NOT_FOUND'
                    : 'FORBIDDEN'
                  : 'UNAUTHORIZED',
            );
          }
          expect(hashState(await snapshot())).toBe(before);
        }),
      );
});

it('fresh GET 뒤 다른 계정의 세션으로 바뀌면 expectedUserId가 접수와 활동을 막는다', async () => {
  const fresh = await board();
  const before = hashState(await snapshot());
  const events = await db.inputEvent.count({ where: { worldId } });
  const turns = await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] });
  const input = {
    worldId,
    requestId: randomUUID(),
    expectedUserId: users[0],
    payload: { type: 'offer', targetId, relation: 'STAFF', revision: fresh.revision },
  };
  expect((await http('campaign.relationship', input, cookies[1], true)).code).toBe('FORBIDDEN');
  // 기존 pending JSON을 다시 읽어 같은 UUID·payload로 수동 재전송해도 UI 계정 기대값을 최상위에 붙인다.
  const pending = JSON.parse(
    JSON.stringify({ kind: 'campaign.relationship', requestId: input.requestId, payload: input.payload }),
  ) as {
    kind: string;
    requestId: string;
    payload: typeof input.payload;
  };
  const manual = { worldId, requestId: pending.requestId, payload: pending.payload, expectedUserId: users[0] };
  expect(manual).toEqual(input);
  expect((await http('campaign.relationship', manual, cookies[1], true)).code).toBe('FORBIDDEN');
  expect(pending).toEqual({ kind: 'campaign.relationship', requestId: input.requestId, payload: input.payload });
  expect((await http('campaign.relationship', { ...input, expectedUserId: users[1] }, cookies[0], true)).code).toBe(
    'FORBIDDEN',
  );
  expect((await http('campaign.relationship', { ...input, expectedUserId: 'invalid' }, cookies[0], true)).code).toBe(
    'BAD_REQUEST',
  );
  const original = await db.inputEvent.findUniqueOrThrow({
    where: {
      worldId_userId_idempotencyKey: { worldId, userId: users[0]!, idempotencyKey: `campaign:${offerRequest}` },
    },
  });
  expect(
    (
      await http(
        'campaign.relationship',
        { ...input, requestId: offerRequest, payload: original.payload },
        cookies[0],
        true,
      )
    ).data,
  ).toMatchObject({ status: 'applied' });
  expect(hashState(await snapshot())).toBe(before);
  expect(await db.inputEvent.count({ where: { worldId } })).toBe(events);
  expect(
    await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
  ).toEqual(turns);
});

it('같은 요청은 한 번만 적용하고 사람 본인의 동의·거절·해제를 보호한다', async () => {
  const offer = await db.inputEvent.findUniqueOrThrow({
    where: {
      worldId_userId_idempotencyKey: { worldId, userId: users[0]!, idempotencyKey: `campaign:${offerRequest}` },
    },
  });
  const before = await snapshot();
  expect(
    (
      await http(
        'campaign.relationship',
        { worldId, requestId: offerRequest, payload: offer.payload },
        cookies[0],
        true,
      )
    ).data,
  ).toMatchObject({ status: 'applied' });
  expect((await snapshot()).state.campaign!.links).toEqual([]);
  const requestId = await submit(
    'campaign.relationship',
    { type: 'respond', offerId, accept: true, revision: (await board(1)).revision },
    1,
  );
  await advance();
  expect(await receipt(requestId, 1)).toMatchObject({ status: 'applied', result: { accepted: true, cost: 0 } });
  expect((await board()).links).toContainEqual({ masterId: ownId, personId: targetId, relation: 'STAFF' });
  expect((await snapshot()).state.generals[ownId]!.gold).toBe(before.state.generals[ownId]!.gold);
  const release = await submit(
    'campaign.relationship',
    { type: 'release', personId: targetId, revision: (await board(1)).revision },
    1,
  );
  await advance();
  expect(await receipt(release, 1)).toMatchObject({ status: 'applied' });
  expect((await board()).links).toEqual([]);
});

it('서로 동시에 보낸 제안은 revision으로 직렬화하고 본인의 거절은 무료다', async () => {
  const before = await snapshot(),
    revision = before.state.campaign!.revision,
    reservations = await db.generalTurn.findMany({
      where: { worldId, generalId: { in: [ownId, targetId] } },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    });
  const requests = await Promise.all([
    submit('campaign.relationship', { type: 'offer', targetId, relation: 'STAFF', revision }),
    submit('campaign.relationship', { type: 'offer', targetId: ownId, relation: 'STAFF', revision }, 1),
  ]);
  await advance();
  const results = await Promise.all(requests.map((request, index) => receipt(request, index)));
  expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({ result: expect.objectContaining({ code: 'STALE_REVISION' }) }),
  ]);
  const winner = results.findIndex((result) => result.status === 'applied'),
    pending = (await snapshot()).state.campaign!.offers.find((offer) => offer.status === 'PENDING')!;
  expect(pending.personId).toBe(winner === 0 ? targetId : ownId);
  const recipient = winner === 0 ? 1 : 0;
  const response = await submit(
    'campaign.relationship',
    { type: 'respond', offerId: pending.id, accept: false, revision: (await board(recipient)).revision },
    recipient,
  );
  await advance();
  expect(await receipt(response, recipient)).toMatchObject({ status: 'applied', result: { accepted: false, cost: 0 } });
  const after = await snapshot();
  expect(after.state.campaign!.links).toEqual([]);
  for (const id of [ownId, targetId]) expect(after.state.generals[id]!.gold).toBe(before.state.generals[id]!.gold);
  expect(
    await db.generalTurn.findMany({
      where: { worldId, generalId: { in: [ownId, targetId] } },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    }),
  ).toEqual(reservations);
});

it('반대 방향 제안의 동시 수락은 한 관계만 만들고 순환·강제 수락을 거부한다', async () => {
  for (const [index, personId] of [targetId, ownId].entries()) {
    await submit(
      'campaign.relationship',
      { type: 'offer', targetId: personId, relation: 'STAFF', revision: (await board(index)).revision },
      index,
    );
    await advance();
  }
  const before = await snapshot(),
    pending = before.state.campaign!.offers.filter((offer) => offer.status === 'PENDING'),
    revision = before.state.campaign!.revision;
  expect(pending).toHaveLength(2);
  const responses = await Promise.all(
    [ownId, targetId].map((id, index) =>
      submit(
        'campaign.relationship',
        { type: 'respond', offerId: pending.find((offer) => offer.personId === id)!.id, accept: true, revision },
        index,
      ),
    ),
  );
  await advance();
  const results = await Promise.all(responses.map((request, index) => receipt(request, index)));
  expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({ result: expect.objectContaining({ code: 'STALE_REVISION' }) }),
  ]);
  const campaign = (await snapshot()).state.campaign!;
  expect(campaign.links).toHaveLength(1);
  const link = campaign.links[0]!,
    childIndex = link.personId === ownId ? 0 : 1;
  const cyclic = await submit(
    'campaign.relationship',
    { type: 'offer', targetId: link.masterId, relation: 'STAFF', revision: campaign.revision },
    childIndex,
  );
  await advance();
  expect(await receipt(cyclic, childIndex)).toMatchObject({ status: 'rejected', result: { code: 'RETINUE_CYCLE' } });
  expect((await snapshot()).state.campaign!.links).toEqual(campaign.links);
  await submit(
    'campaign.relationship',
    { type: 'release', personId: link.personId, revision: (await board(childIndex)).revision },
    childIndex,
  );
  await advance();
  expect((await snapshot()).state.campaign!.links).toEqual([]);
});

it('유효한 NPC 거절도 500금을 한 번 쓰고 같은 달 재시도는 금·원장을 바꾸지 않는다', async () => {
  const before = await snapshot(),
    actor = before.state.generals[targetId]!;
  const candidate = Object.values(before.state.generals).find((general) => {
    const result = applyCampaignRelationship(
      before.state,
      { type: 'offer', targetId: general.id, relation: 'LIEUTENANT', revision: before.state.campaign!.revision },
      targetId,
      before.state.campaign,
      { tick, userId: users[1]!, userActive: true },
    );
    return general.userId === null && result.ok && result.result.accepted === false;
  });
  expect(candidate).toBeDefined();
  declinedNpcId = candidate!.id;
  const payload = {
    type: 'offer',
    targetId: declinedNpcId,
    relation: 'LIEUTENANT',
    revision: before.state.campaign!.revision,
  };
  const request = await submit('campaign.relationship', payload, 1);
  await advance();
  expect(await receipt(request, 1)).toMatchObject({ status: 'applied', result: { accepted: false, cost: 500 } });
  const declined = await snapshot();
  expect(declined.state.generals[targetId]!.gold).toBe(actor.gold - 500);
  expect(declined.state.campaign!.links).toEqual(before.state.campaign!.links);
  expect(declined.state.campaign!.attempts).toContainEqual({ masterId: targetId, personId: declinedNpcId, month: 0 });
  const retry = await submit('campaign.relationship', { ...payload, revision: declined.state.campaign!.revision }, 1);
  await advance();
  expect(await receipt(retry, 1)).toMatchObject({ status: 'rejected', result: { code: 'ALREADY_ATTEMPTED' } });
  expect(hashState(await snapshot())).toBe(hashState(declined));
  expect(
    (await http('campaign.relationship', { worldId, requestId: request, payload }, cookies[1], true)).data,
  ).toMatchObject({ status: 'applied' });
  expect(hashState(await snapshot())).toBe(hashState(declined));
});

it('NPC 서약의 실제 시드·500금·월 1회와 원장 재시작을 확인한다', async () => {
  const before = await snapshot(),
    actor = before.state.generals[ownId]!;
  const candidate = Object.values(before.state.generals).find((general) => {
    if (general.userId !== null || general.officerLevel === 12 || general.cityKey !== actor.cityKey) return false;
    const outcome = applyCampaignRelationship(
      before.state,
      { type: 'offer', targetId: general.id, relation: 'LIEUTENANT', revision: before.state.campaign!.revision },
      ownId,
      before.state.campaign,
      { tick, userId: users[0]!, userActive: true },
    );
    return outcome.ok && outcome.result.accepted === true;
  });
  expect(candidate).toBeDefined();
  lieutenantId = candidate!.id;
  const payload = {
    type: 'offer',
    targetId: candidate!.id,
    relation: 'LIEUTENANT',
    revision: before.state.campaign!.revision,
  };
  const expected = applyCampaignRelationship(before.state, payload, ownId, before.state.campaign, {
    tick,
    userId: users[0]!,
    userActive: true,
  });
  if (!expected.ok) throw new Error(expected.message);
  const requestId = await submit('campaign.relationship', payload);
  await advance();
  expect(await receipt(requestId)).toMatchObject({ status: 'applied', result: expected.result });
  const reopened = createDb(url!);
  try {
    const after = await reopened.$transaction((tx) => loadReplayState(tx, worldId));
    expect(after.state.campaign).toEqual(expected.campaign);
    expect(after.state.generals[ownId]!.gold).toBe(actor.gold - 500);
    expect(after.state.generals[candidate!.id]!.crew).toBe(0);
  } finally {
    await reopened.$disconnect();
  }
});

it('후반 트랜잭션 실패는 편성과 입력 원장을 함께 롤백하며 재시도가 한 번 적용된다', async () => {
  const before = await snapshot();
  const requestId = await submit('campaign.unit', {
    type: 'form',
    commanderId: ownId,
    crewType: 1200,
    revision: before.state.campaign!.revision,
  });
  await expect(
    advance(tick, async () => {
      throw new Error('int06 late rollback');
    }),
  ).rejects.toThrow('int06 late rollback');
  expect(hashState(await snapshot())).toBe(hashState(before));
  expect(await receipt(requestId)).toMatchObject({ status: 'pending' });
  await advance();
  expect(await receipt(requestId)).toMatchObject({ status: 'applied' });
  expect((await board()).units).toHaveLength(2);
  expect((await snapshot(otherWorldId)).state.campaign!.units).toEqual([]);
  const current = await board(),
    empty = current.units.find((unit) => unit.id !== unitId)!;
  const disband = await submit('campaign.unit', { type: 'disband', unitId: empty.id, revision: current.revision });
  await advance();
  expect(await receipt(disband)).toMatchObject({ status: 'applied' });
  expect((await board()).units.map((unit) => unit.id)).toEqual([unitId]);
});

it('실제 휘하 부곡을 지정한 모병·훈련 예약과 편집이 unitId를 보존한다', async () => {
  await submit('campaign.unit', {
    type: 'command',
    unitId,
    commanderId: lieutenantId,
    revision: (await board()).revision,
  });
  await advance();
  const args = { amount: 10, crewType: 1100, unitId };
  expect((await http('turns.precheck', { worldId, commandKey: 'recruit', args })).data).toMatchObject({
    ok: true,
    preview: { goldCost: 88 },
  });
  const current = await http<{ revision: number }>('turns.get', { worldId });
  const saved = await http<{ ok: boolean; revision: number }>(
    'turns.set',
    {
      worldId,
      revision: current.data!.revision,
      slots: [{ commandKey: 'recruit', args }, ...Array.from({ length: 29 }, () => null)],
    },
    cookies[0],
    true,
  );
  expect(saved.data?.ok).toBe(true);
  expect(
    (
      await http(
        'turns.edit',
        {
          worldId,
          revision: saved.data!.revision,
          op: { put: { from: 1, to: 1, commandKey: 'train', args: { unitId } } },
        },
        cookies[0],
        true,
      )
    ).data,
  ).toMatchObject({ ok: true });
  expect(
    await db.generalTurn.findUniqueOrThrow({
      where: { worldId_generalId_slot: { worldId, generalId: ownId, slot: 0 } },
    }),
  ).toMatchObject({
    commandKey: 'recruit',
    args,
  });
  expect(
    await db.generalTurn.findUniqueOrThrow({
      where: { worldId_generalId_slot: { worldId, generalId: ownId, slot: 1 } },
    }),
  ).toMatchObject({
    commandKey: 'train',
    args: { unitId },
  });
  expect(await db.generalTurn.count({ where: { worldId, generalId: ownId } })).toBe(30);
  expect(
    (await http('turns.precheck', { worldId, commandKey: 'recruit', args: { ...args, unitId: 2147483646 } })).data,
  ).toMatchObject({ ok: false, code: 'BAD_TARGET' });
});

it('정식 첫 달 전반의 모든 NPC를 실제 부곡 프로필로 실행한다', async () => {
  await advance(5000);
});
it('정식 첫 달 후반의 모든 NPC와 월 정산을 실행한다', async () => {
  await advance(10000);
});
it('정식 월 경계의 부곡·입력·월 정산을 같은 시드로 재생한다', async () => {
  const archive = await exportReplay(db, worldId);
  const first = replayArchive(archive, 1);
  expect(replayArchive(archive, 1)).toEqual(first);
  expect(first).toHaveLength(1);
  expect(first[0]!.stateHash).toBe(hashState(await snapshot()));
  expect((await snapshot(otherWorldId)).state.campaign!.revision).toBe(0);
});

it('다음 게임 월에는 거절했던 NPC에게 다시 서약하고 그 달의 시드와 비용을 저장한다', async () => {
  const before = await snapshot(),
    actor = before.state.generals[targetId]!,
    payload = {
      type: 'offer',
      targetId: declinedNpcId,
      relation: 'LIEUTENANT',
      revision: before.state.campaign!.revision,
    };
  const expected = applyCampaignRelationship(before.state, payload, targetId, before.state.campaign, {
    tick: 10000,
    userId: users[1]!,
    userActive: true,
  });
  if (!expected.ok) throw new Error(`다음 달 서약 조건: ${expected.code}`);
  expect(actor.gold).toBeGreaterThanOrEqual(500);
  const request = await submit('campaign.relationship', payload, 1);
  await advance(10000);
  expect(await receipt(request, 1)).toMatchObject({ status: 'applied', result: expected.result });
  const after = await snapshot();
  expect(after.state.generals[targetId]!.gold).toBe(actor.gold - 500);
  expect(after.state.campaign).toEqual(expected.campaign);
  expect(after.state.campaign!.attempts).toContainEqual({ masterId: targetId, personId: declinedNpcId, month: 1 });
  expect(after.state.campaign!.attempts).not.toContainEqual({ masterId: targetId, personId: declinedNpcId, month: 0 });
});

it('예약한 실제 부장 부곡에만 모병하고 훈련 미리보기는 그 지휘관의 상승량을 쓴다', async () => {
  const before = await snapshot(),
    actor = before.state.generals[ownId]!;
  await advance(actor.nextTurnTick);
  const after = await snapshot(),
    unit = after.state.campaign!.units.find((unit) => unit.id === unitId)!;
  expect(unit).toMatchObject({ commanderId: lieutenantId, troops: 10, train: 0, atmos: 0 });
  expect(after.state.generals[ownId]!.gold).toBe(actor.gold - 88);
  expect(after.state.generals[ownId]!.crew).toBe(0);
  expect(after.state.generals[lieutenantId]!.crew).toBe(0);
  const city = await http<inferRouterOutputs<AppRouter>['city']['get']>('city.get', {
    worldId,
    cityKey: after.state.generals[lieutenantId]!.cityKey,
  });
  expect(city.code).toBeUndefined();
  expect(city.data).toMatchObject({ campaignEnabled: true, fiveStats: true });
  expect(city.data!.generals.find((general) => general.id === lieutenantId)).toMatchObject({
    crew: 0,
    politics: after.state.generals[lieutenantId]!.politics,
    charm: after.state.generals[lieutenantId]!.charm,
    commandedArmy: { troops: 10, train: 0, atmos: 0 },
  });
  expect(city.data!.generals.find((general) => general.id === ownId)).toMatchObject({
    commandedArmy: { troops: 0, train: 0, atmos: 0 },
  });
  const stranger = await http<inferRouterOutputs<AppRouter>['city']['get']>(
    'city.get',
    {
      worldId,
      cityKey: after.state.generals[lieutenantId]!.cityKey,
    },
    cookies[2],
  );
  const masked = stranger.data!.generals.find((general) => general.id === lieutenantId)!;
  expect(masked).toEqual({
    id: lieutenantId,
    name: after.state.generals[lieutenantId]!.name,
    nationId: after.state.generals[lieutenantId]!.nationId,
  });
  const nationId = after.state.generals[lieutenantId]!.nationId!;
  const otherBefore = hashState(await snapshot(otherWorldId));
  const nation = await http<inferRouterOutputs<AppRouter>['nation']['get']>('nation.get', { worldId, nationId });
  expect(nation.code).toBeUndefined();
  expect(nation.data).toMatchObject({ campaignEnabled: true, fiveStats: true });
  expect(nation.data!.generals.find((general) => general.id === lieutenantId)).toMatchObject({
    crew: 0,
    politics: after.state.generals[lieutenantId]!.politics,
    charm: after.state.generals[lieutenantId]!.charm,
    commandedArmy: { troops: 10, train: 0, atmos: 0 },
  });
  expect(nation.data!.generals.find((general) => general.id === ownId)).toMatchObject({
    commandedArmy: { troops: 0, train: 0, atmos: 0 },
  });
  const hiddenNation = await http<inferRouterOutputs<AppRouter>['nation']['get']>(
    'nation.get',
    { worldId, nationId },
    cookies[2],
  );
  expect(hiddenNation.data!.generals.find((general) => general.id === lieutenantId)).toEqual(masked);
  const isolatedNation = await http<inferRouterOutputs<AppRouter>['nation']['get']>('nation.get', {
    worldId: otherWorldId,
    nationId,
  });
  expect(
    isolatedNation.data!.generals.every((general) => Object.keys(general).sort().join(',') === 'id,name,nationId'),
  ).toBe(true);
  expect((await http('nation.get', { worldId, nationId }, '')).code).toBe('UNAUTHORIZED');
  expect((await http('nation.get', { worldId, nationId, userId: users[0] })).code).toBe('BAD_REQUEST');
  expect(hashState(await snapshot())).toBe(hashState(after));
  expect(hashState(await snapshot(otherWorldId))).toBe(otherBefore);
  expect((await http('turns.precheck', { worldId, commandKey: 'train', args: { unitId } })).data).toMatchObject({
    ok: true,
    preview: { goldCost: 100, gain: 8 + Math.floor(after.state.generals[lieutenantId]!.leadership / 25) },
  });
  const forbidden = await submit('campaign.unit', {
    type: 'disband',
    unitId,
    revision: after.state.campaign!.revision,
  });
  await advance(actor.nextTurnTick);
  expect(await receipt(forbidden)).toMatchObject({ status: 'rejected', result: { code: 'TROOPS_PRESENT' } });
  expect((await snapshot()).state.campaign!.units.find((row) => row.id === unitId)).toEqual(unit);
});
