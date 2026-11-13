import { randomUUID } from 'node:crypto';
import type { Browser, Locator } from '@playwright/test';
import {
  buildCreatedGeneral,
  buildInitialWorld,
  STANDARD_EQUIPMENT_CONFIG,
  logisticsStateSchema,
} from '../packages/rules/src/index';
import { operationalInput } from '../packages/rules/test/operationalMapFixture';
import { TEST_EQUIPMENT_LOGISTICS_CONFIG } from '../packages/rules/src/equipment/testFixture';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { test, expect, type LegalStack } from './legalFixture';

async function textContrast(locator: Locator) {
  return locator.evaluate((node) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const luminance = (values: number[]) =>
      values.slice(0, 3).reduce((sum, value, index) => {
        const channel = value / 255;
        return (
          sum +
          (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
        );
      }, 0);
    let background: Element | null = node;
    while (background) {
      const color = rgb(getComputedStyle(background).backgroundColor);
      if (color.length === 3 || color[3] === 1) {
        const a = luminance(rgb(getComputedStyle(node).color)),
          b = luminance(color);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }
      background = background.parentElement;
    }
    throw Error('실제 불투명 배경색이 없습니다.');
  });
}

// AC-P2-12·30·34: 인공 3도시·2NPC의 실제 공개 웹·HTTP·PG·엔진이다. 성장·재생·정식491·전체 기수 증거는 아니다.
async function actor(stack: LegalStack, browser: Browser) {
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
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return { id, context, page: await context.newPage() };
}

