import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { governanceStateSchema, type GovernanceConfig } from '../packages/rules/src/index';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from '../tools/integration-resources';
import { test as legalTest, expect, type LegalStack } from './legalFixture';

// AC-P2-31·35 실제 공개 빌드·HTTP·PG·엔진 화면 검증이다.
// 원생성 NPC의 계정 연결과 일정을 통제한다. 사람 원생성·정식491·전체 기수·CF 증거는 아니다.
const panel = (page: Page) => page.getByRole('region', { name: '황실', exact: true });
async function fixture(stack: LegalStack, browser: Browser) {
  await initializeIntegrationResources(stack.db);
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: randomUUID(),
  });
  const rulers = initial.generals.filter(
    (general) =>
      general.nationId !== null &&
      general.officerLevel === 12 &&
      general.activeFromYear <= initial.startYear &&
      initial.cities.some(
        (city) =>
          city.nationId === general.nationId &&
          city.kind !== 'PASS' &&
          city.population >= 100_000 &&
          city.commerce >= 1000,
      ),
  );
  const ruler = rulers[0]!,
    lower = rulers.find((general) => general.nationId !== ruler.nationId)!;
  if (!ruler || !lower) throw new Error('화면 검증에 필요한 두 군주가 없습니다.');
  const seat = initial.cities.find(
    (city) =>
      city.nationId === ruler.nationId && city.kind !== 'PASS' && city.population >= 100_000 && city.commerce >= 1000,
  )!;
  const outsider = initial.generals.find(
    (general) =>
      general.nationId !== null &&
      general.nationId !== ruler.nationId &&
      general.nationId !== lower.nationId &&
      general.activeFromYear <= initial.startYear,
  )!;
  const config: GovernanceConfig = {
    version: 1,
    seatCityKey: seat.cityKey,
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
    npc: { cityRatio: 10_000, acceptMaxBp: 2000, offerBp: 1000, cooldownMonths: 6 },
    limits: { sentOffers: 3, receivedOffers: 3, worldOffers: 100 },
  };
  initial.generals = initial.generals.map((general) => ({ ...general, crew: 0, nextTurnTick: 1_000_000 }));
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
  initial.ruleFeatures = features;
  const { worldId } = await saveInitialWorld(stack.db, initial, {
    name: '황실 화면 검증',
    turnTermMinutes: 60,
    endYear: initial.startYear + 10,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: { 'governance-v1': config },
  });
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const accounts = new Map<number, string>();
  async function loginAs(generalId: number) {
    let token = accounts.get(generalId);
    if (!token) {
      const id = randomUUID(),
        session = newSession(Date.now());
      await stack.db.user.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          emailVerifiedAt: new Date(),
          passwordHash: 'not-a-login-hash',
          sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
        },
      });
      const tick = (await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick;
      await stack.db.general.update({
        where: { worldId_id: { worldId, id: generalId } },
        data: { userId: id, lastActiveTick: tick, lastActiveAt: new Date(), residenceTick: tick },
      });
      token = session.token;
      accounts.set(generalId, token);
    }
    await context.addCookies([{ name: 'sid', value: token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  }
  const advance = async (tick = 10_000) => {
    const lease = await acquireLease(stack.db, worldId);
    if (!lease) throw new Error('황실 화면 검증 실행권이 없습니다.');
    try {
      await new TurnLoop(stack.db, lease).advanceTo(tick);
    } finally {
      await releaseLease(stack.db, lease);
    }
  };
  await loginAs(lower.id);
  await loginAs(ruler.id);
  await controlClock(stack.db, worldId, 'start');
  await advance();
  const funded = await stack.db.$transaction((tx) => loadWorld(tx, worldId));
  expect(funded.cityResources!.cities[String(seat.cityKey)]!.gold).toBeGreaterThanOrEqual(100);
  const state = async () =>
    governanceStateSchema.parse((await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).governanceState);
  expect((await state()).throne.emperorGeneralId).toBeNull();
  const orders = () =>
    stack.db.inputEvent.findMany({ where: { worldId, kind: 'governance.act' }, orderBy: { createdAt: 'asc' } });
  const apply = async (count: number) => {
    await expect.poll(async () => (await orders()).length).toBe(count);
    await advance((await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
    await expect.poll(async () => (await orders()).filter((row) => row.status === 'APPLIED').length).toBe(count);
    await expect(panel(page).getByText('요청 처리 대기', { exact: true })).toHaveCount(0);
  };
  await page.goto(`/w/${worldId}`);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: '황위', exact: true })).toBeVisible();
  return {
    page,
    context,
    stack,
    worldId,
    ruler,
    lower,
    outsider,
    seat,
    errors,
    state,
    orders,
    advance,
    apply,
    loginAs,
  };
}
const test = legalTest.extend<{ game: Awaited<ReturnType<typeof fixture>> }>({
  game: async ({ legalStack, browser }, use, info) => {
    const game = await fixture(legalStack, browser);
    try {
      await info.attach('governance-scope', {
        body: JSON.stringify({
          realPostgres: true,
          realHttp: true,
          publicDist: true,
          controlledNpcBinding: true,
          originRecordedNpcSchedule: true,
          originalHumanCreation: false,
          full491: false,
          cloudflare: false,
        }),
        contentType: 'application/json',
      });
      await use(game);
      expect(game.errors).toEqual([]);
    } finally {
      await game.context.close();
      // 화면이 자동 접수한 활동 입력도 자기 엔진에서 끝낸 뒤 HTTP 고정물을 닫는다.
      await game.advance((await game.stack.db.world.findUniqueOrThrow({ where: { id: game.worldId } })).clockTick);
    }
  },
});
test.setTimeout(120_000);
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button').first().click();
}
async function ascend(game: Awaited<ReturnType<typeof fixture>>) {
  await panel(game.page).getByRole('button', { name: '즉위 요청', exact: true }).first().click();
  await confirm(game.page);
  await game.apply(1);
  expect((await game.state()).throne.emperorGeneralId).toBe(game.ruler.id);
}

