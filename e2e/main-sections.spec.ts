import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createAccount, e2eDatabaseUrl, withE2eDb } from './account';
import { holdLease, query } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import type { WorldMap } from '../apps/web/src/game/types';

// T3-10 · AC-M3-08·M1-19·M1-07·INT-10·INT-11의 메인 영역 이동 회귀 검사.
// 실제 API·PostgreSQL과 정식 191년 판을 쓴다. 전체 반응형 AC의 완료 판정은 별도다.
let ownWorld: string | undefined;
let ownEmail: string | undefined;
let hold: Awaited<ReturnType<typeof holdLease>> | undefined;
const executions = new Set<Promise<unknown>>();
test.use({ actionTimeout: 15_000 });

test.afterEach(async ({ page }) => {
  const errors: unknown[] = [];
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  // 본문이 실패해도 오류를 남긴다. 시간 초과 때도 페이지를 닫은 뒤 진행 중인 본문이 끝날 때까지 기다린다.
  for (const result of await Promise.allSettled([...executions]))
    if (result.status === 'rejected') errors.push(result.reason);
  executions.clear();
  let worldDeleted = false;
  if (hold) {
    try {
      await cleanupHeldWorld(hold, e2eDatabaseUrl());
      worldDeleted = true;
    } catch (error) {
      errors.push(error);
    }
  } else if (ownWorld) errors.push(new Error('실행권을 확보하지 못한 시험 월드를 보존합니다.'));
  if (ownEmail) {
    if (!ownWorld || worldDeleted) {
      try {
        await withE2eDb((db) => db.user.deleteMany({ where: { email: ownEmail } }));
      } catch (error) {
        errors.push(error);
      }
    } else errors.push(new Error('보존한 시험 월드의 계정도 함께 보존합니다.'));
  }
  hold = undefined;
  ownWorld = ownEmail = undefined;
  if (errors.length) throw new AggregateError(errors, '메인 영역 시험 본문·페이지·실행권·DB 정리 실패');
});

