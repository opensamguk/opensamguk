import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { inferRouterOutputs } from '@trpc/server';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, type LogisticsConfig } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';

// 조회 계약의 실제 PG·HTTP 검사다. 소속·기술은 통제한 고정물이며 게임 진행·재생의 증거는 아니다.
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url),
  now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
const worlds: string[] = [],
  users: string[] = [],
  cookies: string[] = [];
const routes = ['campaign.get', 'cityResources.get', 'logistics.get', 'resources.worldRules'] as const;
type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'campaign.get': Out['campaign']['get'];
  'cityResources.get': Out['cityResources']['get'];
  'logistics.get': Out['logistics']['get'];
  'resources.worldRules': Out['resources']['worldRules'];
};
let base: string, conditioned: string, legacy: string;
async function query<R extends keyof Results>(route: R, worldId: string, player = 0, cityKey = 1, extra = {}) {
  const input = { worldId, ...(['cityResources.get', 'logistics.get'].includes(route) ? { cityKey } : {}), ...extra };
  const response = await fetch(
    `${base}/trpc/${route}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
    {
      headers: { ...(cookies[player] ? { cookie: cookies[player] } : {}) },
    },
  );
  const [body] = (await response.json()) as [{ result?: { data: Results[R] }; error?: { data: { code: string } } }];
  return { status: response.status, data: body.result?.data, error: body.error?.data.code };
}
async function fixture(conditions: boolean) {
  const initial = buildInitialWorld(operationalInput());
  if (conditions) {
    initial.unitSet.id = initial.unitSetKey = 'recruitment-contract';
    initial.unitSet.crewTypes.find((unit) => unit.id === 1100)!.requirements = [
      { kind: 'tech', min: 1000 },
      { kind: 'cities', cityKeys: [2] },
    ];
    initial.unitSet.crewTypes.find((unit) => unit.id === 1200)!.requirements = [{ kind: 'research', name: 'repeater' }];
  }
  const features = [
    ...new Set([
      ...(initial.ruleFeatures ?? []),
      'campaign-assignment-v2',
      'campaign-v1',
      'city-resources-v1',
      'logistics-v1',
      'personnel',
      'policy',
    ]),
  ].sort();
  const config: LogisticsConfig = {
    version: 1,
    specialties: [{ cityKey: 1, good: 'wood', perMonth: 100 }],
    capacity: { base: 10_000, perLevel: 1000, maxLevel: 2 },
    upgrade: { gold: 1, wood: 1 },
    transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100, maxActivePerNation: 20 },
    recruitPer100: Object.fromEntries(
      [1, 2, 3].map((arm) => [String(arm), { iron: 2, wood: 0, horses: arm === 3 ? 1 : 0 }]),
    ),
    build: { wall: { iron: 0, wood: 1, horses: 0 }, defence: { iron: 1, wood: 1, horses: 0 } },
    trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
  };
  initial.ruleFeatures = features;
  const saved = await saveInitialWorld(db, initial, {
    name: 'AC-INT-22 모집 조건 조회',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: { 'logistics-v1': config },
  });
  worlds.push(saved.worldId);
  for (let index = 0; index < 2; index++)
    await db.general.update({
      where: { worldId_id: { worldId: saved.worldId, id: index + 1 } },
      data: { userId: users[index]! },
    });
  return saved.worldId;
}
beforeAll(async () => {
  for (let index = 0; index < 3; index++) {
    const id = randomUUID(),
      session = newSession(now);
    users.push(id);
    cookies.push(`sid=${session.token}`);
    await db.user.create({
      data: {
        id,
        email: `${id}@example.invalid`,
        passwordHash: 'not-a-login-hash',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
  }
  conditioned = await fixture(true);
  legacy = await fixture(false);
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
const failure = (reason: string) => ({ code: 'BAD_STATE', message: `현재 선택할 수 없는 병종입니다. ${reason}` });
it('AC-INT-22 네 조회는 성벽을 뺀 같은 ID별 첫 조건 사유를 내리고 기존 목록을 유지한다', async () => {
  for (const route of routes) {
    const result = await query(route, conditioned);
    expect(result.status, route).toBe(200);
    expect(result.data).toHaveProperty('recruitment', {
      tick: 0,
      byCrewType: {
        '1100': failure('기술 1000이 필요합니다.'),
        '1200': failure('원융노병 연구가 필요합니다.'),
        '1300': null,
      },
    });
    const list =
      route === 'resources.worldRules'
        ? result.data && 'unitSet' in result.data && result.data.unitSet.crewTypes
        : result.data &&
          ('armyTypes' in result.data
            ? result.data.armyTypes
            : 'recruitUnits' in result.data
              ? result.data.recruitUnits
              : []);
    expect(list && list.map((unit) => unit.id)).toEqual(
      route === 'resources.worldRules' ? [1000, 1100, 1200, 1300] : [1100, 1200, 1300],
    );
  }
});
it('AC-INT-22 세션 장수의 국가 기술·소유 도시를 쓰고 다른 국가의 통과 결과를 섞지 않는다', async () => {
  await db.nation.update({ where: { worldId_id: { worldId: conditioned, id: 2 } }, data: { tech: 1000 } });
  for (const route of routes) {
    expect((await query(route, conditioned, 1, 2)).data).toHaveProperty('recruitment.byCrewType.1100', null);
    expect((await query(route, conditioned)).data).toHaveProperty(
      'recruitment.byCrewType.1100',
      failure('기술 1000이 필요합니다.'),
    );
  }
});
it('AC-INT-22 사유를 추가해도 다른 도시 재고의 가시성을 넓히지 않는다', async () => {
  for (const route of ['cityResources.get', 'logistics.get'] as const) {
    const result = await query(route, conditioned, 0, 2);
    expect(result.data).toMatchObject({ visible: false });
    expect(result.data).not.toHaveProperty('recruitment');
    expect(result.data).not.toHaveProperty('resources');
  }
});
it('AC-INT-22 장수 없는 관람자의 공통 규칙은 그대로 읽고 개인 모집 사유는 생략한다', async () => {
  const result = await query('resources.worldRules', conditioned, 2);
  expect(result.status).toBe(200);
  expect(result.data).toHaveProperty('unitSet');
  expect(result.data).not.toHaveProperty('recruitment');
  for (const route of routes.filter((route) => route !== 'resources.worldRules'))
    expect((await query(route, conditioned, 2)).error).toBe('NOT_FOUND');
});
it('AC-INT-22 조건 없는 기존 판에는 선택 키를 추가하지 않는다', async () => {
  for (const route of routes) {
    const result = await query(route, legacy);
    expect(result.status).toBe(200);
    expect(result.data).not.toHaveProperty('recruitment');
  }
});
it('AC-INT-22 인증과 행위자 주입 방지 입력 검사를 유지한다', async () => {
  for (const route of routes) {
    expect((await query(route, conditioned, 99)).error).toBe('UNAUTHORIZED');
    expect((await query(route, conditioned, 0, 1, { generalId: 2 })).error).toBe('BAD_REQUEST');
  }
});
it('AC-INT-22 조회는 입력 사건·자원·병종 정본을 바꾸지 않는다', async () => {
  const before = await db.world.findUniqueOrThrow({ where: { id: conditioned } });
  const events = await db.inputEvent.count({ where: { worldId: conditioned } });
  for (const route of routes) await query(route, conditioned);
  expect(await db.world.findUniqueOrThrow({ where: { id: conditioned } })).toEqual(before);
  expect(await db.inputEvent.count({ where: { worldId: conditioned } })).toBe(events);
});
