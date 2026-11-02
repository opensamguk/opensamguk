import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildCreatedGeneral, type LogisticsConfig, type WorldInit } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import type { AppRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

// AC-P2-30·35: 실제 HTTP와 원생성부터 사람 생성·건국·물류. 조정한 NPC 차례는 origin에 기록한다.
// 정식491명 원본 스케줄·전체 기수·화면·CF의 증거는 아니다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('전용 물류 API 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw new Error('loopback 전용 테스트 DB를 확인하세요.');
const db = createDb(url),
  worldIds: string[] = [],
  userIds: string[] = [];
const now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let base: string, initial: WorldInit;
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'logistics-v1',
  'operational-map',
  'personnel',
  'policy',
];
type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'world.summary': Out['world']['summary'];
  'logistics.get': Out['logistics']['get'];
  'logistics.request': Out['logistics']['request'];
  'logistics.submit': Out['logistics']['submit'];
  'general.create': Out['general']['create'];
  'turns.set': Out['turns']['set'];
};
type User = { id: string; cookie: string; sessionId: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, user?: User) {
  const mutation = !['logistics.get', 'logistics.request', 'world.summary'].includes(route),
    encoded = JSON.stringify({ 0: input });
  const response = await fetch(
    `${base}/trpc/${route}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`,
    {
      method: mutation ? 'POST' : 'GET',
      headers: {
        origin: 'http://127.0.0.1:5173',
        ...(user ? { cookie: user.cookie } : {}),
        ...(mutation ? { 'content-type': 'application/json' } : {}),
      },
      ...(mutation ? { body: encoded } : {}),
    },
  );
  type Envelope = { result?: { data: Results[R] }; error?: { data: { code: string }; message: string } };
  const payload = (await response.json()) as Envelope | Envelope[];
  const body = Array.isArray(payload) ? payload[0]! : payload;
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(id = randomUUID()) {
  userIds.push(id);
  await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'not-a-login-hash' } });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, sessionId: session.id, cookie: `sid=${session.token}` };
}
async function advance(id: string, tick: number, fail = false) {
  const lease = await acquireLease(db, id);
  if (!lease) throw new Error('물류 API 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw new Error('after-consumption-save');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (id: string) => db.$transaction((tx) => loadReplayState(tx, id));
function creation(name: string) {
  const per = Math.floor(initial.statRules.total / 5);
  return {
    name,
    leadership: per + initial.statRules.total - per * 5,
    strength: per,
    intel: per,
    politics: per,
    charm: per,
    portraitId: null,
  };
}
async function createHuman(worldId: string, player: User, name: string) {
  const creating = rpc('general.create', { worldId, ...creation(name) }, player);
  try {
    const deadline = performance.now() + 5000;
    while (
      !(await db.inputEvent.findFirst({
        where: { worldId, userId: player.id, kind: 'general.create', status: 'PENDING' },
      }))
    ) {
      if (performance.now() >= deadline) throw new Error(`사람 생성 접수가 없습니다: ${(await creating).status}`);
      await delay(10);
    }
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    await advance(worldId, world.clockTick);
    const result = await creating;
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data?.status).toBe('created');
    return db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: player.id } } });
  } finally {
    await creating;
  }
}
async function fixture({ fundedRecruitment = false }: { fundedRecruitment?: boolean } = {}) {
  const seed = randomUUID(),
    payload = creation('물류군주');
  const neutral = initial.cities.filter(
    (city) =>
      city.kind !== 'PASS' &&
      city.nationId === null &&
      city.population > 0 &&
      city.commerce > 0 &&
      (!fundedRecruitment || (city.population >= 100_000 && city.commerce >= 1000)),
  );
  if (!neutral.length) throw new Error('건국할 빈 도시가 없습니다.');
  let playerId = '',
    cityKey = 0;
  for (let i = 0; i < 2000; i++) {
    const candidate = randomUUID();
    const preview = buildCreatedGeneral({
      payload,
      userId: candidate,
      seed,
      id: Math.max(...initial.generals.map((row) => row.id)) + 1,
      startYear: initial.startYear,
      tick: 0,
      monthlyTick: 0,
      cityKeys: initial.cities.filter((city) => city.kind !== 'PASS').map((city) => city.cityKey),
      unitSet: initial.unitSet,
    });
    if (preview.nextTurnTick < 10_000 && neutral.some((city) => city.cityKey === preview.cityKey)) {
      playerId = candidate;
      cityKey = preview.cityKey;
      break;
    }
  }
  if (!playerId) throw new Error('건국 가능한 생성 시드를 찾지 못했습니다.');
  const config: LogisticsConfig = {
    version: 1,
    specialties: [{ cityKey, good: 'wood', perMonth: 100 }],
    capacity: { base: 10_000, perLevel: 1000, maxLevel: 2 },
    upgrade: { gold: 1, wood: 1 },
    transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100, maxActivePerNation: 20 },
    recruitPer100: Object.fromEntries(
      [...new Set(initial.unitSet.crewTypes.filter((type) => type.armType > 0).map((type) => type.armType))].map(
        (armType) => [String(armType), { iron: 2, wood: 0, horses: armType === 3 ? 1 : 0 }],
      ),
    ),
    build: { wall: { iron: 0, wood: 1, horses: 0 }, defence: { iron: 1, wood: 1, horses: 0 } },
    trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
  };
  const saved = await saveInitialWorld(
    db,
    { ...structuredClone(initial), seed },
    {
      name: 'AC-P2-30 물류 HTTP',
      turnTermMinutes: 60,
      endYear: 201,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { 'logistics-v1': config },
    },
  );
  const id = saved.worldId;
  worldIds.push(id);
  const player = await user(playerId);
  await controlClock(db, id, 'start');
  const general = await createHuman(id, player, payload.name);
  expect(general.cityKey).toBe(cityKey);
  const slots = Array.from({ length: 30 }, (_, slot) =>
    slot === 0 ? { commandKey: 'found', args: { name: '물류국', color: '#16324f' } } : null,
  );
  const edited = await rpc('turns.set', { worldId: id, revision: general.turnRevision, slots }, player);
  expect(edited.status, JSON.stringify(edited.error)).toBe(200);
  let beforeTaxGold: number | undefined;
  if (fundedRecruitment) {
    await advance(id, general.nextTurnTick);
    const founded = await snapshot(id);
    expect(founded.state.generals[general.id]!.officerLevel).toBe(12);
    beforeTaxGold = founded.state.cityResources!.cities[String(cityKey)]!.gold;
  }
  await advance(id, 10_000);
  const ruler = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: id, id: general.id } } });
  expect(ruler.officerLevel).toBe(12);
  const state = await snapshot(id);
  expect(state.state.logistics!.cities[String(cityKey)]!.wood).toBeGreaterThan(0);
  expect(state.state.cityResources!.cities[String(cityKey)]!.gold).toBeGreaterThan(7);
  if (beforeTaxGold !== undefined)
    expect(state.state.cityResources!.cities[String(cityKey)]!.gold).toBeGreaterThan(beforeTaxGold);
  return { id, player, generalId: general.id, cityKey, seed, config, state };
}
async function visitorAtCity(world: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 4000; i++) {
    const candidate = randomUUID();
    const preview = buildCreatedGeneral({
      payload: creation('방문자'),
      userId: candidate,
      seed: world.seed,
      id: world.generalId + 1,
      startYear: initial.startYear,
      monthlyTick: 10_000,
      tick: 10_000,
      cityKeys: initial.cities.filter((city) => city.kind !== 'PASS').map((city) => city.cityKey),
      unitSet: initial.unitSet,
    });
    if (preview.cityKey !== world.cityKey) continue;
    const visitor = await user(candidate);
    await createHuman(world.id, visitor, '방문자');
    return visitor;
  }
  throw new Error('방문 장수의 도시를 찾지 못했습니다.');
}
beforeAll(async () => {
  initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'logistics-api',
  });
  initial.ruleFeatures = [...features];
  initial.generals = initial.generals.map((general) => ({ ...general, crew: 0, nextTurnTick: 1_000_000 }));
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try {
    await app.close();
    await db.sanction.deleteMany({ where: { userId: { in: userIds } } });
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
});