test('AC-P2-31 명시 즉위·확인 초점·대기 새로고침은 실제 요청 하나만 처리한다', async ({ game }) => {
  const { page } = game;
  const button = panel(page).getByRole('button', { name: '즉위 요청', exact: true }).first();
  await button.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '즉위 요청 보내기' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(await game.orders()).toEqual([]);
  await button.click();
  await confirm(page);
  await expect.poll(async () => (await game.orders()).length).toBe(1);
  const first = (await game.orders())[0]!;
  expect((await game.state()).throne.emperorGeneralId).toBeNull();
  await page.reload();
  await expect(panel(page).getByText('요청 처리 대기', { exact: true })).toBeVisible();
  expect((await game.orders()).map((row) => row.idempotencyKey)).toEqual([first.idempotencyKey]);
  await expect(panel(page).getByRole('button', { name: '즉위 요청', exact: true })).toHaveCount(0);
  await game.apply(1);
  expect((await game.state()).throne.emperorGeneralId).toBe(game.ruler.id);
  await expect(panel(page).getByRole('button', { name: '퇴위 요청', exact: true }).first()).toBeVisible();
});

test('AC-P2-31 봉신·직위는 상대 동의 뒤에만 생기고 월 봉록을 지급한다', async ({ game }) => {
  const { page } = game;
  await ascend(game);
  await panel(page).getByRole('tab', { name: '봉신', exact: true }).click();
  const form = panel(page).getByRole('form', { name: '봉신 제안', exact: true });
  await form.getByRole('combobox', { name: '상대 국가', exact: true }).selectOption(String(game.lower.nationId));
  await form.getByLabel('금 공납 비율(%)', { exact: true }).fill('10');
  await form.getByLabel('쌀 공납 비율(%)', { exact: true }).fill('5');
  await form.getByRole('button', { name: '제안 보내기', exact: true }).click();
  await confirm(page);
  await game.apply(2);
  expect((await game.state()).vassals).toHaveLength(0);
  await game.loginAs(game.lower.id);
  await page.reload();
  await panel(page).getByRole('tab', { name: /^제안/ }).click();
  await panel(page).getByRole('button', { name: /수락/ }).first().click();
  await confirm(page);
  await game.apply(3);
  expect((await game.state()).vassals).toHaveLength(1);
  await game.loginAs(game.ruler.id);
  await page.reload();
  await panel(page).getByRole('tab', { name: '조정', exact: true }).click();
  await panel(page).getByRole('combobox', { name: '직위', exact: true }).selectOption('chancellor');
  await panel(page)
    .getByRole('combobox', { name: '대상 장수 (황제국 계열)', exact: true })
    .selectOption(String(game.lower.id));
  await panel(page).getByRole('button', { name: '임명 제안 보내기', exact: true }).click();
  await confirm(page);
  await game.apply(4);
  expect((await game.state()).court.chancellor).toBeNull();
  await game.loginAs(game.lower.id);
  await page.reload();
  await panel(page).getByRole('tab', { name: /^제안/ }).click();
  await panel(page).getByRole('button', { name: /수락/ }).first().click();
  await confirm(page);
  await game.apply(5);
  expect((await game.state()).court.chancellor?.generalId).toBe(game.lower.id);
  const before = (
    await game.stack.db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: game.worldId, id: game.lower.id } },
    })
  ).gold;
  await game.advance(20_000);
  const after = (
    await game.stack.db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: game.worldId, id: game.lower.id } },
    })
  ).gold;
  expect(after - before).toBe(100);
  await page.reload();
  await panel(page).getByRole('tab', { name: '기록', exact: true }).click();
  await expect(panel(page).getByRole('cell', { name: /봉록/ })).toBeVisible();
  await game.loginAs(game.outsider.id);
  await page.reload();
  await panel(page).getByRole('tab', { name: '기록', exact: true }).click();
  await expect(panel(page).getByText(/볼 수 있는 기록이 없습니다/)).toBeVisible();
  await expect(panel(page).getByRole('table')).toHaveCount(0);
});

