import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb, type Prisma } from '../packages/db/src/index';
import { buildInitialWorld, statRulesSchema, unitSetSchema } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('전용 규칙 조회 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url),
  now = Date.now(),
  app = await buildServer({ db, now: () => now, logging: false });
const worlds: string[] = [],
  users: string[] = [],
  cookies: string[] = [];
let base: string, primary: string, other: string, five: string;

async function query(input: unknown, cookie: string | undefined = cookies[0]) {
  const response = await fetch(
    `${base}/trpc/resources.worldRules?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    {
      headers: cookie ? { cookie } : {},
    },
  );
  type Envelope = {
    result?: { data: inferRouterOutputs<AppRouter>['resources']['worldRules'] };
    error?: { message: string; data: { code: string } };
  };
  const text = await response.text(),
    payload = JSON.parse(text) as Envelope | Envelope[];
  return { status: response.status, body: Array.isArray(payload) ? payload[0]! : payload, text };
}

async function save(initial: ReturnType<typeof commandInitial>) {
  initial.ruleFeatures = [...new Set([...(initial.ruleFeatures ?? []), 'personnel', 'policy'])].sort();
  const saved = await saveInitialWorld(db, initial, {
    name: 'T4-85 규칙 조회',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: initial.ruleFeatures,
  });
  worlds.push(saved.worldId);
  return saved.worldId;
}

beforeAll(async () => {
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(),
      session = newSession(now);
    users.push(id);
    await db.user.create({
      data: {
        id,
        email: `${id}@example.invalid`,
        passwordHash: 'not-a-login-hash',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    cookies.push(`sid=${session.token}`);
  }
  const first = commandInitial(),
    second = commandInitial();
  first.seed = 't485-private-seed-primary';
  second.seed = 't485-private-seed-other';
  second.unitSet.id = second.unitSetKey = 't485-probe';
  second.unitSet.crewTypes[1]!.attack += 7;
  second.unitSet.crewTypes[1]!.name = '규칙 조회 고정물';
  second.statRules = { total: 180, min: 5, max: 100 };
  primary = await save(first);
  other = await save(second);
  five = await save(buildInitialWorld(operationalInput()));
  await db.general.update({
    where: { worldId_id: { worldId: primary, id: 1 } },
    data: { userId: users[0]!, lastActiveTick: 0 },
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app.close();
    await db.world.deleteMany({ where: { id: { in: worlds } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  } finally {
    await db.$disconnect();
  }
});

it('AC-P2-26 월드별 저장 규칙과 같고 비공개 메타데이터를 응답하지 않는다', async () => {
  for (const id of [primary, other, five]) {
    const stored = await db.world.findUniqueOrThrow({ where: { id } }),
      result = await query({ worldId: id });
    expect(result.status).toBe(200);
    expect(result.body.result?.data).toEqual({
      unitSetKey: stored.unitSetKey,
      unitSet: unitSetSchema.parse(stored.unitSet),
      statRules: { ...statRulesSchema.parse({ stat: stored.statRules }).stat, count: id === five ? 5 : 3 },
    });
    expect(Object.keys(result.body.result!.data).sort()).toEqual(['statRules', 'unitSet', 'unitSetKey']);
    expect(result.text).not.toContain(stored.seed);
    expect(result.body.result!.data.statRules).not.toHaveProperty('heritage');
  }
  expect((await query({ worldId: primary })).body.result?.data).not.toEqual(
    (await query({ worldId: other })).body.result?.data,
  );
});

it('AC-P2-26 장수 없는 다른 계정도 같은 공통 규칙을 읽는다', async () => {
  expect(await db.general.count({ where: { userId: users[1]! } })).toBe(0);
  expect((await query({ worldId: primary }, cookies[1])).body).toEqual((await query({ worldId: primary })).body);
});

it.each(['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED'] as const)(
  'AC-P2-26 %s 상태에서도 저장 규칙은 같다',
  async (status) => {
    const before = await query({ worldId: primary });
    await db.world.update({ where: { id: primary }, data: { status } });
    expect((await query({ worldId: primary })).body).toEqual(before.body);
  },
);

it('AC-P2-26 인증·존재·strict 입력을 검사한다', async () => {
  expect((await query({ worldId: primary }, '')).body.error?.data.code).toBe('UNAUTHORIZED');
  expect((await query({ worldId: randomUUID() })).body.error?.data.code).toBe('NOT_FOUND');
  for (const input of [
    {},
    { worldId: 'bad-id' },
    { worldId: primary, generalId: 1 },
    { worldId: primary, userId: users[1] },
  ])
    expect((await query(input)).body.error?.data.code).toBe('BAD_REQUEST');
});

it.each(['unitSet', 'statRules'] as const)('AC-P2-26 잘못 저장된 %s의 내부 검사 내용은 숨긴다', async (field) => {
  const privateMarker = 't485-invalid-private-value';
  const stored = await db.world.create({
    data: {
      name: '잘못된 저장값 고정물',
      scenarioKey: 't485',
      mapKey: 't485',
      unitSetKey: 'basic',
      seed: privateMarker,
      startYear: 191,
      turnTermMinutes: 60,
      initialStateHash: 'a'.repeat(64),
      unitSet: (field === 'unitSet' ? { hidden: privateMarker } : commandInitial().unitSet) as Prisma.InputJsonValue,
      statRules: field === 'statRules' ? { hidden: privateMarker } : commandInitial().statRules,
    },
  });
  worlds.push(stored.id);
  const result = await query({ worldId: stored.id });
  expect(result.status).toBe(500);
  expect(result.body.error?.data.code).toBe('INTERNAL_SERVER_ERROR');
  expect(result.body.error?.message).toBe('요청을 처리하지 못했습니다.');
  expect(result.text).not.toContain(privateMarker);
  expect(result.text).not.toContain('stack');
});
