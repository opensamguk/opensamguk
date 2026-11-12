import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './t210-fixture';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { createAccount, withE2eDb } from './account';
import { holdLease, releaseHold } from './game';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { prepareInitialWorld, saveInitialWorld, savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { initializeExpandedResources } from '../tools/expanded-resources';

// T3-10 · AC-M3-08. 기존 예턴 저장 회귀와 SAN10 핵심 화면의 375px 검사를 함께 실행한다.
const executions = new Set<Promise<unknown>>();
const run = promisify(execFile);
const expandedFixtureDir = process.env.SAN10_EXPANDED_FIXTURE_DIR;
const expandedManifestSha = process.env.SAN10_EXPANDED_MANIFEST_SHA;
if (Boolean(expandedFixtureDir) !== Boolean(expandedManifestSha)) {
  throw new Error('SAN10 확장판 검증에는 데이터 디렉터리와 manifest SHA-256이 모두 필요합니다.');
}
test.use({ isMobile: true, hasTouch: true });
let ownWorld: string | undefined;
let ownEmail: string | undefined;
let hold: Awaited<ReturnType<typeof holdLease>> | undefined;
async function settled() {
  while (executions.size > 0) await Promise.allSettled([...executions]);
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

async function targetSizes(targets: Locator) {
  return targets.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const label = element.matches('input[type="radio"],input[type="checkbox"]') ? element.closest('label') : null;
      const rect = (label ?? element).getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      return [
        {
          name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40),
          width: rect.width,
          height: rect.height,
        },
      ];
    }),
  );
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function tapTargets(targets: Locator) {
  await expect(targets.first()).toBeVisible();
  const sizes = await targetSizes(targets);
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.filter((size) => size.width < 44 || size.height < 44)).toEqual([]);
}

async function measureMobileScreen(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const selector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="tab"]',
      '[role="link"]',
      '[tabindex]:not([tabindex="-1"])',
      'tr[data-slot]',
      '[data-tap-key]',
    ].join(',');
    const identify = (element: Element) => ({
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
      tag: element.localName,
      class: element.getAttribute('class'),
    });
    const targets = Array.from(document.querySelectorAll(selector)).flatMap((element) => {
      // Operational map marker clicks are replaced on touch screens by the actual SVG hit rectangles below.
      if (element.matches('svg g[data-site-kind]')) return [];
      const label =
        element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)
          ? element.labels?.[0]
          : undefined;
      const target = label ?? element;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(target).visibility !== 'visible') return [];
      return [{ ...identify(element), width: rect.width, height: rect.height }];
    });
    const overflow = [document.documentElement, ...document.querySelectorAll('body *')].flatMap((element) => {
      if (!(element instanceof HTMLElement) || !element.clientWidth || element.scrollWidth <= element.clientWidth)
        return [];
      if (element !== document.documentElement && !['auto', 'scroll'].includes(getComputedStyle(element).overflowX))
        return [];
      return [{ ...identify(element), width: element.clientWidth, scrollWidth: element.scrollWidth }];
    });
    return {
      width: window.innerWidth,
      targetCount: targets.length,
      undersized: targets.filter((target) => target.width < 44 || target.height < 44),
      overflow,
    };
  });
}

