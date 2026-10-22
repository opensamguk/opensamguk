import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import { bindGeneral, query } from './world';

// 독립 리뷰 탐침. 격리된 PREOPEN 월드의 명시적 DB fixture로 페이지 경계만 검증한다.
// 실제 엔진 실행 증거는 바꾸지 않은 main.spec.ts의 전체 실행과 별도로 기록한다.
test('독립 리뷰: 기록 세 종류 30/60/65건, 권한과 지도 키보드 선택', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await createAccount(page);
  const result = spawnSync(
    'pnpm',
    ['-s', 'world:create', '--scenario', '1030', '--map', 'che', '--seed', 'review-pages', '--name', '리뷰 기록 월드'],
    { encoding: 'utf8', env: process.env },
  );
  expect(result.status, result.stderr).toBe(0);
  const worldId = (JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { worldId: string }).worldId;
  const { user } = await query<{ user: { id: string } }>(page.request, 'auth.me');
  await bindGeneral(worldId, user.id);
  const home = await query<{ general: { id: number; nationId: number; cityKey: number } }>(page.request, 'home.get', {
    worldId,
  });
  await withE2eDb(async (db) => {
    for (let tick = 1; tick <= 65; tick += 1) {
      await db.generalLog.create({
        data: {
          worldId,
          generalId: home.general.id,
          tick,
          commandKey: 'rest',
          kind: 'success',
          text: `독립 페이지 fixture ${tick}`,
        },
      });
      await db.nationHistory.create({
        data: {
          worldId,
          nationId: home.general.nationId,
          tick,
          data: { nationId: home.general.nationId, cities: 1, generals: 1, gold: tick, rice: tick },
        },
      });
      await db.yearbookSnapshot.create({
        data: {
          worldId,
          tick,
          year: 191 + Math.floor((tick - 1) / 12),
          month: ((tick - 1) % 12) + 1,
          sequence: tick,
          stateHash: 'review-fixture-not-engine-output',
          data: { nations: [{ nationId: home.general.nationId, cities: 1, generals: 1 }], cities: [] },
        },
      });
    }
  });

  await page.goto(`/w/${worldId}`);
  await expect(page.getByTestId('world-map').locator('[data-city-key]')).toHaveCount(94);
  await expect(page.getByTestId('turn-editor').locator('tr[data-slot]')).toHaveCount(30);
  const otherCity = page
    .getByTestId('world-map')
    .locator(`[data-city-key]:not([data-city-key="${home.general.cityKey}"])`)
    .first();
  const key = await otherCity.getAttribute('data-city-key');
  await otherCity.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`\\?city=${key}$`));
  await expect(otherCity).toHaveAttribute('aria-pressed', 'true');

  for (const [kind, label, selector] of [
    ['general', '개인 기록', 'li'],
    ['nation', '국가 기록', 'tbody tr'],
    ['world', '중원 정세', 'li'],
  ] as const) {
    const region = page.getByRole('region', { name: label, exact: true });
    await expect(region.locator(selector)).toHaveCount(30);
    const ids: number[] = [];
    for (const expected of [60, 65]) {
      const response = page.waitForResponse((r) => r.url().includes(`records.${kind}`) && r.url().includes('cursor'));
      await region.getByRole('button', { name: '더 보기', exact: true }).click();
      const res = await response;
      expect(res.ok()).toBe(true);
      await expect(region.locator(selector)).toHaveCount(expected);
      ids.push(expected);
    }
    expect(ids).toEqual([60, 65]);
    await expect(region.getByRole('button', { name: '더 보기', exact: true })).toHaveCount(0);
  }
  const texts = await page.getByRole('region', { name: '개인 기록', exact: true }).locator('li').allTextContents();
  expect(new Set(texts).size).toBe(65);
  expect(texts[0]).toContain('fixture 65');
  expect(texts[64]).toContain('fixture 1');
  await page.screenshot({ path: test.info().outputPath('review-pagination-keyboard.png'), fullPage: true });

  const stranger = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const other = await stranger.newPage();
  await createAccount(other);
  await other.goto(`/w/${worldId}`);
  for (const kind of ['general', 'nation']) {
    const res = await other.request.get(
      `/trpc/records.${kind}?input=${encodeURIComponent(JSON.stringify({ worldId }))}`,
    );
    expect(res.status()).toBe(404);
  }
  const world = await query<{ items: unknown[] }>(other.request, 'records.world', { worldId });
  expect(world.items).toHaveLength(30);
  await expect(other.getByRole('region', { name: '개인 기록', exact: true })).not.toContainText('독립 페이지 fixture');
  await expect(other.getByRole('region', { name: '중원 정세', exact: true }).locator('li')).toHaveCount(30);
  await stranger.clearCookies();
  const forbidden = await other.request.get(
    `/trpc/records.world?input=${encodeURIComponent(JSON.stringify({ worldId }))}`,
  );
  expect(forbidden.status()).toBe(401);
  await stranger.close();
  await withE2eDb((db) => db.world.delete({ where: { id: worldId } }));
});
