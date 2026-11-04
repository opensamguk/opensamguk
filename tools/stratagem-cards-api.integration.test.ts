import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { TEST_STRATAGEM_CARDS_CONFIG } from '../packages/rules/src/stratagemCards/testFixture';
import { buildCreatedGeneral, type StratagemCardsConfig } from '../packages/rules/src/index';
import { FIVE_STAT_RULES } from '../packages/rules/src/general/fiveStats';
import { operationalFixture } from '../packages/rules/test/operationalMapFixture';
import { governanceTestConfig } from '../packages/rules/src/governance/testFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { AppRouter } from '../apps/server/src/router';
import { initializeIntegrationResources } from './integration-resources';
import { testDatabaseUrl } from './test-database';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { cardProcessProbe } from './stratagem-cards-crash-probe';
import { persistStratagemCardsState } from '../apps/engine/src/stratagemCards/state';

// AC-P2-23·35: 명시 시험 config·4명 NPC를 고정한 실제 HTTP/PG/엔진 검증이다.
// 공개 기본값·국가 전략 3종·491명 원본 차례·화면의 완료 증거가 아니다.
if (!process.env.TEST_DATABASE_URL) throw Error('전용 계략 패 테스트 DB가 필요합니다.');
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url.href),
  worldIds: string[] = [],
  userIds: string[] = [],
  now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let base: string;