async function joinMobileWorld(page: Page, name: string, edition: 'integration' | 'san10' | 'san10-expanded') {
  if (edition === 'san10-expanded' && expandedFixtureDir && expandedManifestSha) {
    await withE2eDb(initializeExpandedResources);
    await run(
      process.execPath,
      ['--import', 'tsx', 'tools/init-san10-expanded-resources.ts', expandedFixtureDir, expandedManifestSha],
      { timeout: 60_000 },
    );
  }
  const { worldId } = await withE2eDb(async (db) => {
    if (edition === 'san10') await initializeExpandedResources(db);
    const expanded = edition === 'san10-expanded';
    const initial = await loadInitialWorldFromDb(db, {
      scenario: expanded ? 'san10-expanded-s0185' : edition === 'san10' ? 'san10-191' : 'integration191',
      map: edition,
      statRules: 'five-stats',
      portraitMap: expanded ? 'san10-expanded-portraits' : '191-map',
      ...(expanded ? { unitSet: 'expanded' } : {}),
      seed: 'mobile-controls-191',
    });
    initial.ruleFeatures = [
      ...(expanded ? ['battle-affinity-v2'] : []),
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.generals).toHaveLength(expanded ? 928 : 491);
    expect(initial.nations).toHaveLength(expanded ? 20 : 21);
    expect(initial.cities).toHaveLength(expanded ? 322 : edition === 'san10' ? 155 : 61);
    // 확장판 화면 검증은 첫 월간 기록을 사용하므로 초기 NPC 개인 턴만 다음 달로 미룬다.
    if (expanded)
      initial.generals = initial.generals.map((general) => ({ ...general, nextTurnTick: TICKS_PER_MONTH + 1 }));
    const options = { name, turnTermMinutes: 60, endYear: initial.startYear + 10 };
    if (edition === 'integration') return saveInitialWorld(db, initial, options);
    const prepared = prepareInitialWorld(initial, options);
    return db.$transaction((tx) => savePreparedInitialWorld(tx, prepared), { timeout: 30_000 });
  });
  ownWorld = worldId;
  const worldHold = await holdLease(worldId);
  hold = worldHold;
  await controlClock(worldHold.db, worldId, 'start');
  ownEmail = `mobile-${randomUUID()}@example.test`;
  await createAccount(page, ownEmail);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${worldId}/create`);
  await expect(page.getByRole('spinbutton')).toHaveCount(5);
  await page.getByLabel('이름', { exact: true }).fill('손가락장수');
  await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
  await expect
    .poll(() => worldHold.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
    .toBe(1);
  expect(worldHold.lost).toBeUndefined();
  await new TurnLoop(worldHold.db, worldHold.lease).advanceTo(0);
  await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
  return { worldId, worldHold };
}

test('T3-10 정식191년 모바일 명령·방침·탭의 크기와 30번 칸 실제 저장·초안 복귀', async ({ page }, info) => {
  test.setTimeout(120_000);
  const execution = (async () => {
    const { worldHold: hold } = await joinMobileWorld(page, '모바일 조작 정식191', 'integration');
    const main = `/w/${ownWorld}?city=40`;
    await page.goto(main);
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    const targets = editor
      .locator('button,input,select')
      .or(page.getByTestId('policy-bar').locator('button,select'))
      .or(page.getByRole('group', { name: '지도 배율', exact: true }).locator('button'));
    const measurements = [];
    for (const width of [375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      if (width < 768) {
        await tapTargets(targets);
        await tapTargets(editor.locator('tr[data-slot]'));
        expect(await editor.getByLabel('명령 찾기').evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');
      }
      measurements.push({ width, targets: await targetSizes(targets) });
      await page.screenshot({ path: info.outputPath(`formal-controls-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    const last = editor.locator('tr[data-slot="30"]');
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    expect(await last.evaluate((row) => row.closest('table')!.parentElement!.scrollTop)).toBeGreaterThan(0);
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    const radio = editor.getByRole('radio', { name: '농지 개간', exact: true });
    const label = radio.locator('..');
    await tapTargets(label);
    await label.click({ position: { x: 4, y: 40 } });
    await expect(radio).toBeChecked();
    await editor.getByRole('button', { name: '30번 칸에 넣기', exact: true }).click();
    await expect(last).toContainText('농지 개간');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    const actor = await hold.db.general.findFirstOrThrow({ where: { worldId: ownWorld, user: { email: ownEmail } } });
    const slots = await hold.db.generalTurn.findMany({
      where: { worldId: ownWorld, generalId: actor.id },
      orderBy: { slot: 'asc' },
    });
    expect(slots).toHaveLength(30);
    expect(slots[29]!.commandKey).toBe('farm');
    expect(await hold.db.general.count({ where: { worldId: ownWorld, userId: null } })).toBe(491);
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
    await page.reload();
    await expect(page).toHaveURL(main);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.locator('tr[data-slot="1"]')).toContainText('농지 개간');
    await tapTargets(
      page.locator(
        '[data-main-area="city"] a:not(table a),[data-main-area="city"] button:not(table button),[data-main-area="general"] a,[data-main-area="general"] button,[data-main-area] > header a,[data-main-area] > header button',
      ),
    );
    const remaining = await targetSizes(page.locator('svg [role="button"],table:not([role="grid"]) button'));
    await writeFile(
      info.outputPath('mobile-controls-measurements.json'),
      JSON.stringify(
        {
          measurements,
          remainingSmallSvgOrTable: remaining.filter((size) => size.width < 44 || size.height < 44),
        },
        null,
        2,
      ),
    );
    for (const [tab, title] of [
      ['general', '내 장수'],
      ['nation', '국가 역사'],
      ['world', '월드 정세'],
      ['timelapse', '영토 재생'],
    ]) {
      await page
        .getByRole('navigation', { name: '게임 메뉴', exact: true })
        .filter({ visible: true })
        .getByRole('link', { name: '기록', exact: true })
        .click();
      await expect(page.getByRole('navigation', { name: '기록 종류', exact: true })).toBeVisible();
      await page
        .getByRole('navigation', { name: '기록 종류', exact: true })
        .getByRole('link', { name: title, exact: true })
        .click();
      expect(new URL(page.url()).searchParams.get('city')).toBe('40');
      expect(new URL(page.url()).searchParams.get('tab')).toBe(tab);
      await page.reload();
      await tapTargets(page.getByRole('navigation', { name: '기록 종류', exact: true }).locator('a'));
      const back = page.getByRole('link', { name: '메인에서 보기', exact: true });
      await tapTargets(back);
      await noOverflow(page);
      await back.click();
      await expect(page).toHaveURL(main);
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    }
    for (const invalid of ['0', '2147483648', 'NaN']) {
      await page.goto(`/w/${ownWorld}/records?city=${invalid}`);
      await expect(page.getByRole('link', { name: '메인에서 보기', exact: true })).toHaveAttribute(
        'href',
        `/w/${ownWorld}`,
      );
      for (const href of await page
        .getByRole('navigation', { name: '기록 종류', exact: true })
        .locator('a')
        .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href)))
        expect(new URL(href).searchParams.has('city')).toBe(false);
    }
    await page.goto(`/w/${ownWorld}/ranking`);
    await expect(page.getByRole('navigation', { name: '순위 종류', exact: true })).toBeVisible();
    await tapTargets(page.getByRole('navigation', { name: '순위 종류', exact: true }).locator('a'));
    await noOverflow(page);
  })();
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  await execution;
});

