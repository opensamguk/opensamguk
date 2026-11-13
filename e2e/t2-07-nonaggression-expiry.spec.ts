import { randomUUID } from 'node:crypto';
import type { Browser, Locator, Page } from '@playwright/test';
import { TICKS_PER_MONTH, toGameDate } from '../packages/rules/src/index';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { test, expect, type LegalStack } from './legalFixture';

// T2-07 · AC-M2-06 불가침 기한 만료 공개 Chromium 사례.
// 실제 공개 dist·HTTP·PG와 시험이 직접 돌리는 실제 TurnLoop을 쓴다. 중립인 두 사람 국가의 이름 붙인 군주 세션이
// 외교실 화면에서 1개월 불가침을 제안하고 수락한다. 조약·외교·입력 행은 DB에 쓰지 않고 읽기만 한다.
// 시험이 DB에 직접 쓰는 것은 계정·세션, 월드 생성(장수 이름·첫 턴)과 생성 직후 두 군주 장수의 계정 연결뿐이다.
// 월드는 형식 3 생성 기록에 personnel·policy·treaty·treaty-break 기능을 켠다. personnel 생성 기록은 사람 장수를
// 받지 않으므로 계정 연결은 생성 뒤에 마지막 활동 시각과 함께 쓴다.
//
// 시각: 제안 PROPOSE_TICK, 수락 ACCEPT_TICK(월 중간). 원 기한 E = 수락 + 1개월(raw endTick).
// 실제 종료는 E 다음 월 정산 B = ceil(E ÷ 월) × 월이다. E와 B−1에는 ACTIVE·불가침 관계가 그대로 있고 B에서 ENDED가 된다.
// 마지막 단언은 끝남 카드의 '끝' 날짜가 실제 정산 월 B의 연월인지 본다.
const FEATURES = ['personnel', 'policy', 'treaty', 'treaty-break'];
const MONTH = TICKS_PER_MONTH;
const PROPOSE_TICK = 1_000;
const ACCEPT_TICK = 1_500;
// 장수 개인 턴이 시험 동안 끼지 않게 모든 장수의 첫 턴을 멀리 둔다. 선전포고 사전 검사 tick도 이 값이다.
const IDLE_TICK = 1_000_000;
const A = { nationId: 1, generalId: 1, ruler: '불가침갑군주' } as const;
const B = { nationId: 2, generalId: 2, ruler: '불가침을군주' } as const;
const NOT_NEUTRAL = '중립 국가에만 선전포고할 수 있습니다.';

type Actor = { userId: string; page: Page; close(): Promise<void> };
type Precheck = { ok: true } | { ok: false; reason: string };
type Applied = {
  outcome: string;
  by?: string;
  tick: number;
  treatyId: string;
  cost?: { from: number; to: number };
  endTick?: number | null;
};

const panel = (page: Page) => page.getByTestId('treaty-requests');
const finished = (page: Page, outcome: string) =>
  panel(page).locator(`li[data-result="applied"][data-outcome="${outcome}"]`);
const card = (page: Page, id: number) => page.locator(`[data-testid="treaty-card"][data-treaty-id="${id}"]`);
const fact = (treatyCard: Locator, label: string) =>
  treatyCard
    .locator('dl > div')
    .filter({ has: treatyCard.page().getByText(label, { exact: true }) })
    .locator('dd');