type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'general.create': Out['general']['create'];
  'turns.set': Out['turns']['set'];
  'nationTurns.get': Out['nationTurns']['get'];
  'nationTurns.set': Out['nationTurns']['set'];
  'admin.world.requestReset': Out['admin']['world']['requestReset'];
  'admin.world.resetRequest': Out['admin']['world']['resetRequest'];
  'stratagemCards.mine': Out['stratagemCards']['mine'];
  'stratagemCards.setTrap': Out['stratagemCards']['setTrap'];
  'stratagemCards.request': Out['stratagemCards']['request'];
};
type User = { id: string; cookie: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, user?: User) {
  const mutation = [
      'general.create',
      'turns.set',
      'nationTurns.set',
      'stratagemCards.setTrap',
      'admin.world.requestReset',
    ].includes(route),
    encoded = JSON.stringify(input);
  const response = await fetch(`${base}/trpc/${route}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(user ? { cookie: user.cookie } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body: encoded } : {}),
  });
  type Envelope = { result?: { data: Results[R] }; error?: { data: { code: string }; message: string } };
  const payload = (await response.json()) as Envelope | Envelope[],
    body = Array.isArray(payload) ? payload[0]! : payload;
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(id: string = randomUUID()): Promise<User> {
  userIds.push(id);
  await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'not-a-login-hash' } });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}
async function advance(id: string, tick: number, fail = false) {
  const lease = await acquireLease(db, id, randomUUID(), 120000);
  if (!lease) throw Error('계략 패 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('card-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (id: string) => db.$transaction((tx) => loadReplayState(tx, id));
async function replay(id: string) {
  const current = await db.world.findUniqueOrThrow({ where: { id } });
  await advance(id, current.monthlyTick + 10_000);
  const archive = await exportReplay(db, id);
  const hashes = replayArchive(archive, archive.months.length).map((row) => row.stateHash);
  expect(hashes).toEqual(archive.months.map((row) => row.stateHash));
  expect(hashes.at(-1)).toBe(hashState(await snapshot(id)));
}
async function fixture(
  kind: StratagemCardsConfig['deck'][number]['kind'] = 'trap',
  enabled = true,
  options: {
    trapLossBp?: number;
    trapExpiryMonths?: number;
    secondNeutral?: boolean;
    campaign?: boolean;
    governance?: boolean;
    emptyDefence?: boolean;
  } = {},
) {
  const initial = commandInitial(),
    seed = `cards-pg-${randomUUID()}`;
  initial.seed = seed;
  initial.statRules = { ...FIVE_STAT_RULES };
  for (const general of initial.generals)
    Object.assign(general, { politics: 55, charm: 55, nextTurnTick: 1_000_000_000 });
  if (options.secondNeutral)
    Object.assign(initial.cities[3]!, { nationId: null, wall: 0, wallMax: 0, defence: 0, defenceMax: 0 });
  if (options.emptyDefence) Object.assign(initial.cities[2]!, { wall: 0, wallMax: 0, defence: 0, defenceMax: 0 });
  const campaign = options.campaign || options.governance;
  if (campaign) {
    for (const general of initial.generals) general.crew = 0;
    for (const city of initial.cities) city.kind = 'CITY';
    const map = operationalFixture(),
      template = map.sites.find((site) => site.kind === 'CITY')!;
    if (template.kind !== 'CITY') throw Error('도시 고정물이 없습니다.');
    map.id = initial.mapKey;
    map.sites = initial.cities.map((city) => ({
      ...template,
      id: `city:${city.cityKey}`,
      name: city.name,
      anchorKey: city.cityKey,
      legacyCityId: city.cityKey,
      position: { x: city.x, y: city.y },
      initial: {
        population: city.population,
        agriculture: city.agriculture,
        commerce: city.commerce,
        security: city.security,
        defence: city.defence,
        wall: city.wall,
      },
      max: {
        population: city.populationMax,
        agriculture: city.agricultureMax,
        commerce: city.commerceMax,
        security: city.securityMax,
        defence: city.defenceMax,
        wall: city.wallMax,
      },
    }));
    map.routes = initial.cities.flatMap((city) =>
      city.connections
        .filter((to) => to > city.cityKey)
        .map((to) => ({
          id: `route:${city.cityKey}:${to}`,
          from: `city:${city.cityKey}`,
          to: `city:${to}`,
          mode: 'LAND' as const,
          direction: 'BOTH' as const,
          enabled: true,
        })),
    );
    initial.operationalMap = map;
  }
  initial.diplomacies = initial.diplomacies.map((row) => ({ ...row, state: 'NON_AGGRESSION', untilTick: 1_000_000 }));
  const payload = {
    name: '함정군주',
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
    portraitId: null,
  };
  let playerId = '';
  for (let i = 0; i < 2000; i++) {
    const candidate = randomUUID(),
      preview = buildCreatedGeneral({
        payload,
        userId: candidate,
        seed,
        id: 5,
        startYear: initial.startYear,
        tick: 0,
        monthlyTick: 0,
        cityKeys: [1, 2, 3, 4],
        unitSet: initial.unitSet,
      });
    if (preview.cityKey === 3 && preview.nextTurnTick > 2 && preview.nextTurnTick < 10_000) {
      playerId = candidate;
      break;
    }
  }
  if (!playerId) throw Error('중립 도시에서 건국할 생성 시드가 없습니다.');
  const config = {
    ...TEST_STRATAGEM_CARDS_CONFIG,
    trap: {
      ...TEST_STRATAGEM_CARDS_CONFIG.trap,
      lossBp: options.trapLossBp ?? TEST_STRATAGEM_CARDS_CONFIG.trap.lossBp,
    },
    deck: [{ kind, weight: 1 }],
    ...(options.trapExpiryMonths !== undefined ? { trapExpiryMonths: options.trapExpiryMonths } : {}),
  };
  const saved = await saveInitialWorld(db, initial, {
    name: '계략 패 실제 처리 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [
      'five-stats',
      'personnel',
      'policy',
      'stratagem-basic',
      ...(enabled ? ['stratagem-cards-v1'] : []),
      ...(campaign ? ['operational-map', 'campaign-v1'] : []),
      ...(options.governance ? ['campaign-assignment-v2', 'city-resources-v1', 'governance-v1', 'treaty'] : []),
    ].sort(),
    featureData: {
      ...(enabled ? { 'stratagem-cards-v1': { version: 1, config } } : {}),
      ...(options.governance ? { 'governance-v1': governanceTestConfig } : {}),
    },
  });
  const id = saved.worldId;
  worldIds.push(id);
  const player = await user(playerId);
  await controlClock(db, id, 'start');
  const creating = rpc('general.create', { worldId: id, ...payload }, player);
  try {
    const deadline = performance.now() + 5000;
    while (!(await db.inputEvent.findFirst({ where: { worldId: id, kind: 'general.create', status: 'PENDING' } }))) {
      if (performance.now() >= deadline) throw Error(`사람 생성 접수가 없습니다: ${(await creating).status}`);
      await delay(10);
    }
    await advance(id, 0);
    const result = await creating;
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data?.status).toBe('created');
  } finally {
    await creating;
  }
  let actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: id, userId: player.id } } });
  const edited = await rpc(
    'turns.set',
    {
      worldId: id,
      revision: actor.turnRevision,
      slots: Array.from({ length: 30 }, (_, slot) =>
        slot === 0 ? { commandKey: 'found', args: { name: '카드국', color: '#123456' } } : null,
      ),
    },
    player,
  );
  expect(edited.status, JSON.stringify(edited.error)).toBe(200);
  await advance(id, actor.nextTurnTick);
  actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: id, id: actor.id } } });
  expect(actor.officerLevel).toBe(12);
  expect(actor.nationId).not.toBeNull();
  await advance(id, 10_000);
  return { id, player, actorId: actor.id, nationId: actor.nationId! };
}
function request(f: Awaited<ReturnType<typeof fixture>>, requestId = randomUUID()) {
  return {
    worldId: f.id,
    requestId,
    expectedUserId: f.player.id,
    expectedGeneralId: f.actorId,
    payload: { type: 'trap.set' as const, nationId: f.nationId, cityKey: 3 },
  };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  commands: Array<{ commandKey: string; args: Record<string, unknown> }>,
) {
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: f.actorId } } });
  const result = await rpc(
    'turns.set',
    { worldId: f.id, revision: actor.turnRevision, slots: Array.from({ length: 30 }, (_, i) => commands[i] ?? null) },
    f.player,
  );
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  return actor.nextTurnTick;
}
async function attacker(f: Awaited<ReturnType<typeof fixture>>) {
  const player = await user(),
    current = await db.world.findUniqueOrThrow({ where: { id: f.id } });
  const creating = rpc(
    'general.create',
    {
      worldId: f.id,
      name: '출병장수',
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
      portraitId: null,
    },
    player,
  );
  try {
    const deadline = performance.now() + 5000;
    while (
      !(await db.inputEvent.findFirst({
        where: { worldId: f.id, userId: player.id, kind: 'general.create', status: 'PENDING' },
      }))
    ) {
      if (performance.now() >= deadline) throw Error(`출병 장수 생성 접수가 없습니다: ${(await creating).status}`);
      await delay(10);
    }
    await advance(f.id, current.clockTick);
    expect((await creating).status).toBe(200);
  } finally {
    await creating;
  }
  let general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: f.id, userId: player.id } } });
  const joined = { ...f, player, actorId: general.id, nationId: 2 };
  await advance(f.id, await reserve(joined, [{ commandKey: 'join', args: { nationId: 2 } }]));
  general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: general.id } } });
  expect(general.nationId).toBe(2);
  expect(general.cityKey).toBe(2);
  return joined;
}
async function declare(f: Awaited<ReturnType<typeof fixture>>) {
  const tabs = await rpc('nationTurns.get', { worldId: f.id }, f.player),
    tab = tabs.data?.tabs.find((row) => row.officerLevel === 12);
  if (!tab || !tab.edit.ok) throw Error(`군주 예턴을 편집할 수 없습니다: ${JSON.stringify(tabs.error)}`);
  const result = await rpc(
    'nationTurns.set',
    {
      worldId: f.id,
      office: tab.office,
      revision: tab.revision,
      slots: Array.from({ length: 12 }, (_, slot) =>
        slot === 0 ? { commandKey: 'nation_declare', args: { nationId: 2 } } : null,
      ),
    },
    f.player,
  );
  expect(result.status, JSON.stringify(result.error)).toBe(200);
}
beforeAll(async () => {
  await initializeIntegrationResources(db);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app.close();
    await db.sanction.deleteMany({ where: { worldId: { in: worldIds } } });
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});

for (const route of ['stratagemCards.mine', 'stratagemCards.setTrap', 'stratagemCards.request'] as const)
  for (const category of categories)
    it(
      `${route} ${category}`,
      authzCase(route, category, async () => {
        const f = await fixture(),
          stranger = await user(),
          input = request(f);
        expect((await rpc('stratagemCards.setTrap', input, f.player)).status).toBe(200);
        const before = hashState(await snapshot(f.id)),
          count = await db.inputEvent.count({ where: { worldId: f.id } });
        const caller = category === 'unauthenticated' ? undefined : category === 'otherUser' ? stranger : f.player;
        const sanction =
          category === 'sanctioned'
            ? await db.sanction.create({
                data: { userId: f.player.id, worldId: f.id, createdBy: f.player.id, reason: '계략 패 권한 검증' },
              })
            : null;
        try {
          const value =
            category === 'invalidInput'
              ? { worldId: f.id, unknown: true }
              : route === 'stratagemCards.mine'
                ? { worldId: f.id }
                : route === 'stratagemCards.request'
                  ? { worldId: f.id, requestId: input.requestId }
                  : { ...input, expectedUserId: caller?.id ?? f.player.id };
          const result = await rpc(route, value, caller);
          const expected =
            category === 'unauthenticated'
              ? 401
              : category === 'invalidInput'
                ? 400
                : category === 'otherUser' && route !== 'stratagemCards.mine'
                  ? 404
                  : category === 'sanctioned' && route === 'stratagemCards.setTrap'
                    ? 403
                    : 200;
          expect(result.status, `${route} ${category}: ${JSON.stringify(result.error)}`).toBe(expected);
          if (route === 'stratagemCards.mine' && result.status === 200) {
            const board = result.data as Out['stratagemCards']['mine'];
            expect(board.userId).toBe(caller!.id);
            if (category === 'otherUser') {
              expect(board.mine).toBeNull();
              expect(board.hand).toEqual([]);
              expect(board.traps).toEqual([]);
            } else {
              expect(board.mine?.nationId).toBe(f.nationId);
              expect(board.hand).toEqual(['trap']);
            }
            if (category === 'sanctioned') expect(board.canSubmit).toBe(false);
            const text = JSON.stringify(board);
            expect(text).not.toContain((await snapshot(f.id)).state.stratagemCards!.seed);
            expect(text).not.toContain('"nations"');
          }
          expect(hashState(await snapshot(f.id))).toBe(before);
          expect(await db.inputEvent.count({ where: { worldId: f.id } })).toBe(count);
        } finally {
          if (sanction) await db.sanction.delete({ where: { id: sanction.id } });
        }
      }),
      60000,
    );

it('AC-P2-23 접수는 패를 바꾸지 않고 동일 UUID는 소비·활동을 중복시키지 않는다', async () => {
  const f = await fixture(),
    input = request(f),
    beforeState = await snapshot(f.id),
    before = hashState(beforeState);
  expect((await rpc('stratagemCards.setTrap', input, f.player)).data).toMatchObject({ status: 'pending' });
  expect(hashState(await snapshot(f.id))).toBe(before);
  expect((await rpc('stratagemCards.setTrap', input, f.player)).data).toMatchObject({ status: 'pending' });
  expect(
    (await rpc('stratagemCards.setTrap', { ...input, payload: { ...input.payload, cityKey: 2 } }, f.player)).status,
  ).toBe(409);
  await advance(f.id, 10_000);
  const result = await rpc('stratagemCards.request', { worldId: f.id, requestId: input.requestId }, f.player);
  expect(result.data).toMatchObject({ status: 'applied', result: { action: 'trap.set', tick: 10_000 } });
  const after = await snapshot(f.id),
    cards = after.state.stratagemCards!;
  expect(cards.nations[f.nationId]).toEqual({ hand: [], traps: [{ cityKey: 3, setTick: 10_000 }] });
  expect(after.state.generals[f.actorId]!.nextTurnTick).toBe(beforeState.state.generals[f.actorId]!.nextTurnTick);
  expect(after.turns[f.actorId]).toEqual(beforeState.turns[f.actorId]);
  expect((await rpc('stratagemCards.setTrap', input, f.player)).data).toMatchObject({ status: 'applied' });
  expect(await db.inputEvent.count({ where: { worldId: f.id, kind: 'stratagem-cards.act' } })).toBe(1);
  await replay(f.id);
});

it('AC-P2-23 같은 월 동시 설치는 실행 순서대로 한 번만 적용하고 실패 입력도 재생한다', async () => {
  const f = await fixture(),
    first = request(f),
    second = request(f);
  expect((await rpc('stratagemCards.setTrap', first, f.player)).status).toBe(200);
  expect((await rpc('stratagemCards.setTrap', second, f.player)).status).toBe(200);
  await advance(f.id, 10_000);
  expect(
    (await rpc('stratagemCards.request', { worldId: f.id, requestId: first.requestId }, f.player)).data?.status,
  ).toBe('applied');
  expect(
    (await rpc('stratagemCards.request', { worldId: f.id, requestId: second.requestId }, f.player)).data,
  ).toMatchObject({ status: 'rejected', result: { code: 'NO_TRAP_CARD' } });
  expect((await snapshot(f.id)).state.stratagemCards!.nations[f.nationId]!.traps).toHaveLength(1);
  await replay(f.id);
});

it('AC-P2-23 커밋 직전 예외는 패·함정·입력·해시를 함께 되돌리고 재시도한다', async () => {
  const f = await fixture(),
    input = request(f);
  await rpc('stratagemCards.setTrap', input, f.player);
  const before = hashState(await snapshot(f.id));
  await expect(advance(f.id, 10_000, true)).rejects.toThrow('card-save-failure');
  expect(hashState(await snapshot(f.id))).toBe(before);
  expect(
    (await rpc('stratagemCards.request', { worldId: f.id, requestId: input.requestId }, f.player)).data?.status,
  ).toBe('pending');
  await advance(f.id, 10_000);
  expect(
    (await rpc('stratagemCards.request', { worldId: f.id, requestId: input.requestId }, f.player)).data?.status,
  ).toBe('applied');
  await replay(f.id);
});

it('AC-P2-23 월 보충은 설치 함정을 포함한 3장 상한을 지키며 전체 해시가 같다', async () => {
  const f = await fixture();
  await rpc('stratagemCards.setTrap', request(f), f.player);
  await advance(f.id, 10_000);
  await advance(f.id, 50_000);
  const cards = (await snapshot(f.id)).state.stratagemCards!;
  expect(cards.monthlyTick).toBe(50_000);
  expect(cards.nations[f.nationId]!.hand).toEqual(['trap', 'trap']);
  expect(cards.nations[f.nationId]!.traps).toEqual([{ cityKey: 3, setTick: 10_000 }]);
  await replay(f.id);
});

it('AC-P2-23 끈 월드는 SQL NULL·비활성 DTO·기존 재생을 유지한다', async () => {
  const f = await fixture('trap', false);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.id } })).stratagemCardsState).toBeNull();
  expect(Object.hasOwn((await snapshot(f.id)).state, 'stratagemCards')).toBe(false);
  expect((await rpc('stratagemCards.mine', { worldId: f.id }, f.player)).data).toMatchObject({
    enabled: false,
    hand: [],
    traps: [],
    canSubmit: false,
  });
  expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(412);
  await replay(f.id);
});

it('AC-P2-23 저장 시드 변조는 조회·내보내기에서 거부하고 원 상태로 복구한다', async () => {
  const f = await fixture(),
    before = await snapshot(f.id),
    cards = before.state.stratagemCards!;
  try {
    await db.world.update({
      where: { id: f.id },
      data: { stratagemCardsState: { ...cards, seed: 'tampered-seed' } as Prisma.InputJsonValue },
    });
    await expect(snapshot(f.id)).rejects.toThrow('시드');
    await expect(exportReplay(db, f.id)).rejects.toThrow('시드');
    expect((await rpc('stratagemCards.mine', { worldId: f.id }, f.player)).status).toBe(500);
  } finally {
    await db.world.update({ where: { id: f.id }, data: { stratagemCardsState: cards as Prisma.InputJsonValue } });
  }
  expect(hashState(await snapshot(f.id))).toBe(hashState(before));
});

it('AC-P2-23 SQL과 저장 어댑터는 비활성·누락·설정·시드·시각·revision 역행을 거부한다', async () => {
  const f = await fixture(),
    before = await snapshot(f.id);
  await expect(db.$executeRaw`UPDATE "World" SET "stratagemCardsState"=NULL WHERE id=${f.id}`).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "World" SET "stratagemCardsState"='null'::jsonb WHERE id=${f.id}`,
  ).rejects.toThrow();
  await expect(db.$executeRaw`UPDATE "World" SET "stratagemCardsState"='[]'::jsonb WHERE id=${f.id}`).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "World" SET "ruleFeatures"=array_remove("ruleFeatures",'stratagem-cards-v1') WHERE id=${f.id}`,
  ).rejects.toThrow();
  for (const part of ['missing', 'feature', 'config', 'seed', 'tick', 'revision']) {
    const next = structuredClone(before.state);
    if (part === 'missing') delete next.stratagemCards;
    if (part === 'feature') next.ruleFeatures = next.ruleFeatures!.filter((key) => key !== 'stratagem-cards-v1');
    if (part === 'config') next.stratagemCards!.config.trap.lossBp++;
    if (part === 'seed') next.stratagemCards!.seed += '-changed';
    if (part === 'tick') next.stratagemCards!.monthlyTick += 10_000;
    if (part === 'revision') next.stratagemCards!.revision = 0;
    await expect(db.$transaction((tx) => persistStratagemCardsState(tx, f.id, before.state, next))).rejects.toThrow();
  }
  expect(hashState(await snapshot(f.id))).toBe(hashState(before));
});

it('AC-P2-23 게시491명의 실제 관리자 초기화는 설정과 새 카드 상태를 복원한다', async () => {
  const initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: `cards-reset-${randomUUID()}`,
  });
  initial.ruleFeatures = [
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
    'stratagem-basic',
    'stratagem-cards-v1',
  ];
  const config = { ...TEST_STRATAGEM_CARDS_CONFIG, startHand: 1, deck: [{ kind: 'trap' as const, weight: 1 }] };
  const saved = await saveInitialWorld(db, initial, {
    name: '계략 패 초기화 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: ['five-stats', 'operational-map', 'personnel', 'policy', 'stratagem-basic', 'stratagem-cards-v1'],
    featureData: { 'stratagem-cards-v1': { version: 1, config } },
  });
  worldIds.push(saved.worldId);
  const f = { id: saved.worldId, player: await user() };
  await controlClock(db, f.id, 'start');
  await db.inputEvent.create({
    data: {
      worldId: f.id,
      userId: f.player.id,
      generalId: null,
      kind: 'general.create',
      idempotencyKey: `general.create:${randomUUID()}`,
      payload: {
        name: '초기화장수',
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
        portraitId: null,
      },
    },
  });
  await advance(f.id, 0);
  expect(await db.general.count({ where: { worldId: f.id } })).toBe(492);
  const original = (await snapshot(f.id)).state.stratagemCards!;
  await controlClock(db, f.id, 'pause');
  await db.user.update({ where: { id: f.player.id }, data: { role: 'ADMIN' } });
  const current = await db.world.findUniqueOrThrow({ where: { id: f.id } }),
    binding = { worldId: f.id, expectedUserId: f.player.id, idempotencyKey: randomUUID() };
  const admitted = await rpc(
    'admin.world.requestReset',
    {
      ...binding,
      confirmName: current.name,
      expectedRevision: current.clockRevision,
      reason: '계략 패 원 설정 보존 검증',
    },
    f.player,
  );
  expect(admitted.status, JSON.stringify(admitted.error)).toBe(200);
  expect(admitted.data?.status).toBe('PENDING');
  await advance(f.id, current.clockTick);
  const receipt = await rpc('admin.world.resetRequest', binding, f.player);
  expect(receipt.data?.status, JSON.stringify(receipt.error ?? receipt.data)).toBe('APPLIED');
  const newId = receipt.data!.plannedNewWorldId;
  worldIds.push(newId);
  const reset = await snapshot(newId);
  expect(reset.state.stratagemCards!.config).toEqual(original.config);
  expect(reset.state.stratagemCards!.monthlyTick).toBe(0);
  expect(reset.state.stratagemCards!.revision).toBe(0);
  expect(
    Object.values(reset.state.stratagemCards!.nations).every(
      (cards) => cards.hand.length === 1 && cards.hand[0] === 'trap' && cards.traps.length === 0,
    ),
  ).toBe(true);
  expect(reset.state.stratagemCards!.seed).not.toBe(original.seed);
  expect(Object.values(reset.state.generals)).toHaveLength(491);
  expect(Object.values(reset.state.generals).every((general) => general.userId === null)).toBe(true);
  await exportReplay(db, f.id);
});

it('AC-P2-23 황실·거점 회계·휘하와 함께 새 국가·설치·월 보충을 재생한다', async () => {
  const f = await fixture('trap', true, { governance: true });
  expect((await rpc('stratagemCards.mine', { worldId: f.id }, f.player)).data?.canSubmit).toBe(true);
  expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
  await advance(f.id, 10_000);
  await advance(f.id, 30_000);
  expect((await snapshot(f.id)).state.stratagemCards!.nations[f.nationId]).toEqual({
    hand: ['trap', 'trap'],
    traps: [{ cityKey: 3, setTick: 10_000 }],
  });
  await replay(f.id);
});

it.each([
  { lossBp: 2000, campaign: false, survive: false },
  { lossBp: 10000, campaign: false, survive: false },
  { lossBp: 10000, campaign: true, survive: false },
  { lossBp: 2000, campaign: true, survive: false },
  { lossBp: 2000, campaign: false, survive: true },
  { lossBp: 2000, campaign: true, survive: true },
])(
  'AC-P2-23 실제 출병 loss=$lossBp campaign=$campaign survive=$survive 함정·국가 정리를 재생한다',
  async ({ lossBp, campaign, survive }) => {
    const f = await fixture('trap', true, {
      trapLossBp: lossBp,
      campaign,
      emptyDefence: true,
      secondNeutral: survive,
    });
    expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
    await advance(f.id, 10_000);
    await declare(f);
    if (survive)
      await reserve(f, [
        { commandKey: 'trade_rice', args: { amount: 500, buy: false } },
        { commandKey: 'recruit', args: { amount: 10, crewType: 1100 } },
        { commandKey: 'morale', args: {} },
        { commandKey: 'attack', args: { cityKey: 4 } },
      ]);
    else
      await reserve(f, [
        { commandKey: 'trade_rice', args: { amount: 500, buy: false } },
        { commandKey: 'recruit', args: { amount: 10, crewType: 1100 } },
        ...(campaign
          ? [
              { commandKey: 'train', args: {} },
              { commandKey: 'train', args: {} },
            ]
          : []),
        { commandKey: 'morale', args: {} },
        { commandKey: 'morale', args: {} },
      ]);
    const enemy = await attacker(f);
    const commands = [
      ...(campaign ? [{ commandKey: 'rest', args: {} }] : []),
      ...(survive
        ? [
            { commandKey: 'rest', args: {} },
            { commandKey: 'rest', args: {} },
          ]
        : []),
      { commandKey: 'trade_rice', args: { amount: 500, buy: true } },
      { commandKey: 'recruit', args: { amount: 50, crewType: 1100 } },
      ...(campaign
        ? [
            { commandKey: 'train', args: {} },
            { commandKey: 'train', args: {} },
          ]
        : []),
      { commandKey: 'morale', args: {} },
      { commandKey: 'morale', args: {} },
      ...(campaign
        ? [
            { commandKey: 'morale', args: {} },
            { commandKey: 'morale', args: {} },
          ]
        : []),
      { commandKey: 'attack', args: { cityKey: 3 } },
    ];
    const firstTick = await reserve(enemy, commands),
      attackTick = firstTick + (commands.length - 1) * 10_000;
    await advance(f.id, attackTick - 1);
    const beforeAttack = (await snapshot(f.id)).state;
    await advance(f.id, attackTick);
    const state = (await snapshot(f.id)).state,
      battles = await db.battleLog.findMany({ where: { worldId: f.id } });
    const attackLogs = await db.generalLog.findMany({
      where: { worldId: f.id, generalId: enemy.actorId, commandKey: 'attack' },
    });
    expect(
      attackLogs.some((row) => row.text.includes('함정')),
      JSON.stringify({
        logs: attackLogs.map((row) => row.text),
        actor: state.generals[enemy.actorId],
        diplomacy: state.diplomacies,
      }),
    ).toBe(true);
    expect(state.stratagemCards!.nations[f.nationId]?.traps ?? []).toEqual([]);
    if (lossBp === 10000) {
      expect(battles).toHaveLength(0);
      if (campaign) {
        expect(state.generals[enemy.actorId]!.crew).toBe(0);
        expect(
          state.campaign!.units.filter((unit) => unit.ownerId === enemy.actorId).every((unit) => unit.troops === 0),
        ).toBe(true);
      } else expect(state.generals[enemy.actorId]!.crew).toBe(0);
      expect(state.cities[3]!.nationId).toBe(f.nationId);
    } else {
      // 구판 전투는 장수 로그, 휘하 전투는 BattleLog에도 기록한다.
      expect(
        battles,
        JSON.stringify({
          beforeArmy: beforeAttack.campaign,
          beforeDefender: beforeAttack.generals[f.actorId],
          logs: (await db.generalLog.findMany({ where: { worldId: f.id, generalId: f.actorId } })).map(
            (row) => row.text,
          ),
          attack: attackLogs.map((row) => row.text),
          afterArmy: state.campaign,
        }),
      ).toHaveLength(campaign && !survive ? 1 : 0);
      expect(
        state.cities[3]!.nationId,
        JSON.stringify({
          beforeArmy: beforeAttack.campaign,
          beforeDefender: beforeAttack.generals[f.actorId],
          beforeAttacker: beforeAttack.generals[enemy.actorId],
          afterAttacker: state.generals[enemy.actorId],
          attack: attackLogs.map((row) => row.text),
          battles,
        }),
      ).toBe(2);
      if (survive) {
        expect(state.cities[4]!.nationId).toBe(f.nationId);
        expect(state.nations[f.nationId]).toBeDefined();
        expect(state.stratagemCards!.nations[f.nationId]).toBeDefined();
      } else {
        expect(state.nations[f.nationId]).toBeUndefined();
        expect(state.stratagemCards!.nations[f.nationId]).toBeUndefined();
      }
    }
    await replay(f.id);
  },
  60000,
);

it.each(['BEFORE_COMMIT', 'AFTER_COMMIT'] as const)(
  'AC-P2-23 %s 실제 SIGKILL 뒤 새 프로세스가 한 번만 복구한다',
  async (mode) => {
    const f = await fixture(),
      input = request(f);
    expect((await rpc('stratagemCards.setTrap', input, f.player)).status).toBe(200);
    const before = hashState(await snapshot(f.id)),
      crashedPid = await cardProcessProbe(f.id, mode);
    expect(
      (await rpc('stratagemCards.request', { worldId: f.id, requestId: input.requestId }, f.player)).data?.status,
    ).toBe(mode === 'BEFORE_COMMIT' ? 'pending' : 'applied');
    if (mode === 'BEFORE_COMMIT') expect(hashState(await snapshot(f.id))).toBe(before);
    await expect
      .poll(
        async () => {
          const rows = await db.$queryRaw<
            Array<{ expired: boolean }>
          >`SELECT "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "EngineLease" WHERE "worldId"=${f.id}`;
          return rows.length === 0 || rows[0]!.expired;
        },
        { timeout: 5000, interval: 50 },
      )
      .toBe(true);
    const recoveredPid = await cardProcessProbe(f.id, 'RECOVER');
    expect(recoveredPid).not.toBe(crashedPid);
    expect((await rpc('stratagemCards.setTrap', input, f.player)).data?.status).toBe('applied');
    expect((await snapshot(f.id)).state.stratagemCards!.nations[f.nationId]).toEqual({
      hand: [],
      traps: [{ cityKey: 3, setTick: 10_000 }],
    });
    expect(await db.inputEvent.count({ where: { worldId: f.id, kind: 'stratagem-cards.act' } })).toBe(1);
    console.info(`CARDS_PROCESS_CRASH ${JSON.stringify({ mode, crashedPid, recoveredPid })}`);
    await replay(f.id);
  },
  60000,
);