const editions = [
  { edition: 'san10', sites: 155 },
  ...(expandedFixtureDir ? [{ edition: 'san10-expanded', sites: 322 } as const] : []),
] as const;
for (const { edition, sites } of editions) {
  test(`AC-M3-08 ${edition} 로비와 핵심 화면에 375px 가로 넘침과 44px 미만 조작 대상이 없다`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    const execution = (async () => {
      const name = `모바일 ${edition}`;
      const { worldId, worldHold } = await joinMobileWorld(page, name, edition);
      await new TurnLoop(worldHold.db, worldHold.lease).advanceTo(TICKS_PER_MONTH);
      const world = `/w/${worldId}`;
      const routeChecks: Array<[string, string, Locator]> = [
        ['lobby', '/lobby', page.getByTestId('public-map').getByTestId('world-map')],
        ['main', `${world}?city=40`, page.getByTestId('turn-editor')],
        ['map', `${world}/map`, page.getByTestId('world-map')],
        ['turns', `${world}/turns`, page.getByTestId('turn-editor')],
        ['city', `${world}/city/40`, page.getByRole('heading', { name: /^도시 정보 · / })],
        ['nation', `${world}/nation/1`, page.getByRole('heading', { name: /^국가 정보 · / })],
        ['records-general', `${world}/records?tab=general`, page.getByRole('heading', { name: '기록 · 내 장수' })],
        ['records-nation', `${world}/records?tab=nation`, page.getByRole('heading', { name: '기록 · 국가 역사' })],
        ['records-world', `${world}/records?tab=world`, page.getByRole('heading', { name: '기록 · 월드 정세' })],
        ['records-timelapse', `${world}/records?tab=timelapse`, page.getByTestId('timelapse-map')],
        ['records-intel', `${world}/records?tab=intel`, page.getByRole('heading', { name: '기록 · 첩보 기록' })],
        ['ranking', `${world}/ranking`, page.getByRole('table')],
      ];
      const screens = [];
      for (const [screen, path, ready] of routeChecks) {
        await page.goto(path);
        if (screen === 'lobby') await page.getByRole('tab', { name, exact: true }).tap();
        await expect(ready).toBeVisible();
        if (screen === 'main' || screen === 'turns') {
          await expect(page.getByRole('combobox', { name: '기본 방침', exact: true })).toBeVisible();
        }
        if (screen === 'map') await expect(ready.getByTestId('map-tap-target')).toHaveCount(sites);
        if (screen === 'lobby') await expect(ready.locator('[data-anchor-key]')).toHaveCount(sites);
        await expect(page.locator('[data-state="loading"]:visible')).toHaveCount(0);
        await expect(page.locator('[data-state="error"]:visible')).toHaveCount(0);
        screens.push({ screen, ...(await measureMobileScreen(page)) });
        await page.screenshot({ path: info.outputPath(`mobile-${screen}-375.png`), fullPage: true });
        if (screen === 'main') {
          const menu = page.locator('summary').filter({ hasText: /^전체$/ });
          const close = page.getByRole('button', { name: '메뉴 닫기', exact: true });
          await expect(close).toBeHidden();
          await menu.tap();
          await expect(close).toBeVisible();
          screens.push({ screen: 'main-open-menu', ...(await measureMobileScreen(page)) });
          await page.screenshot({ path: info.outputPath('mobile-main-open-menu-375.png') });
          await close.tap();
          await expect(close).toBeHidden();
        }
      }
      await page.context().clearCookies();
      await page.goto('/lobby');
      await expect(page.getByRole('link', { name: '로그인', exact: true }).first()).toBeVisible();
      await page.getByRole('tab', { name, exact: true }).tap();
      await expect(page.getByTestId('public-map').getByTestId('world-map')).toBeVisible();
      await expect(page.locator('[data-state="loading"]:visible')).toHaveCount(0);
      screens.push({ screen: 'lobby-anonymous', ...(await measureMobileScreen(page)) });
      await page.screenshot({ path: info.outputPath('mobile-lobby-anonymous-375.png'), fullPage: true });
      await writeFile(info.outputPath('mobile-screen-measurements.json'), JSON.stringify(screens, null, 2));
      for (const { screen, width, targetCount, undersized, overflow } of screens) {
        expect.soft(width, screen).toBe(375);
        expect.soft(targetCount, screen).toBeGreaterThan(0);
        expect.soft(undersized, `${screen}: 44px`).toEqual([]);
        expect.soft(overflow, `${screen}: horizontal overflow`).toEqual([]);
      }
    })();
    executions.add(execution);
    void execution.finally(() => executions.delete(execution)).catch(() => undefined);
    await execution;
  });
}
