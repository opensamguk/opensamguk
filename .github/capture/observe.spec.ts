import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAccount, withE2eDb } from '../../e2e/account';
import { e2eWorld, turns, waitTurnWindow, query } from '../../e2e/game';
import { bindGeneral, query as apiQuery } from '../../e2e/world';

test('fresh actual main observation, no request mocks', async ({ page }) => {
  const out = process.env.OWNER_SNAPSHOT_DIR!;
  await mkdir(out, { recursive: true });
  const m: any = { observedAt: new Date().toISOString(), sourceSha: process.env.APP_SHA, captureCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, environment: 'GitHub standard ubuntu-24.04 hosted runner; isolated PostgreSQL18 Docker service; Node24; pnpm10.33; actual server and engine; Chromium', mockedRequests: false, fixtureDisclosure: 'Fresh E2E-only database. Existing main E2E helpers create a test account/session and bind one scenario NPC to it. World is created by actual engine CLI; no API response replacement.', screenshots: [], pageErrors: [], consoleErrors: [], networkErrors: [], checks: {}, limitations: 'Current-state visual observation only. Not whole-product acceptance, not independent 15-minute completion demo.' };
  page.on('pageerror', e => m.pageErrors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') m.consoleErrors.push(e.text()); });
  page.on('requestfailed', r => m.networkErrors.push({ url: r.url().split('?')[0], failure: r.failure() }));
  page.on('response', r => { if (r.status() >= 400) m.networkErrors.push({url:r.url().split('?')[0], status:r.status()}); });
  async function snap(file: string, action: string) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${out}/${file}`, fullPage: true }); m.screenshots.push({file, action, at: new Date().toISOString(), url: page.url()}); }
  try {
    await createAccount(page);
    const worldId = await e2eWorld(page);
    m.worldId = worldId;
    const { user } = await apiQuery<{user:{id:string}}>(page.request, 'auth.me');
    await bindGeneral(worldId, user.id);
    await waitTurnWindow(page, worldId, 45000);
    await page.goto(`/w/${worldId}`);
    await expect(page.getByRole('heading', {name:'메인', exact:true})).toBeVisible();
    await expect(page.getByTestId('world-map').locator('[data-city-key]')).toHaveCount(94);
    const editor = page.getByRole('region',{name:'명령 목록',exact:true}).getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    m.checks.mapCities = 94; m.checks.turnSlots = 30;
    m.before = await turns(page, worldId);
    await snap('01-main-map-30-turns.png', 'Actual authenticated main with 94-city map and complete 30-slot editor');
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio',{name:'농지 개간',exact:true}).check();
    await editor.getByRole('button',{name:'1번 칸에 넣기',exact:true}).click();
    await editor.getByRole('button',{name:'저장',exact:true}).click();
    await expect(editor.getByText('저장했습니다.')).toBeVisible();
    m.saved = await turns(page, worldId);
    expect(m.saved.slots[0].commandKey).toBe('farm');
    m.checks.savedByRealUiAndReadBack = true;
    await snap('02-farm-command-saved.png', 'Selected first slot, inserted farm command and saved via actual UI; real turns.get confirms farm');
    await expect.poll(async () => (await turns(page,worldId)).revision,{timeout:150000,intervals:[2000]}).toBeGreaterThan(m.saved.revision);
    m.after = await turns(page,worldId);
    const records = await query<any>(page, 'records.general', {worldId});
    m.records = records;
    expect(records.items.length).toBeGreaterThan(0);
    m.checks.engineTurnAdvanced = true;
    await page.goto(`/w/${worldId}/records?tab=general`);
    await expect(page.getByRole('heading',{level:1})).toContainText('기록');
    await expect(page.getByText(records.items[0].text,{exact:true}).first()).toBeVisible();
    await snap('03-records-after-engine-turn.png', 'Waited for real engine turn/revision advancement; opened real general records');
    m.database = await withE2eDb(async db => ({world: await db.world.findUnique({where:{id:worldId},select:{id:true,status:true,startYear:true,clockTick:true}}), generalCount: await db.general.count({where:{worldId}})}));
    m.result = 'CAPTURED_REAL_GAME_STATES';
  } catch(e) { m.result = 'FAILED'; m.failure = String(e); await snap('failure-observed-screen.png','Failure preserved, not acceptance').catch(()=>{}); throw e; }
  finally { m.finishedAt = new Date().toISOString(); await writeFile(`${out}/manifest.json`,JSON.stringify(m,null,2)); }
});
