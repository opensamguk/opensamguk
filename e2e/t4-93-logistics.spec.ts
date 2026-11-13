import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from '../tools/integration-resources';
import { test as legalTest, expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { trpcCalls } from './t210-fixture';

// AC-P2-30/35 화면 증분. 실제 공개 dist·PG·HTTP·엔진을 쓴다.
// origin에 기록한 NPC 일정과 시험 계정 바인딩·위치를 통제한다. 사람 원생성/정식491/CF 증거가 아니다.
async function fixture(stack: LegalStack, browser: Browser) {
  await initializeIntegrationResources(stack.db);
  const initial = await loadInitialWorldFromDb(stack.db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: randomUUID(),
  });
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
  initial.ruleFeatures = features;
  const cavalry = initial.unitSet.crewTypes.find((unit) => unit.armType === 3)!;
  cavalry.name = '긴 이름의 기병 부대 비용 확인';
  initial.generals = initial.generals.map((row) => ({ ...row, crew: 0, nextTurnTick: 1_000_000 }));
  const source = initial.cities.find(
    (city) =>
      city.kind !== 'PASS' &&
      city.supplied &&
      city.nationId !== null &&
      initial.cities.some(
        (other) => city.connections.includes(other.cityKey) && other.nationId === city.nationId && other.supplied,
      ) &&
      initial.generals.some(
        (general) =>
          general.nationId === city.nationId &&
          general.officerLevel === 12 &&
          general.activeFromYear <= initial.startYear,
      ),
  );
  if (!source) throw new Error('실제 원생성에 연결된 자국 거점과 군주가 없습니다.');
  const destination = initial.cities.find(
    (city) => source.connections.includes(city.cityKey) && city.nationId === source.nationId && city.supplied,
  )!;
  const ruler = initial.generals.find(
    (general) =>
      general.nationId === source.nationId &&
      general.officerLevel === 12 &&
      general.activeFromYear <= initial.startYear,
  )!;
  const other = initial.generals.find(
    (general) =>
      general.nationId !== null && general.nationId !== source.nationId && general.activeFromYear <= initial.startYear,
  )!;
  const config = {
    version: 1,
    specialties: [{ cityKey: source.cityKey, good: 'iron', perMonth: 1000 }],
    capacity: { base: 100_000, perLevel: 10_000, maxLevel: 2 },
    upgrade: { gold: 1, wood: 1 },
    transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 1000, maxActivePerNation: 20 },
    recruitPer100: Object.fromEntries(
      [...new Set(initial.unitSet.crewTypes.filter((row) => row.armType > 0).map((row) => row.armType))].map(
        (armType) => [String(armType), { iron: 2, wood: 0, horses: armType === 3 ? 2_147_483_647 : 0 }],
      ),
    ),
    build: { wall: { iron: 0, wood: 1, horses: 0 }, defence: { iron: 1, wood: 1, horses: 0 } },
    trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
  };
  const { worldId } = await saveInitialWorld(stack.db, initial, {
    name: '물류 화면 검증',
    turnTermMinutes: 60,
    endYear: initial.startYear + 10,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: { 'logistics-v1': config },
  });
  const advance = async (tick: number) => {
    const lease = await acquireLease(stack.db, worldId);
    if (!lease) throw new Error('화면 시험 실행권을 얻지 못했습니다.');
    try {
      await new TurnLoop(stack.db, lease).advanceTo(tick);
    } finally {
      await releaseLease(stack.db, lease);
    }
  };
  await controlClock(stack.db, worldId, 'start');
  await advance(10_000);
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const loginAs = async (generalId: number) => {
    const id = randomUUID(),
      session = newSession(Date.now());
    await stack.db.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword(TEST_PASSWORD),
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    await stack.db.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: {
        userId: id,
        cityKey: source.cityKey,
        lastActiveTick: 10_000,
        lastActiveAt: new Date(),
        residenceTick: 10_000,
      },
    });
    await context.addCookies([
      { name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' },
    ]);
    return id;
  };
  const userId = await loginAs(ruler.id);
  // 물류 칸은 도시 화면에 있다 (INT-25). 메인 도시 칸에는 링크만 둔다.
  await page.goto(`/w/${worldId}/city/${source.cityKey}`);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: '보내기', exact: true })).toBeVisible();
  const orders = () =>
    stack.db.inputEvent.findMany({ where: { worldId, kind: 'logistics.order' }, orderBy: { createdAt: 'asc' } });
  const apply = async (expectedCount: number, tick = 10_000, notice = /수송대 \d+가 출발했습니다\./) => {
    await expect.poll(async () => (await orders()).length).toBe(expectedCount);
    await advance(tick);
    await expect
      .poll(async () => (await orders()).filter((row) => row.status === 'APPLIED').length)
      .toBe(expectedCount);
    await expect(panel(page).getByText('요청 처리 대기', { exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('status').filter({ hasText: notice })).toBeVisible();
  };
  return {
    stack,
    context,
    page,
    worldId,
    source,
    destination,
    ruler,
    other,
    userId,
    loginAs,
    advance,
    orders,
    apply,
    cavalryId: cavalry.id,
  };
}
const panel = (page: Page) => page.getByRole('region', { name: '도시 물류', exact: true });
const test = legalTest.extend<{ game: Awaited<ReturnType<typeof fixture>> }>({
  game: async ({ legalStack, browser }, use, info) => {
    const game = await fixture(legalStack, browser);
    try {
      await info.attach('logistics-fixture-scope', {
        body: JSON.stringify({
          worldId: game.worldId,
          realPostgres: true,
          realHttp: true,
          publicDist: true,
          controlledNpcBinding: true,
          controlledPlacement: true,
          controlledUnitNameAndMaximumCost: true,
          originRecordedNpcSchedule: true,
          originalHumanCreation: false,
          full491: false,
          cloudflare: false,
        }),
        contentType: 'application/json',
      });
      await use(game);
    } finally {
      await game.context.close();
    }
  },
});
test.setTimeout(120_000);
async function send(game: Awaited<ReturnType<typeof fixture>>, amount = '100') {
  const view = panel(game.page);
  await view.getByRole('tab', { name: '보내기', exact: true }).click();
  await view.getByRole('combobox', { name: '도착지', exact: true }).selectOption(String(game.destination.cityKey));
  await view.getByLabel(/^철 \(보유/).fill(amount);
  await view.getByRole('button', { name: '보내기 요청', exact: true }).click();
}

test('AC-P2-30 실제 수송·취소·도착·교역·증축과 새로고침 복구', async ({ game }, info) => {
  const { page, stack, worldId } = game;
  await send(game);
  await expect.poll(async () => (await game.orders()).length).toBe(1);
  const first = (await game.orders())[0]!;
  await page.reload();
  await expect(panel(page).getByText('요청 처리 대기', { exact: true })).toBeVisible();
  expect((await game.orders()).map((row) => row.idempotencyKey)).toEqual([first.idempotencyKey]);
  await game.apply(1);
  await panel(page)
    .getByRole('tab', { name: /^수송대/ })
    .click();
  const cancel = panel(page).getByRole('button', { name: /^수송대 \d+ 취소$/ });
  await cancel.click();
  await expect(panel(page).getByRole('group', { name: /^수송대 \d+ 취소 확인$/ })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '취소 요청 보내기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cancel).toBeFocused();
  await cancel.click();
  await panel(page).getByRole('button', { name: '취소 요청 보내기', exact: true }).click();
  await game.apply(2, 10_000, /수송대를 취소하고 화물을 출발지로 돌려보냈습니다/);
  await send(game);
  await game.apply(3);
  await game.advance(20_000);
  await page.reload();
  await page.getByRole('button', { name: game.destination.name, exact: true }).first().click();
  await expect(panel(page).getByRole('heading', { name: '도시 물류' })).toBeVisible();
  const state = await stack.db.world.findUniqueOrThrow({ where: { id: worldId } });
  const stock = state.logisticsState as { cities: Record<string, { iron: number }> };
  expect(stock.cities[String(game.destination.cityKey)]!.iron).toBe(99);
  await expect(panel(page).getByRole('img', { name: '공용 창고 99 / 100,000 사용', exact: true })).toBeVisible({
    timeout: 25_000,
  });
  await panel(page).getByRole('tab', { name: '기록', exact: true }).click();
  await expect(panel(page).getByText('도착', { exact: true })).toBeVisible();
  await page.goto(`/w/${worldId}/city/${game.source.cityKey}`);
  await expect(panel(page).getByRole('button', { name: '보내기 요청', exact: true })).toBeVisible();
  await panel(page).getByRole('tab', { name: '교역', exact: true }).click();
  await panel(page).getByRole('combobox', { name: '재화', exact: true }).selectOption('wood');
  await panel(page).getByLabel('수량', { exact: true }).fill('10');
  await panel(page).getByRole('button', { name: '교역 요청', exact: true }).click();
  await game.apply(4, 20_000, /교역/);
  await panel(page).getByRole('tab', { name: '창고 증축', exact: true }).click();
  await panel(page).getByRole('button', { name: '증축 요청', exact: true }).click();
  await game.apply(5, 20_000, /창고를 증축했습니다/);
  const upgraded = (await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).logisticsState as {
    cities: Record<string, { level: number; wood: number }>;
  };
  expect(upgraded.cities[String(game.source.cityKey)]).toMatchObject({ level: 1, wood: 9 });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel(page).scrollIntoViewIfNeeded();
    expect(await panel(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const path = info.outputPath(`logistics-${width}.png`);
    await panel(page).screenshot({ path });
    await info.attach(`logistics-${width}`, { path, contentType: 'image/png' });
  }
});

test('AC-P2-35 응답 유실 뒤 같은 번호로만 수동 복구하고 재조회 실패에도 입력을 보존한다', async ({ game }) => {
  let abortSubmit = true,
    abortRefresh = false;
  const submitted: unknown[] = [];
  await game.page.route('**/trpc/**', async (route) => {
    const calls = trpcCalls(route.request());
    const submit = calls.find((call) => call.path === 'logistics.submit');
    if (submit) {
      submitted.push(submit.input);
      if (abortSubmit) {
        abortSubmit = false;
        await route.abort('connectionfailed');
        return;
      }
    }
    if (abortRefresh && calls.some((call) => call.path === 'logistics.get')) {
      abortRefresh = false;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });
  await send(game, '11');
  await expect(panel(game.page).getByRole('button', { name: '같은 요청 상태 확인', exact: true })).toBeEnabled();
  await panel(game.page).getByRole('button', { name: '같은 요청 상태 확인', exact: true }).click();
  await expect(panel(game.page).getByRole('button', { name: '같은 요청 다시 접수', exact: true })).toBeVisible();
  expect(await game.orders()).toEqual([]);
  await panel(game.page).getByRole('button', { name: '같은 요청 다시 접수', exact: true }).click();
  await game.apply(1);
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  const view = panel(game.page);
  await view.getByRole('combobox', { name: '도착지', exact: true }).selectOption(String(game.destination.cityKey));
  await view.getByLabel(/^철 \(보유/).fill('17');
  abortRefresh = true;
  await expect(view.getByRole('button', { name: '새로 확인', exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(view.getByLabel(/^철 \(보유/)).toHaveValue('17');
  await expect(view.getByRole('button', { name: '보내기 요청', exact: true })).toBeDisabled();
  await view.getByRole('button', { name: '새로 확인', exact: true }).click();
  await expect(view.getByRole('button', { name: '보내기 요청', exact: true })).toBeEnabled();
  await expect(view.getByLabel(/^철 \(보유/)).toHaveValue('17');
  expect((await game.orders()).length).toBe(1);
});

test('AC-P2-35 직책 미달은 지시를 막고 계정 변경 뒤 타국에는 특산만 보인다', async ({ game }) => {
  const { page, stack, worldId } = game;
  await stack.db.general.update({ where: { worldId_id: { worldId, id: game.ruler.id } }, data: { officerLevel: 4 } });
  await page.reload();
  await expect(panel(page).getByRole('button', { name: '보내기 요청', exact: true })).toBeDisabled();
  expect(await game.orders()).toEqual([]);
  await game.loginAs(game.other.id);
  await page.reload();
  await expect(panel(page).getByText(/특산 철/)).toBeVisible();
  await expect(panel(page).getByRole('tab')).toHaveCount(0);
  await expect(panel(page).getByRole('form')).toHaveCount(0);
  await expect(panel(page).getByText('요청 처리 대기', { exact: true })).toHaveCount(0);
  expect(await game.orders()).toEqual([]);
});

test('AC-P2-30 비용 미리보기는 큰 수와 긴 이름을 표시하고 재조회해도 입력을 지키며 명령을 접수하지 않는다', async ({
  game,
}, info) => {
  const { page } = game;
  let reads = 0;
  page.on('request', (request) => {
    if (trpcCalls(request).some((call) => call.path === 'logistics.get')) reads++;
  });
  const costs = panel(page)
    .locator('details')
    .filter({ has: page.getByText('모병·투자 재화 비용', { exact: true }) });
  await costs.locator('summary').focus();
  await page.keyboard.press('Enter');
  await costs.getByRole('combobox', { name: '병종', exact: true }).selectOption(String(game.cavalryId));
  const people = costs.getByRole('spinbutton', { name: /^모집 인원/ });
  await people.fill('1000000');
  await expect(costs.getByLabel('모병 예상 소비')).toContainText('말 21,474,836,470,000');
  await expect(
    costs
      .getByRole('note')
      .filter({ hasText: /지금 재고로는/ })
      .first(),
  ).toBeVisible();
  const before = reads;
  await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThan(before);
  await expect(people).toHaveValue('1000000');
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await costs.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach(`logistics-costs-${width}`, {
      body: await costs.screenshot({ path: info.outputPath(`logistics-costs-${width}.png`) }),
      contentType: 'image/png',
    });
  }
  await costs.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(people).toBeHidden();
  expect(await game.orders()).toEqual([]);
});