test('AC-P2-35 다섯 황실 탭은 375·768·1440 폭에서 가로 넘침 없이 열리고 폼을 보존한다', async ({ game }, info) => {
  const { page } = game;
  await ascend(game);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await panel(page).scrollIntoViewIfNeeded();
    for (const name of ['황위', '조정', '봉신', '제안', '기록']) {
      await panel(page)
        .getByRole('tab', { name: new RegExp(`^${name}`) })
        .click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await panel(page).getByRole('tab', { name: '봉신', exact: true }).click();
    const rate = panel(page).getByLabel('금 공납 비율(%)', { exact: true });
    await rate.fill('12.34');
    await expect(rate).toHaveValue('12.34');
    const all = panel(page)
      .locator('details')
      .filter({ has: page.getByText(/^전체 계열도 \(공개\)/) });
    const disclosure = all.locator('summary');
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(all).toHaveAttribute('open', '');
    await expect(all.getByRole('list', { name: '전체 봉신 계열도', exact: true }).getByRole('listitem')).toHaveCount(
      Object.keys((await game.state()).legitimacy).length,
    );
    await expect(rate).toHaveValue('12.34');
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(all).not.toHaveAttribute('open');
    await expect(rate).toHaveValue('12.34');
    await info.attach(`governance-${width}`, {
      body: await panel(page).screenshot({ path: info.outputPath(`governance-${width}.png`) }),
      contentType: 'image/png',
    });
  }
  expect((await game.orders()).length).toBe(1);
});

test('AC-P2-35 계정 전환은 이전 계정의 확인창을 버리고 새 계정으로 전송하지 않는다', async ({ game }) => {
  const { page } = game;
  await panel(page).getByRole('button', { name: '즉위 요청', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await game.loginAs(game.lower.id);
  const fresh = page.waitForResponse((response) => response.url().includes('/trpc/governance.get'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const raw = await (await fresh).json();
  const board = (Array.isArray(raw) ? raw[0] : raw).result.data;
  expect(board.view.ownNationId).toBe(game.lower.nationId);
  await expect(panel(page).getByRole('tab', { name: '황위', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '즉위 요청 보내기', exact: true })).toHaveCount(0);
  expect(await game.orders()).toEqual([]);
  expect((await game.state()).throne.emperorGeneralId).toBeNull();
});