it.each([
  { queued: false, offset: 10000, trigger: false },
  { queued: true, offset: 10000, trigger: false },
  { queued: false, offset: 9999, trigger: true },
  { queued: true, offset: 9999, trigger: true },
])(
  'AC-P2-23 만료 경계 offset=$offset queued=$queued 출병은 행위 시각을 쓴다',
  async ({ queued, offset, trigger }) => {
    const f = await fixture('trap', true, {
      trapExpiryMonths: 1,
      trapLossBp: 10000,
      secondNeutral: true,
      emptyDefence: true,
    });
    await declare(f);
    await reserve(f, [
      { commandKey: 'trade_rice', args: { amount: 500, buy: false } },
      { commandKey: 'recruit', args: { amount: 10, crewType: 1100 } },
      { commandKey: 'morale', args: {} },
      { commandKey: 'attack', args: { cityKey: 4 } },
    ]);
    const enemy = await attacker(f);
    const commands = [
      { commandKey: 'rest', args: {} },
      { commandKey: 'rest', args: {} },
      { commandKey: 'trade_rice', args: { amount: 500, buy: true } },
      { commandKey: 'recruit', args: { amount: 50, crewType: 1100 } },
      { commandKey: 'morale', args: {} },
      { commandKey: 'morale', args: {} },
      { commandKey: 'attack', args: { cityKey: 3 } },
    ];
    const tick = (await reserve(enemy, commands)) + (commands.length - 1) * 10000;
    const setTick = tick - offset;
    await advance(f.id, setTick);
    expect((await snapshot(f.id)).state.cities[4]!.nationId).toBe(f.nationId);
    expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
    await advance(f.id, setTick);
    await advance(f.id, tick - 1);
    if (queued) {
      const input = request(f);
      input.payload.cityKey = 4;
      expect((await rpc('stratagemCards.setTrap', input, f.player)).status).toBe(200);
    } else {
      const cards = (await snapshot(f.id)).state.stratagemCards;
      expect((await db.world.findUniqueOrThrow({ where: { id: f.id } })).clockTick).toBeGreaterThan(cards!.monthlyTick);
      await reserve(f, []);
      expect((await snapshot(f.id)).state.stratagemCards).toEqual(cards);
    }
    // 현재 처리 시각은 만료 뒤지만, 밀린 출병은 예약된 자기 시각으로 판정한다.
    await advance(f.id, tick + 2);
    const state = (await snapshot(f.id)).state;
    expect(
      await db.generalLog.count({
        where: { worldId: f.id, generalId: enemy.actorId, tick, commandKey: 'attack', text: { contains: '함정' } },
      }),
    ).toBe(trigger ? 1 : 0);
    expect(state.cities[3]!.nationId).toBe(trigger ? f.nationId : 2);
    expect(state.stratagemCards!.nations[f.nationId]).toBeDefined();
    expect(state.stratagemCards!.nations[f.nationId]!.traps).toEqual(queued ? [{ cityKey: 4, setTick: tick + 2 }] : []);
    await replay(f.id);
  },
  60000,
);

