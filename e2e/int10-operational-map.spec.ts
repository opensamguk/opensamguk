import { test, expect, apiMutate, apiQuery } from './t210-fixture';
import { initializeIntegrationResources } from '../tools/integration-resources';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { persistPublicMap } from '../apps/engine/src/publicMap';
import { holdLease, releaseHold } from './game';
import type { WorldMap as WorldMapResponse } from '../apps/web/src/game/types';

test('AC-INT-10 정식191년 실제 API·80표식·375px·키보드·지연 공개 지도', async ({ world, browser }) => {
  const user = await world.user('member');
  const db = world.hold.db;
  await initializeIntegrationResources(db);
  const initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'int10-formal-191',
  });
  expect(initial.generals).toHaveLength(491);
  expect(initial.nations).toHaveLength(21);
  const name = 'INT10 정식191년';
  const { worldId } = await saveInitialWorld(db, initial, { name, turnTermMinutes: 60, endYear: 201 });
  const hold = await holdLease(worldId);
  const anonymous = await browser.newContext({ baseURL: world.stack.webOrigin });
  try {
    await controlClock(db, worldId, 'start');
    const creating = apiMutate<{ status: string }>(world, user, 'general.create', {
      worldId,
      name: '지도검수장수',
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    });
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    const past = Date.now() - 11 * 60_000;
    await new TurnLoop(hold.db, hold.lease, { publicMapNow: () => past }).advanceTo(0);
    expect((await creating).status).toBe('created');
    const data = await apiQuery<WorldMapResponse>(user, 'world.map', { worldId });
    expect(data.cities).toHaveLength(61);
    expect(data.operationalMap?.sites).toHaveLength(80);
    expect(JSON.stringify(data.operationalMap)).not.toMatch(/"(?:crew|gold|rice|generals|population|initial)"/);
    await user.page.goto(`/w/${worldId}/map`);
    const map = user.page.getByTestId('world-map');
    await expect(map).toBeVisible();
    const decoded = await map.locator('image').evaluateAll(async (images) => {
      const sources = [...new Set(images.map((image) => image.getAttribute('href')!))];
      return Promise.all(
        sources.map(async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          return image.naturalWidth > 0;
        }),
      );
    });
    expect(decoded).toHaveLength(5);
    expect(decoded.every(Boolean)).toBe(true);
    for (const [kind, count] of [
      ['CITY', 53],
      ['PASS', 8],
      ['PORT', 6],
      ['FIELD', 13],
    ] as const)
      await expect(map.locator(`[data-site-kind="${kind}"]`)).toHaveCount(count);
    await expect(
      map.locator('[data-site-kind="PORT"][role="button"], [data-site-kind="FIELD"][role="button"]'),
    ).toHaveCount(0);
    await user.page.getByRole('button', { name: '지도 확대' }).click();
    expect(Number((await map.getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(1000);
    await map.focus();
    const beforeKeyboardX = Number((await map.getAttribute('viewBox'))!.split(' ')[0]);
    await map.press('ArrowRight');
    await expect
      .poll(async () => Number((await map.getAttribute('viewBox'))!.split(' ')[0]))
      .toBeGreaterThan(beforeKeyboardX);
    await user.page.getByRole('button', { name: '지도 전체' }).click();
    await expect(map).toHaveAttribute('viewBox', '0 0 1000 700');
    await user.page.setViewportSize({ width: 375, height: 812 });
    const selector = user.page.getByRole('combobox', { name: '지도 거점' });
    await expect(selector.locator('option')).toHaveCount(62);
    await selector.selectOption(String(data.cities[0]!.key));
    await expect(map).not.toHaveAttribute('viewBox', '0 0 1000 700');
    const box = await map.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect((await user.page.getByRole('button', { name: '지도 확대' }).boundingBox())!.height).toBeGreaterThanOrEqual(
      44,
    );
    await user.page.screenshot({ path: 'test-results/int10-formal-191-mobile.png', fullPage: true });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const state = await loadWorld(tx, worldId);
      await persistPublicMap(tx, hold.lease, state, 0, past, { delayMinutes: 10, intervalMinutes: 5 });
    });
    const publicPage = await anonymous.newPage();
    await publicPage.goto('/login');
    await publicPage.getByRole('tab', { name, exact: true }).click();
    const publicMap = publicPage.getByTestId('public-map');
    await expect(publicMap.getByTestId('geographic-relief')).toBeVisible();
    await expect(publicMap.locator('[data-site-kind="CITY"]')).toHaveCount(53);
    await expect(publicMap.locator('[data-site-kind="PORT"]')).toHaveCount(6);
    await publicPage.screenshot({ path: 'test-results/int10-formal-191-public.png', fullPage: true });
  } finally {
    await anonymous.close();
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
