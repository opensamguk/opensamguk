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
    // INT-20: 그림 수는 배율에 따라 바뀐다(멀리서는 바탕 그림과 깃발, 가까이서는 표식 그림). 모두 해독되어야 한다.
    expect(decoded.length).toBeGreaterThanOrEqual(2);
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
    // INT-20 AC: 지도 조작 글자와 주변 안내 글자의 실제 계산 색 대비(WCAG 2.x, 일반 글자 4.5:1 이상). 밝은 색·어두운 색 둘 다.
    const zoomGroup = user.page.getByRole('group', { name: '지도 배율' });
    const contrastTargets = [
      { name: '지도 확대 버튼', locator: zoomGroup.getByRole('button', { name: '지도 확대' }) },
      { name: '지도 전체 버튼', locator: zoomGroup.getByRole('button', { name: '지도 전체' }) },
      { name: '지도 배율 표시', locator: zoomGroup.locator('output') },
      { name: '지도 거점 선택 글자', locator: user.page.locator('label', { hasText: '지도 거점' }) },
      { name: '지도 거점 선택 상자', locator: user.page.getByRole('combobox', { name: '지도 거점' }) },
      { name: '지도 안내 문장', locator: user.page.getByText('드래그나 방향키로 이동') },
    ];
    for (const scheme of ['light', 'dark'] as const) {
      await user.page.emulateMedia({ colorScheme: scheme });
      for (const target of contrastTargets) {
        const sample = await target.locator.evaluate((element) => {
          const channels = (value: string) => value.match(/[\d.]+/g)!.map(Number);
          const fg = channels(getComputedStyle(element).color);
          let bg: number[] | null = null;
          for (let node: Element | null = element; node && !bg; node = node.parentElement) {
            const value = channels(getComputedStyle(node).backgroundColor);
            if (value.length < 4 || value[3] === 1) bg = value.slice(0, 3);
          }
          return { fg: fg.slice(0, 3), bg: bg ?? [255, 255, 255], text: element.textContent?.trim() ?? '' };
        });
        const luminance = ([r, g, b]: number[]) => {
          const [R, G, B] = [r, g, b].map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
        };
        const [hi, lo] = [luminance(sample.fg), luminance(sample.bg)].sort((a, b) => b - a) as [number, number];
        const ratio = (hi + 0.05) / (lo + 0.05);
        expect(
          ratio,
          `${scheme} ${target.name} "${sample.text}": fg rgb(${sample.fg}) on bg rgb(${sample.bg}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    await user.page.emulateMedia({ colorScheme: null });
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
    // INT-20 다크 모드: 같은 375px 화면에서 지도가 가로로 잘리지 않고 확대 단추 44px를 유지해야 한다.
    await user.page.emulateMedia({ colorScheme: 'dark' });
    await expect(map).toBeVisible();
    const darkBox = await map.boundingBox();
    expect(darkBox!.x).toBeGreaterThanOrEqual(0);
    expect(darkBox!.x + darkBox!.width).toBeLessThanOrEqual(375);
    expect(
      await user.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    expect((await user.page.getByRole('button', { name: '지도 확대' }).boundingBox())!.height).toBeGreaterThanOrEqual(
      44,
    );
    await user.page.screenshot({ path: 'test-results/int10-formal-191-mobile-dark.png', fullPage: true });
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