it('AC-P2-23 월 정산 전 만료된 함정도 direct 입력으로 정리하지 않는다', async () => {
  const f = await fixture('trap', true, { trapExpiryMonths: 1 });
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: f.actorId } } });
  const setTick = actor.nextTurnTick - 2;
  await advance(f.id, setTick);
  expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
  await advance(f.id, setTick);
  const expiry = setTick + 10000;
  await advance(f.id, expiry + 1);
  const before = (await snapshot(f.id)).state.stratagemCards!;
  const current = await db.world.findUniqueOrThrow({ where: { id: f.id } });
  expect(before.monthlyTick).toBeLessThan(expiry);
  expect(current.clockTick).toBeGreaterThanOrEqual(expiry);
  expect(before.nations[f.nationId]!.traps).toEqual([{ cityKey: 3, setTick }]);
  await reserve(f, []);
  expect((await snapshot(f.id)).state.stratagemCards).toEqual(before);
  await replay(f.id);
});

it('AC-P2-23 설치 이전에 예정된 지연 출병에는 새 함정을 소급하지 않는다', async () => {
  const f = await fixture('trap', true, { emptyDefence: true, trapExpiryMonths: 1, trapLossBp: 10000 });
  await declare(f);
  const enemy = await attacker(f);
  const commands = [
    { commandKey: 'trade_rice', args: { amount: 500, buy: true } },
    { commandKey: 'recruit', args: { amount: 50, crewType: 1100 } },
    { commandKey: 'morale', args: {} },
    { commandKey: 'morale', args: {} },
    { commandKey: 'attack', args: { cityKey: 3 } },
  ];
  const tick = (await reserve(enemy, commands)) + (commands.length - 1) * 10000;
  await advance(f.id, tick - 1);
  expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
  await advance(f.id, tick + 1);
  expect(
    await db.generalLog.count({
      where: { worldId: f.id, generalId: enemy.actorId, tick, commandKey: 'attack', text: { contains: '함정' } },
    }),
  ).toBe(0);
  expect((await snapshot(f.id)).state.cities[3]!.nationId).toBe(2);
  await replay(f.id);
}, 60000);

