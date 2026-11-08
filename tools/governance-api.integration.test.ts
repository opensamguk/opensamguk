import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { TICKS_PER_MONTH } from '../packages/rules/src/clock/constants';
import {
  buildCreatedGeneral,
  governanceMovementSchema,
  monthlyDate,
  runMonthly,
  settleMonthlyFeatures,
  type GovernanceConfig,
  type GovernanceInput,
  type WorldInit,
} from '../packages/rules/src/index';
import { rngFor } from '../packages/shared/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import type { AppRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { authzCase } from '../apps/server/src/authz/case';
import { categories } from '../apps/server/src/authz/coverage';

// AC-P2-31·35: 실제 생성·건국·동의·공납·봉록. 원생성의 NPC 차례만 미룬 축소 스케줄이다.
// 정식 491명 전체 스케줄, 전체 기수, 브라우저와 CF 대조를 통과했다는 증거는 아니다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('전용 황실 테스트 DB가 필요합니다.');
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
  'governance-v1',
  'operational-map',
  'personnel',
  'policy',
  'treaty',
];
type Out = inferRouterOutputs<AppRouter>;
type Results = {
  'general.create': Out['general']['create'];
  'turns.set': Out['turns']['set'];
  'turns.precheck': Out['turns']['precheck'];
  'nationTurns.get': Out['nationTurns']['get'];
  'nationTurns.set': Out['nationTurns']['set'];
  'nationCommands.precheck': Out['nationCommands']['precheck'];
  'governance.get': Out['governance']['get'];
  'governance.submit': Out['governance']['submit'];
  'governance.request': Out['governance']['request'];
  'admin.game.request': Out['admin']['game']['request'];
  'admin.game.requestStatus': Out['admin']['game']['requestStatus'];
};
type User = { id: string; cookie: string };
async function rpc<R extends keyof Results>(route: R, input: unknown, user?: User) {
  const mutation = ![
      'governance.get',
      'governance.request',
      'admin.game.requestStatus',
      'turns.precheck',
      'nationTurns.get',
      'nationCommands.precheck',
    ].includes(route),
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
  const payload = (await response.json()) as Envelope | Envelope[],
    body = Array.isArray(payload) ? payload[0]! : payload;
  return { status: response.status, data: body.result?.data, error: body.error };
}
async function user(id = randomUUID()): Promise<User> {
  userIds.push(id);
  await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'not-a-login-hash' } });
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
  return { id, cookie: `sid=${session.token}` };
}
async function advance(worldId: string, tick: number, fail = false, connection = db) {
  const lease = await acquireLease(connection, worldId);
  if (!lease) throw new Error('황실 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(
      connection,
      lease,
      fail
        ? {
            beforeCommit: async () => {
              throw new Error('governance-save-failure');
            },
          }
        : {},
    ).advanceTo(tick);
  } finally {
    await releaseLease(connection, lease);
  }
}
const snapshot = (worldId: string) => db.$transaction((tx) => loadReplayState(tx, worldId));

