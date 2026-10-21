import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { signUpByApi } from '../../e2e/account';
import { e2eWorld, mine, query } from '../../e2e/game';
import { createDb } from '../../packages/db/src/index';
import { runEngine } from '../../apps/engine/src/main';

test('real pending rejection returns to editable creation form', async ({ page }) => {
  test.setTimeout(120_000);
  await signUpByApi(page);
  // Bind the dev engine to the first world, leaving this second world queued.
  await e2eWorld(page);
  await page.waitForTimeout(2000);
  const created = spawnSync('pnpm', ['-s', 'world:create', '--scenario', '1030', '--map', 'che', '--seed', 'review-pending', '--turn-term', '1', '--name', 'review pending'], { encoding: 'utf8', env: process.env });
  expect(created.status).toBe(0);
  const worldId = JSON.parse(created.stdout.trim().split('\n').at(-1)!).worldId as string;
  const start = spawnSync('pnpm', ['-s', 'world:start', '--world', worldId], { encoding: 'utf8', env: process.env });
  expect(start.status).toBe(0);
  const db = createDb(process.env.DATABASE_URL!);
  const controller = new AbortController();
  let engine: Promise<void> | undefined;
  try {
    const existing = await db.general.findFirstOrThrow({ where: { worldId }, select: { name: true } });
    await page.goto(`/w/${worldId}/create`);
    await page.getByLabel('이름', { exact: true }).fill(existing.name);
    const response = page.waitForResponse(r => r.url().includes('general.create') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    const body = await (await response).json();
    expect(JSON.stringify(body)).toContain('pending');
    await expect(page.getByRole('status').filter({ hasText: '장수를 만드는 중' })).toBeVisible();
    expect((await mine(page, worldId)).creation?.status).toBe('pending');
    // Existing engine code, own second world, no direct game-state mutation.
    engine = runEngine(db, { worldId, signal: controller.signal });
    await expect.poll(async () => (await mine(page, worldId)).creation?.status).toBe('rejected');
    const rejected = await query(page, 'general.mine', { worldId });
    console.log('REVIEW_REAL_REJECTED', JSON.stringify(rejected));
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'test-results/review-pending-rejected.png', fullPage: true });
    console.log('REVIEW_UI', JSON.stringify({ spinner: await page.getByRole('status').filter({ hasText: '장수를 만드는 중' }).count(), form: await page.getByLabel('이름', { exact: true }).count(), rejectionVisible: await page.getByText('이미 사용 중인 장수 이름입니다.', { exact: false }).count() }));
    await expect(page.getByText('이미 사용 중인 장수 이름입니다.', { exact: false })).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel('이름', { exact: true })).toBeVisible();
  } finally {
    controller.abort();
    await engine;
    await db.$disconnect();
  }
});