describe('AC-P2-30 실제 HTTP 물류 접수·조회·엔진', () => {
  it('일반 차례 저장 뒤 실패는 소비·금·도시·예턴·로그·순번을 함께 롤백하고 새 엔진이 한 번 처리한다', async () => {
    const world = await fixture();
    const ruler = await db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
    });
    expect(
      (
        await rpc(
          'turns.set',
          {
            worldId: world.id,
            revision: ruler.turnRevision,
            slots: Array.from({ length: 30 }, (_, slot) => (slot === 0 ? { commandKey: 'wall', args: {} } : null)),
          },
          world.player,
        )
      ).status,
    ).toBe(200);
    await advance(world.id, 10_000);
    const before = await snapshot(world.id);
    const count = await db.logisticsMovement.count({ where: { worldId: world.id } });
    const sequence = (await db.world.findUniqueOrThrow({ where: { id: world.id } })).actionSequence;
    const logs = await db.generalLog.count({ where: { worldId: world.id } });
    await expect(advance(world.id, ruler.nextTurnTick, true)).rejects.toThrow('after-consumption-save');
    expect(hashState(await snapshot(world.id))).toBe(hashState(before));
    expect(await db.logisticsMovement.count({ where: { worldId: world.id } })).toBe(count);
    expect(await db.generalLog.count({ where: { worldId: world.id } })).toBe(logs);
    expect((await db.world.findUniqueOrThrow({ where: { id: world.id } })).actionSequence).toBe(sequence);
    await advance(world.id, ruler.nextTurnTick);
    const after = await snapshot(world.id);
    expect(after.state.logistics!.cities[String(world.cityKey)]!.wood).toBe(
      before.state.logistics!.cities[String(world.cityKey)]!.wood - 1,
    );
    expect(await db.logisticsMovement.count({ where: { worldId: world.id, reason: 'CONSUME' } })).toBe(1);
    await advance(world.id, ruler.nextTurnTick);
    expect(hashState(await snapshot(world.id))).toBe(hashState(after));
  });

  it('사람의 실제 예턴 모집·징병·건설 소비를 저장하고 원생성 다섯 월을 재생한다', async () => {
    const world = await fixture({ fundedRecruitment: true });
    for (const [good, amount] of [
      ['iron', 7],
      ['horses', 3],
    ] as const) {
      expect(
        (
          await rpc(
            'logistics.submit',
            {
              worldId: world.id,
              expectedUserId: world.player.id,
              requestId: randomUUID(),
              payload: { type: 'trade', cityKey: world.cityKey, good, side: 'buy', amount },
            },
            world.player,
          )
        ).status,
      ).toBe(200);
    }
    await advance(world.id, 10_000);
    expect(
      await db.inputEvent.count({ where: { worldId: world.id, kind: 'logistics.order', status: 'APPLIED' } }),
    ).toBe(2);
    const supplied = await snapshot(world.id);
    expect(supplied.state.cityResources!.cities[String(world.cityKey)]!.gold).toBe(
      world.state.state.cityResources!.cities[String(world.cityKey)]!.gold - 30,
    );
    expect(supplied.state.cityResources!.cities[String(world.cityKey)]!.gold).toBeGreaterThanOrEqual(1500);
    expect(supplied.state.logistics!.cities[String(world.cityKey)]).toMatchObject({ iron: 7, horses: 3 });
    const cavalry = initial.unitSet.crewTypes.find((type) => type.armType === 3);
    if (!cavalry) throw new Error('생성 자원에 기병이 없습니다.');
    const commands = [
      { commandKey: 'recruit', args: { amount: 101, crewType: cavalry.id } },
      { commandKey: 'wall', args: {} },
      { commandKey: 'conscript', args: { amount: 1, crewType: cavalry.id } },
      { commandKey: 'defence', args: {} },
    ];
    const ruler = await db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
    });
    expect(
      (
        await rpc(
          'turns.set',
          {
            worldId: world.id,
            revision: ruler.turnRevision,
            slots: Array.from({ length: 30 }, (_, slot) => commands[slot] ?? null),
          },
          world.player,
        )
      ).status,
    ).toBe(200);
    await advance(world.id, 10_000);
    for (const command of commands) {
      const before = await snapshot(world.id);
      const due = await db.general.findUniqueOrThrow({
        where: { worldId_id: { worldId: world.id, id: world.generalId } },
      });
      expect(due.nextTurnTick % 10_000).not.toBe(0);
      await advance(world.id, due.nextTurnTick);
      const after = await snapshot(world.id);
      const rows = await db.logisticsMovement.findMany({
        where: { worldId: world.id, tick: due.nextTurnTick, reason: 'CONSUME' },
        orderBy: { ordinal: 'asc' },
      });
      const expected =
        command.commandKey === 'recruit'
          ? { iron: 4, wood: 0, horses: 2 }
          : command.commandKey === 'conscript'
            ? { iron: 2, wood: 0, horses: 1 }
            : world.config.build[command.commandKey as 'wall' | 'defence'];
      const logs = await db.generalLog.findMany({
        where: { worldId: world.id, generalId: world.generalId, tick: due.nextTurnTick },
        select: { commandKey: true, kind: true, text: true },
      });
      const context = JSON.stringify({
        command: command.commandKey,
        cityKey: world.cityKey,
        gold: before.state.cityResources!.cities[String(world.cityKey)]!.gold,
        population: before.state.cities[world.cityKey]!.population,
        stock: before.state.logistics!.cities[String(world.cityKey)],
        afterGold: after.state.cityResources!.cities[String(world.cityKey)]!.gold,
        afterStock: after.state.logistics!.cities[String(world.cityKey)],
        logs,
      });
      expect(
        rows.map(({ good, delta }) => ({ good, delta })),
        context,
      ).toEqual(
        Object.entries(expected)
          .filter(([, amount]) => amount > 0)
          .map(([good, amount]) => ({ good, delta: -amount })),
      );
      expect(after.state.logistics!.revision).toBe(before.state.logistics!.revision + 1);
      const oldResource = before.state.cityResources!.cities[String(world.cityKey)]!;
      const resource = after.state.cityResources!.cities[String(world.cityKey)]!;
      if (command.commandKey === 'recruit' || command.commandKey === 'conscript') {
        const amount = command.commandKey === 'recruit' ? 101 : 1;
        expect(after.state.cities[world.cityKey]!.population).toBe(
          before.state.cities[world.cityKey]!.population - amount,
        );
        expect(resource.gold).toBeLessThan(oldResource.gold);
        expect(resource.garrison.find((row) => row.crewType === cavalry.id)!.troops).toBe(
          (oldResource.garrison.find((row) => row.crewType === cavalry.id)?.troops ?? 0) + amount,
        );
      } else {
        expect(after.state.generals[world.generalId]!.gold).toBeLessThan(before.state.generals[world.generalId]!.gold);
        expect(resource.gold).toBe(oldResource.gold);
      }
      await advance(world.id, Math.ceil(due.nextTurnTick / 10_000) * 10_000);
    }
    const state = await snapshot(world.id);
    expect(state.state.logistics!.cities[String(world.cityKey)]).toMatchObject({ iron: 0, horses: 0 });
    const archive = await exportReplay(db, world.id),
      replayed = replayArchive(archive, 5);
    expect(replayed.map((row) => row.stateHash)).toEqual(archive.months.map((row) => row.stateHash));
    expect(replayed.at(-1)!.stateHash).toBe(hashState(state));
  });

  it('예약 뒤 재고가 사라지면 모집을 거부하고 금·인구·수비병·재화는 보존한다', async () => {
    const world = await fixture({ fundedRecruitment: true });
    const trade = async (good: 'iron' | 'horses', side: 'buy' | 'sell', amount: number) => {
      const requestId = randomUUID();
      expect(
        (
          await rpc(
            'logistics.submit',
            {
              worldId: world.id,
              expectedUserId: world.player.id,
              requestId,
              payload: { type: 'trade', cityKey: world.cityKey, good, side, amount },
            },
            world.player,
          )
        ).status,
      ).toBe(200);
      await advance(world.id, 10_000);
      const receipt = await rpc('logistics.request', { worldId: world.id, requestId }, world.player, false);
      expect(receipt.data?.status).toBe('applied');
    };
    await trade('iron', 'buy', 7);
    await trade('horses', 'buy', 3);
    const cavalry = initial.unitSet.crewTypes.find((type) => type.armType === 3)!;
    const ruler = await db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
    });
    expect(
      (
        await rpc(
          'turns.set',
          {
            worldId: world.id,
            revision: ruler.turnRevision,
            slots: Array.from({ length: 30 }, (_, slot) =>
              slot === 0 ? { commandKey: 'recruit', args: { amount: 101, crewType: cavalry.id } } : null,
            ),
          },
          world.player,
        )
      ).status,
    ).toBe(200);
    await trade('iron', 'sell', 7);
    const before = await snapshot(world.id);
    const due = await db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
    });
    expect(due.nextTurnTick).toBeGreaterThan(10_000);
    expect(due.nextTurnTick).toBeLessThan(20_000);
    expect(before.state.logistics!.cities[String(world.cityKey)]).toMatchObject({ iron: 0, horses: 3 });
    await advance(world.id, due.nextTurnTick);
    const after = await snapshot(world.id);
    const logs = await db.generalLog.findMany({
      where: { worldId: world.id, generalId: world.generalId, tick: due.nextTurnTick },
      select: { commandKey: true, kind: true, text: true },
    });
    expect(
      logs.some((row) => row.commandKey === 'recruit' && row.text.includes('도시의 철·목재·말이 부족합니다.')),
      JSON.stringify(logs),
    ).toBe(true);
    expect(after.state.logistics).toEqual(before.state.logistics);
    expect(after.state.cityResources).toEqual(before.state.cityResources);
    expect(after.state.cities[world.cityKey]!.population).toBe(before.state.cities[world.cityKey]!.population);
    for (const key of ['gold', 'rice', 'crew'] as const)
      expect(after.state.generals[world.generalId]![key]).toBe(before.state.generals[world.generalId]![key]);
    expect(
      await db.logisticsMovement.count({ where: { worldId: world.id, tick: due.nextTurnTick, reason: 'CONSUME' } }),
    ).toBe(0);
    await advance(world.id, 20_000);
    const archive = await exportReplay(db, world.id);
    expect(replayArchive(archive, 2).map((row) => row.stateHash)).toEqual(archive.months.map((row) => row.stateHash));
  });

  it('월 정산 대기 중에는 409와 읽기 전용을 주고 정산 뒤 같은 번호로 접수한다', async () => {
    const world = await fixture();
    const input = {
      worldId: world.id,
      requestId: randomUUID(),
      expectedUserId: world.player.id,
      payload: { type: 'trade', cityKey: world.cityKey, good: 'iron', side: 'buy', amount: 1 },
    };
    // 엔진 catch-up의 경계만 재현한다. 이 시험의 clock 변경은 원생성 재생 증거로 쓰지 않는다.
    await db.world.update({ where: { id: world.id }, data: { clockTick: 20_000 } });
    const before = hashState(await snapshot(world.id));
    expect((await rpc('logistics.submit', input, world.player)).status).toBe(409);
    expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'logistics.order' } })).toBe(0);
    expect(hashState(await snapshot(world.id))).toBe(before);
    expect(
      (await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, world.player)).data,
    ).toMatchObject({ settling: true, canManage: false });
    await advance(world.id, 20_000);
    expect((await rpc('logistics.submit', input, world.player)).data?.status).toBe('pending');
  });

  it('사람 생성·건국·생산 뒤 HTTP 교역·증축 결과를 원생성에서 두 월 재생한다', async () => {
    const world = await fixture();
    expect((await rpc('world.summary', { worldId: world.id }, world.player)).data?.logisticsEnabled).toBe(true);
    const before = await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, world.player);
    expect(before.status).toBe(200);
    if (!before.data?.visible || !before.data.own) throw new Error('자기 재고가 보이지 않습니다.');
    expect(before.data.canManage).toBe(true);
    const requests = [
      { type: 'trade', cityKey: world.cityKey, good: 'iron', side: 'buy', amount: 2 },
      { type: 'upgrade', cityKey: world.cityKey },
    ].map((payload) => ({ worldId: world.id, expectedUserId: world.player.id, requestId: randomUUID(), payload }));
    for (const input of requests)
      expect((await rpc('logistics.submit', input, world.player)).data?.status).toBe('pending');
    expect(hashState(await snapshot(world.id))).toBe(hashState(world.state));
    await advance(world.id, 10_000);
    for (const input of requests)
      expect(
        (await rpc('logistics.request', { worldId: world.id, requestId: input.requestId }, world.player)).data?.status,
      ).toBe('applied');
    const after = await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, world.player);
    if (!after.data?.visible || !after.data.own) throw new Error('저장된 재고가 보이지 않습니다.');
    expect(after.data.resources).toMatchObject({ iron: 2, wood: before.data.resources.wood - 1, level: 1 });
    expect(after.data.gold).toBe(before.data.gold - 7);
    expect(after.data.movements.some((row) => row.reason === 'TRADE')).toBe(true);
    expect(after.data.movements.some((row) => row.reason === 'UPGRADE')).toBe(true);
    await advance(world.id, 20_000);
    const archive = await exportReplay(db, world.id),
      replayed = replayArchive(archive, 2);
    expect(replayed.map((row) => row.stateHash)).toEqual(archive.months.map((row) => row.stateHash));
    expect(replayed.at(-1)!.stateHash).toBe(hashState(await snapshot(world.id)));
    expect(
      archive.inputs.filter((input) => input.kind === 'logistics.order' && input.status === 'APPLIED'),
    ).toHaveLength(2);
  });

  it('같은 요청의 동시 재전송은 입력·활동 한 쌍만 접수하고 다른 내용은 충돌한다', async () => {
    const world = await fixture(),
      other = await user();
    const input = {
      worldId: world.id,
      requestId: randomUUID(),
      expectedUserId: world.player.id,
      payload: { type: 'trade', cityKey: world.cityKey, good: 'iron', side: 'buy', amount: 1 },
    };
    const sent = await Promise.all([
      rpc('logistics.submit', input, world.player),
      rpc('logistics.submit', input, world.player),
    ]);
    expect(sent.map((reply) => reply.status)).toEqual([200, 200]);
    expect(
      await db.inputEvent.count({ where: { worldId: world.id, kind: 'logistics.order', status: 'PENDING' } }),
    ).toBe(1);
    expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'general.active', status: 'PENDING' } })).toBe(
      1,
    );
    expect(hashState(await snapshot(world.id))).toBe(hashState(world.state));
    expect(
      (await rpc('logistics.submit', { ...input, payload: { ...input.payload, amount: 2 } }, world.player)).status,
    ).toBe(409);
    expect((await rpc('logistics.submit', { ...input, expectedUserId: other.id }, world.player)).status).toBe(409);
    expect((await rpc('logistics.request', { worldId: world.id, requestId: input.requestId }, other)).status).toBe(404);
    expect(
      (await rpc('logistics.submit', { ...input, requestId: randomUUID(), generalId: world.generalId }, world.player))
        .status,
    ).toBe(400);
    await advance(world.id, 10_000);
    expect(
      (await rpc('logistics.request', { worldId: world.id, requestId: input.requestId }, world.player)).data?.status,
    ).toBe('applied');
  });

  it('무인증·만료·월드/전역 제재·권한 상실은 쓰지 못하고 실패 입력도 접수하지 않는다', async () => {
    const world = await fixture();
    const input = {
      worldId: world.id,
      requestId: randomUUID(),
      expectedUserId: world.player.id,
      payload: { type: 'trade', cityKey: world.cityKey, good: 'iron', side: 'buy', amount: 1 },
    };
    expect((await rpc('logistics.submit', input)).status).toBe(401);
    expect(
      (await rpc('logistics.submit', { ...input, payload: { ...input.payload, amount: -1 } }, world.player)).status,
    ).toBe(400);
    const sanction = await db.sanction.create({
      data: { userId: world.player.id, worldId: world.id, reason: '물류 시험', createdBy: world.player.id },
    });
    expect((await rpc('logistics.submit', input, world.player)).status).toBe(403);
    const board = await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, world.player);
    if (!board.data?.visible || !board.data.own) throw new Error('제재의 읽기 경계가 다릅니다.');
    expect(board.data.canManage).toBe(false);
    await db.sanction.delete({ where: { id: sanction.id } });
    // 권한 경합만 시험하는 DB 변경이다. 이 시험은 원생성 재생 증거로 쓰지 않는다.
    await db.general.update({
      where: { worldId_id: { worldId: world.id, id: world.generalId } },
      data: { officerLevel: 1 },
    });
    expect((await rpc('logistics.submit', input, world.player)).status).toBe(403);
    expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'logistics.order' } })).toBe(0);
    await db.session.update({ where: { id: world.player.sessionId }, data: { expiresAt: new Date(now - 1) } });
    expect((await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, world.player)).status).toBe(401);
    const fresh = newSession(now);
    await db.session.create({ data: { id: fresh.id, userId: world.player.id, expiresAt: fresh.expiresAt } });
    const active = { ...world.player, cookie: `sid=${fresh.token}`, sessionId: fresh.id };
    const global = await db.sanction.create({
      data: { userId: world.player.id, reason: '전역 시험', createdBy: world.player.id },
    });
    try {
      expect((await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, active)).status).toBe(401);
      expect((await rpc('logistics.submit', input, active)).status).toBe(401);
    } finally {
      await db.sanction.delete({ where: { id: global.id } });
    }
  });

  it('같은 도시에 있는 다른 국가 장수에게 특산만 보이고 재고·수송대·가격·원장은 숨긴다', async () => {
    const world = await fixture();
    const visitor = await visitorAtCity(world);
    const board = await rpc('logistics.get', { worldId: world.id, cityKey: world.cityKey }, visitor);
    expect(board.status).toBe(200);
    expect(board.data).toEqual({
      userId: visitor.id,
      cityKey: world.cityKey,
      visible: true,
      own: false,
      specialty: { cityKey: world.cityKey, good: 'wood', perMonth: 100 },
    });
    const remote = initial.cities.find((city) => city.cityKey !== world.cityKey)!;
    expect((await rpc('logistics.get', { worldId: world.id, cityKey: remote.cityKey }, visitor)).data).toEqual({
      userId: visitor.id,
      cityKey: remote.cityKey,
      visible: false,
    });
  });

  it('새 세 경로의 권한 다섯 범주를 실제 HTTP 결과와 게임 상태로 기록한다', async () => {
    const world = await fixture(),
      visitor = await visitorAtCity(world);
    const requestId = randomUUID();
    const submit = {
      worldId: world.id,
      requestId,
      expectedUserId: world.player.id,
      payload: { type: 'trade', cityKey: world.cityKey, good: 'iron', side: 'buy', amount: 1 },
    };
    expect((await rpc('logistics.submit', submit, world.player)).status).toBe(200);
    for (const route of ['logistics.get', 'logistics.submit', 'logistics.request'] as const) {
      for (const category of categories)
        await authzCase(route, category, async () => {
          const before = hashState(await snapshot(world.id));
          const actor = category === 'unauthenticated' ? undefined : category === 'otherUser' ? visitor : world.player;
          const input =
            route === 'logistics.get'
              ? { worldId: world.id, cityKey: category === 'invalidInput' ? -1 : world.cityKey }
              : route === 'logistics.request'
                ? { worldId: world.id, requestId: category === 'invalidInput' ? 'bad' : requestId }
                : {
                    ...submit,
                    expectedUserId: actor?.id ?? world.player.id,
                    ...(category === 'invalidInput' ? { payload: { ...submit.payload, amount: -1 } } : {}),
                  };
          const sanction =
            category === 'sanctioned'
              ? await db.sanction.create({
                  data: { userId: world.player.id, worldId: world.id, reason: '권한 범주', createdBy: world.player.id },
                })
              : null;
          try {
            const reply = await rpc(route, input, actor);
            const expected =
              category === 'unauthenticated'
                ? 401
                : category === 'invalidInput'
                  ? 400
                  : category === 'otherUser'
                    ? route === 'logistics.submit'
                      ? 403
                      : route === 'logistics.request'
                        ? 404
                        : 200
                    : category === 'sanctioned' && route === 'logistics.submit'
                      ? 403
                      : 200;
            expect(reply.status, `${route} ${category}: ${JSON.stringify(reply.error)}`).toBe(expected);
            if (route === 'logistics.get' && category === 'otherUser')
              expect(reply.data).toEqual({
                userId: visitor.id,
                cityKey: world.cityKey,
                visible: true,
                own: false,
                specialty: { cityKey: world.cityKey, good: 'wood', perMonth: 100 },
              });
            if (route === 'logistics.get' && category === 'sanctioned')
              expect(reply.data).toMatchObject({ canManage: false });
            if (route === 'logistics.request' && expected === 200)
              expect(reply.data).toEqual({ userId: world.player.id, requestId, status: 'pending' });
            expect(hashState(await snapshot(world.id))).toBe(before);
            expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'logistics.order' } })).toBe(1);
          } finally {
            if (sanction) await db.sanction.delete({ where: { id: sanction.id } });
          }
        })();
    }
  });
});