it('AC-P2-23 계략 패와 금·쌀·성장·예턴은 명령 저장 실패 때 함께 되돌아간다', async () => {
  const f = await fixture('fire_attack');
  const tick = await reserve(f, [{ commandKey: 'fire_attack', args: { cityKey: 2 } }]);
  await advance(f.id, tick - 1);
  const before = await snapshot(f.id),
    beforeHash = hashState(before);
  await expect(advance(f.id, tick, true)).rejects.toThrow('card-save-failure');
  expect(hashState(await snapshot(f.id))).toBe(beforeHash);
  await advance(f.id, tick);
  const after = (await snapshot(f.id)).state;
  expect(after.stratagemCards!.nations[f.nationId]!.hand).toHaveLength(
    before.state.stratagemCards!.nations[f.nationId]!.hand.length - 1,
  );
  expect(after.generals[f.actorId]!.gold).toBeLessThan(before.state.generals[f.actorId]!.gold);
  expect(after.generals[f.actorId]!.rice).toBeLessThan(before.state.generals[f.actorId]!.rice);
  expect(after.generals[f.actorId]!.experience).toBeGreaterThan(before.state.generals[f.actorId]!.experience);
  expect(after.generals[f.actorId]!.nextTurnTick).toBe(tick + 10000);
  await replay(f.id);
});