async function stopMonthlyProcess(worldId: string, phase: 'beforeCommit' | 'committed') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tools/governance-monthly-crash-worker.ts', worldId, phase],
    { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true },
  );
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
      closed.then(() => {
        throw Error('황실 정산 중단 지점 전에 프로세스가 끝났습니다.');
      }),
    ]);
    expect(message).toBe(phase);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual([null, 'SIGKILL']);
  } finally {
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  const { fencingToken } = await db.engineLease.findUniqueOrThrow({ where: { worldId } });
  await db.engineLease.update({
    where: { worldId, fencingToken },
    data: { expiresAt: new Date(0) },
  });
  return fencingToken;
}
function creation(name: string) {
  const stat = Math.floor(initial.statRules.total / 5);
  return {
    name,
    leadership: stat + initial.statRules.total - stat * 5,
    strength: stat,
    intel: stat,
    politics: stat,
    charm: stat,
    portraitId: null,
  };
}
function selectPlayer(seed: string, id: number, tick: number, excluded: readonly number[] = [], beforeTick = 10_000) {
  const payload = creation('황실장수');
  const cities = initial.cities.filter(
    (city) =>
      city.kind !== 'PASS' &&
      city.nationId === null &&
      city.population >= 100_000 &&
      city.commerce >= 1000 &&
      !excluded.includes(city.cityKey),
  );
  for (let attempt = 0; attempt < 4000; attempt++) {
    const userId = randomUUID();
    const preview = buildCreatedGeneral({
      payload,
      userId,
      seed,
      id,
      startYear: initial.startYear,
      tick,
      monthlyTick: 0,
      cityKeys: initial.cities.filter((city) => city.kind !== 'PASS').map((city) => city.cityKey),
      unitSet: initial.unitSet,
    });
    if (
      preview.nextTurnTick > tick &&
      preview.nextTurnTick < beforeTick &&
      cities.some((city) => city.cityKey === preview.cityKey)
    )
      return { userId, cityKey: preview.cityKey };
  }
  throw new Error('실제 세수를 받을 건국 도시를 찾지 못했습니다.');
}
async function createGeneralWithOrder(
  worldId: string,
  player: User,
  name: string,
  order:
    { commandKey: 'found'; args: { name: string; color: string } } | { commandKey: 'join'; args: { nationId: number } },
) {
  const creating = rpc('general.create', { worldId, ...creation(name) }, player);
  try {
    const deadline = performance.now() + 10_000;
    while (
      !(await db.inputEvent.findFirst({
        where: { worldId, userId: player.id, kind: 'general.create', status: 'PENDING' },
      }))
    ) {
      if (performance.now() >= deadline) throw new Error(`장수 접수가 없습니다: ${(await creating).status}`);
      await delay(10);
    }
    await advance(worldId, (await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
    expect((await creating).status).toBe(200);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: player.id } } });
    const edit = await rpc(
      'turns.set',
      {
        worldId,
        revision: general.turnRevision,
        slots: Array.from({ length: 30 }, (_, slot) => (slot === 0 ? order : null)),
      },
      player,
    );
    expect(edit.status, JSON.stringify(edit.error)).toBe(200);
    await advance(worldId, general.nextTurnTick);
    return await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: general.id } } });
  } finally {
    await creating;
  }
}
async function createRuler(worldId: string, player: User, name: string) {
  const ruler = await createGeneralWithOrder(worldId, player, name, {
    commandKey: 'found',
    args: { name, color: '#183b35' },
  });
  expect(ruler.officerLevel).toBe(12);
  if (ruler.nationId === null) throw new Error('실제 건국이 실패했습니다.');
  return ruler;
}
async function fixture(withRival = false) {
  const seed = randomUUID(),
    firstId = Math.max(...initial.generals.map((general) => general.id)) + 1;
  const first = selectPlayer(seed, firstId, 0, [], 5000);
  const config: GovernanceConfig = {
    version: 1,
    seatCityKey: first.cityKey,
    legitimacy: {
      seatGain: 2,
      emperorGain: 1,
      officeGain: 1,
      maxOfficeGain: 3,
      decay: 1,
      ascendAt: 1,
      censureLoss: 5,
      renounceLoss: 10,
    },
    tribute: { maxBp: 2000, maxAmount: 100_000 },
    stipendGold: { chancellor: 100, grandMarshal: 100, minister: 100 },
    offerMonths: 6,
    maxDepth: 3,
    maxRemitMonths: 12,
    censureCooldownMonths: 6,
    npc: { cityRatio: 10_000, acceptMaxBp: 1000, offerBp: 500, cooldownMonths: 12 },
    limits: { sentOffers: 3, receivedOffers: 5, worldOffers: 200 },
  };
  const saved = await saveInitialWorld(
    db,
    { ...structuredClone(initial), seed },
    {
      name: 'AC-P2-31 황실 HTTP',
      turnTermMinutes: 60,
      endYear: 201,
      replayFormat: 3,
      ruleFeatures: features,
      featureData: { 'governance-v1': config },
    },
  );
  const id = saved.worldId;
  worldIds.push(id);
  await controlClock(db, id, 'start');
  const emperor = await user(first.userId),
    ruler = await createRuler(id, emperor, '황실국');
  expect(ruler.cityKey).toBe(first.cityKey);
  const at = await db.world.findUniqueOrThrow({ where: { id } });
  const second = selectPlayer(seed, firstId + 1, at.clockTick, [first.cityKey], withRival ? 7500 : 10_000);
  const vassal = await user(second.userId),
    lower = await createRuler(id, vassal, '봉신국');
  expect(lower.cityKey).toBe(second.cityKey);
  let rival;
  if (withRival) {
    const { clockTick } = await db.world.findUniqueOrThrow({ where: { id } });
    const third = selectPlayer(seed, firstId + 2, clockTick, [first.cityKey, second.cityKey]);
    const player = await user(third.userId);
    const ruler = await createRuler(id, player, '경합국');
    expect(ruler.cityKey).toBe(third.cityKey);
    rival = { player, ruler };
  }
  await advance(id, 10_000);
  const state = await snapshot(id);
  expect(state.state.governance!.legitimacy[String(ruler.nationId)]).toBe(2);
  expect(state.state.cityResources!.cities[String(lower.cityKey)]!.gold).toBeGreaterThan(100);
  return { id, seed, emperor, ruler, vassal, lower, rival };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function send(world: Fixture, actor: User, payload: GovernanceInput) {
  const requestId = randomUUID();
  const reply = await rpc(
    'governance.submit',
    { worldId: world.id, requestId, expectedUserId: actor.id, payload },
    actor,
  );
  expect(reply.status, JSON.stringify(reply.error)).toBe(200);
  expect(reply.data?.status).toBe('pending');
  await advance(world.id, (await db.world.findUniqueOrThrow({ where: { id: world.id } })).clockTick);
  const result = await rpc('governance.request', { worldId: world.id, requestId }, actor);
  expect(result.data?.status, JSON.stringify(result)).toBe('applied');
  return result;
}
beforeAll(async () => {
  initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'governance-api',
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

describe('AC-P2-31 실제 HTTP 황실 접수·동의·경제', () => {
  it('봉신 체결 전 저장한 선전포고·출병을 거부하고 계약 해제 뒤 선전포고한다', async () => {
    const world = await fixture();
    const worldId = world.id,
      upper = world.ruler.nationId!,
      lower = world.lower.nationId!;
    const declare = { commandKey: 'nation_declare', args: { nationId: lower } };
    const attack = { commandKey: 'attack', args: { cityKey: world.lower.cityKey } };
    const reserveDeclaration = async () => {
      const reply = await rpc('nationTurns.get', { worldId }, world.emperor);
      const tab = reply.data?.tabs.find((row) => row.officerLevel === 12);
      if (!tab) throw new Error('군주 예턴을 찾을 수 없습니다.');
      const saved = await rpc(
        'nationTurns.set',
        {
          worldId,
          office: tab.office,
          revision: tab.revision,
          slots: Array.from({ length: 12 }, (_, slot) => (slot === 0 ? declare : null)),
        },
        world.emperor,
      );
      expect(saved.data, JSON.stringify(saved.error)).toMatchObject({ ok: true });
    };
    const precheckDeclaration = () => rpc('nationCommands.precheck', { worldId, ...declare }, world.emperor);
    const relationBetween = (replay: Awaited<ReturnType<typeof snapshot>>) =>
      replay.state.diplomacies.filter(
        ({ nationA, nationB }) => nationA === Math.min(upper, lower) && nationB === Math.max(upper, lower),
      );
    const bound = '같은 봉신 계열의 국가를 공격하거나 선전포고할 수 없습니다.';

    expect((await precheckDeclaration()).data).toEqual({ ok: true });
    await reserveDeclaration();
    const personal = await rpc(
      'turns.set',
      {
        worldId,
        revision: world.ruler.turnRevision,
        slots: Array.from({ length: 30 }, (_, slot) => (slot === 0 ? attack : null)),
      },
      world.emperor,
    );
    expect(personal.data, JSON.stringify(personal.error)).toMatchObject({ ok: true });
    await send(world, world.emperor, {
      type: 'vassal.offer',
      authority: 'OWN',
      targetNationId: lower,
      direction: 'DEMAND',
      goldBp: 1000,
      riceBp: 1000,
    });
    await send(world, world.vassal, { type: 'vassal.respond', offerId: 1, accept: true });
    expect((await precheckDeclaration()).data).toEqual({ ok: false, reason: bound });
    expect((await rpc('turns.precheck', { worldId, ...attack }, world.emperor)).data).toMatchObject({
      ok: false,
      code: 'VASSAL_BOUND',
      message: bound,
    });
    const before = await snapshot(worldId);
    const tick = world.ruler.nextTurnTick;
    await advance(worldId, tick);
    const blocked = await snapshot(worldId);
    expect(relationBetween(blocked)).toEqual([]);
    expect(blocked.state.governance!.vassals).toEqual(before.state.governance!.vassals);
    expect(blocked.state.cities[world.lower.cityKey]!.nationId).toBe(lower);
    expect(blocked.state.nations[upper]).toBeDefined();
    expect(blocked.state.nations[lower]).toBeDefined();
    expect(
      await db.generalLog.findFirst({ where: { worldId, tick, generalId: world.ruler.id, commandKey: 'attack' } }),
    ).toMatchObject({ kind: 'failure', text: `VASSAL_BOUND: ${bound}` });
    const refused = await db.nationHistory.findMany({ where: { worldId, tick, nationId: upper } });
    expect(refused).toMatchObject([{ data: { events: [`선전포고: VASSAL_BOUND: ${bound}`] } }]);

    await send(world, world.emperor, { type: 'vassal.release', vassalId: before.state.governance!.vassals[0]!.id });
    expect((await precheckDeclaration()).data).toEqual({ ok: true });
    await reserveDeclaration();
    const nextTick = tick + TICKS_PER_MONTH;
    await advance(worldId, nextTick);
    const allowed = await snapshot(worldId);
    expect(allowed.state.governance!.vassals).toEqual([]);
    expect(relationBetween(allowed)).toMatchObject([{ state: 'DECLARED' }]);
    const declared = await db.nationHistory.findMany({
      where: { worldId, tick: nextTick, nationId: { in: [upper, lower] } },
      orderBy: { nationId: 'asc' },
    });
    expect(declared.map(({ nationId, data }) => ({ nationId, data }))).toEqual(
      [upper, lower]
        .sort((a, b) => a - b)
        .map((nationId) => ({ nationId, data: { events: ['황실국 → 봉신국 선전포고'] } })),
    );

    await advance(worldId, 30_000);
    const archive = await exportReplay(db, worldId);
    expect(replayArchive(archive, 3)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(worldId)));
  }, 60_000);

  it('두 상위국 제안을 함께 수락하면 접수 순서의 첫 계약만 저장한다', async () => {
    const world = await fixture(true);
    if (!world.rival) throw new Error('경합할 두 번째 상위국이 필요합니다.');
    const upperNations = [world.ruler.nationId!, world.rival.ruler.nationId!];
    const lowerNationId = world.lower.nationId!;
    for (const player of [world.emperor, world.rival.player]) {
      await send(world, player, {
        type: 'vassal.offer',
        authority: 'OWN',
        targetNationId: lowerNationId,
        direction: 'DEMAND',
        goldBp: 1000,
        riceBp: 1000,
      });
    }
    const requests = upperNations.map((overlordNationId, index) => ({
      requestId: randomUUID(),
      offerId: index + 1,
      overlordNationId,
    }));
    const replies = await Promise.all(
      requests.map(({ requestId, offerId }) =>
        rpc(
          'governance.submit',
          {
            worldId: world.id,
            requestId,
            expectedUserId: world.vassal.id,
            payload: { type: 'vassal.respond', offerId, accept: true },
          },
          world.vassal,
        ),
      ),
    );
    expect(replies.map(({ status, data }) => ({ status, requestStatus: data?.status }))).toEqual([
      { status: 200, requestStatus: 'pending' },
      { status: 200, requestStatus: 'pending' },
    ]);
    const events = await db.inputEvent.findMany({
      where: { worldId: world.id, kind: 'governance.act', status: 'PENDING' },
      orderBy: { id: 'asc' },
    });
    expect(events).toHaveLength(2);
    const [winner, loser] = events.map((event) =>
      requests.find(({ requestId }) => event.idempotencyKey === `governance:${requestId}`),
    );
    if (!winner || !loser || winner === loser) throw new Error('서로 다른 수락 요청 두 건이 필요합니다.');
    expect((await snapshot(world.id)).state.governance!.vassals).toEqual([]);

    await advance(world.id, 10_000);
    for (const [request, status] of [
      [winner, 'applied'],
      [loser, 'rejected'],
    ] as const) {
      const reply = await rpc('governance.request', { worldId: world.id, requestId: request.requestId }, world.vassal);
      expect(reply.status).toBe(200);
      expect(reply.data).toMatchObject({ requestId: request.requestId, status });
      if (status === 'rejected') expect(reply.data).toMatchObject({ result: { code: 'ALREADY_VASSAL' } });
    }
    const accepted = await snapshot(world.id);
    expect(accepted.state.governance!.vassals).toEqual([
      expect.objectContaining({ vassalNationId: lowerNationId, overlordNationId: winner.overlordNationId }),
    ]);
    expect(accepted.state.nations[loser.overlordNationId]).toBeDefined();

    await advance(world.id, 20_000);
    const archive = await exportReplay(db, world.id);
    expect(replayArchive(archive, 2)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(world.id)));
  }, 60_000);

  it('황제국 해산 뒤 봉신국을 보존하고 먼저 접수된 해산으로 직위 수락을 거부한다', async () => {
    const world = await fixture();
    const emperorNationId = world.ruler.nationId!;
    const lowerNationId = world.lower.nationId!;
    await send(world, world.emperor, { type: 'throne.ascend' });
    await send(world, world.emperor, {
      type: 'vassal.offer',
      authority: 'OWN',
      targetNationId: lowerNationId,
      direction: 'DEMAND',
      goldBp: 1000,
      riceBp: 1000,
    });
    await send(world, world.vassal, { type: 'vassal.respond', offerId: 1, accept: true });
    await advance(world.id, 70_000);
    expect(await db.governanceMovement.count({ where: { worldId: world.id, tick: 70_000, kind: 'TRIBUTE' } })).toBe(2);
    await send(world, world.emperor, { type: 'court.offer', office: 'chancellor', generalId: world.lower.id });

    const operator = await user();
    await db.user.update({ where: { id: operator.id }, data: { role: 'ADMIN', emailVerifiedAt: new Date(now) } });
    const disband = { expectedUserId: operator.id, worldId: world.id, idempotencyKey: randomUUID() };
    const queued = await rpc(
      'admin.game.request',
      {
        ...disband,
        reason: '황제국 해산과 잔존 봉신국을 확인합니다.',
        action: { kind: 'admin.nation.disband', nationId: emperorNationId },
      },
      operator,
    );
    expect(queued.status, JSON.stringify(queued.error)).toBe(200);
    expect(queued.data?.status).toBe('PENDING');
    const response = { worldId: world.id, requestId: randomUUID() };
    const accepted = await rpc(
      'governance.submit',
      { ...response, expectedUserId: world.vassal.id, payload: { type: 'court.respond', offerId: 2, accept: true } },
      world.vassal,
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect(accepted.data?.status).toBe('pending');

    await advance(world.id, 70_000);
    expect((await rpc('admin.game.requestStatus', disband, operator)).data).toMatchObject({ status: 'APPLIED' });
    expect((await rpc('governance.request', response, world.vassal)).data).toMatchObject({
      status: 'rejected',
      result: { code: 'NOT_FOUND' },
    });
    const after = await snapshot(world.id);
    expect(after.state.nations[emperorNationId]).toBeUndefined();
    expect(after.state.nations[lowerNationId]?.capitalCityKey).toBe(world.lower.cityKey);
    expect(after.state.generals[world.lower.id]).toMatchObject({ nationId: lowerNationId, officerLevel: 12 });
    expect(after.state.governance).toMatchObject({
      throne: { emperorGeneralId: null, emperorNationId: null },
      vassals: [],
      offers: [],
      court: { chancellor: null },
    });
    await advance(world.id, 100_000);
    expect(await db.governanceMovement.count({ where: { worldId: world.id, tick: { gt: 70_000 } } })).toBe(0);
    const archive = await exportReplay(db, world.id);
    expect(replayArchive(archive, 10)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(world.id)));
  }, 60_000);

  it('제안한 나라의 군주를 먼저 교체하면 대기 중인 봉신 수락을 거부하고 두 나라를 보존한다', async () => {
    const world = await fixture();
    const nationId = world.ruler.nationId!;
    const lowerNationId = world.lower.nationId!;
    const successor = await createGeneralWithOrder(world.id, await user(), '후임장수', {
      commandKey: 'join',
      args: { nationId },
    });
    expect(successor).toMatchObject({ nationId, officerLevel: 1 });
    await send(world, world.emperor, {
      type: 'vassal.offer',
      authority: 'OWN',
      targetNationId: lowerNationId,
      direction: 'DEMAND',
      goldBp: 1000,
      riceBp: 1000,
    });
    const operator = await user();
    await db.user.update({ where: { id: operator.id }, data: { role: 'ADMIN', emailVerifiedAt: new Date(now) } });
    const change = { expectedUserId: operator.id, worldId: world.id, idempotencyKey: randomUUID() };
    const queued = await rpc(
      'admin.game.request',
      {
        ...change,
        reason: '군주 교체 뒤 봉신 수락을 검증합니다.',
        action: { kind: 'admin.nation.setRuler', nationId, generalId: successor.id, expectedRulerId: world.ruler.id },
      },
      operator,
    );
    expect(queued.status, JSON.stringify(queued.error)).toBe(200);
    expect(queued.data?.status).toBe('PENDING');
    const response = { worldId: world.id, requestId: randomUUID() };
    const accepted = await rpc(
      'governance.submit',
      {
        ...response,
        expectedUserId: world.vassal.id,
        payload: { type: 'vassal.respond', offerId: 1, accept: true },
      },
      world.vassal,
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect(accepted.data?.status).toBe('pending');

    const { clockTick } = await db.world.findUniqueOrThrow({ where: { id: world.id } });
    await advance(world.id, clockTick);
    expect((await rpc('admin.game.requestStatus', change, operator)).data).toMatchObject({ status: 'APPLIED' });
    expect((await rpc('governance.request', response, world.vassal)).data).toMatchObject({
      status: 'rejected',
      result: { code: 'NOT_FOUND' },
    });
    const after = await snapshot(world.id);
    expect(after.state.nations[nationId]?.capitalCityKey).toBe(world.ruler.cityKey);
    expect(after.state.nations[lowerNationId]?.capitalCityKey).toBe(world.lower.cityKey);
    expect(after.state.generals[successor.id]).toMatchObject({ nationId, officerLevel: 12 });
    expect(after.state.generals[world.ruler.id]).toMatchObject({ nationId, officerLevel: 1 });
    expect(after.state.generals[world.lower.id]).toMatchObject({ nationId: lowerNationId, officerLevel: 12 });
    expect(after.state.governance).toMatchObject({ vassals: [], offers: [] });
    const nextMonth = Math.floor(clockTick / TICKS_PER_MONTH) + 1;
    await advance(world.id, nextMonth * TICKS_PER_MONTH);
    const archive = await exportReplay(db, world.id);
    expect(replayArchive(archive, nextMonth)).toEqual(
      archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
    );
    expect(archive.months.at(-1)!.stateHash).toBe(hashState(await snapshot(world.id)));
  }, 60_000);

  it('동시 재전송은 한 번 접수하며 실패 뒤 새 엔진이 즉위를 한 번만 저장한다', async () => {
    const world = await fixture(),
      requestId = randomUUID();
    const input = {
      worldId: world.id,
      requestId,
      expectedUserId: world.emperor.id,
      payload: { type: 'throne.ascend' },
    };
    const before = await snapshot(world.id);
    const replies = await Promise.all([
      rpc('governance.submit', input, world.emperor),
      rpc('governance.submit', input, world.emperor),
    ]);
    expect(replies.map((reply) => reply.data?.status)).toEqual(['pending', 'pending']);
    expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'governance.act' } })).toBe(1);
    expect(hashState(await snapshot(world.id))).toBe(hashState(before));
    expect(
      (await rpc('governance.submit', { ...input, payload: { type: 'throne.abdicate' } }, world.emperor)).status,
    ).toBe(409);
    expect((await rpc('governance.submit', { ...input, expectedUserId: world.vassal.id }, world.emperor)).status).toBe(
      409,
    );
    expect((await rpc('governance.request', { worldId: world.id, requestId }, world.vassal)).status).toBe(404);
    const sequence = (await db.world.findUniqueOrThrow({ where: { id: world.id } })).actionSequence;
    await expect(advance(world.id, 10_000, true)).rejects.toThrow('governance-save-failure');
    expect(hashState(await snapshot(world.id))).toBe(hashState(before));
    expect((await db.world.findUniqueOrThrow({ where: { id: world.id } })).actionSequence).toBe(sequence);
    expect((await rpc('governance.request', { worldId: world.id, requestId }, world.emperor)).data?.status).toBe(
      'pending',
    );
    const fresh = createDb(url);
    try {
      await advance(world.id, 10_000, false, fresh);
    } finally {
      await fresh.$disconnect();
    }
    expect((await snapshot(world.id)).state.governance!.throne.emperorGeneralId).toBe(world.ruler.id);
    expect((await rpc('governance.request', { worldId: world.id, requestId }, world.emperor)).data?.status).toBe(
      'applied',
    );
    const after = hashState(await snapshot(world.id));
    await advance(world.id, 10_000);
    expect(hashState(await snapshot(world.id))).toBe(after);
  }, 60_000);

  it('사람 계약·직위 동의와 공납·봉록을 저장하고 월 정산의 프로세스 종료를 복구한다', async () => {
    const world = await fixture();
    await send(world, world.emperor, { type: 'throne.ascend' });
    await send(world, world.emperor, {
      type: 'vassal.offer',
      authority: 'OWN',
      targetNationId: world.lower.nationId!,
      direction: 'DEMAND',
      goldBp: 1000,
      riceBp: 1000,
    });
    expect((await snapshot(world.id)).state.governance!.vassals).toEqual([]);
    await send(world, world.vassal, { type: 'vassal.respond', offerId: 1, accept: true });
    await send(world, world.emperor, { type: 'court.offer', office: 'chancellor', generalId: world.lower.id });
    expect((await snapshot(world.id)).state.governance!.court.chancellor).toBeNull();
    await send(world, world.vassal, { type: 'court.respond', offerId: 2, accept: true });
    const contract = (await snapshot(world.id)).state.governance!.vassals[0]!;
    expect(contract).toMatchObject({ overlordMonarchId: world.ruler.id, vassalMonarchId: world.lower.id });
    expect(
      (
        await rpc(
          'governance.submit',
          {
            worldId: world.id,
            requestId: randomUUID(),
            expectedUserId: world.vassal.id,
            payload: { type: 'vassal.release', vassalId: contract.id },
          },
          world.vassal,
        )
      ).status,
    ).toBe(403);
    const beforePay = await snapshot(world.id);
    await advance(world.id, 20_000);
    const paid = await snapshot(world.id);
    expect(paid.state.generals[world.lower.id]!.gold).toBe(beforePay.state.generals[world.lower.id]!.gold + 100);
    const board = await rpc('governance.get', { worldId: world.id }, world.vassal);
    expect(board.data?.movements).toHaveLength(1);
    expect(board.data?.movements[0]).toMatchObject({ holder: 'general', holderId: world.lower.id, delta: 100 });
    const visitor = await user();
    const publicBoard = await rpc('governance.get', { worldId: world.id }, visitor);
    expect(publicBoard.data?.movements).toEqual([]);
    expect(publicBoard.data?.view.enabled && publicBoard.data.view.offers).toEqual([]);
    await advance(world.id, 69_999);
    const before = await snapshot(world.id),
      count = await db.governanceMovement.count({ where: { worldId: world.id } });
    const date = monthlyDate(before.state.startYear, 70_000);
    const baseMonth = runMonthly(before.state, 70_000, rngFor(world.seed, 'monthly', date.year, date.month));
    const expected = settleMonthlyFeatures(before, { ...before, state: baseMonth.state, monthlyTick: 70_000 }, 70_000);
    const expectedRows = z
      .object({ movements: z.array(governanceMovementSchema) })
      .parse(expected.effects['governance-v1']).movements;
    const yearbooks = await db.yearbookSnapshot.count({ where: { worldId: world.id } });
    const monthKey = { worldId_tick: { worldId: world.id, tick: 70_000 } };
    const cursor = () =>
      db.world.findUniqueOrThrow({
        where: { id: world.id },
        select: { monthlyTick: true, actionSequence: true },
      });
    const beforeCursor = await cursor();
    const rollbackToken = await stopMonthlyProcess(world.id, 'beforeCommit');
    expect(hashState(await snapshot(world.id))).toBe(hashState(before));
    expect(await cursor()).toEqual(beforeCursor);
    expect(await db.governanceMovement.count({ where: { worldId: world.id } })).toBe(count);
    expect(await db.yearbookSnapshot.count({ where: { worldId: world.id } })).toBe(yearbooks);

    const committedToken = await stopMonthlyProcess(world.id, 'committed');
    expect(committedToken).toBeGreaterThan(rollbackToken);
    const committed = await snapshot(world.id);
    const committedMonth = await db.yearbookSnapshot.findUniqueOrThrow({ where: monthKey });
    const monthlyRows = () =>
      db.governanceMovement.findMany({
        where: { worldId: world.id, tick: 70_000 },
        orderBy: { ordinal: 'asc' },
      });
    const rows = await monthlyRows();
    expect(rows).toHaveLength(4);
    expect(rows.every(({ sequence }) => sequence === committedMonth.sequence)).toBe(true);
    expect(await db.yearbookSnapshot.count({ where: { worldId: world.id } })).toBe(yearbooks + 1);
    expect(await db.governanceMovement.count({ where: { worldId: world.id } })).toBe(count + 4);
    expect(committed.monthlyTick).toBe(70_000);
    const committedCursor = await cursor();
    expect(committedCursor.actionSequence).toBe(committedMonth.sequence);

    const recovered = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'apps/engine/test/presetWorker.ts', world.id, '70000'],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    const committedHash = hashState(committed);
    expect(JSON.parse(recovered)).toMatchObject({ beforeHash: committedHash, afterHash: committedHash });
    expect((await db.engineLease.findUniqueOrThrow({ where: { worldId: world.id } })).fencingToken).toBeGreaterThan(
      committedToken,
    );
    expect(await db.yearbookSnapshot.findUniqueOrThrow({ where: monthKey })).toEqual(committedMonth);
    expect(await monthlyRows()).toEqual(rows);
    expect(await cursor()).toEqual(committedCursor);
    expect(await db.yearbookSnapshot.count({ where: { worldId: world.id } })).toBe(yearbooks + 1);
    expect(await db.governanceMovement.count({ where: { worldId: world.id } })).toBe(count + 4);
    expect(rows.filter((row) => row.kind === 'TRIBUTE')).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'STIPEND')).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
    expect(
      rows.map(({ kind, refId, holder, holderId, resource, delta, fromNationId, toNationId }) => ({
        kind,
        refId,
        holder,
        holderId,
        resource,
        delta,
        fromNationId,
        toNationId,
      })),
    ).toEqual(expectedRows);
    expect(rows.map((row) => row.ordinal)).toEqual(expectedRows.map((_, index) => index));
    expect(hashState(await snapshot(world.id))).toBe(hashState(expected.replay));
    const archive = await exportReplay(db, world.id),
      replayed = replayArchive(archive, 7);
    expect(replayed.map((month) => month.stateHash)).toEqual(archive.months.map((month) => month.stateHash));
    expect(replayed.at(-1)!.stateHash).toBe(hashState(await snapshot(world.id)));
    expect(replayArchive(archive, 7)).toEqual(replayed);
    const firstRow = rows[0]!;
    const key = {
      worldId_sequence_ordinal: { worldId: world.id, sequence: firstRow.sequence, ordinal: firstRow.ordinal },
    };
    const finalHash = hashState(await snapshot(world.id));
    try {
      await db.governanceMovement.update({ where: key, data: { delta: firstRow.delta - 1 } });
      expect(hashState(await snapshot(world.id))).toBe(finalHash);
      await expect(exportReplay(db, world.id)).rejects.toThrow('원생성 재생의 월 효과');
    } finally {
      await db.governanceMovement.update({ where: key, data: { delta: firstRow.delta } });
    }
  }, 120_000);

  for (const route of ['governance.get', 'governance.submit', 'governance.request'] as const) {
    for (const category of categories)
      it(
        `${route} ${category}`,
        authzCase(route, category, async () => {
          const world = await fixture(),
            requestId = randomUUID();
          const input = {
            worldId: world.id,
            requestId,
            expectedUserId: world.emperor.id,
            payload: { type: 'throne.ascend' },
          };
          expect((await rpc('governance.submit', input, world.emperor)).status).toBe(200);
          const before = hashState(await snapshot(world.id));
          const inputCount = await db.inputEvent.count({ where: { worldId: world.id } });
          const actor =
            category === 'unauthenticated' ? undefined : category === 'otherUser' ? world.vassal : world.emperor;
          const sanction =
            category === 'sanctioned'
              ? await db.sanction.create({
                  data: {
                    userId: world.emperor.id,
                    worldId: world.id,
                    reason: '황실 권한 범주',
                    createdBy: world.emperor.id,
                  },
                })
              : null;
          try {
            const value =
              category === 'invalidInput'
                ? { worldId: world.id, unknown: true }
                : route === 'governance.get'
                  ? { worldId: world.id }
                  : route === 'governance.request'
                    ? { worldId: world.id, requestId }
                    : { ...input, expectedUserId: actor?.id ?? world.emperor.id };
            const result = await rpc(route, value, actor);
            const expected =
              category === 'unauthenticated'
                ? 401
                : category === 'invalidInput'
                  ? 400
                  : category === 'otherUser' && route === 'governance.request'
                    ? 404
                    : category === 'otherUser' && route === 'governance.submit'
                      ? 400
                      : category === 'sanctioned' && route === 'governance.submit'
                        ? 403
                        : 200;
            expect(result.status, `${route} ${category}: ${JSON.stringify(result.error)}`).toBe(expected);
            expect(hashState(await snapshot(world.id))).toBe(before);
            expect(await db.inputEvent.count({ where: { worldId: world.id } })).toBe(inputCount);
            expect(await db.inputEvent.count({ where: { worldId: world.id, kind: 'governance.act' } })).toBe(1);
          } finally {
            if (sanction) await db.sanction.delete({ where: { id: sanction.id } });
          }
        }),
        60_000,
      );
  }
});
