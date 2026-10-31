import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  applyCampaignRelationship,
  BALANCE,
  buildInitialWorld,
  type CampaignOrder,
  type WorldInit,
} from '../packages/rules/src/index';
import { affordableRecruits } from '../packages/rules/src/commands/statScores';
import { cityNpcAllocations } from '../packages/rules/src/cityResources/npc';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, assertLease, lockLease, releaseLease, renewLease, LEASE_TTL_MS } from '../apps/engine/src/lease';
import { assertWorldCapabilities } from '../apps/engine/src/capsGate';
import { processInputs } from '../apps/engine/src/inputs';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import type { readCampaignOrders } from '../apps/server/src/game/campaignOrders';
import type { readCampaignRequest } from '../apps/server/src/game/campaignApi';
import { testDatabaseUrl } from './test-database';

// AC-INT-19B: NPC 자기 부곡 지시를 작은 통제 월드에서 끝까지 실행한다. 정식 191 월드의 지시 시나리오는
// int19-orders.suite.ts가 맡고, 이 파일은 다른 NPC의 도시 금 경쟁 없이 정상 경로만으로 병력을 받는 사례를 맡는다.
// 게임 상태는 saveInitialWorld, 실제 loopback HTTP 요청, 실행권을 가진 엔진으로만 바꾼다. SQL 게임 상태 주입은 없다.
if (!process.env.TEST_DATABASE_URL) throw new Error('INT19 전용 TEST_DATABASE_URL이 필요합니다.');
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.searchParams.has('host') || url.searchParams.has('port'))
  throw new Error('INT19는 loopback 전용 테스트 DB만 사용합니다.');
const db = createDb(url.toString());
const origin = 'http://127.0.0.1:5173',
  now = Date.now();
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
];
type Account = { userId: string; cookie: string };
type Actor = Account & { generalId: number };
type Board = Awaited<ReturnType<typeof readCampaignOrders>>;
type Receipt = Awaited<ReturnType<typeof readCampaignRequest>>;
const userIds: string[] = [];
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let initial: WorldInit, a: Actor;
let base = '',
  worldId = '',
  rulerId = 0,
  npcId = 0,
  failed = false;