it.each([
  { type: 'MONTHLY', mode: 'BEFORE_COMMIT' },
  { type: 'MONTHLY', mode: 'AFTER_COMMIT' },
  { type: 'BATTLE', mode: 'BEFORE_COMMIT' },
  { type: 'BATTLE', mode: 'AFTER_COMMIT' },
] as const)(
  'AC-P2-23 $type $mode 실제 SIGKILL이 보충·소비·전투 효과를 함께 복구한다',
  async ({ type, mode }) => {
    const f = await fixture('trap', true, { emptyDefence: type === 'BATTLE' });
    let tick = 20000;
    if (type === 'BATTLE') {
      expect((await rpc('stratagemCards.setTrap', request(f), f.player)).status).toBe(200);
      await advance(f.id, 10000);
      await declare(f);
      const enemy = await attacker(f);
      const commands = [
        { commandKey: 'trade_rice', args: { amount: 500, buy: true } },
        { commandKey: 'recruit', args: { amount: 50, crewType: 1100 } },
        { commandKey: 'morale', args: {} },
        { commandKey: 'morale', args: {} },
        { commandKey: 'attack', args: { cityKey: 3 } },
      ];
      tick = (await reserve(enemy, commands)) + (commands.length - 1) * 10000;
      await advance(f.id, tick - 1);
    }
    if (type === 'MONTHLY') await advance(f.id, tick - 1);
    const boundary = { type, tick };
    const before = await snapshot(f.id),
      beforeHash = hashState(before);
    const crashedPid = await cardProcessProbe(f.id, mode, boundary);
    if (mode === 'BEFORE_COMMIT') expect(hashState(await snapshot(f.id))).toBe(beforeHash);
    else expect(hashState(await snapshot(f.id))).not.toBe(beforeHash);
    await expect
      .poll(
        async () => {
          const rows = await db.$queryRaw<
            Array<{ expired: boolean }>
          >`SELECT "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "EngineLease" WHERE "worldId"=${f.id}`;
          return rows.length === 0 || rows[0]!.expired;
        },
        { timeout: 5000, interval: 50 },
      )
      .toBe(true);
    const recoveredPid = await cardProcessProbe(f.id, 'RECOVER', boundary);
    expect(recoveredPid).not.toBe(crashedPid);
    const after = await snapshot(f.id),
      afterHash = hashState(after);
    if (type === 'MONTHLY') {
      expect(after.state.stratagemCards!.monthlyTick).toBe(tick);
      expect(after.state.stratagemCards!.nations[f.nationId]!.hand).toHaveLength(
        before.state.stratagemCards!.nations[f.nationId]!.hand.length + 1,
      );
    } else {
      expect(after.state.cities[3]!.nationId).toBe(2);
      expect(after.state.stratagemCards!.nations[f.nationId]).toBeUndefined();
      expect(
        await db.generalLog.count({ where: { worldId: f.id, commandKey: 'attack', tick, text: { contains: '함정' } } }),
      ).toBe(1);
    }
    await cardProcessProbe(f.id, 'RECOVER', boundary);
    expect(hashState(await snapshot(f.id))).toBe(afterHash);
    console.info(`CARDS_PROCESS_CRASH ${JSON.stringify({ type, mode, tick, crashedPid, recoveredPid })}`);
    await replay(f.id);
  },
  60000,
);