test('정식191년 메인·예턴 메뉴 이동·초점·375~1440px·30초 재조회 뒤 초안 보존', async ({ page }, info) => {
  test.setTimeout(180_000);
  const execution = (async () => {
    ownWorld = (
      await withE2eDb(async (db) => {
        const initial = await loadInitialWorldFromDb(db, {
          scenario: 'integration191',
          map: 'integration',
          statRules: 'five-stats',
          portraitMap: '191-map',
          seed: 'main-sections-191',
        });
        initial.ruleFeatures = [
          'campaign-assignment-v2',
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
        return saveInitialWorld(db, initial, { name: '메인 영역 정식191', turnTermMinutes: 60, endYear: 201 });
      })
    ).worldId;
    hold = await holdLease(ownWorld);
    await controlClock(hold.db, ownWorld, 'start');
    ownEmail = `main-sections-${randomUUID()}@example.test`;
    await createAccount(page, ownEmail);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${ownWorld}`);
    // 768px 이상은 위 바로가기 띠, 그보다 좁으면 하단 막대(지도·예턴·현황·기록·메시지·메뉴)로 패널을 하나씩 본다 (INT-25).
    const nav = page.getByRole('navigation', { name: '메인 영역 바로가기', exact: true });
    const bar = page.getByRole('tablist', { name: '메인 화면', exact: true });
    const tab = (name: string) => bar.getByRole('tab', { name, exact: true });
    const cityPanel = page.getByRole('region', { name: '도시 정보', exact: true });
    const commandPanel = page.getByRole('region', { name: '명령 목록', exact: true });
    const mainPath = `/w/${ownWorld}`;
    await expect(nav).toBeHidden();
    await expect(tab('지도')).toHaveAttribute('aria-selected', 'true');
    await expect(commandPanel).toBeHidden();
    await tab('예턴').click();
    await expect(page).toHaveURL(new RegExp(`${mainPath}#main-commands$`));
    await expect(commandPanel.getByText('이 월드에 내 장수가 없습니다', { exact: true })).toBeVisible();
    await tab('현황').click();
    await expect(tab('현황')).toHaveAttribute('aria-selected', 'true');
    await expect(cityPanel.getByText('지도에서 도시를 고르세요', { exact: true })).toBeVisible();
    await expect(commandPanel).toBeHidden();
    await tab('예턴').click();

    await commandPanel.getByRole('link', { name: '장수 만들기', exact: true }).click();
    await expect(page.getByRole('spinbutton')).toHaveCount(5);
    await page.getByLabel('이름', { exact: true }).fill('영역장수');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect
      .poll(() =>
        hold!.db.inputEvent.count({ where: { worldId: ownWorld, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    expect(hold.lost).toBeUndefined();
    await new TurnLoop(hold.db, hold.lease).advanceTo(0);
    await expect(page.getByRole('heading', { level: 1, name: '군략도', exact: true })).toBeVisible();
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    const map = await query<WorldMap>(page, 'world.map', { worldId: ownWorld });
    expect(map.operationalMap).not.toBeNull();
    expect(map.nations).toHaveLength(21);

    const measurements = [];
    for (const width of [375, 767, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const mobile = width < 768;
      if (mobile) {
        await expect(nav).toBeHidden();
        await tab('지도').click();
      } else {
        await expect(bar).toBeHidden();
        await nav.getByRole('button', { name: '지도로 이동', exact: true }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const sizes = await (mobile ? bar.getByRole('tab') : nav.locator('button')).evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.textContent, width: rect.width, height: rect.height };
        }),
      );
      expect(sizes).toHaveLength(6);
      expect(sizes.filter((size) => size.width < 44 || size.height < 44)).toEqual([]);
      const detailTarget = (await page.getByRole('button', { name: '도시 정보 보기', exact: true }).boundingBox())!;
      expect(detailTarget.width).toBeGreaterThanOrEqual(44);
      expect(detailTarget.height).toBeGreaterThanOrEqual(44);
      const mapBox = (await page.getByRole('region', { name: '지도', exact: true }).boundingBox())!;
      if (mobile) {
        // 한 번에 한 패널만 보이고 막대는 화면 아래에 붙어 있다.
        await expect(cityPanel).toBeHidden();
        await expect(commandPanel).toBeHidden();
        const barBox = (await bar.boundingBox())!;
        expect(barBox.y + barBox.height).toBeCloseTo(900, 0);
        expect(barBox.width).toBe(await page.evaluate(() => document.documentElement.clientWidth));
        measurements.push({ width, sizes, detailTarget, mapBox, barBox });
      } else {
        const cityBox = (await cityPanel.boundingBox())!;
        const commandsBox = (await commandPanel.boundingBox())!;
        expect(cityBox.y).toBeGreaterThan(mapBox.y + mapBox.height - 1);
        if (width <= 1100) expect(commandsBox.y).toBeGreaterThan(cityBox.y + cityBox.height - 1);
        else expect(commandsBox.x).toBeGreaterThan(mapBox.x + mapBox.width - 1);
        measurements.push({ width, sizes, detailTarget, mapBox, cityBox, commandsBox });
      }
      await page.screenshot({ path: info.outputPath(`main-sections-${width}.png`), fullPage: true });
    }

    // 375×812 첫 예턴 화면: 막대의 `예턴`을 키보드로 고르면 44px 칸이 12개 이상 막대 위에 다 보인다.
    await page.setViewportSize({ width: 375, height: 812 });
    await tab('지도').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab('예턴')).toBeFocused();
    await expect(tab('지도')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(tab('예턴')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('예턴')).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`${mainPath}#main-commands$`));
    await expect(editor).toBeVisible();
    const barTop = (await bar.boundingBox())!.y;
    const firstScreen = await editor.locator('tr[data-slot]').evaluateAll((rows, limit) => {
      const heights = rows.map((row) => row.getBoundingClientRect().height);
      const shown = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        const box = row.closest('table')!.parentElement!.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= Math.min(limit, box.bottom) + 0.5;
      }).length;
      return { heights, shown };
    }, barTop);
    expect(firstScreen.heights.every((height) => height >= 44)).toBe(true);
    expect(firstScreen.shown).toBeGreaterThanOrEqual(12);
    measurements.push({ width: 375, height: 812, firstTurnScreen: firstScreen });
    await page.screenshot({ path: info.outputPath('main-sections-turns-375x812.png') });
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="30"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: '30번 칸에 넣기', exact: true }).click();
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await editor.evaluate((node) => Object.assign(window, { __mainSectionEditor: node }));
    const actor = await hold.db.general.findFirstOrThrow({ where: { worldId: ownWorld, user: { email: ownEmail } } });
    const enemy = map.cities.find(
      (city) => city.nationId !== null && city.nationId !== actor.nationId && city.key !== actor.cityKey,
    )!;
    await tab('지도').click();
    await expect(page).toHaveURL(new RegExp(`${mainPath}$`));
    const enemyMarker = page.getByTestId('world-map').locator(`[data-city-key="${enemy.key}"]`);
    await enemyMarker.focus();
    await page.keyboard.press('Enter');
    // 지도에서 고른 도시는 패널을 바꾸지 않는다. `도시 정보 보기`가 현황 패널을 열고 도시 머리글로 초점을 옮긴다.
    await expect(tab('지도')).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '도시 정보 보기', exact: true }).click();
    await expect(tab('현황')).toHaveAttribute('aria-selected', 'true');
    await expect(cityPanel.getByRole('heading', { name: '도시 정보', exact: true })).toBeFocused();
    await expect(cityPanel.locator(`[data-city-key="${enemy.key}"][data-visibility="public"]`)).toBeVisible();
    await expect(cityPanel.getByRole('meter')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('main-sections-city-375.png') });
    const base = `${new URL(page.url()).origin}${mainPath}?city=${enemy.key}`;
    const selectedUrl = page.url();
    expect(selectedUrl).toBe(`${base}#main-status`);
    // 새로고침해도 고른 패널과 도시가 남는다. 저장하지 않은 편집은 탭의 sessionStorage에 있다.
    await page.reload();
    await expect(tab('현황')).toHaveAttribute('aria-selected', 'true');
    await expect(cityPanel.locator(`[data-city-key="${enemy.key}"][data-visibility="public"]`)).toBeVisible();
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await editor.evaluate((node) => Object.assign(window, { __mainSectionEditor: node }));

    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const historyLength = await page.evaluate(() => history.length);
      if (width === 375) {
        // 좁은 메인에는 게임 메뉴 막대 대신 메인 하단 막대 하나만 있다.
        await expect(
          page.getByRole('navigation', { name: '게임 메뉴', exact: true }).filter({ visible: true }),
        ).toHaveCount(0);
        await expect(page.locator('summary').filter({ hasText: /^전체$/ })).toBeHidden();
        await tab('예턴').click();
        await expect(tab('예턴')).toHaveAttribute('aria-selected', 'true');
        await expect(page).toHaveURL(`${base}#main-commands`);
      } else {
        const gameNav = page.getByRole('navigation', { name: '게임 메뉴', exact: true }).filter({ visible: true });
        const turnsLink = gameNav.getByRole('link', { name: '예턴', exact: true }).filter({ visible: true });
        await expect(turnsLink).toHaveAttribute('href', `/w/${ownWorld}?city=${enemy.key}#main-commands`);
        await turnsLink.click();
        await expect(commandPanel.getByRole('heading', { name: '명령 목록', exact: true })).toBeFocused();
        await turnsLink.focus();
        await page.keyboard.press('Enter');
        await expect(commandPanel.getByRole('heading', { name: '명령 목록', exact: true })).toBeFocused();
        expect(page.url()).toBe(selectedUrl);
        await expect(
          gameNav.getByRole('link', { name: '군략도', exact: true }).filter({ visible: true }),
        ).toHaveAttribute('aria-current', 'page');
        await expect(turnsLink).not.toHaveAttribute('aria-current');
        const headingBox = (await commandPanel.getByRole('heading', { name: '명령 목록', exact: true }).boundingBox())!;
        const shortcutBox = (await nav.boundingBox())!;
        expect(headingBox.y).toBeGreaterThan(shortcutBox.y + shortcutBox.height);
      }
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(
        await editor.evaluate(
          (node) => node === (window as unknown as { __mainSectionEditor: Element }).__mainSectionEditor,
        ),
      ).toBe(true);
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
      await expect(editor.locator('tr[data-slot="30"]')).toHaveAttribute('aria-selected', 'true');
      await page.screenshot({ path: info.outputPath(`main-turns-menu-${width}.png`) });
    }

    // 768~1099px은 한 줄로 쌓인 칸을 위 바로가기 띠로 오간다. 375px은 하단 막대로 패널을 바꾼다. 둘 다 도시 선택은 그대로다.
    await page.setViewportSize({ width: 1024, height: 900 });
    for (const [name, heading] of [
      ['국가로 이동', '국가 정보'],
      ['장수로 이동', '장수 정보'],
      ['기록으로 이동', '개인 기록'],
      ['예턴으로 이동', '명령 목록'],
    ]) {
      const button = nav.getByRole('button', { name, exact: true });
      await button.focus();
      await page.keyboard.press('Space');
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeFocused();
      expect(new URL(page.url()).searchParams.get('city')).toBe(String(enemy.key));
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const mainMenu = page.getByRole('navigation', { name: '국가와 내 장수 메뉴', exact: true });
    for (const [name, regions, hash] of [
      ['현황', ['도시 정보', '국가 정보', '장수 정보'], 'main-status'],
      ['기록', ['개인 기록'], 'main-records'],
      ['메뉴', [], 'main-menu'],
      ['예턴', ['명령 목록'], 'main-commands'],
    ] as const) {
      await tab(name).focus();
      await page.keyboard.press('Space');
      await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(`${base}#${hash}`);
      for (const region of regions) await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
      if (name === '메뉴') await expect(mainMenu).toBeVisible();
      else await expect(mainMenu).toBeHidden();
    }
    const turnsRefresh = page.waitForResponse((response) => response.url().includes('turns.get') && response.ok());
    // 10초 주기 재조회가 여러 번 지나도 초안과 선택을 유지한다.
    await Promise.all([turnsRefresh, new Promise((resolve) => setTimeout(resolve, 31_000))]);
    expect(
      await editor.evaluate(
        (node) => node === (window as unknown as { __mainSectionEditor: Element }).__mainSectionEditor,
      ),
    ).toBe(true);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    await expect(editor.locator('tr[data-slot="30"]')).toHaveAttribute('aria-selected', 'true');

    // 보조 화면에서도 같은 월드·도시의 메인 예턴으로 돌아온다. 뒤로·앞으로 이동과 단독 주소도 유지한다.
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 375) {
        // 좁은 메인의 공통 화면은 `메뉴` 패널에 있다.
        await tab('메뉴').click();
        await page
          .getByRole('navigation', { name: '공통 메뉴', exact: true })
          .getByRole('link', { name: '기록', exact: true })
          .click();
      } else {
        await page
          .getByRole('navigation', { name: '게임 메뉴', exact: true })
          .filter({ visible: true })
          .getByRole('link', { name: '기록', exact: true })
          .filter({ visible: true })
          .click();
      }
      await expect(page.getByRole('heading', { level: 1, name: '기록 · 내 장수', exact: true })).toBeVisible();
      const recordsUrl = page.url();
      expect(new URL(recordsUrl).searchParams.get('city')).toBe(String(enemy.key));
      const gameNav = page.getByRole('navigation', { name: '게임 메뉴', exact: true }).filter({ visible: true });
      const turnsLink = gameNav.getByRole('link', { name: '예턴', exact: true }).filter({ visible: true });
      await turnsLink.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${base}#main-commands`);
      await expect(commandPanel.getByRole('heading', { name: '명령 목록', exact: true })).toBeFocused();
      if (width === 375) await expect(tab('예턴')).toHaveAttribute('aria-selected', 'true');
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
      await expect(editor.locator('tr[data-slot="30"]')).toHaveAttribute('aria-selected', 'true');
      await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
      await page.goBack();
      await expect(page).toHaveURL(recordsUrl);
      await page.goForward();
      await expect(page).toHaveURL(`${base}#main-commands`);
      await expect(commandPanel.getByRole('heading', { name: '명령 목록', exact: true })).toBeFocused();
      const historyLength = await page.evaluate(() => history.length);
      // 메인에서 다시 예턴을 골라도 기록이 쌓이지 않는다. 좁은 메인은 게임 메뉴 대신 하단 막대를 쓴다.
      if (width === 375) await tab('예턴').click();
      else await turnsLink.click();
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      await page.goBack();
      await expect(page).toHaveURL(recordsUrl);
      await page.goForward();
      await expect(page).toHaveURL(`${base}#main-commands`);
      await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
      await editor.getByLabel('명령 찾기').focus();
      const refresh = page.waitForResponse((response) => response.url().includes('turns.get') && response.ok());
      await refresh;
      await expect(editor.getByLabel('명령 찾기')).toBeFocused();
      await page.screenshot({ path: info.outputPath(`main-turns-return-${width}.png`) });
    }
    // 좁은 메인의 다른 패널에서 보조 화면으로 갔다가 뒤로 오면 그 패널이 그대로다.
    await tab('메뉴').click();
    await mainMenu.getByRole('link', { name: '지도 크게', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${ownWorld}/map$`));
    await page.goBack();
    await expect(page).toHaveURL(`${base}#main-menu`);
    await expect(tab('메뉴')).toHaveAttribute('aria-selected', 'true');
    await expect(mainMenu).toBeVisible();
    await page.goto(`/w/${ownWorld}/turns`);
    await expect(page.getByRole('heading', { level: 1, name: '예턴 편집', exact: true })).toBeVisible();
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await page
      .getByRole('navigation', { name: '게임 메뉴', exact: true })
      .filter({ visible: true })
      .getByRole('link', { name: '예턴', exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/w/${ownWorld}#main-commands$`));
    await expect(commandPanel.getByRole('heading', { name: '명령 목록', exact: true })).toBeFocused();
    await expect(tab('예턴')).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await page.goto(`${base}#main-commands`);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    const saved = await hold.db.generalTurn.findMany({
      where: { worldId: ownWorld, generalId: actor.id },
      orderBy: { slot: 'asc' },
    });
    expect(saved).toHaveLength(30);
    expect(saved[29]).toMatchObject({ slot: 29, commandKey: 'farm' });

    // 실제 조회 실패와 장수 없음은 구분하고, 복구한 뒤 같은 막대를 쓸 수 있다.
    await page.route('**/trpc/**', async (route) => {
      if (route.request().url().includes('world.map')) await route.abort('failed');
      else await route.continue();
    });
    await page.reload();
    const mapPanel = page.getByRole('region', { name: '지도', exact: true });
    await tab('지도').click();
    await expect(mapPanel).toBeVisible();
    await expect(page).toHaveURL(base);
    await expect(mapPanel.getByRole('alert')).toContainText('불러오지 못했습니다', { timeout: 20_000 });
    await page.unroute('**/trpc/**');
    await mapPanel.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByTestId('operational-world-map')).toBeVisible();
    // 같은 HTTP 배치의 다른 조회도 중단될 수 있다. 새 문서에서 저장한 목록과 선택 도시를 다시 확인한다.
    await page.reload();
    await tab('예턴').click();
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    expect(new URL(page.url()).searchParams.get('city')).toBe(String(enemy.key));
    await writeFile(
      info.outputPath('main-sections-measurements.json'),
      JSON.stringify({ measurements, wholeResponsiveAcPassed: false }, null, 2),
    );
  })();
  executions.add(execution);
  await execution;
});