test('T4-24 장비 카드 예약·실제 매매·100 초과 표시와 세 화면 폭', async ({ legalStack: stack, browser }, info) => {
  test.setTimeout(120000);
  const player = await actor(stack, browser),
    page = player.page,
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const input = operationalInput(),
    template = input.map.sites.find((site) => site.kind === 'CITY')!;
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
  const initial = buildInitialWorld(input),
    payload = {
      name: '장비화면',
      leadership: 40,
      strength: 90,
      intel: 40,
      politics: 50,
      charm: 55,
      portraitId: null,
    };
  initial.generals = initial.generals.map((general) => ({ ...general, crew: 0, nextTurnTick: 1_000_000_000 }));
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'NON_AGGRESSION', untilTick: 1_000_000 }];
  let selected = false;
  for (let index = 0; index < 100; index++) {
    initial.seed = `equipment-browser-${index}`;
    const created = buildCreatedGeneral({
      id: 3,
      userId: player.id,
      payload,
      seed: initial.seed,
      startYear: initial.startYear,
      tick: 0,
      monthlyTick: 0,
      cityKeys: [1, 2, 3],
      unitSet: initial.unitSet,
    });
    if (created.cityKey === 3 && created.nextTurnTick > 2 && created.nextTurnTick < 10000) {
      selected = true;
      break;
    }
  }
  expect(selected).toBe(true);
  const features = [
    'campaign-assignment-v2',
    'campaign-v1',
    'city-resources-v1',
    'equipment-v1',
    'five-stats',
    'logistics-v1',
    'operational-map',
    'personnel',
    'policy',
  ].sort();
  initial.ruleFeatures = features;
  const logistics = structuredClone(TEST_EQUIPMENT_LOGISTICS_CONFIG);
  logistics.capacity.base = 10000;
  logistics.specialties = [{ cityKey: 3, good: 'iron', perMonth: 500 }];
  const { worldId } = await saveInitialWorld(stack.db, initial, {
    name: '장비 화면 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: features,
    featureData: { 'logistics-v1': logistics, 'equipment-v1': STANDARD_EQUIPMENT_CONFIG },
  });
  const advance = async (tick: number) => {
    const lease = await acquireLease(stack.db, worldId, randomUUID(), 120000);
    if (!lease) throw Error('장비 화면 검증 실행권이 없습니다.');
    try {
      await new TurnLoop(stack.db, lease).advanceTo(tick);
    } finally {
      await releaseLease(stack.db, lease);
    }
  };
  const general = () =>
    stack.db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: player.id } } });
  const order = async (commandKey: string, args: unknown) => {
    const g = await general();
    const response = await page.request.post('/trpc/turns.set', {
      headers: { origin: stack.origin },
      data: {
        worldId,
        revision: g.turnRevision,
        slots: Array.from({ length: 30 }, (_, index) => (index === 0 ? { commandKey, args } : null)),
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    await advance(g.nextTurnTick - 1);
    await advance(g.nextTurnTick);
  };
  try {
    await controlClock(stack.db, worldId, 'start');
    const creation = page.request.post('/trpc/general.create', {
      headers: { origin: stack.origin },
      data: { worldId, ...payload },
    });
    await expect
      .poll(() => stack.db.inputEvent.count({ where: { worldId, userId: player.id, status: 'PENDING' } }))
      .toBe(1);
    await advance(0);
    expect((await creation).status()).toBe(200);
    await order('found', { name: '장비국', color: '#334455' });
    await order('trade_rice', { amount: 1000, buy: false });
    // 성장 완료 고정물이다. 생성 상한90을 바꾸거나 성장 과정의 증거로 세지 않는다.
    await stack.db.general.update({
      where: { worldId_userId: { worldId, userId: player.id } },
      data: { strength: 100 },
    });
    await advance((await general()).nextTurnTick - 1);
    const before = await general();
    const stock = logisticsStateSchema.parse(
      (await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).logisticsState,
    ).cities['3']!.iron;
    await page.goto(`/w/${worldId}`);
    const editor = page.getByTestId('turn-editor'),
      picker = editor.getByRole('region', { name: '명령 고르기', exact: true });
    // 768px 미만 메인은 하단 막대로 패널을 하나씩 본다 (INT-25). 장수 칸은 `현황`, 예턴은 `예턴` 패널이다.
    // 인자 입력 화면(모달)을 연 동안에는 그 패널이 늘 그려지므로 막대를 누르지 않는다.
    const showPanel = async (name: '현황' | '예턴') => {
      if ((page.viewportSize()?.width ?? 1440) >= 768) return;
      const tab = page.getByRole('tablist', { name: '메인 화면', exact: true }).getByRole('tab', { name, exact: true });
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
    };
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByRole('searchbox').fill('장비');
    await editor.getByRole('radio', { name: '장비매매', exact: true }).check();
    const slot = picker.getByRole('combobox', { name: '장비 칸', exact: true }),
      item = picker.getByRole('combobox', { name: '매매할 장비', exact: true });
    await slot.selectOption('weapon');
    await item.selectOption('weapon_01');
    await expect(picker.getByText('금 1,000 · 무력 +1', { exact: false }).last()).toBeVisible();
    await expect(picker.getByText('철 5', { exact: false }).last()).toBeVisible();
    await slot.focus();
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
    for (const colorScheme of ['light', 'dark'] as const)
      for (const width of [375, 768, 1440]) {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 900 });
        for (const control of [slot, item, picker.getByRole('button', { name: '1번 칸에 넣기', exact: true })]) {
          const box = (await control.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await picker.screenshot({ path: info.outputPath(`t4-24-trade-${colorScheme}-${width}.png`) });
      }
    await picker.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    expect(
      await stack.db.generalTurn.findUniqueOrThrow({
        where: { worldId_generalId_slot: { worldId, generalId: before.id, slot: 0 } },
      }),
    ).toMatchObject({ commandKey: 'equipment_trade', args: { slot: 'weapon', itemKey: 'weapon_01' } });
    await advance(before.nextTurnTick);
    // SSE가 실제 저장 결과를 다시 조회해야 한다. 새로고침으로 갱신 누락을 숨기지 않는다.
    const equipment = page.getByRole('region', { name: '장착 장비', exact: true });
    await expect(equipment.getByText('단도', { exact: true })).toBeVisible();
    const generalPanel = page.locator('[data-general-id]');
    await expect(generalPanel.getByText('101', { exact: true })).toBeVisible();
    await expect(generalPanel.getByText('기본 100 + 장비 1', { exact: true })).toBeVisible();
    const bought = await general();
    expect(bought.strength).toBe(100);
    expect(bought.gold).toBe(before.gold - 1000);
    expect(
      logisticsStateSchema.parse((await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).logisticsState)
        .cities['3']!.iron,
    ).toBe(stock - 5);
    for (const colorScheme of ['light', 'dark'] as const)
      for (const width of [375, 768, 1440]) {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 900 });
        await showPanel('현황');
        await generalPanel.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await generalPanel.screenshot({ path: info.outputPath(`t4-24-stats-${colorScheme}-${width}.png`) });
        expect(await textContrast(generalPanel.getByText('기본 100 + 장비 1', { exact: true }))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    // 넣으면 인자 입력 화면이 닫힌다 (INT-25). 같은 칸을 다시 골라 화면을 연다.
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByRole('searchbox').fill('장비');
    await editor.getByRole('radio', { name: '장비매매', exact: true }).check();
    await slot.selectOption('weapon');
    await item.selectOption('weapon_06');
    // 지금 상태의 경고는 30칸 표의 사전 검사와 같은 말이고, 경고가 있어도 넣을 수 있다고 바로 이어 적는다.
    const condition = picker.getByRole('note').filter({ hasText: '사전 검사 경고:' });
    await expect(picker.getByText(/경고가 있어도 넣을 수 있고 실행할 때/)).toBeVisible();
    const replacement = picker.getByRole('note').filter({ hasText: '교체하면 기존 장비 금액은 돌려받지 않습니다.' });
    await expect(condition).toBeVisible();
    await expect(replacement).toBeVisible();
    await expect(picker.getByRole('button', { name: '1번 칸에 넣기', exact: true })).toBeEnabled();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 375, height: 900 });
      expect(await textContrast(condition)).toBeGreaterThanOrEqual(4.5);
      expect(await textContrast(replacement)).toBeGreaterThanOrEqual(4.5);
      await picker.screenshot({ path: info.outputPath(`t4-24-warning-${colorScheme}-375.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await slot.selectOption('book');
    await item.selectOption('book_05');
    await picker.screenshot({ path: info.outputPath('t4-24-long-name-dark-1440.png') });
    await page.reload();
    await expect(equipment.getByText('단도', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByRole('searchbox').fill('장비');
    await editor.getByRole('radio', { name: '장비매매', exact: true }).check();
    await slot.selectOption('weapon');
    await item.selectOption('none');
    await expect(picker.getByText('현재 장착품 기준 판매 금액: 금 500', { exact: true })).toBeVisible();
    await picker.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    await advance(bought.nextTurnTick - 1);
    const saleGold = (await general()).gold;
    await advance(bought.nextTurnTick);
    await expect(equipment.getByText('단도', { exact: true })).toHaveCount(0);
    await expect(generalPanel.getByText('기본 100 + 장비 1', { exact: true })).toHaveCount(0);
    expect((await general()).gold).toBe(saleGold + 500);

    // AC-P2-34: 실제 연결 실패에서 장수 칸과 장비 카드가 공통 오류 칸을 보이고, 다시 시도가 375px에서도 44px이며 복구된다.
    // 같은 HTTP 배치의 다른 조회도 함께 끊길 수 있어 복구 뒤 새 문서에서 다시 확인한다.
    await page.setViewportSize({ width: 375, height: 900 });
    await page.route('**/trpc/**', async (route) => {
      if (route.request().url().includes('equipment.mine')) await route.abort('failed');
      else await route.continue();
    });
    await page.reload();
    await showPanel('현황');
    const statusAlert = generalPanel.getByRole('alert').filter({ hasText: '장비 정보를 불러오지 못했습니다.' });
    await expect(statusAlert).toBeVisible({ timeout: 20_000 });
    await expect(generalPanel.getByText('무력', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText(
      '100',
    );
    // 375px은 장수 칸(현황)과 명령 칸(예턴)이 다른 패널이라 장수 칸의 다시 시도를 먼저 잰다.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const box = (await statusAlert.getByRole('button', { name: '다시 시도', exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(376);
      await generalPanel.screenshot({ path: info.outputPath(`t4-24-retry-stats-${colorScheme}-375.png`) });
    }
    await showPanel('예턴');
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByRole('searchbox').fill('장비');
    await editor.getByRole('radio', { name: '장비매매', exact: true }).check();
    const pickerAlert = picker.getByRole('alert').filter({ hasText: '장비 정보를 불러오지 못했습니다.' });
    await expect(pickerAlert).toBeVisible();
    await expect(picker.getByRole('button', { name: '1번 칸에 넣기 (사용 불가)', exact: true })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const box = (await pickerAlert.getByRole('button', { name: '다시 시도', exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(376);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await picker.screenshot({ path: info.outputPath(`t4-24-retry-trade-${colorScheme}-375.png`) });
    }
    await page.unroute('**/trpc/**');
    await pickerAlert.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(slot).toBeVisible();
    // 인자 입력 화면을 닫고 현황 패널에서 장비 카드가 돌아온 것을 본다.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-args-screen')).toBeHidden();
    await showPanel('현황');
    await expect(equipment.getByText('미장착', { exact: true }).first()).toBeVisible();
    await expect(statusAlert).toHaveCount(0);
    await page.reload();
    await expect(equipment).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await player.context.close();
    await stack.db.world.delete({ where: { id: worldId } });
    await stack.db.user.delete({ where: { id: player.id } });
  }
});
