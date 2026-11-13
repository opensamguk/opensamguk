import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../apps/server/src/router';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { holdLease, releaseHold } from './game';
import { test, expect, apiQuery } from './t210-fixture';

type Outputs = inferRouterOutputs<AppRouter>;

// T4-97 AC-P2-34: 자기 PG·실제 API·Vite·Chromium이다. 저장한 NPC에 계정을 붙이는 시험 배치이며 생성/재생 인수는 아니다.
// 위 띠·계정 메뉴(U1), 바로가기 띠의 예턴 상태와 도시에서 명령 고르기(U2)를 실제 저장·재접속·충돌까지 본다.
test('T4-97 메인 HUD 계정 메뉴·예턴 상태·도시에서 명령 고르기와 실제 저장·충돌', async ({ world }, info) => {
  test.setTimeout(120_000);
  const actor = await world.user('ruler');
  const initial = await readFixture();
  initial.ruleFeatures = ['personnel'];
  initial.generals[0] = { ...initial.generals[0]!, nextTurnTick: 1_000_000 };
  const { worldId } = await saveInitialWorld(world.hold.db, initial, {
    name: '메인 HUD 인수',
    turnTermMinutes: 60,
    endYear: 201,
    replayFormat: 3,
    ruleFeatures: ['personnel'],
  });
  const hold = await holdLease(worldId);
  const { page } = actor;
  const generalId = initial.generals[0]!.id;
  try {
    await hold.db.general.update({ where: { worldId_id: { worldId, id: generalId } }, data: { userId: actor.userId } });
    await controlClock(hold.db, worldId, 'start');
    await page.goto(`/w/${worldId}`);
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    const shortcuts = page.getByRole('navigation', { name: '메인 영역 바로가기', exact: true });
    const turnShortcut = shortcuts.getByRole('button', { name: '예턴으로 이동', exact: true });
    const turnStatus = page.getByTestId('main-turn-status');
    await expect(turnShortcut).toHaveAttribute('data-turn-status', 'saved');
    await expect(turnStatus).toHaveText('저장된 목록');
    await expect(shortcuts.getByRole('button')).toHaveCount(6);

    // U1: 375px 위 띠에는 계정 링크가 없고 `전체` 메뉴의 계정 줄에 있다. 1440px은 위 띠에 그대로 둔다.
    const banner = page.getByRole('banner');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [375, 767, 768, 1440]) {
        await test.step(`${colorScheme} ${width}px 계정 배치와 위 띠→게임 메뉴 Tab`, async () => {
          await page.setViewportSize({ width, height: 900 });
          const gameNav = page.getByRole('navigation', { name: '게임 메뉴', exact: true }).filter({ visible: true });
          // 폭 변경의 CSS는 바로 바뀌지만 계정 조작의 위치는 matchMedia change 뒤 React가 다시 그려야 바뀐다.
          // 그 전에 마지막 조작을 고르면 사라질 로그아웃(좁아짐)이나 뒤에 새로 생길 계정 링크(넓어짐) 앞에 서게 된다.
          // 이 폭의 계정 배치가 끝난 뒤에 위 띠 마지막 조작을 고르고 실제 Tab 순서를 본다.
          if (width < 768) {
            await expect(banner.getByRole('button', { name: '로그아웃', exact: true })).toHaveCount(0);
            await expect(banner.getByRole('link', { name: '내 계정', exact: true })).toHaveCount(0);
            await expect(gameNav.locator('summary')).toBeVisible();
          } else {
            await expect(banner.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
            await expect(banner.getByRole('link', { name: '내 계정', exact: true })).toBeVisible();
            await expect(banner.getByRole('link', { name: '알림 설정', exact: true })).toBeVisible();
          }
          const lastControl = banner.locator('a,button').filter({ visible: true }).last();
          await lastControl.focus();
          await expect(lastControl).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(gameNav.getByRole('link', { name: '군략도', exact: true })).toBeFocused();
          if (width < 768) {
            const summary = gameNav.locator('summary');
            await summary.click();
            const account = gameNav.getByRole('group', { name: '계정', exact: true });
            for (const name of ['내 계정', '알림 설정']) {
              const box = (await account.getByRole('link', { name, exact: true }).boundingBox())!;
              expect(box.width).toBeGreaterThanOrEqual(44);
              expect(box.height).toBeGreaterThanOrEqual(44);
            }
            const logout = account.getByRole('button', { name: '로그아웃', exact: true });
            await expect(logout).toBeVisible();
            const logoutBox = (await logout.boundingBox())!;
            expect(logoutBox.width).toBeGreaterThanOrEqual(44);
            expect(logoutBox.height).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: info.outputPath(`t4-97-menu-${colorScheme}-${width}.png`) });
            await page.keyboard.press('Escape');
            await expect(summary).toBeFocused();
            await expect(gameNav.locator('details')).not.toHaveAttribute('open');
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const badgeBox = (await turnShortcut.boundingBox())!;
          expect(badgeBox.width).toBeGreaterThanOrEqual(44);
          expect(badgeBox.height).toBeGreaterThanOrEqual(44);
          await page.screenshot({ path: info.outputPath(`t4-97-main-${colorScheme}-${width}.png`) });
        });
      }
    }

    // U2: 지도에서 고른 도시로 명령 칸에 가서 고르고 넣는다. 바로 넣지 않으며 대상 도시 기본값만 채운다.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const map = await apiQuery<Outputs['world']['map']>(actor, 'world.map', { worldId });
    const target = map.cities.find((city) => city.key !== initial.generals[0]!.cityKey)!;
    const commands = await apiQuery<Outputs['commands']['list']>(actor, 'commands.list', { worldId });
    const move = commands.find((command) => {
      const properties = (command.argsSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'cityKey' in properties;
    })!;
    await page.getByTestId('world-map').locator(`[data-city-key="${target.key}"]`).click();
    await expect(page).toHaveURL(new RegExp(`[?&]city=${target.key}`));
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    const cityPanel = page.getByRole('region', { name: '도시 정보', exact: true });
    await cityPanel.getByRole('button', { name: '이 도시로 명령 고르기', exact: true }).click();
    // 고른 칸이 없으므로 칸 목록으로 간다. 칸에서 Enter를 누르면 그 칸을 고르고 명령 찾기로 간다.
    const rowFocused = await editor.evaluate(
      (node) => node.contains(document.activeElement) && Boolean(document.activeElement?.matches('tr[data-slot]')),
    );
    expect(rowFocused).toBe(true);
    await page.keyboard.press('Enter');
    await expect(editor.getByRole('searchbox')).toBeFocused();
    await expect(turnShortcut).toHaveAttribute('data-turn-status', 'saved');
    await editor.getByRole('radio', { name: move.name, exact: true }).check();
    await expect(
      page.getByRole('radiogroup', { name: '대상 도시' }).getByRole('radio', { name: new RegExp(`^${target.name}`) }),
    ).toHaveAttribute('aria-checked', 'true');
    const slot = Number(await editor.locator('tr[aria-selected="true"]').getAttribute('data-slot'));
    await editor.getByRole('button', { name: `${slot}번 칸에 넣기`, exact: true }).click();
    await expect(turnShortcut).toHaveAttribute('data-turn-status', 'unsaved');
    await expect(turnStatus).toHaveText('저장하지 않은 편집 1건');
    await expect(turnShortcut.locator('[aria-hidden="true"]')).toHaveText('1');
    await page.screenshot({ path: info.outputPath('t4-97-unsaved-1440.png') });
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    await expect(turnShortcut).toHaveAttribute('data-turn-status', 'saved');
    await expect(turnShortcut.locator('[aria-hidden="true"]')).toHaveCount(0);
    let stored = await hold.db.generalTurn.findMany({ where: { worldId, generalId }, orderBy: { slot: 'asc' } });
    expect(stored).toHaveLength(30);
    expect(stored[slot - 1]).toMatchObject({ commandKey: move.key, args: { cityKey: target.key } });
    await page.reload();
    await expect(editor.locator(`tr[data-slot="${slot}"]`)).toContainText(move.name);
    await expect(turnShortcut).toHaveAttribute('data-turn-status', 'saved');

    // 두 탭 충돌: 늦은 탭의 바로가기도 충돌 상태가 되고 다시 적용해 저장하면 저장된 목록으로 돌아온다.
    const other = await actor.context.newPage();
    try {
      await other.setViewportSize({ width: 375, height: 900 });
      await other.goto(`/w/${worldId}`);
      const late = other.getByTestId('turn-editor');
      const lateShortcut = other
        .getByRole('navigation', { name: '메인 영역 바로가기', exact: true })
        .getByRole('button', { name: '예턴으로 이동', exact: true });
      await late.getByRole('button', { name: '선택 해제', exact: true }).click();
      await late.locator('tr[data-slot="29"]').click();
      await late.getByRole('radio', { name: '농지 개간', exact: true }).check();
      await late.getByRole('button', { name: '29번 칸에 넣기', exact: true }).click();
      await expect(lateShortcut).toHaveAttribute('data-turn-status', 'unsaved');
      await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
      await editor.locator('tr[data-slot="30"]').click();
      await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
      await editor.getByRole('button', { name: '30번 칸에 넣기', exact: true }).click();
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
      await late.getByRole('button', { name: '저장', exact: true }).click();
      await expect(late.getByTestId('stale-alert')).toBeVisible();
      await expect(lateShortcut).toHaveAttribute('data-turn-status', 'conflict');
      await expect(other.getByTestId('main-turn-status')).toHaveText('충돌 확인 필요 · 보관한 편집 1건');
      await other.screenshot({ path: info.outputPath('t4-97-conflict-375.png') });
      await late.getByTestId('stale-alert').getByRole('button', { name: '내 편집 다시 적용' }).click();
      await late.getByRole('button', { name: '저장', exact: true }).click();
      await expect(late.getByText('저장했습니다.', { exact: true })).toBeVisible();
      await expect(lateShortcut).toHaveAttribute('data-turn-status', 'saved');
      stored = await hold.db.generalTurn.findMany({ where: { worldId, generalId }, orderBy: { slot: 'asc' } });
      expect(stored[28]!.commandKey).toBe('farm');
      expect(stored[29]!.commandKey).toBe('farm');
      expect(stored[slot - 1]).toMatchObject({ commandKey: move.key, args: { cityKey: target.key } });
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const gameNav = page.getByRole('navigation', { name: '게임 메뉴', exact: true }).filter({ visible: true });
    await gameNav.locator('summary').click();
    await gameNav
      .getByRole('group', { name: '계정', exact: true })
      .getByRole('button', { name: '로그아웃', exact: true })
      .click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await page.close();
    await releaseHold(hold);
  }
});
