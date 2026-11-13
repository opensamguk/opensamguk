import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, buildCreatedGeneral, STANDARD_EQUIPMENT_CONFIG } from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { TEST_EQUIPMENT_LOGISTICS_CONFIG } from '../packages/rules/src/equipment/testFixture';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import type { LineageInput } from '../packages/rules/src/lineage/actions';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { persistEquipmentState } from '../apps/engine/src/equipmentState';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { readEquipmentBoard } from '../apps/server/src/game/equipmentApi';
import type { readLineageBoard, readLineageRequest } from '../apps/server/src/lineage/service';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';
import { initializeIntegrationResources } from './integration-resources';
import { testDatabaseUrl } from './test-database';
import { recoverTurnAfterCrash, turnCrashPhases } from './turn-process-test';
import { listenLegalLoopback } from '../e2e/legalFixturePorts';

// AC-P2-12: NPC 두 명의 차례를 원생성에서 고정한 장비 저장·실제 HTTP 검증이다.
// 공개 확장 프로필·전체 NPC 전략·화면의 완료 증거는 아니다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw Error('loopback 전용 장비 테스트 DB를 확인하세요.');
const db = createDb(url.href),
  worldIds: string[] = [],
  userIds: string[] = [],
  now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let base: string;
type Results = {
  'equipment.mine': Awaited<ReturnType<typeof readEquipmentBoard>>;
  'general.create': unknown;
  'turns.set': unknown;
  'logistics.submit': { status: string };
  'lineage.get': Awaited<ReturnType<typeof readLineageBoard>>;
  'lineage.submit': unknown;
  'lineage.request': Awaited<ReturnType<typeof readLineageRequest>>;
};
type User = { id: string; cookie: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, player?: User) {
  const mutation = !['equipment.mine', 'lineage.get', 'lineage.request'].includes(route),
    encoded = JSON.stringify(input);
  const response = await fetch(`${base}/trpc/${route}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin: 'http://127.0.0.1:5173',
      ...(player ? { cookie: player.cookie } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body: encoded } : {}),
  });
  const body = (await response.json()) as { result?: { data: Results[R] }; error?: { message: string } };
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
  const lease = await acquireLease(db, id, randomUUID(), 120_000);
  if (!lease) throw Error('장비 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      db,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw Error('equipment-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
const snapshot = (id: string) => db.$transaction((tx) => loadReplayState(tx, id));
async function fixture(enabled = true, lineage = false, specialty: 'iron' | 'horses' = 'iron') {
  const input = operationalInput();
  const template = input.map.sites.find((site) => site.kind === 'CITY')!;
  if (template.kind !== 'CITY') throw Error('시험 도시가 없습니다.');
  input.map.sites.push({
    ...template,
    id: 'city:3',
    name: '장비도시',
    anchorKey: 3,
    legacyCityId: 3,
    position: { x: 700, y: 500 },
    initial: { ...template.initial, population: 20000, security: 10000 },
    max: { ...template.max, population: 40000, security: 10000 },
  });
  input.map.routes.push({
    id: 'route:3',
    from: 'city:2',
    to: 'city:3',
    mode: 'LAND',
    direction: 'BOTH',
    enabled: true,
  });
  const initial = buildInitialWorld(input);
  initial.seed = `equipment-pg-${randomUUID()}`;
  initial.generals = initial.generals.map((general) => ({
    ...general,
    crew: 0,
    nextTurnTick: 1_000_000_000,
    ...(lineage ? { sex: 'UNKNOWN' as const } : {}),
  }));
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 1_000_000 }];
  const features = [
    'campaign-assignment-v2',
    'campaign-v1',
    'city-resources-v1',
    'five-stats',
    'logistics-v1',
    'operational-map',
    'personnel',
    'policy',
    ...(enabled ? ['equipment-v1'] : []),
    ...(lineage ? ['lineage-v1'] : []),
  ].sort();
  initial.ruleFeatures = features;
  const logistics = structuredClone(TEST_EQUIPMENT_LOGISTICS_CONFIG);
  logistics.capacity.base = 10000;
  logistics.specialties = [{ cityKey: 3, good: specialty, perMonth: specialty === 'iron' ? 500 : 100 }];
  const family = structuredClone(lineageTestConfig);
  family.birth.comingOfAgeYears = 1;
  family.marriage.npc.perMonth = 0;
  family.limits.maxBirthsPerYear = 1;
  const saved = await saveInitialWorld(db, initial, {
    name: '장비 실제 처리 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: {
      'logistics-v1': logistics,
      ...(enabled ? { 'equipment-v1': STANDARD_EQUIPMENT_CONFIG } : {}),
      ...(lineage ? { 'lineage-v1': family } : {}),
    },
  });
  worldIds.push(saved.worldId);
  const payload = {
    name: '장비시험자',
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
    portraitId: null,
    ...(lineage ? { sex: 'MALE' as const } : {}),
  };
  let selected: string | undefined;
  for (let index = 0; index < 2000; index++) {
    const candidate = randomUUID(),
      created = buildCreatedGeneral({
        id: 3,
        userId: candidate,
        payload,
        seed: initial.seed,
        startYear: initial.startYear,
        tick: 0,
        monthlyTick: 0,
        cityKeys: [1, 2, 3],
        unitSet: initial.unitSet,
      });
    if (created.cityKey === 3 && created.nextTurnTick > 2 && created.nextTurnTick < 10000) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw Error('중립 도시 장수 생성 시험값이 없습니다.');
  const player = await user(selected);
  await controlClock(db, saved.worldId, 'start', now);
  const creation = rpc('general.create', { worldId: saved.worldId, ...payload }, player);
  const deadline = Date.now() + 5000;
  while (!(await db.inputEvent.findFirst({ where: { worldId: saved.worldId, status: 'PENDING' } }))) {
    if (Date.now() >= deadline) throw Error('장수 생성 입력이 접수되지 않았습니다.');
    await delay(10);
  }
  await advance(saved.worldId, 0);
  expect((await creation).status).toBe(200);
  const f = { id: saved.worldId, player, actorId: 3 };
  await execute(f, 'found', { name: `장비국${worldIds.length}`, color: '#334455' });
  return { ...f, initial };
}
type Fixture = { id: string; player: User; actorId: number };
async function prepare(f: Fixture, kind: string, args: unknown) {
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: f.actorId } } });
  const response = await rpc(
    'turns.set',
    {
      worldId: f.id,
      revision: actor.turnRevision,
      slots: Array.from({ length: 30 }, (_, index) => (index === 0 ? { commandKey: kind, args } : null)),
    },
    f.player,
  );
  expect(response.status, JSON.stringify(response.error)).toBe(200);
  await advance(f.id, actor.nextTurnTick - 1);
  return actor.nextTurnTick;
}
async function execute(f: Fixture, kind: string, args: unknown) {
  await advance(f.id, await prepare(f, kind, args));
}

async function partner(f: Awaited<ReturnType<typeof fixture>>) {
  const world = await db.world.findUniqueOrThrow({ where: { id: f.id } });
  const payload = {
    name: '장비배우자',
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
    portraitId: null,
    sex: 'FEMALE' as const,
  };
  let selected: string | undefined;
  for (let index = 0; index < 2000; index++) {
    const candidate = randomUUID(),
      created = buildCreatedGeneral({
        id: 4,
        userId: candidate,
        payload,
        seed: f.initial.seed,
        startYear: f.initial.startYear,
        tick: world.clockTick,
        monthlyTick: world.monthlyTick,
        cityKeys: [1, 2, 3],
        unitSet: f.initial.unitSet,
      });
    if (created.cityKey === 3) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw Error('같은 도시의 배우자 생성 시험값이 없습니다.');
  const player = await user(selected),
    creation = rpc('general.create', { worldId: f.id, ...payload }, player);
  const deadline = Date.now() + 5000;
  while (!(await db.inputEvent.findFirst({ where: { worldId: f.id, userId: player.id, status: 'PENDING' } }))) {
    if (Date.now() >= deadline) throw Error(`배우자 생성 접수가 없습니다: ${JSON.stringify(await creation)}`);
    await delay(10);
  }
  await advance(f.id, (await db.world.findUniqueOrThrow({ where: { id: f.id } })).clockTick);
  expect((await creation).status).toBe(200);
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId: f.id, userId: player.id } } });
  expect(actor.cityKey).toBe(3);
  return { player, actorId: actor.id };
}

async function lineageAction(f: Fixture, player: User, generalId: number, payload: LineageInput) {
  const requestId = randomUUID();
  const admitted = await rpc(
    'lineage.submit',
    { worldId: f.id, expectedUserId: player.id, expectedGeneralId: generalId, requestId, payload },
    player,
  );
  expect(admitted.status, JSON.stringify(admitted.error)).toBe(200);
  await advance(f.id, (await db.world.findUniqueOrThrow({ where: { id: f.id } })).clockTick);
  const result = await rpc('lineage.request', { worldId: f.id, requestId }, player);
  expect(result.data?.status, JSON.stringify(result.error ?? result.data)).toBe('applied');
  if (result.data?.status !== 'applied') throw Error('가문 명령 실행 결과가 없습니다.');
  return result.data.result;
}

beforeAll(async () => {
  await initializeIntegrationResources(db);
  base = await listenLegalLoopback(
    (port) => app.listen({ host: '127.0.0.1', port }),
    () => app.server.listening,
  );
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

it.each([
  { slot: 'weapon', itemKey: 'weapon_01', good: 'iron', stat: 'strength' },
  { slot: 'horse', itemKey: 'horse_01', good: 'horses', stat: 'leadership' },
] as const)(
  'AC-P2-12·30 $slot 구매의 재료·장비·경험이 함께 저장·롤백되고 12개월 재생과 재접속 해시가 같다',
  async ({ slot, itemKey, good, stat }) => {
    const f = await fixture(true, false, good);
    expect((await rpc('equipment.mine', { worldId: f.id }, f.player)).data?.items).toHaveLength(18);
    await execute(f, 'trade_rice', { amount: 1000, buy: false });
    for (const other of ['iron', 'wood', 'horses'].filter((resource) => resource !== good)) {
      const order = await rpc(
        'logistics.submit',
        {
          worldId: f.id,
          expectedUserId: f.player.id,
          requestId: randomUUID(),
          payload: { type: 'trade', cityKey: 3, good: other, side: 'buy', amount: 2 },
        },
        f.player,
      );
      expect(order.data?.status, JSON.stringify(order.error)).toBe('pending');
    }
    const tick = await prepare(f, 'equipment_trade', { slot, itemKey });
    const beforeReplay = await snapshot(f.id),
      before = beforeReplay.state;
    const stock = before.logistics!.cities['3']!;
    expect(Math.min(stock.iron, stock.wood, stock.horses)).toBeGreaterThan(0);
    await expect(advance(f.id, tick, true)).rejects.toThrow('equipment-save-failure');
    expect(await snapshot(f.id)).toEqual(beforeReplay);
    await advance(f.id, tick);
    const after = (await snapshot(f.id)).state;
    expect(after.equipment?.generals['3']).toEqual({ [slot]: itemKey });
    expect(after.generals[3]!.gold).toBe(before.generals[3]!.gold - 1000);
    expect(after.generals[3]!.experience).toBe(before.generals[3]!.experience + 10);
    expect(after.generals[3]![stat]).toBe(before.generals[3]![stat]);
    expect(after.logistics?.cities['3']).toEqual({ ...stock, [good]: stock[good] - 5 });
    await expect(db.$transaction((tx) => persistEquipmentState(tx, f.id, before, after))).rejects.toThrow(
      '장비 상태가 바뀌어',
    );
    expect((await snapshot(f.id)).state).toEqual(after);
    await expect(db.$executeRaw`UPDATE "World" SET "equipmentState"=NULL WHERE id=${f.id}`).rejects.toThrow();
    await expect(
      db.$transaction(async (tx) => {
        await tx.world.update({
          where: { id: f.id },
          data: { equipmentState: { ...after.equipment!, generals: { '9999': { [slot]: itemKey } } } },
        });
        await loadReplayState(tx, f.id);
      }),
    ).rejects.toThrow();
    expect((await snapshot(f.id)).state).toEqual(after);
    const board = await rpc('equipment.mine', { worldId: f.id }, f.player);
    expect(board.data?.stats[stat]).toBe(board.data!.baseStats[stat] + 1);
    expect(board.data?.sales.find((sale) => sale.slot === slot)?.proceeds).toBe(500);
    await advance(f.id, 120000);
    const archive = await exportReplay(db, f.id);
    expect(archive.months).toHaveLength(12);
    expect(replayArchive(archive, 12).map((month) => month.stateHash)).toEqual(
      archive.months.map((month) => month.stateHash),
    );
    const reconnected = createDb(url.href);
    try {
      const restored = await reconnected.$transaction((tx) => loadReplayState(tx, f.id));
      expect(hashState(restored)).toBe(archive.months.at(-1)!.stateHash);
      expect(restored.state.equipment?.generals['3']).toEqual({ [slot]: itemKey });
      expect(restored.state.equipment).toEqual((await snapshot(f.id)).state.equipment);
    } finally {
      await reconnected.$disconnect();
    }
    const saleTick = await prepare(f, 'equipment_trade', { slot, itemKey: 'none' });
    const beforeSale = (await snapshot(f.id)).state;
    await advance(f.id, saleTick);
    const sold = (await snapshot(f.id)).state;
    expect(sold.equipment?.generals['3']).toBeUndefined();
    expect(sold.generals[3]!.gold).toBe(beforeSale.generals[3]!.gold + 500);
    expect(sold.logistics?.cities['3']).toEqual(beforeSale.logistics?.cities['3']);
  },
);

it.each(turnCrashPhases)(
  'AC-P2-12·30 장비 구매 %s에서 프로세스를 종료해도 새 프로세스가 한 번만 저장한다',
  async (phase) => {
    const f = await fixture(true, false, 'horses');
    await execute(f, 'trade_rice', { amount: 1000, buy: false });
    const commandKey = 'equipment_trade';
    const tick = await prepare(f, commandKey, { slot: 'horse', itemKey: 'horse_01' });
    const before = await snapshot(f.id);
    const stock = before.state.logistics!.cities['3']!;
    expect(stock.horses).toBeGreaterThanOrEqual(5);
    const recovered = await recoverTurnAfterCrash(db, url, f.id, f.actorId, tick, commandKey, phase);
    expect(recovered.state.equipment?.generals[String(f.actorId)]).toEqual({ horse: 'horse_01' });
    expect(recovered.state.generals[f.actorId]!.gold).toBe(before.state.generals[f.actorId]!.gold - 1000);
    expect(recovered.state.generals[f.actorId]!.experience).toBe(before.state.generals[f.actorId]!.experience + 10);
    expect(recovered.state.logistics?.cities['3']).toEqual({ ...stock, horses: stock.horses - 5 });
  },
  60_000,
);
for (const category of categories) {
  it(
    `equipment.mine ${category}`,
    authzCase('equipment.mine', category, async () => {
      const f = await fixture();
      let caller: User | undefined = f.player;
      if (category === 'unauthenticated') caller = undefined;
      if (category === 'otherUser') caller = await user();
      if (category === 'sanctioned')
        await db.sanction.create({
          data: { userId: f.player.id, worldId: f.id, reason: '장비 조회 제재 검증', createdBy: f.player.id },
        });
      const input = { worldId: f.id, ...(category === 'invalidInput' ? { generalId: f.actorId + 1 } : {}) };
      const result = await rpc('equipment.mine', input, caller);
      expect(result.status).toBe(
        category === 'unauthenticated' ? 401 : category === 'otherUser' ? 404 : category === 'invalidInput' ? 400 : 200,
      );
      if (result.status === 200) expect(result.data?.generalId).toBe(f.actorId);
      if (category === 'sanctioned') {
        const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: f.actorId } } });
        expect(
          (
            await rpc(
              'turns.set',
              { worldId: f.id, revision: actor.turnRevision, slots: Array(30).fill(null) },
              f.player,
            )
          ).status,
        ).toBe(403);
      }
    }),
  );
}

it('AC-P2-12: 장비 비활성 월드는 저장값이 없고 조회·장비 명령을 열지 않는다', async () => {
  const f = await fixture(false);
  expect((await db.world.findUniqueOrThrow({ where: { id: f.id } })).equipmentState).toBeNull();
  expect((await snapshot(f.id)).state.equipment).toBeUndefined();
  expect((await rpc('equipment.mine', { worldId: f.id }, f.player)).status).toBe(412);
  const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId: f.id, id: f.actorId } } });
  expect(
    (
      await rpc(
        'turns.set',
        {
          worldId: f.id,
          revision: actor.turnRevision,
          slots: Array.from({ length: 30 }, (_, index) =>
            index === 0 ? { commandKey: 'equipment_trade', args: { slot: 'book', itemKey: 'book_01' } } : null,
          ),
        },
        f.player,
      )
    ).status,
  ).toBe(400);
  await expect(
    db.world.update({
      where: { id: f.id },
      data: {
        equipmentState: {
          version: 1,
          config: STANDARD_EQUIPMENT_CONFIG,
          generals: {},
        },
      },
    }),
  ).rejects.toThrow();
});

async function equippedFamily() {
  // 기존 가문 결합 시험처럼 등장 1년·출산 100%를 명시한 인공 시험이다. 공개 프로필 기본값이 아니다.
  const f = await fixture(true, true);
  await execute(f, 'trade_rice', { amount: 1000, buy: false });
  await execute(f, 'equipment_trade', { slot: 'weapon', itemKey: 'weapon_01' });
  const mother = await partner(f);
  const proposed = await lineageAction(f, f.player, f.actorId, {
    type: 'marriage.propose',
    targetGeneralId: mother.actorId,
  });
  if (!proposed.offerId) throw Error('혼인 제안 번호가 없습니다.');
  await lineageAction(f, mother.player, mother.actorId, {
    type: 'marriage.respond',
    offerId: proposed.offerId,
    accept: true,
  });
  await advance(f.id, 240000);
  const grown = (await snapshot(f.id)).state;
  const heir = Number(
    Object.entries(grown.lineage!.persons).find(([, person]) => person.parents.includes(f.actorId))?.[0],
  );
  expect(grown.generals[heir], JSON.stringify(grown.lineage)).toBeDefined();
  await lineageAction(f, f.player, f.actorId, { type: 'heir.designate', heirGeneralId: heir });
  return { f, heir };
}

it('AC-P2-12·32: 기록된 혼인·출생·사람 계승은 장비와 조작자를 함께 옮기고 다음 월 재생도 같다', async () => {
  const { f, heir } = await equippedFamily();
  const board = await rpc('lineage.get', { worldId: f.id }, f.player),
    preview = board.data?.view.mine?.preview;
  if (!preview) throw Error(`계승 미리보기가 없습니다: ${JSON.stringify(board)}`);
  expect(preview.equipment).toEqual({ from: { weapon: 'weapon_01' }, heir: null, inherited: { weapon: 'weapon_01' } });
  await lineageAction(f, f.player, f.actorId, { type: 'succession.confirm', heirGeneralId: heir, expected: preview });
  const inherited = (await snapshot(f.id)).state;
  expect(inherited.equipment?.generals[String(f.actorId)]).toBeUndefined();
  expect(inherited.equipment?.generals[String(heir)]).toEqual({ weapon: 'weapon_01' });
  expect(inherited.generals[heir]?.userId).toBe(f.player.id);
  expect(inherited.generals[f.actorId]?.userId).toBeNull();
  expect((await rpc('equipment.mine', { worldId: f.id }, f.player)).data?.generalId).toBe(heir);
  await advance(f.id, 250000);
  const archive = await exportReplay(db, f.id);
  expect(replayArchive(archive, 25).map((row) => row.stateHash)).toEqual(archive.months.map((row) => row.stateHash));
  expect(archive.months.at(-1)?.stateHash).toBe(hashState(await snapshot(f.id)));
});

it('AC-P2-12·32: 접수 뒤 장비가 겹치면 계승을 거부하고 전임자 판매 뒤에만 조작권을 옮긴다', async () => {
  const { f, heir } = await equippedFamily();
  const board = await rpc('lineage.get', { worldId: f.id }, f.player);
  const preview = board.data?.view.mine?.preview;
  if (!preview) throw Error('접수할 계승 미리보기가 없습니다.');
  const requestId = randomUUID();
  const input = {
    worldId: f.id,
    expectedUserId: f.player.id,
    expectedGeneralId: f.actorId,
    requestId,
    payload: { type: 'succession.confirm', heirGeneralId: heir, expected: preview },
  };
  expect(await rpc('lineage.submit', input, f.player)).toMatchObject({ status: 200, data: { status: 'pending' } });
  // 접수와 실행 사이에 후계자가 이미 장착한 경우만 시험 고정물로 만든다.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${f.id} FOR UPDATE`;
    const before = (await loadReplayState(tx, f.id)).state;
    const after = structuredClone(before);
    after.equipment!.generals[String(heir)] = { weapon: 'weapon_02' };
    await persistEquipmentState(tx, f.id, before, after);
  });
  const conflict = await rpc('lineage.get', { worldId: f.id }, f.player);
  expect(conflict.data?.view.mine).toMatchObject({
    preview: null,
    previewFailure: { code: 'EQUIPMENT_CONFLICT', message: expect.stringContaining('먼저 판매') },
  });
  const before = (await snapshot(f.id)).state;
  await advance(f.id, 240000);
  expect((await rpc('lineage.request', { worldId: f.id, requestId }, f.player)).data).toMatchObject({
    status: 'rejected',
    result: { code: 'EQUIPMENT_CONFLICT' },
  });
  const rejected = (await snapshot(f.id)).state;
  expect(rejected.generals).toEqual(before.generals);
  expect(rejected.lineage).toEqual(before.lineage);
  expect(rejected.equipment).toEqual(before.equipment);

  await execute(f, 'equipment_trade', { slot: 'weapon', itemKey: 'none' });
  const refreshed = (await rpc('lineage.get', { worldId: f.id }, f.player)).data?.view.mine?.preview;
  if (!refreshed) throw Error('판매 뒤 계승 미리보기가 없습니다.');
  expect(refreshed.equipment).toEqual({
    from: null,
    heir: { weapon: 'weapon_02' },
    inherited: { weapon: 'weapon_02' },
  });
  await lineageAction(f, f.player, f.actorId, { type: 'succession.confirm', heirGeneralId: heir, expected: refreshed });
  const inherited = (await snapshot(f.id)).state;
  expect(inherited.equipment?.generals).toEqual({ [heir]: { weapon: 'weapon_02' } });
  expect(inherited.generals[heir]?.userId).toBe(f.player.id);
  expect(inherited.generals[f.actorId]?.userId).toBeNull();
  expect((await rpc('equipment.mine', { worldId: f.id }, f.player)).data?.generalId).toBe(heir);
});
