import { expect, test, type Browser, type Page } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import { createGeneralByApi, e2eWorld, mutate, query, setTurns, stubPortraits, turns } from './game';

// T2-12 · AC-M2-15 화면: 국가 작전판과 감찰.
// 계약은 AppRouter의 operation·inspection 라우터(T2-11, Codex)다. 이 시험은 부모가 배정한 통합 슬롯에서만 돌리고 그 전에는 증거로 세지 않는다.
// 화면: docs/plans/T2-12.md "실제 API 대조와 착수 정정" 절.

test.describe.configure({ timeout: 180_000 });

interface Member {
  page: Page;
  generalId: number;
}

// 새 계정·장수를 만들고 DB에서 nationId 국가의 장수로 둔다. 수뇌 5~10, 일반 1 (T2-05 표).
async function member(browser: Browser, world: string, nationId: number, officerLevel: number): Promise<Member> {
  const page = await (await browser.newContext()).newPage();
  await stubPortraits(page);
  await createAccount(page);
  const general = await createGeneralByApi(page, world);
  await withE2eDb(async (db) => {
    const city = await db.city.findFirstOrThrow({ where: { worldId: world, nationId }, select: { cityKey: true } });
    await db.general.update({
      where: { worldId_id: { worldId: world, id: general.id } },
      data: { nationId, officerLevel, cityKey: city.cityKey, crew: 0 },
    });
  });
  return { page, generalId: general.id };
}

// 새 장수는 병력·훈련·사기가 0이다. 기준 1000/60/60 제안은 모병 1·훈련 6·사기 6·출병 1의 14칸이 목표 전에 있어야 한다.
// 첫 칸이 다음 달 첫 tick이어도 준비가 index 2부터 들어가 STALE 시험의 index 1 farm과 겹치지 않도록 목표를 지금+17개월로 둔다.
async function setup(page: Page) {
  await createAccount(page);
  const world = await e2eWorld(page);
  const map = await query<{
    cities: Array<{ key: number; nationId: number | null }>;
    nations: Array<{ id: number }>;
  }>(page, 'world.map', { worldId: world });
  const summary = await query<{ gameDate: { year: number; month: number } }>(page, 'world.summary', { worldId: world });
  const [ours, theirs] = map.nations;
  const target = map.cities.find((c) => c.nationId === theirs!.id)!;
  const at = summary.gameDate.year * 12 + summary.gameDate.month - 1 + 17;
  return {
    world,
    ours: ours!.id,
    theirs: theirs!.id,
    target,
    targetDate: { year: Math.floor(at / 12), month: (at % 12) + 1 },
  };
}

const editor = (page: Page) => page.getByTestId('turn-editor');

