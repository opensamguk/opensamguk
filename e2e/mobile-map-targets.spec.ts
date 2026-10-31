import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './t210-fixture';
import { createAccount, withE2eDb } from './account';
import { holdLease, query, releaseHold } from './game';
import type { WorldMap } from '../apps/web/src/game/types';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { persistPublicMap } from '../apps/engine/src/publicMap';

test.use({ isMobile: true, hasTouch: true });
const executions = new Set<Promise<unknown>>();
let ownWorld: string | undefined;
let ownEmail: string | undefined;
let hold: Awaited<ReturnType<typeof holdLease>> | undefined;
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}
test.beforeEach(settled);
test.afterEach(async ({ page }) => {
  await page.close();
  await settled();
  if (hold) await releaseHold(hold);
  hold = undefined;
  await withE2eDb(async (db) => {
    if (ownWorld) await db.world.deleteMany({ where: { id: ownWorld } });
    if (ownEmail) await db.user.deleteMany({ where: { email: ownEmail } });
  });
  ownWorld = ownEmail = undefined;
});
async function overlap(svg: Locator) {
  await svg.scrollIntoViewIfNeeded();
  return svg.getByTestId('map-tap-target').evaluateAll((elements) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const x1 = Math.max(boxes[a]!.left, boxes[b]!.left),
          x2 = Math.min(boxes[a]!.right, boxes[b]!.right);
        const y1 = Math.max(boxes[a]!.top, boxes[b]!.top),
          y2 = Math.min(boxes[a]!.bottom, boxes[b]!.bottom);
        if (x2 - x1 > 12 && y2 - y1 > 12) return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      }
    throw new Error('정식 지도에서 겹친 터치 영역을 찾지 못했습니다.');
  });
}
async function sized(svg: Locator) {
  const result = await svg.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    return [...element.querySelectorAll('[data-tap-key]')].map((target) => {
      const r = target.getBoundingClientRect();
      return {
        key: target.getAttribute('data-tap-key'),
        width: r.width,
        height: r.height,
        inside:
          r.left >= frame.left - 0.1 &&
          r.top >= frame.top - 0.1 &&
          r.right <= frame.right + 0.1 &&
          r.bottom <= frame.bottom + 0.1,
      };
    });
  });
  expect(result.length).toBeGreaterThan(0);
  expect(result.filter((r) => r.width < 44 || r.height < 44 || !r.inside)).toEqual([]);
  return result;
}
async function tapOverlap(page: Page, svg: Locator) {
  const point = await overlap(svg);
  await page.touchscreen.tap(point.x, point.y);
  const choices = page.getByRole('group', { name: '겹친 거점 선택', exact: true });
  await expect(choices).toBeVisible();
  await expect(choices.getByRole('button').first()).toBeFocused();
  expect(await choices.getByRole('button').count()).toBeGreaterThan(2);
  for (const size of await choices.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const r = button.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }),
  )) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  return choices;
}