it.each(['rank', 'nation', 'owner', 'sanction'] as const)(
  'AC-P2-23 접수 후 %s 변경도 실행 직전에 다시 거부한다',
  async (change) => {
    const f = await fixture(),
      input = request(f);
    expect((await rpc('stratagemCards.setTrap', input, f.player)).status).toBe(200);
    const cards = (await snapshot(f.id)).state.stratagemCards;
    // 외부 상태가 이미 바뀐 경계의 부정 검증이다. 원본 재생 증거로 세지 않는다.
    if (change === 'rank')
      await db.general.update({ where: { worldId_id: { worldId: f.id, id: f.actorId } }, data: { officerLevel: 11 } });
    if (change === 'nation')
      await db.general.update({
        where: { worldId_id: { worldId: f.id, id: f.actorId } },
        data: { nationId: 1, officerLevel: 1 },
      });
    if (change === 'owner')
      await db.general.update({
        where: { worldId_id: { worldId: f.id, id: f.actorId } },
        data: { userId: (await user()).id },
      });
    if (change === 'sanction')
      await db.sanction.create({
        data: { userId: f.player.id, worldId: f.id, createdBy: f.player.id, reason: '접수 후 제재' },
      });
    await advance(f.id, 10_000);
    expect(
      (await rpc('stratagemCards.request', { worldId: f.id, requestId: input.requestId }, f.player)).data,
    ).toMatchObject({
      status: 'rejected',
      result: {
        code: { rank: 'FORBIDDEN', nation: 'NATION_CHANGED', owner: 'NOT_OWNER', sanction: 'ACTOR_SANCTIONED' }[change],
      },
    });
    expect((await snapshot(f.id)).state.stratagemCards).toEqual(cards);
  },
  60000,
);