test.describe('국가 작전판', () => {
  test('수뇌가 작전을 만들면 판정이 아이콘과 글자로 보이고 일반 장수는 만들기 단추가 없다', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const chief = await member(browser, s.world, s.ours, 5);
    const soldier = await member(browser, s.world, s.ours, 1);

    await chief.page.goto(`/w/${s.world}/operations`);
    const form = chief.page.getByRole('form', { name: '작전 만들기' });
    await form.getByLabel('목표 도시').selectOption(String(s.target.key));
    await form.getByLabel('목표 연').fill(String(s.targetDate.year));
    await form.getByLabel('목표 월').fill(String(s.targetDate.month));
    await form.getByRole('checkbox').first().check();
    await form.getByRole('button', { name: '작전 만들기' }).click();
    await expect(chief.page).toHaveURL(/\/operations\/[^/]+$/);
    const timeline = chief.page.getByTestId('operation-timeline');
    await expect(timeline.locator('tbody tr').first()).toHaveAttribute('data-verdict', /READY|LATE|WEAK|MISSING/);
    await expect(timeline).toContainText(/준비됨|늦음|미흡|없음/);
    // 새 장수의 예턴은 비워 둔 칸이다. 직접 넣은 휴식과 다른 글자로 보인다.
    await expect(timeline.locator('td[data-kind="empty"]').first()).toHaveText('빈 칸');

    await soldier.page.goto(`/w/${s.world}/operations`);
    await expect(soldier.page.getByRole('button', { name: '작전 만들기' })).toHaveCount(0);
    await expect(soldier.page.getByRole('link', { name: '감찰' })).toHaveCount(0);
  });

  test('메인 초안을 고친 채 작전에 맞추면 덮기를 묻고, 넣은 뒤 같은 편집기로 저장하며 작전 밖 칸은 그대로다', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const chief = await member(browser, s.world, s.ours, 5);
    const { id } = await mutate<{ id: string }>(chief.page, 'operation.create', {
      worldId: s.world,
      targetCityKey: s.target.key,
      targetYear: s.targetDate.year,
      targetMonth: s.targetDate.month,
      min: { crew: 1000, train: 60, atmos: 60 },
      memberIds: [chief.generalId],
    });
    await setTurns(
      chief.page,
      s.world,
      Array.from({ length: 30 }, (_, i) => (i === 20 ? { commandKey: 'farm' } : null)),
    );

    // 메인에서 저장하지 않은 편집 하나를 만든다.
    await chief.page.goto(`/w/${s.world}`);
    await editor(chief.page).locator('tr[data-slot="25"]').click();
    await editor(chief.page).getByLabel('명령 찾기').fill('훈련');
    await editor(chief.page).getByRole('radio', { name: '훈련' }).check();
    await editor(chief.page)
      .getByRole('button', { name: /25번 칸에 넣기/ })
      .click();

    await chief.page.goto(`/w/${s.world}/operations/${id}`);
    await expect(editor(chief.page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await chief.page.getByRole('button', { name: '내 예턴을 작전에 맞추기' }).click();
    await expect(chief.page.getByTestId('align-preview').locator('tbody tr').first()).toBeVisible();
    // 미리보기를 닫아도 초안은 그대로다.
    await chief.page.getByRole('button', { name: '미리보기 닫기' }).click();
    await expect(editor(chief.page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

    await chief.page.getByRole('button', { name: '내 예턴을 작전에 맞추기' }).click();
    await chief.page.getByRole('button', { name: '초안에 넣기', exact: true }).click();
    await expect(chief.page.getByRole('alertdialog', { name: '초안 덮기 확인' })).toContainText(
      '저장하지 않은 편집 1건',
    );
    await chief.page.getByRole('button', { name: '덮고 넣기' }).click();
    await editor(chief.page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor(chief.page).getByRole('status')).toContainText('저장했습니다');

    const saved = await turns(chief.page, s.world);
    expect(saved.slots.some((slot) => slot.commandKey === 'attack')).toBe(true);
    expect(saved.slots[24]!.commandKey).toBe('train');
  });

  test('미리보기 중 다른 탭에서 예턴을 바꾸면 저장 때 충돌 안내와 다시 받은 비교를 보이고 고치던 초안은 남는다', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const chief = await member(browser, s.world, s.ours, 5);
    const { id } = await mutate<{ id: string }>(chief.page, 'operation.create', {
      worldId: s.world,
      targetCityKey: s.target.key,
      targetYear: s.targetDate.year,
      targetMonth: s.targetDate.month,
      min: { crew: 1000, train: 60, atmos: 60 },
      memberIds: [chief.generalId],
    });
    await chief.page.goto(`/w/${s.world}/operations/${id}`);
    await chief.page.getByRole('button', { name: '내 예턴을 작전에 맞추기' }).click();
    await chief.page.getByRole('button', { name: '초안에 넣기', exact: true }).click();
    // 다른 탭의 저장.
    await setTurns(chief.page, s.world, [null, { commandKey: 'farm' }]);
    await editor(chief.page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor(chief.page).getByTestId('stale-alert')).toBeVisible();
    await expect(chief.page.getByTestId('align-panel').getByRole('alert')).toContainText(
      '다른 곳에서 예턴이 바뀌었습니다',
    );
    await editor(chief.page).getByRole('button', { name: '내 편집 다시 적용' }).click();
    await editor(chief.page).getByRole('button', { name: '저장', exact: true }).click();
    const saved = await turns(chief.page, s.world);
    expect(saved.slots[1]!.commandKey).toBe('farm');
    expect(saved.slots.some((slot) => slot.commandKey === 'attack')).toBe(true);
  });

  test('다른 국가 작전 주소는 안내만 보이고 감찰 메뉴는 직책자에게만 보인다', async ({ browser, page }) => {
    const s = await setup(page);
    const chief = await member(browser, s.world, s.ours, 5);
    const outsider = await member(browser, s.world, s.theirs, 5);
    const { id } = await mutate<{ id: string }>(chief.page, 'operation.create', {
      worldId: s.world,
      targetCityKey: s.target.key,
      targetYear: s.targetDate.year,
      targetMonth: s.targetDate.month,
      min: { crew: 1000, train: 60, atmos: 60 },
      memberIds: [chief.generalId],
    });
    await outsider.page.goto(`/w/${s.world}/operations/${id}`);
    await expect(outsider.page.getByText('볼 수 없는 작전입니다')).toBeVisible();

    await chief.page.goto(`/w/${s.world}`);
    await chief.page.getByRole('link', { name: '감찰' }).click();
    await expect(chief.page.getByTestId('inspection-table')).toBeVisible();
  });
});
