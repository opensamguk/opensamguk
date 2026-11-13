import type { AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { createAccount, withE2eDb } from './account';
import { holdLease, query, releaseHold } from './game';
import { apiMutate, apiQuery, expect, test } from './t210-fixture';

type Output = inferRouterOutputs<AppRouter>;
const isTurnEdit = (url: URL) =>
  url.pathname.startsWith('/trpc/') && url.pathname.slice('/trpc/'.length).split(',').includes('turns.edit');

test.describe.configure({ timeout: 75_000 });

test('AC-M3-13 공지 지시를 우선 표시하고 조언을 누르면 첫 예턴이 한 번에 저장된다', async ({ world }, info) => {
  const ruler = await world.user('ruler');
  const member = await world.user('member');
  const { id: worldId } = world;
  const reason = '도시 농업을 보강합니다';
  await apiMutate(world, ruler, 'notice.nation.set', {
    worldId,
    body: reason,
    directive: { commandKey: 'farm', args: {} },
  });
  const expected = await apiQuery<Output['advice']['get']>(member, 'advice.get', { worldId });
  expect(expected.items).toHaveLength(3);
  expect(expected.items[0]).toMatchObject({ source: 'notice', reason, commandKey: 'farm' });
  const { page } = member;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${worldId}`);
  await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
  const advice = page.getByTestId('military-advice');
  await advice.getByRole('button', { name: '펼치기', exact: true }).click();
  const rows = advice.getByTestId('advice-item');
  await expect(rows).toHaveCount(3);
  const expectedReasons = expected.items.map((item) => item.reason);
  for (const [index, text] of expectedReasons.entries()) await expect(rows.nth(index)).toContainText(text);
  await expect(rows.first()).toHaveAttribute('data-advice-source', 'notice');
  await page.reload();
  await expect(rows).toHaveCount(3);
  for (const [index, text] of expectedReasons.entries()) await expect(rows.nth(index)).toContainText(text);
  const editor = page.getByTestId('turn-editor');
  const slot = editor.locator('tr[data-slot="1"]');
  const noticeRow = advice.locator('[data-testid="advice-item"][data-advice-source="notice"]');
  const put = noticeRow.getByRole('button', { name: '1칸에 넣기', exact: true });
  await put.click();
  await expect(slot).toContainText(expected.items[0]!.commandName);
  const saved = await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId });
  expect(saved.revision).toBe(expected.basis.revision + 1);
  expect(saved.slots[0]).toMatchObject({ commandKey: 'farm', args: {} });
  await page.reload();
  await expect(slot).toContainText(expected.items[0]!.commandName);
  await put.click();
  const confirmation = advice.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toHaveAccessibleDescription(/1칸의 .+ 바꿉니다/);
  const cancel = confirmation.getByRole('button', { name: '취소', exact: true });
  await expect(cancel).toBeFocused();
  await cancel.press('Escape');
  await expect(put).toBeFocused();
  expect((await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId })).revision).toBe(saved.revision);

  let external: Output['turns']['edit'] | undefined;
  await page.route(
    isTurnEdit,
    async (route) => {
      external = await apiMutate<Output['turns']['edit']>(world, member, 'turns.edit', {
        worldId,
        revision: saved.revision,
        op: { put: { from: 0, to: 0, commandKey: 'train', args: {} } },
      });
      await route.continue();
    },
    { times: 1 },
  );
  await put.click();
  await confirmation.getByRole('button', { name: '바꿔 넣기', exact: true }).click();
  await expect(advice.getByRole('status')).toContainText('다른 곳에서 먼저 바뀌었습니다.');
  expect(external?.ok).toBe(true);
  await expect(slot).toContainText('훈련');
  const current = await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId });
  expect(current.revision).toBe(saved.revision + 1);

  await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
  await editor.locator('tr[data-slot="2"]').click();
  await editor.getByLabel('명령 찾기').fill('훈련');
  await editor.getByRole('radio', { name: '훈련', exact: true }).check();
  await editor.getByRole('button', { name: '2번 칸에 넣기', exact: true }).click();
  await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  await noticeRow.getByRole('button', { name: '1칸에 넣기 (사용 불가)', exact: true }).click();
  await expect(noticeRow.getByRole('note')).toContainText('편집 중인 예턴을 저장하거나 취소하면 넣을 수 있습니다');
  expect((await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId })).revision).toBe(current.revision);

  const updated = '농업을 계속 보강합니다';
  await apiMutate(world, ruler, 'notice.nation.set', {
    worldId,
    body: updated,
    directive: { commandKey: 'farm', args: {} },
  });
  await page.getByRole('dialog').getByRole('button', { name: '확인', exact: true }).click();
  await expect(rows.first()).toContainText(updated);
  await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  const actor = await world.hold.db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId, id: member.generalId } },
  });
  const storedWorld = await world.hold.db.world.findUniqueOrThrow({ where: { id: worldId } });
  await apiMutate(world, ruler, 'operation.create', {
    worldId,
    targetCityKey: actor.cityKey,
    targetYear: storedWorld.startYear,
    targetMonth: 6,
    min: { crew: 1000, train: 70, atmos: 60 },
    memberIds: [member.generalId],
  });
  await advice.getByRole('button', { name: '접기', exact: true }).click();
  await advice.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(rows.nth(0)).toHaveAttribute('data-advice-source', 'operation');
  await expect(rows.nth(1)).toHaveAttribute('data-advice-source', 'notice');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await advice.screenshot({ path: info.outputPath('military-advice-375.png') });

  const ronin = await world.user('ronin');
  const recommendations = await apiQuery<Output['advice']['get']>(ronin, 'advice.get', { worldId });
  const nation = recommendations.items.find((item) => item.nation !== null)?.nation;
  expect(nation).toBeDefined();
  await ronin.page.goto(`/w/${worldId}`);
  const roninAdvice = ronin.page.getByTestId('military-advice');
  await roninAdvice.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(roninAdvice.getByText(nation!.name, { exact: true }).first()).toBeVisible();
  await roninAdvice.getByRole('button', { name: '임관 넣기', exact: true }).first().click();
  await expect(roninAdvice.getByRole('status')).toContainText('저장했습니다');
  const joined = await apiQuery<Output['turns']['get']>(ronin, 'turns.get', { worldId });
  expect(joined.slots[0]).toMatchObject({ commandKey: 'join', args: { nationId: nation!.id } });
});

test('AC-M3-13 같은 예턴 판 번호에서도 계정이나 장수가 바뀌면 조언 저장을 거부한다', async ({ world }) => {
  const member = await world.user('member');
  const rival = await world.user('rival');
  const { id: worldId } = world;
  const { page } = member;
  const memberBefore = await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId });
  const rivalBefore = await apiQuery<Output['turns']['get']>(rival, 'turns.get', { worldId });
  expect(memberBefore.revision).toBe(rivalBefore.revision);

  await page.goto(`/w/${worldId}`);
  const advice = page.getByTestId('military-advice');
  await advice.getByRole('button', { name: '펼치기', exact: true }).click();
  const put = advice.getByRole('button', { name: '1칸에 넣기', exact: true }).first();
  await page.route(
    isTurnEdit,
    async (route) => {
      const response = await rival.context.request.post(route.request().url(), {
        data: route.request().postDataJSON(),
        headers: { Origin: world.stack.webOrigin },
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await put.click();
  await expect(advice.getByRole('alert')).toContainText('다시 로그인해야 저장할 수 있습니다');
  expect(await apiQuery<Output['turns']['get']>(rival, 'turns.get', { worldId })).toEqual(rivalBefore);

  await page.reload();
  await expect(put).toBeVisible();
  const replacement = await world.user('rivalMember');
  const replacementBefore = await apiQuery<Output['turns']['get']>(replacement, 'turns.get', { worldId });
  expect(replacementBefore.revision).toBe(memberBefore.revision);
  await page.route(
    isTurnEdit,
    async (route) => {
      await world.hold.db.$transaction(async (tx) => {
        await tx.general.update({ where: { worldId_id: { worldId, id: member.generalId } }, data: { userId: null } });
        await tx.general.update({
          where: { worldId_id: { worldId, id: replacement.generalId } },
          data: { userId: member.userId },
        });
      });
      await route.continue();
    },
    { times: 1 },
  );
  await put.click();
  await expect(advice.getByRole('alert')).toContainText('장수가 바뀌었습니다');
  expect(await apiQuery<Output['turns']['get']>(member, 'turns.get', { worldId })).toEqual(replacementBefore);
  expect(await world.hold.db.inputEvent.count({ where: { worldId, kind: 'turns.set' } })).toBe(0);
});

test('AC-M3-15 실제 월간 정산이 기록 화면에 순위와 한 줄 평을 갱신한다', async ({ page, t210Stack }, info) => {
  const email = await createAccount(page);
  const user = await withE2eDb((db) => db.user.findUniqueOrThrow({ where: { email } }));
  const initial = await monthlyFixture();
  initial.generals = initial.generals.map((general) => ({ ...general, nextTurnTick: 1_000_000_000, injury: 0 }));
  const player = initial.generals[2]!;
  const city = initial.cities.find((row) => row.cityKey === 3)!;
  city.agriculture = city.agricultureMax - 1;
  Object.assign(player, {
    userId: user.id,
    cityKey: city.cityKey,
    activeFromYear: initial.startYear,
    nextTurnTick: 500,
    gold: 100000,
  });
  const { worldId } = await withE2eDb((db) =>
    saveInitialWorld(db, initial, {
      name: '월단평 화면 검증',
      turnTermMinutes: 60,
      endYear: null,
      ruleFeatures: ['policy', 'reputation-v1'],
    }),
  );
  const hold = await holdLease(worldId);
  try {
    await controlClock(hold.db, worldId, 'start');
    const result = await page.request.post('/trpc/turns.edit', {
      headers: { Origin: t210Stack.webOrigin },
      data: { worldId, revision: 0, op: { put: { from: 0, to: 0, commandKey: 'farm', args: {} } } },
    });
    expect(result.ok()).toBe(true);
    expect(await result.json()).toMatchObject({ result: { data: { ok: true } } });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${worldId}/records?tab=world`);
    await expect(page.getByText('중원 정세가 아직 없습니다. 월간 정산 뒤에 쌓입니다')).toBeVisible();
    const engine = new TurnLoop(hold.db, hold.lease);
    await engine.advanceTo(TICKS_PER_MONTH);
    const first = await query<NonNullable<Output['review']['latest']>>(page, 'review.latest', { worldId });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ rank: 1, name: player.name, score: 2, kinds: ['domestic'] });
    const panel = page.getByTestId('monthly-review');
    await expect(panel).toContainText(first.entries[0]!.line);
    const records = await query<Output['records']['world']>(page, 'records.world', { worldId });
    const headline = records.items[0]?.review?.headline;
    expect(headline).toBeTruthy();
    await expect(page.getByText(headline!, { exact: true })).toBeVisible();
    await engine.advanceTo(2 * TICKS_PER_MONTH);
    await expect(panel).toContainText(/평판에 오른 장수가 없/);
    const month = panel.getByRole('combobox');
    await month.selectOption({ label: `${first.year}년 ${first.month}월` });
    await expect(panel).toContainText(first.entries[0]!.line);
    await expect(panel.getByRole('link', { name: new RegExp(player.name) })).toHaveAttribute(
      'href',
      `/w/${worldId}/nation/${first.entries[0]!.nation!.id}`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    await panel.screenshot({ path: info.outputPath('monthly-review-375.png') });
    expect(first.month).toBe(1);
    await month.selectOption({ label: `${first.year}년 2월` });
    await expect(panel.getByRole('heading')).toHaveText(`${first.year}년 2월 월단평`);
    await engine.advanceTo(3 * TICKS_PER_MONTH);
    await expect(panel.getByRole('heading')).toHaveText(`${first.year}년 3월 월단평`);
    await expect(month.locator('option:checked')).toHaveText(`${first.year}년 3월`);
    await page.goto(`/w/${worldId}`);
    await expect(page.getByTestId('world-review-headline').filter({ hasText: headline! })).toBeVisible();
  } finally {
    await page.close();
    await releaseHold(hold);
    await withE2eDb(async (db) => {
      await db.world.delete({ where: { id: worldId } });
      await db.user.delete({ where: { id: user.id } });
    });
  }
});