async function api<T = unknown>(path: string, input: unknown, account: Account | null = a, mutation = false) {
  const body = JSON.stringify({ 0: input });
  const response = await fetch(`${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(body)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin,
      ...(account ? { cookie: account.cookie } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const [entry] = (await response.json()) as Array<{
    result?: { data: T };
    error?: { message?: string; data: { code: string } };
  }>;
  if (!entry) throw new Error('INT19 HTTP 응답이 없습니다.');
  return { data: entry.result?.data, code: entry.error?.data.code, message: entry.error?.message };
}
function snapshot() {
  return db.$transaction((tx) => loadReplayState(tx, worldId), { isolationLevel: 'RepeatableRead' });
}
async function leased<T>(
  run: (lease: NonNullable<Awaited<ReturnType<typeof acquireLease>>>, signal: AbortSignal) => Promise<T>,
) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('INT19 실행권을 얻지 못했습니다.');
  const controller = new AbortController();
  let renewalError: unknown;
  const renewal = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(LEASE_TTL_MS / 3, undefined, { signal: controller.signal });
        if (!controller.signal.aborted) await renewLease(db, lease);
      } catch (error) {
        if (!controller.signal.aborted) {
          renewalError = error;
          controller.abort();
        }
      }
    }
  })();
  try {
    const value = await run(lease, controller.signal);
    if (renewalError) throw renewalError;
    return value;
  } finally {
    controller.abort();
    await renewal;
    await releaseLease(db, lease);
  }
}
function drain() {
  return leased(async (lease) => {
    for (let count = 0; count < 64; count++) {
      const applied = await db.$transaction(async (tx) => {
        await lockLease(tx, lease);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await assertWorldCapabilities(tx, world);
        const processed = await processInputs(tx, world, world.clockTick);
        await assertLease(tx, lease);
        return processed;
      });
      if (!applied) return;
    }
    throw new Error('INT19 준비 입력 수 한도를 넘었습니다.');
  });
}
function advance(tick: number) {
  return leased((lease, signal) => new TurnLoop(db, lease).advanceTo(tick, signal));
}
async function board() {
  const result = await api<Board>('campaign.orders', { worldId });
  expect(result.code).toBeUndefined();
  if (!result.data) throw new Error('INT19 지시 현황이 없습니다.');
  return result.data;
}
async function receipt(requestId: string) {
  const result = await api<Receipt>('campaign.request', { worldId, requestId });
  expect(result.code).toBeUndefined();
  if (!result.data) throw new Error('INT19 입력 결과가 없습니다.');
  return result.data;
}
// 실제 접수 API를 부른다. 접수 사전검사 거부(BAD_REQUEST)는 그 메시지를 돌려주고, 다른 오류는 실패시킨다.
async function tryInput(path: 'campaign.relationship' | 'campaign.order', payload: unknown) {
  const requestId = randomUUID();
  const result = await api<{ status: string }>(
    path,
    { worldId, requestId, expectedUserId: a.userId, payload },
    a,
    true,
  );
  if (result.code !== undefined) {
    expect(result.code).toBe('BAD_REQUEST');
    return { denied: result.message ?? '' } as const;
  }
  expect(result.data?.status).toBe('pending');
  await drain();
  const applied = await receipt(requestId);
  expect(applied.status).toBe('applied');
  return { applied } as const;
}
async function issue(commandKey: string, args: unknown) {
  const result = await tryInput('campaign.order', {
    type: 'issue',
    recipientId: npcId,
    command: { commandKey, args },
    revision: (await board()).revision,
  });
  if ('denied' in result) return { denied: result.denied };
  if (result.applied.status !== 'applied' || result.applied.kind !== 'campaign.order')
    throw new Error('INT19 지시 접수 실패');
  return { orderId: result.applied.result.orderId };
}
async function issued(commandKey: string, args: unknown) {
  const result = await issue(commandKey, args);
  if (result.orderId === undefined) throw new Error(`INT19 ${commandKey} 지시가 거부됐습니다. ${result.denied}`);
  return result.orderId;
}
async function order(id: number): Promise<CampaignOrder> {
  const found = (await snapshot()).state.campaign!.orders?.items.find((item) => item.id === id);
  if (!found) throw new Error('INT19 저장 지시가 없습니다.');
  return found;
}
// 수신 장수의 실제 다음 차례까지 엔진을 돌리고, 지시가 그 차례 한 칸만 쓰고 끝났는지 확인한다.
async function executeOrder(id: number, expected: 'EXECUTED' | 'RESOLVED' = 'EXECUTED') {
  const before = await snapshot(),
    saved = await order(id),
    due = before.state.generals[npcId]!.nextTurnTick;
  expect(saved.status).toBe('READY');
  expect(saved.recipientId).toBe(npcId);
  const result = await advance(due);
  expect(result.filter((row) => row.generalId === npcId && row.tick === due)).toHaveLength(1);
  const after = await snapshot(),
    resolved = await order(id);
  if (expected === 'RESOLVED') expect(['EXECUTED', 'FAILED']).toContain(resolved.status);
  else expect(resolved.status).toBe(expected);
  expect(resolved.resolvedTick).toBe(due);
  expect(after.revisions[npcId]).toBe(before.revisions[npcId]! + 1);
  expect(after.turns[npcId]!.slice(0, 29)).toEqual(before.turns[npcId]!.slice(1));
  const logs = await db.generalLog.findMany({
    where: { worldId, generalId: npcId, tick: due, commandKey: saved.command.commandKey },
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.kind).toBe(resolved.status === 'FAILED' ? 'failure' : 'success');
  return { after, status: resolved.status };
}
async function account(): Promise<Account> {
  const userId = randomUUID();
  await db.user.create({
    data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'int19-non-login-session-fixture' },
  });
  userIds.push(userId);
  const session = newSession(now);
  await db.session.create({ data: { id: session.id, userId, expiresAt: session.expiresAt } });
  return { userId, cookie: `sid=${session.token}` };
}
async function setTurns(actor: Actor, commandKey = 'rest', args: unknown = {}) {
  const revision = (await snapshot()).revisions[actor.generalId]!;
  const result = await api<{ ok: boolean }>(
    'turns.set',
    {
      worldId,
      revision,
      slots: [{ commandKey, args }, ...Array.from({ length: 29 }, () => ({ commandKey: 'rest', args: {} }))],
    },
    actor,
    true,
  );
  expect(result.code).toBeUndefined();
  expect(result.data?.ok).toBe(true);
}

beforeAll(async () => {
  const source = operationalInput();
  // 나라 하나가 도시1·관문을 갖고 도시2는 공백지다. 교전 상대와 도시 금을 나눠 쓰는 다른 나라가 없다.
  source.scenario.nation = [['국가1', '#112233', 10000, 10000, '', 0, '', 0, ['도시1', '관문']]];
  // 서약 후보는 정치가 높고 통솔·무력이 낮아 전선 이동(60+군사)보다 내정(70+정치)을 골라 도시1에 머문다.
  // 통솔 30이면 지휘 상한이 3000이라 군주는 2000명을 한 번에 배속할 수 있다.
  // 서약 동의는 장수마다 정해진 굴림이므로 같은 조건의 후보를 여럿 두고 실제 규칙이 수락하는 장수를 고른다.
  const candidateStats = { leadership: 30, strength: 30, intel: 50, politics: 100, charm: 50 };
  source.scenario.general = [
    [0, '군주', '', 1, '도시1', 50, 50, 50, 12, 150, 250, null, null],
    ...[1, 2, 3, 4].map((index) => [0, `부장${index}`, '', 1, '도시1', 30, 30, 50, 1, 150, 250, null, null] as const),
  ];
  source.scenario.generalStats = [
    { leadership: 50, strength: 50, intel: 50, politics: 50, charm: 50 },
    ...Array.from({ length: 4 }, () => ({ ...candidateStats })),
  ].map((stats, index) => ({
    generalId: index + 1,
    stats,
    sourceId: 'test-fixture',
    sourceRevision: 'test-fixture-v1',
    officerId: index + 1,
  }));
  for (const site of source.map.sites)
    if (site.kind === 'CITY') {
      site.initial.population = site.max.population = 50000;
      site.initial.commerce = site.max.commerce = 100000;
      site.initial.agriculture = site.max.agriculture = 100000;
    }
  initial = buildInitialWorld(source);
  initial.ruleFeatures = [...features];
  rulerId = initial.generals.find((g) => g.officerLevel === BALANCE.RULER_LEVEL)!.id;
  ({ worldId } = await saveInitialWorld(db, initial, {
    name: 'INT19 NPC 자기부곡 통제 검사',
    turnTermMinutes: 60,
    endYear: 201,
  }));
  await controlClock(db, worldId, 'start');
  app = await buildServer({ db, logging: false, publicOrigin: origin, now: () => now });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const owner = await account();
  const creating = api<{ status: string }>(
    'general.create',
    { worldId, name: '지시검사', portraitId: null, leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55 },
    owner,
    true,
  );
  for (let started = performance.now(); ; await delay(50)) {
    const count = await db.inputEvent.count({
      where: { worldId, userId: owner.userId, kind: 'general.create', status: 'PENDING' },
    });
    if (count === 1) break;
    if (performance.now() - started > 10_000) throw new Error('INT19 장수 생성 접수를 확인하지 못했습니다.');
  }
  await drain();
  expect(['created', 'pending']).toContain((await creating).data?.status);
  const general = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: owner.userId } } });
  a = { ...owner, generalId: general.id };
  await setTurns(a, 'join', { nationId: 1 });
  await advance((await snapshot()).state.generals[a.generalId]!.nextTurnTick);
  expect((await snapshot()).state.generals[a.generalId]!.nationId).toBe(1);
  await setTurns(a);
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    if (!failed && worldId) await db.world.delete({ where: { id: worldId } });
    if (!failed) await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await db.$disconnect();
  }
}, 120_000);

it('NPC자기부곡 지시는 정상 도시 준비와 NPC군주 배속으로 병력을 받은 뒤 실제 훈련을 실행하고 소유권을 지킨다', async ({
  onTestFailed,
}) => {
  onTestFailed(() => {
    failed = true;
  });
  const start = await snapshot(),
    home = start.state.nations[1]!.capitalCityKey;
  const ruler = start.state.generals[rulerId]!;
  expect(ruler).toMatchObject({ userId: null, nationId: 1, officerLevel: BALANCE.RULER_LEVEL });
  expect(start.state.nations[1]!.isNpc).toBe(true);
  expect(start.state.cities[home]!.nationId).toBe(1);
  expect(Object.values(start.state.generals).filter((g) => g.userId === null)).toHaveLength(5);

  // 사람 장수는 정상 서약 입력으로 NPC를 직속으로 둔다. 비용·동의는 실제 규칙이 정한다.
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const offerTo = (targetId: number) =>
    ({ type: 'offer', targetId, relation: 'LIEUTENANT', revision: start.state.campaign!.revision }) as const;
  const pledge = (targetId: number) =>
    applyCampaignRelationship(start.state, offerTo(targetId), a.generalId, start.state.campaign, {
      tick: world.clockTick,
      userId: a.userId,
      userActive: true,
    });
  const candidates = Object.values(start.state.generals)
    .filter((g) => g.userId === null && g.officerLevel !== BALANCE.RULER_LEVEL)
    .sort((x, y) => x.id - y.id);
  const candidate = candidates.find((g) => {
    const result = pledge(g.id);
    return g.cityKey === home && result.ok && result.result.accepted === true;
  });
  if (!candidate) {
    const reasons = candidates.map((g) => {
      const result = pledge(g.id);
      return `${g.id}@${g.cityKey}:${result.ok ? `roll=${result.result.roll}/${result.result.chance}` : result.code}`;
    });
    throw new Error(`INT19 정상 자금·동의 조건을 만족하는 NPC 서약 후보가 없습니다. ${reasons.join(' ')}`);
  }
  npcId = candidate.id;
  const offer = offerTo(npcId);
  const linked = await tryInput('campaign.relationship', offer);
  expect(linked).toMatchObject({ applied: { status: 'applied', result: { accepted: true } } });
  expect((await snapshot()).state.campaign!.links).toContainEqual({
    masterId: a.generalId,
    personId: npcId,
    relation: 'LIEUTENANT',
  });

  // 군주와 겹치지 않는 병종으로 NPC에게 빈 부곡을 정상 편성시킨다. 이 나라의 부곡은 이것 하나다.
  const crewType = initial.unitSet.crewTypes
    .filter((row) => row.armType > 0 && row.id !== ruler.crewType)
    .sort((x, y) => x.cost - y.cost || x.id - y.id)[0]!;
  await executeOrder(await issued('form_unit', { crewType: crewType.id }));
  const formed = (await snapshot()).state.campaign!.units;
  expect(formed).toHaveLength(1);
  expect(formed[0]).toMatchObject({ ownerId: npcId, commanderId: npcId, crewType: crewType.id, troops: 0 });
  const unitId = formed[0]!.id;

  // 도시 금으로 그 병종 수비병만 모병·사기·훈련하게 지시하고, NPC군주의 실제 국가 차례 배속을 기다린다.
  let allocated: Awaited<ReturnType<typeof snapshot>> | undefined,
    prepared: { state: Awaited<ReturnType<typeof snapshot>>; key: string } | undefined;
  for (let round = 0; round < 80; round++) {
    const state = await snapshot(),
      unit = state.state.campaign!.units.find((row) => row.id === unitId)!,
      npc = state.state.generals[npcId]!,
      city = state.state.cityResources!.cities[String(home)]!;
    expect(unit).toMatchObject({ ownerId: npcId, commanderId: npcId, crewType: crewType.id });
    expect(npc.cityKey).toBe(home);
    const garrison = city.garrison.find((row) => row.crewType === crewType.id);
    const status = `round=${round} tick=${npc.nextTurnTick} gold=${city.gold} garrison=${JSON.stringify(garrison ?? null)} unitTroops=${unit.troops}`;
    if (unit.troops > 0) {
      console.info(`INT19 NPC 배속 완료 ${status}`);
      allocated = state;
      break;
    }
    const choices: { key: string; args: Record<string, unknown> }[] = [];
    if (garrison?.troops && garrison.atmos < 70)
      choices.push({ key: 'morale', args: { target: 'city', crewType: crewType.id } });
    else if (garrison?.troops && garrison.train < 60)
      choices.push({ key: 'train', args: { target: 'city', crewType: crewType.id } });
    else if (!garrison?.troops) {
      // 군주가 한 번에 다 배속하도록 NPC 지휘 상한 안에서만 모병한다.
      const capacity = Math.min(2000, npc.leadership * BALANCE.CREW_PER_LEADERSHIP);
      const amount = affordableRecruits(
        state.state,
        { ...npc, gold: city.gold },
        crewType.cost,
        Math.min(capacity, state.state.cities[home]!.population),
      );
      if (amount > 0) choices.push({ key: 'recruit', args: { amount, crewType: crewType.id } });
    }
    // 준비가 끝났거나 도시 금이 모자라면 차례를 쉬며 월 수입과 군주 차례를 기다린다.
    choices.push({ key: 'rest', args: {} });
    const denied: string[] = [];
    let orderId: number | undefined;
    for (const choice of choices) {
      const result = await issue(choice.key, choice.args);
      if (result.orderId !== undefined) {
        orderId = result.orderId;
        prepared = { state, key: choice.key };
        console.info(`INT19 NPC 준비 ${status} order=${choice.key} denied=${JSON.stringify(denied)}`);
        break;
      }
      denied.push(`${choice.key}:${result.denied}`);
    }
    if (orderId === undefined)
      throw new Error(`INT19 NPC 준비 지시가 모두 거부됐습니다. ${status} ${denied.join(' ')}`);
    await executeOrder(orderId, 'RESOLVED');
  }
  if (!allocated) throw new Error('INT19 NPC 부곡 배속 관찰 한도를 넘었습니다.');
  if (!prepared) throw new Error('INT19 배속 직전 상태가 없습니다.');
  // 국가 차례 결과는 따로 기록되지 않으므로, 배속이 일어난 차례에 NPC는 쉬기만 했고 직전 상태에서
  // 실제 규칙의 NPC군주 배속 후보가 이 부곡과 수량을 가리키며, 도시 수비병이 그만큼만 줄었는지 대조한다.
  const preparedGarrison = prepared.state.state.cityResources!.cities[String(home)]!.garrison.find(
    (row) => row.crewType === crewType.id,
  )!;
  const allocatedUnit = allocated.state.campaign!.units.find((row) => row.id === unitId)!;
  expect(prepared.key).toBe('rest');
  expect(preparedGarrison.train).toBeGreaterThanOrEqual(60);
  expect(preparedGarrison.atmos).toBeGreaterThanOrEqual(70);
  expect(cityNpcAllocations(prepared.state.state, 1).map((row) => [row.key, row.args])).toEqual([
    ['nation_city_allocate', { cityKey: home, unitId, crewType: crewType.id, amount: allocatedUnit.troops }],
  ]);
  const remaining =
    allocated.state.cityResources!.cities[String(home)]!.garrison.find((row) => row.crewType === crewType.id)?.troops ??
    0;
  expect(remaining).toBe(preparedGarrison.troops - allocatedUnit.troops);

  // 자기 부곡 훈련을 지시하고 월 녹봉 등 다른 변화가 끝난 NPC 차례 직전 상태를 기준으로 삼는다.
  const trainId = await issued('train', { unitId });
  await advance(allocated.state.generals[npcId]!.nextTurnTick - 1);
  const before = await snapshot(),
    npc = before.state.generals[npcId]!,
    unit = before.state.campaign!.units.find((row) => row.id === unitId)!;
  expect(unit).toMatchObject({ ownerId: npcId, commanderId: npcId, crewType: crewType.id });
  expect(unit.troops).toBeGreaterThan(0);
  expect(before.state.cities[npc.cityKey]!.nationId).toBe(npc.nationId);
  expect(npc.gold).toBeGreaterThanOrEqual(BALANCE.DRILL_COST);
  expect(unit.train).toBeLessThan(100);
  const { after } = await executeOrder(trainId);
  const trained = after.state.campaign!.units.find((row) => row.id === unitId)!;
  expect(trained).toMatchObject({
    ownerId: npcId,
    commanderId: npcId,
    troops: unit.troops,
    crewType: unit.crewType,
  });
  expect(trained.train).toBeGreaterThan(unit.train);
  expect(after.state.generals[npcId]!.gold).toBe(npc.gold - BALANCE.DRILL_COST);
  expect(after.state.campaign!.units).toHaveLength(1);
  // 이미 처리한 시각까지 다시 진행해도 상태와 지시가 바뀌지 않는다.
  const unchanged = hashState(after);
  await advance((await db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
  expect(hashState(await snapshot())).toBe(unchanged);
  expect((await order(trainId)).status).toBe('EXECUTED');
}, 600_000);
