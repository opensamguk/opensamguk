import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../apps/server/src/router';
import { readFixture } from '../apps/server/test/readFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { holdLease, releaseHold } from './game';
import { test, expect, apiQuery } from './t210-fixture';

type Outputs = inferRouterOutputs<AppRouter>;

// AC-P2-29: 자기 PG·실제 API·Vite·Chromium이다. 저장한 NPC에 계정을 붙이는 시험 배치이며 생성/재생 인수는 아니다.
// 작은 폭의 키보드/레이아웃은 이 시험, 실제 터치 조작은 함께 실행하는 mobile-controls가 본다.
test('T4-92 명령 카드의 개인 30칸·국가 12칸 저장과 모바일·키보드', async ({ world }, info) => {
  test.setTimeout(120_000);
  const actor = await world.user('ruler');
  const member = await world.user('member');
  const initial = await readFixture();
  initial.ruleFeatures = ['personnel'];
  initial.generals[0] = {
    ...initial.generals[0]!,
    officerLevel: 12,
    nextTurnTick: 1_000_000,
  };
  initial.generals[1] = { ...initial.generals[1]!, officerLevel: 1 };
  const { worldId } = await saveInitialWorld(world.hold.db, initial, {
    name: '명령 카드 인수',
    turnTermMinutes: 60,
    endYear: 201,
    replayFormat: 3,
    ruleFeatures: ['personnel'],
  });
  const hold = await holdLease(worldId);
  const { page } = actor;
  try {
    await hold.db.general.update({
      where: { worldId_id: { worldId, id: initial.generals[0]!.id } },
      data: { userId: actor.userId },
    });
    await hold.db.general.update({
      where: { worldId_id: { worldId, id: initial.generals[1]!.id } },
      data: { userId: member.userId },
    });
    await controlClock(hold.db, worldId, 'start');
    await page.goto(`/w/${worldId}/turns`);
    const editor = page.getByTestId('turn-editor');
    const picker = editor.getByRole('region', { name: '명령 고르기' });
    const listId = await picker.getByRole('searchbox').getAttribute('aria-controls');
    const cardList = page.locator(`[id="${listId}"]`);
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    const listed = await apiQuery<Outputs['commands']['list']>(actor, 'commands.list', { worldId });
    await expect(picker.getByRole('radio')).toHaveCount(listed.length);
    for (const command of listed) {
      const radio = picker.getByRole('radio', { name: command.name, exact: true });
      await expect(radio).toHaveAttribute('aria-describedby', /.+/);
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const sizes = await picker.getByRole('radio').evaluateAll((radios) =>
          radios.map((radio) => {
            const card = radio.closest('label')!.getBoundingClientRect();
            return { width: card.width, height: card.height };
          }),
        );
        expect(sizes.every((card) => card.width >= 44 && card.height >= 44)).toBe(true);
        // 분류 단추와 넣기 단추도 모든 폭에서 44px다.
        const controls = await picker
          .getByRole('group', { name: '명령 분류' })
          .getByRole('button')
          .or(picker.getByRole('button', { name: /에 넣기/ }))
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const box = button.getBoundingClientRect();
              return { width: box.width, height: box.height };
            }),
          );
        expect(controls.length).toBeGreaterThan(1);
        expect(controls.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await cardList.evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
        // 긴 이름은 CSS만 검사하는 DOM 고정물이다. 서버 응답이나 게임 명령 이름을 바꾸지 않는다.
        const nameId = await picker.getByRole('radio').first().getAttribute('aria-labelledby');
        const name = page.locator(`[id="${nameId}"]`);
        const originalName = await name.textContent();
        await name.evaluate((element) => {
          element.textContent = '아주긴명령이름'.repeat(30);
        });
        expect(await cardList.evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
        await name.evaluate((element, original) => {
          element.textContent = original;
        }, originalName);
        await picker.screenshot({ path: info.outputPath(`command-cards-${colorScheme}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await picker.getByRole('group', { name: '명령 분류' }).getByRole('button').last().focus();
    await page.keyboard.press('Tab');
    await expect(picker.getByRole('radio').first()).toBeFocused();
    expect(
      await picker
        .getByRole('radio')
        .first()
        .evaluate((radio) => getComputedStyle(radio.closest('label')!).outlineWidth),
    ).toBe('2px');
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('radio').nth(1)).toBeFocused();
    await expect(picker.getByRole('radio').nth(1)).toBeChecked();
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="30"]').click();
    await picker.getByRole('searchbox').fill('농지 개간');
    await picker.getByRole('searchbox').press('Enter');
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    let stored = await hold.db.generalTurn.findMany({
      where: { worldId, generalId: initial.generals[0]!.id },
      orderBy: { slot: 'asc' },
    });
    expect(stored).toHaveLength(30);
    expect(stored[29]!.commandKey).toBe('farm');

    const other = await actor.context.newPage();
    try {
      await other.goto(`/w/${worldId}/turns`);
      const late = other.getByTestId('turn-editor');
      await late.getByRole('button', { name: '선택 해제', exact: true }).click();
      await late.locator('tr[data-slot="1"]').click();
      await late.getByRole('radio', { name: '상업 투자', exact: true }).check();
      await late.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
      await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
      await editor.locator('tr[data-slot="2"]').click();
      await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
      await editor.getByRole('button', { name: '2번 칸에 넣기', exact: true }).click();
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
      await late.getByRole('button', { name: '저장', exact: true }).click();
      const conflict = late.getByTestId('stale-alert');
      await expect(conflict).toContainText('다른 곳에서 먼저 바뀌었습니다.');
      await conflict.getByRole('button', { name: '내 편집 다시 적용' }).click();
      await late.getByRole('button', { name: '저장', exact: true }).click();
      await expect(late.getByText('저장했습니다.', { exact: true })).toBeVisible();
      stored = await hold.db.generalTurn.findMany({
        where: { worldId, generalId: initial.generals[0]!.id },
        orderBy: { slot: 'asc' },
      });
      expect(stored[0]!.commandKey).toBe('commerce');
      expect(stored[1]!.commandKey).toBe('farm');
      expect(stored[29]!.commandKey).toBe('farm');
    } finally {
      await other.close();
    }

    await page.goto(`/w/${worldId}/nation/turns`);
    await expect(editor.locator('tr[data-slot]')).toHaveCount(12);
    const national = await apiQuery<Outputs['nationCommands']['list']>(actor, 'nationCommands.list', { worldId });
    await expect(picker.getByRole('radio')).toHaveCount(national.length);
    for (const command of national)
      await expect(picker.getByRole('radio', { name: command.name, exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="12"]').click();
    await picker.getByRole('radio', { name: '천도', exact: true }).check();
    // 인자 입력 화면(INT-25)의 도시 목록에서 고른다.
    const capitalName = initial.cities.find((city) => city.cityKey === initial.nations[0]!.capitalCityKey)!.name;
    await page
      .getByRole('radiogroup', { name: '대상 도시' })
      .getByRole('radio', { name: new RegExp(`^${capitalName}`) })
      .click();
    await editor.getByRole('button', { name: '12번 칸에 넣기', exact: true }).click();
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(editor.locator('tr[data-slot="12"]')).toContainText('천도');
    const tabs = await apiQuery<Outputs['nationTurns']['get']>(actor, 'nationTurns.get', { worldId });
    const own = tabs.tabs.find((tab) => tab.holder?.generalId === initial.generals[0]!.id);
    expect(own?.slots).toHaveLength(12);
    expect(own?.slots[11]?.commandKey).toBe('nation_capital');
    const request = {
      worldId,
      office: own!.office,
      revision: own!.revision,
      slots: own!.slots.map(({ commandKey, args }) => ({ commandKey, args })),
    };
    const denied = await member.context.request.post('/trpc/nationTurns.set', {
      data: request,
      headers: { Origin: world.stack.webOrigin },
    });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.data.code).toBe('FORBIDDEN');
    const invalid = await actor.context.request.post('/trpc/nationTurns.set', {
      data: { ...request, slots: request.slots.slice(1) },
      headers: { Origin: world.stack.webOrigin },
    });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.data.code).toBe('BAD_REQUEST');
    expect(await apiQuery(actor, 'nationTurns.get', { worldId })).toEqual(tabs);
    expect(
      await hold.db.generalTurn.findMany({
        where: { worldId, generalId: initial.generals[0]!.id },
        orderBy: { slot: 'asc' },
      }),
    ).toEqual(stored);
  } finally {
    await page.close();
    await releaseHold(hold);
  }
});