for (const key of ['fire_attack', 'sabotage', 'incite', 'plunder'] as const)
  for (const available of [true, false])
    it(`AC-P2-23 실제 ${key} ${available ? '패 소비' : '패 없음 거부'}와 일반 명령의 무소모를 재생한다`, async () => {
      const f = await fixture(available ? key : 'trap');
      const before = await snapshot(f.id);
      const due = await reserve(f, [
        { commandKey: 'trade_rice', args: { amount: 500, buy: false } },
        { commandKey: key, args: { cityKey: 2 } },
      ]);
      await advance(f.id, due);
      const traded = await snapshot(f.id);
      expect(traded.state.generals[f.actorId]!.gold).toBe(before.state.generals[f.actorId]!.gold + 500);
      expect(traded.state.stratagemCards).toEqual(before.state.stratagemCards);
      await advance(f.id, 20_000);
      const ready = await snapshot(f.id),
        cards = ready.state.stratagemCards!;
      expect(cards.nations[f.nationId]!.hand).toHaveLength(2);
      await advance(f.id, ready.state.generals[f.actorId]!.nextTurnTick);
      const after = (await snapshot(f.id)).state.stratagemCards!;
      const logs = await db.generalLog.findMany({ where: { worldId: f.id, generalId: f.actorId, commandKey: key } });
      expect(logs).toHaveLength(1);
      if (available) {
        expect(after.nations[f.nationId]!.hand).toEqual([key]);
        expect(after.revision).toBe(cards.revision + 1);
      } else {
        expect(after).toEqual(cards);
        expect(logs[0]!.text).toContain('이 계략 패가 없습니다.');
      }
      await replay(f.id);
    }, 60000);