// 시험용 계정·세션만 DB에 심는다. 장수는 월드 생성 기록에서 이 계정의 군주로 둔다.
async function account(stack: LegalStack, browser: Browser): Promise<Actor> {
  const userId = randomUUID();
  const session = newSession(Date.now());
  await stack.db.user.create({
    data: {
      id: userId,
      email: `${userId}@example.invalid`,
      emailVerifiedAt: new Date(),
      passwordHash: 'not-a-login-hash',
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return { userId, page: await context.newPage(), close: () => context.close() };
}

async function query<T>(who: Actor, path: string, input: unknown): Promise<T> {
  const response = await who.page.request.get(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

async function requestIdOf(item: Locator): Promise<string> {
  const id = await item.getAttribute('data-request-id');
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return id!;
}

test.setTimeout(240_000);

test('AC-M2-06 1개월 불가침은 원 기한 E가 지나도 다음 월 정산 B까지 유지되고 B에서 신의 벌점 없이 끝난다', async ({
  legalStack: stack,
  browser,
}) => {
  await test.info().attach('t2-07-nonaggression-expiry-scope', {
    body: JSON.stringify({
      realPostgres: true,
      realHttp: true,
      publicDist: true,
      realTurnLoop: true,
      uiProposeAndAccept: true,
      neutralHumanNations: 2,
      smallExplicitWorld: true,
      cloudflare: false,
    }),
    contentType: 'application/json',
  });
  const { db } = stack;
  const a = await account(stack, browser);
  const b = await account(stack, browser);
  let worldId: string | undefined;
  try {
    const initial = commandInitial();
    initial.seed = `t207-nonaggression-expiry-${randomUUID()}`;
    initial.ruleFeatures = FEATURES;
    initial.nations = initial.nations.map((nation) => ({ ...nation, isNpc: false }));
    initial.diplomacies = [];
    initial.generals = initial.generals.map((general) => ({
      ...general,
      nextTurnTick: IDLE_TICK,
      ...(general.id === A.generalId ? { name: A.ruler } : {}),
      ...(general.id === B.generalId ? { name: B.ruler } : {}),
    }));
    expect(initial.generals[0]).toMatchObject({ id: A.generalId, nationId: A.nationId, officerLevel: 12 });
    expect(initial.generals[1]).toMatchObject({ id: B.generalId, nationId: B.nationId, officerLevel: 12 });
    expect(initial.generals.every((general) => general.userId === null)).toBe(true);
    ({ worldId } = await saveInitialWorld(db, initial, {
      name: 'AC-M2-06 불가침 만료 공개 화면',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: FEATURES,
    }));
    const id = worldId;
    const stored = await db.world.findUniqueOrThrow({
      where: { id },
      select: { ruleFeatures: true, replayOrigin: true, clockTick: true },
    });
    expect(stored.ruleFeatures).toEqual(FEATURES);
    expect(stored.replayOrigin).toMatchObject({ version: 3, initial: { ruleFeatures: FEATURES } });
    expect(stored.replayOrigin).not.toHaveProperty('capabilities');
    // 두 군주 장수를 각 계정에 연결하고 마지막 활동을 생성 시각으로 둔다.
    for (const [who, generalId] of [
      [a, A.generalId],
      [b, B.generalId],
    ] as const)
      await db.general.update({
        where: { worldId_id: { worldId: id, id: generalId } },
        data: {
          userId: who.userId,
          lastActiveTick: stored.clockTick,
          lastActiveAt: new Date(),
          residenceTick: stored.clockTick,
        },
      });
    await controlClock(db, id, 'start');

    const advance = async (tick: number) => {
      const lease = await acquireLease(db, id, randomUUID(), 120_000);
      if (!lease) throw new Error('불가침 만료 화면 시험 실행권이 없습니다.');
      try {
        return await new TurnLoop(db, lease).advanceTo(tick);
      } finally {
        await releaseLease(db, lease);
      }
    };
    const pendingCount = (kind: string, userId: string) =>
      db.inputEvent.count({ where: { worldId: id, userId, kind, status: 'PENDING' } });
    const eventByRequest = async (kind: string, requestId: string) => {
      const rows = await db.inputEvent.findMany({ where: { worldId: id, idempotencyKey: `${kind}:${requestId}` } });
      expect(rows).toHaveLength(1);
      return rows[0]! as (typeof rows)[number] & { result: Applied };
    };
    const treatyRow = (treatyId: number) =>
      db.treaty.findUniqueOrThrow({
        where: { worldId_id: { worldId: id, id: treatyId } },
        select: {
          status: true,
          fromNationId: true,
          toNationId: true,
          startTick: true,
          endTick: true,
          costFrom: true,
          costTo: true,
          closedSequence: true,
        },
      });
    const relation = () =>
      db.diplomacy.findUnique({
        where: { worldId_nationA_nationB: { worldId: id, nationA: A.nationId, nationB: B.nationId } },
        select: { state: true, untilTick: true },
      });
    const world = () =>
      db.world.findUniqueOrThrow({ where: { id }, select: { monthlyTick: true, actionSequence: true } });
    const declare = (who: Actor, target: number) =>
      query<Precheck>(who, 'nationCommands.precheck', {
        worldId: id,
        commandKey: 'nation_declare',
        args: { nationId: target },
      });
    const expectDeclare = async (expected: Precheck) => {
      expect(await declare(a, B.nationId)).toEqual(expected);
      expect(await declare(b, A.nationId)).toEqual(expected);
    };
    const yearMonth = (tick: number) => {
      const date = toGameDate(initial.startYear, tick);
      return `${date.year}년 ${date.month}월`;
    };
    const errors: string[] = [];
    for (const page of [a.page, b.page]) page.on('pageerror', (error) => errors.push(error.message));

    // 시작: 두 사람 국가는 중립이고 서로 선전포고 사전 검사를 통과한다. 조약·신의 기록은 없다.
    expect(await relation()).toBeNull();
    await expectDeclare({ ok: true });
    expect(await db.treaty.count({ where: { worldId: id } })).toBe(0);

    // 갑 군주가 조약서 쓰기 화면에서 1개월 불가침을 보낸다. 엔진이 PROPOSE_TICK에 처리한다.
    await a.page.goto(`/w/${id}/diplomacy?tab=write`);
    await a.page.getByLabel('상대').selectOption(String(B.nationId));
    await a.page.getByLabel('불가침', { exact: true }).check();
    await a.page.getByLabel('기간(개월)').fill('1');
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    await a.page.getByRole('button', { name: '제안 보내기', exact: true }).click();
    await expect.poll(() => pendingCount('treaty.propose', a.userId)).toBe(1);
    await advance(PROPOSE_TICK);
    const proposed = finished(a.page, 'PROPOSED');
    await expect(proposed).toContainText('제안을 보냈습니다', { timeout: 30_000 });
    const proposal = await eventByRequest('treaty.propose', await requestIdOf(proposed));
    expect(proposal).toMatchObject({
      status: 'APPLIED',
      generalId: A.generalId,
      userId: a.userId,
      result: { outcome: 'PROPOSED' },
    });
    const treatyId = Number(proposal.result.treatyId);
    expect(await treatyRow(treatyId)).toMatchObject({
      status: 'PROPOSED',
      fromNationId: A.nationId,
      toNationId: B.nationId,
    });

    // 을 군주가 받은 제안 화면에서 수락한다. 엔진이 월 중간 ACCEPT_TICK에 처리한다.
    const goldBefore = await db.nation.findMany({
      where: { worldId: id, id: { in: [A.nationId, B.nationId] } },
      orderBy: { id: 'asc' },
      select: { gold: true },
    });
    await b.page.goto(`/w/${id}/diplomacy?tab=incoming`);
    const incoming = card(b.page, treatyId);
    await expect(incoming).toContainText('불가침 1개월');
    await incoming.getByRole('button', { name: '수락', exact: true }).click();
    await expect.poll(() => pendingCount('treaty.respond', b.userId)).toBe(1);
    await advance(ACCEPT_TICK);
    const accepted = finished(b.page, 'ACCEPTED');
    await expect(accepted).toContainText('조약을 맺었습니다', { timeout: 30_000 });
    const response = await eventByRequest('treaty.respond', await requestIdOf(accepted));
    expect(response).toMatchObject({
      status: 'APPLIED',
      generalId: B.generalId,
      userId: b.userId,
      tick: ACCEPT_TICK,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', tick: ACCEPT_TICK, treatyId: String(treatyId) },
    });
    const cost = response.result.cost!;
    expect(
      (
        await db.nation.findMany({
          where: { worldId: id, id: { in: [A.nationId, B.nationId] } },
          orderBy: { id: 'asc' },
          select: { gold: true },
        })
      ).map((n) => n.gold),
    ).toEqual([goldBefore[0]!.gold - cost.from, goldBefore[1]!.gold - cost.to]);

    // 원 기한 E(raw endTick)와 다음 월 정산 B를 DB 값에서 정한다.
    const active = await treatyRow(treatyId);
    const E = active.endTick!;
    expect(E).toBe(ACCEPT_TICK + MONTH);
    expect(response.result.endTick).toBe(E);
    expect(active).toMatchObject({
      status: 'ACTIVE',
      startTick: ACCEPT_TICK,
      endTick: E,
      costFrom: cost.from,
      costTo: cost.to,
      closedSequence: null,
    });
    const BOUNDARY = Math.ceil(E / MONTH) * MONTH;
    expect(BOUNDARY).toBeGreaterThan(E);
    expect(BOUNDARY - MONTH).toBeLessThan(E);
    // 이 사례가 의미 있으려면 E와 B의 달력 달이 달라야 한다.
    expect(yearMonth(E)).not.toBe(yearMonth(BOUNDARY));
    expect(await relation()).toEqual({ state: 'NON_AGGRESSION', untilTick: E });
    await expectDeclare({ ok: false, reason: NOT_NEUTRAL });

    // 갑 군주는 진행 중 탭을 연 채로 둔다. 이후 새로 고치지 않고 화면의 자동 갱신만 본다.
    await a.page.goto(`/w/${id}/diplomacy?tab=active`);
    const activeCard = card(a.page, treatyId);
    await expect(activeCard).toContainText('진행 중');
    await expect(activeCard.getByRole('region', { name: '서버가 집행하는 조항' })).toContainText('불가침');
    await a.page.evaluate(() => {
      (window as unknown as { __t207NoReload?: boolean }).__t207NoReload = true;
    });
    // 호출한 뒤에 새로 나간 목록 요청 하나의 응답까지 기다린다. 그 전에 나간 요청은 엔진 commit 전 상태일 수 있다.
    const nextList = async () => {
      const request = await a.page.waitForRequest((r) => r.url().includes('treaty.list') && r.method() === 'GET', {
        timeout: 30_000,
      });
      expect((await request.response())?.status()).toBe(200);
    };

    // E와 B−1: 원 기한은 지났거나 같지만 월 정산 전이라 ACTIVE·불가침 관계가 남고 선전포고는 막힌다.
    for (const tick of [E, BOUNDARY - 1]) {
      await advance(tick);
      expect(await world()).toMatchObject({ monthlyTick: BOUNDARY - MONTH });
      expect(await treatyRow(treatyId)).toMatchObject({ status: 'ACTIVE', endTick: E, closedSequence: null });
      expect(await relation()).toEqual({ state: 'NON_AGGRESSION', untilTick: E });
      await expectDeclare({ ok: false, reason: NOT_NEUTRAL });
      // 진행 중 탭이 이 시점 이후의 목록을 한 번 더 받은 뒤에도 카드가 남아 있다.
      await nextList();
      await expect(activeCard).toContainText('진행 중');
    }

    // B: 월 정산이 조약을 ENDED로 닫고 관계 행을 지운다. 닫은 sequence는 이 월 정산의 sequence다.
    await advance(BOUNDARY);
    const atBoundary = await world();
    expect(atBoundary.monthlyTick).toBe(BOUNDARY);
    const ended = await treatyRow(treatyId);
    expect(ended).toMatchObject({
      status: 'ENDED',
      startTick: ACCEPT_TICK,
      endTick: E,
      costFrom: cost.from,
      costTo: cost.to,
    });
    expect(ended.closedSequence).toBe(atBoundary.actionSequence);
    expect(ended.closedSequence!).toBeGreaterThan(Number(response.sequence));
    expect(await relation()).toBeNull();

    // 열어 둔 진행 중 탭은 새로 고치지 않아도 카드를 뺀다.
    await expect(activeCard).toHaveCount(0, { timeout: 30_000 });
    expect(
      await a.page.evaluate(() => (window as unknown as { __t207NoReload?: boolean }).__t207NoReload === true),
    ).toBe(true);

    // 만료 뒤에는 서로 다시 선전포고할 수 있다. 기한 만료는 파기가 아니라 신의 기록이 생기지 않는다.
    await expectDeclare({ ok: true });
    expect(await db.nationTrust.findMany({ where: { worldId: id } })).toEqual([]);
    expect(ended.status).not.toBe('BROKEN');

    // 끝남 탭에 같은 조약 카드가 끝남으로 보인다.
    await a.page.goto(`/w/${id}/diplomacy?tab=ended`);
    const endedCard = card(a.page, treatyId);
    await expect(endedCard).toContainText('끝남');
    await expect(endedCard.getByRole('region', { name: '서버가 집행하는 조항' })).toContainText('불가침');
    await expect(fact(endedCard, '시작')).toHaveText(yearMonth(ACCEPT_TICK));
    await expect(fact(endedCard, '끝')).toHaveCount(1);
    expect(errors).toEqual([]);

    // 끝 날짜는 raw endTick E가 아니라 실제로 정산한 월 B의 달력 달이다.
    await expect(
      fact(endedCard, '끝'),
      `끝 날짜는 실제 종료 월 정산 B(${BOUNDARY})의 ${yearMonth(BOUNDARY)}이어야 합니다. raw endTick ${E}의 ${yearMonth(E)}가 아닙니다.`,
    ).toHaveText(yearMonth(BOUNDARY));
  } finally {
    try {
      await a.close();
      await b.close();
    } finally {
      // 이 시험이 자기 DB에 만든 월드만 지운다. 묶음 DB 자체는 legalFixture가 정리한다.
      if (worldId) await db.world.deleteMany({ where: { id: worldId } });
    }
  }
});