test('T3-10 정식 GIS61거점 실제 터치·밀집 후보·끌기·취소와 기존30칸 초안을 보존한다', async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const execution = (async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'mobile-map-191',
    });
    initial.ruleFeatures = [
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    ownWorld = (
      await withE2eDb((db) =>
        saveInitialWorld(db, initial, { name: '지도 터치 정식191', turnTermMinutes: 60, endYear: 201 }),
      )
    ).worldId;
    hold = await holdLease(ownWorld);
    await controlClock(hold.db, ownWorld, 'start');
    ownEmail = `map-${randomUUID()}@example.test`;
    await createAccount(page, ownEmail);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(`/w/${ownWorld}/create`);
    await expect(page.getByRole('spinbutton')).toHaveCount(5);
    await page.getByLabel('이름', { exact: true }).fill('지도장수');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect
      .poll(() =>
        hold!.db.inputEvent.count({ where: { worldId: ownWorld, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    expect(hold.lost).toBeUndefined();
    await new TurnLoop(hold.db, hold.lease).advanceTo(0);
    await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
    await page.goto(`/w/${ownWorld}?city=40`);
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
    const before = await hold.db.generalTurn.findMany({
      where: { worldId: ownWorld },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    });
    const geography = await query<WorldMap>(page, 'world.map', { worldId: ownWorld });
    const svg = page.getByTestId('world-map');
    const targets = svg.getByTestId('map-tap-target');
    for (const [kind, count] of [
      ['city', 53],
      ['pass', 8],
      ['port', 6],
      ['field', 13],
    ] as const)
      await expect(svg.getByTestId(`site-icon-${kind}`)).toHaveCount(count);
    const measurements = [];
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(targets).toHaveCount(61);
      measurements.push({ width, targets: await sized(svg) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const choices = await tapOverlap(page, svg);
    const originName = (await choices.getByRole('button').first().innerText()).replace(/ \((도시|관문)\)$/, '');
    const origin = geography.cities.find((city) => city.name === originName)!;
    expect(new URL(page.url()).searchParams.get('city')).toBe('40');
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await choices.getByRole('button', { name: '선택 취소', exact: true }).click();
    await expect(choices).toHaveCount(0);
    await expect(svg.locator(`[data-anchor-key="${origin.key}"]`)).toBeFocused();
    await tapOverlap(page, svg);
    await page.keyboard.press('Escape');
    await expect(choices).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('city')).toBe('40');
    await tapOverlap(page, svg);
    const label = (await choices.getByRole('button').allTextContents()).find(
      (name) => name !== '선택 취소' && !name.startsWith('천수 '),
    )!;
    const selected = geography.cities.find((city) => city.name === label.replace(/ \((도시|관문)\)$/, ''))!;
    await choices.getByRole('button', { name: label, exact: true }).click();
    await expect(choices).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('city')).toBe(String(selected.key));
    await page.getByRole('button', { name: '지도 전체', exact: true }).click();
    await svg.scrollIntoViewIfNeeded();
    const edge = targets.first();
    const edgeKey = await edge.getAttribute('data-tap-key');
    const edgeCity = geography.cities.find((city) => String(city.key) === edgeKey)!;
    const r = (await edge.boundingBox())!;
    await page.touchscreen.tap(r.x + 2, r.y + 2);
    if (await choices.count()) {
      await expect(
        choices.getByRole('button', {
          name: `${edgeCity.name} (${edgeCity.kind === 'CITY' ? '도시' : '관문'})`,
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    } else expect(new URL(page.url()).searchParams.get('city')).toBe(edgeKey);
    await page.getByRole('button', { name: '지도 확대', exact: true }).click();
    await sized(svg);
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const oldView = await svg.getAttribute('viewBox');
    const oldCity = new URL(page.url()).searchParams.get('city');
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + 35, y: start.y + 25, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(svg).not.toHaveAttribute('viewBox', oldView!);
      expect(new URL(page.url()).searchParams.get('city')).toBe(oldCity);
      await expect(choices).toHaveCount(0);
      await page.getByRole('button', { name: '지도 전체', exact: true }).click();
      await tapOverlap(page, svg);
      await page.keyboard.press('Escape');
      await svg.scrollIntoViewIfNeeded();
      const frame = (await svg.boundingBox())!;
      const first = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2, id: 1 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [first, { ...first, id: 2, x: first.x + 25 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      expect(new URL(page.url()).searchParams.get('city')).toBe(oldCity);
      await expect(choices).toHaveCount(0);
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
      await tapOverlap(page, svg);
      await page.keyboard.press('Escape');
    } finally {
      await cdp.detach();
    }
    await page.getByRole('combobox', { name: '지도 거점', exact: true }).selectOption('40');
    expect(new URL(page.url()).searchParams.get('city')).toBe('40');
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(targets).toHaveCount(0);
      await page.getByRole('button', { name: '지도 전체', exact: true }).click();
      const city = svg.locator('[data-anchor-key="22"]');
      await city.focus();
      await page.keyboard.press('Enter');
      expect(new URL(page.url()).searchParams.get('city')).toBe('22');
      await svg.locator('[data-anchor-key="40"]').focus();
      await page.keyboard.press('Space');
      expect(new URL(page.url()).searchParams.get('city')).toBe('40');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.reload();
    await expect(targets).toHaveCount(61);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.locator('tr[data-slot="1"]')).toContainText('농지 개간');
    expect(
      await hold.db.generalTurn.findMany({
        where: { worldId: ownWorld },
        orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
      }),
    ).toEqual(before);
    await tapOverlap(page, svg);
    await page.screenshot({ path: info.outputPath('formal-map-choices-375.png'), fullPage: true });
    await hold.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${ownWorld} FOR UPDATE`;
      const state = await loadWorld(tx, ownWorld!);
      await persistPublicMap(tx, hold!.lease, state, 0, Date.now() - 11 * 60_000, {
        delayMinutes: 10,
        intervalMinutes: 5,
      });
    });
    const anonymous = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      isMobile: true,
      hasTouch: true,
      viewport: { width: 375, height: 900 },
    });
    try {
      const readOnly = await anonymous.newPage();
      await readOnly.goto('/login');
      const worldName = (await hold.db.world.findUniqueOrThrow({ where: { id: ownWorld } })).name;
      await readOnly.getByRole('tab', { name: worldName, exact: true }).click();
      const map = readOnly.getByTestId('public-map').getByTestId('world-map');
      await expect(map).toBeVisible();
      await expect(map.locator('[data-anchor-key]')).toHaveCount(61);
      await expect(map.getByTestId('map-tap-target')).toHaveCount(0);
      await expect(map.locator('[data-anchor-key][role="button"]')).toHaveCount(0);
      await expect(readOnly.getByRole('combobox', { name: '지도 거점', exact: true })).toHaveCount(0);
      await map.scrollIntoViewIfNeeded();
      const marker = (await map.locator('[data-anchor-key="40"]').boundingBox())!;
      await readOnly.touchscreen.tap(marker.x + marker.width / 2, marker.y + marker.height / 2);
      await expect(readOnly.getByRole('group', { name: '겹친 거점 선택', exact: true })).toHaveCount(0);
      expect(new URL(readOnly.url()).pathname).toBe('/login');
      await readOnly.screenshot({ path: info.outputPath('formal-readonly-map-375.png'), fullPage: true });
    } finally {
      await anonymous.close();
    }
    await writeFile(
      info.outputPath('map-target-measurements.json'),
      JSON.stringify({ measurements, wholeResponsiveAcPassed: false }, null, 2),
    );
  })();
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  await execution;
});
