import { expect, test, type Page } from '@playwright/test';
import { newEmail, signUpByApi, TEST_PASSWORD } from './account';
import {
  ApiError,
  createGeneralByApi,
  e2eWorld,
  mine,
  mutate,
  newGeneralName,
  setTurns,
  setUserStatus,
  stubPortraits,
  turns,
  waitNextTurn,
  waitTurnWindow,
} from './game';

// T1-15 · AC-M1-06~09 화면: 실제 서버·PostgreSQL·엔진(pnpm dev)과 Chromium으로 장수 생성과 30칸 예턴 편집을 본다.
// 엔진은 1분 턴으로 돈다. 칸 위치를 확인하는 시험은 waitTurnWindow로 다음 턴까지 여유가 있을 때 시작한다.

// 장수 생성 대기(최대 5초)와 다음 턴까지의 창 기다림(최대 약 1분)이 들어가므로 기본 30초보다 넉넉히 둔다.
test.describe.configure({ timeout: 150_000 });

const editor = (page: Page) => page.getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);
const saveButton = (page: Page) => editor(page).getByRole('button', { name: '저장', exact: true });

async function login(page: Page, email: string) {
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
}

// 새 계정과 장수를 만들고 예턴 화면을 연다. 30칸은 모두 휴식으로 시작한다.
async function openEditor(page: Page) {
  const email = await signUpByApi(page);
  const world = await e2eWorld(page);
  await createGeneralByApi(page, world);
  await waitTurnWindow(page, world);
  await page.goto(`/w/${world}/turns`);
  await expect(page.getByRole('heading', { level: 1, name: '예턴 편집' })).toBeVisible();
  await expect(row(page, 30)).toBeVisible();
  return { email, world };
}

async function pick(page: Page, command: string) {
  await editor(page).getByLabel('명령 찾기').fill(command);
  await editor(page).getByRole('radio', { name: command }).check();
}

test.describe('장수 생성', () => {
  test.beforeEach(async ({ page }) => stubPortraits(page));

  test('로그인하지 않으면 생성·예턴 화면 대신 로그인으로 보낸다', async ({ page }) => {
    await page.goto('/w/00000000-0000-4000-8000-000000000000/create');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.goto('/w/00000000-0000-4000-8000-000000000000/turns');
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test('합계를 넘으면 막고 이유를 보이며, 정상 생성하면 메인으로 가고 두 번째 생성은 거부된다', async ({ page }) => {
    await signUpByApi(page);
    const world = await e2eWorld(page);
    const name = newGeneralName();
    await page.goto(`/w/${world}/create`);
    await expect(page.getByRole('heading', { level: 1, name: '장수 생성' })).toBeVisible();

    await page.getByLabel('이름').fill(name);
    await page.getByRole('spinbutton', { name: '통솔' }).fill('80');
    await page.getByRole('spinbutton', { name: '무력' }).fill('80');
    await page.getByRole('spinbutton', { name: '지력' }).fill('15');
    await expect(page.getByTestId('remaining')).toHaveText('남은 점수 -10');
    const blocked = page.getByRole('button', { name: '장수 만들기 (사용 불가)' });
    await expect(blocked).toBeVisible();
    await blocked.click();
    await expect(page.getByRole('note')).toHaveText('능력치 합계가 10점 넘습니다. 합계는 165입니다.');

    await page.getByRole('spinbutton', { name: '무력' }).fill('70');
    await expect(page.getByTestId('remaining')).toHaveText('남은 점수 0');
    await page.getByRole('radio', { name: '초상 1' }).check();
    await page.screenshot({ path: 'test-results/t1-15-create.png', fullPage: true });
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();

    await expect(page).toHaveURL(`/w/${world}`);
    const { general } = await mine(page, world);
    expect(general).toMatchObject({ name, portraitId: 10001, leadership: 80, strength: 70, intel: 15 });

    await page.goto(`/w/${world}/create`);
    await expect(page.getByText(`이 월드의 내 장수는 ${name}입니다.`)).toBeVisible();
    await expect(page.getByRole('button', { name: /장수 만들기/ })).toHaveCount(0);
    const second = await mutate(page, 'general.create', {
      worldId: world,
      name: newGeneralName(),
      leadership: 55,
      strength: 55,
      intel: 55,
      portraitId: null,
    }).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(ApiError);
    expect((second as ApiError).code).toBe('CONFLICT');
  });

  test('잘못된 이름은 보내기 전에 막고, 이미 쓰는 이름은 서버 안내를 보여 준다', async ({ page }) => {
    await signUpByApi(page);
    const world = await e2eWorld(page);
    const taken = (await createGeneralByApi(page, world)).name;
    await page.context().clearCookies();
    await signUpByApi(page);

    await page.goto(`/w/${world}/create`);
    await page.getByLabel('이름').fill('조 운');
    await expect(page.getByText('이름은 한글·한자·영문·숫자만 씁니다.')).toBeVisible();
    await expect(page.getByRole('button', { name: '장수 만들기 (사용 불가)' })).toBeVisible();

    await page.getByLabel('이름').fill(taken);
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '이미 사용 중인 장수 이름입니다.' })).toBeVisible();
    expect((await mine(page, world)).general).toBeNull();
  });

  test('제재된 계정은 생성되지 않고 다시 로그인하라고 안내한다', async ({ page }) => {
    const email = await signUpByApi(page);
    const world = await e2eWorld(page);
    await page.goto(`/w/${world}/create`);
    await page.getByLabel('이름').fill(newGeneralName());
    await setUserStatus(email, 'SANCTIONED');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '로그인이 풀렸습니다.' })).toBeVisible();
    await expect(page.getByRole('link', { name: '다시 로그인' })).toBeVisible();
    expect(
      (
        await page.request.get(`/trpc/general.mine?input=${encodeURIComponent(JSON.stringify({ worldId: world }))}`)
      ).status(),
    ).toBe(401);
  });
});

test.describe('예턴 편집', () => {
  test('2~5칸 선택 → 농지 개간 → 경고가 있어도 저장 → 새로고침 후 유지', async ({ page }) => {
    const { world } = await openEditor(page);
    await row(page, 2).click();
    await row(page, 5).click({ modifiers: ['Shift'] });
    await expect(editor(page).getByTestId('selection')).toHaveText('선택: 2~5번 칸');

    await pick(page, '농지 개간');
    await editor(page).getByRole('button', { name: '2~5번 칸에 넣기' }).click();
    for (const slot of [2, 3, 4, 5]) await expect(row(page, slot)).toContainText('농지 개간');
    await expect(row(page, 1)).toContainText('휴식');
    await expect(row(page, 6)).toContainText('휴식');
    // 재야 장수는 내정을 할 수 없다. 사전 검사 경고가 보여도 저장은 된다 (AC-M1-09).
    await expect(row(page, 2)).toContainText('경고: 국가에 소속되어야 합니다.');
    await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await page.screenshot({ path: 'test-results/t1-15-turns-warning.png', fullPage: true });

    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    await expect(editor(page).getByTestId('draft-state')).toHaveText('저장된 목록');
    const saved = await turns(page, world);
    expect(saved.slots.slice(0, 6).map((s) => s.commandKey)).toEqual(['rest', 'farm', 'farm', 'farm', 'farm', 'rest']);

    await page.reload();
    for (const slot of [2, 3, 4, 5]) await expect(row(page, slot)).toContainText('농지 개간');
    await expect(row(page, 1)).toContainText('휴식');
  });

  test('밀기 1은 첫 칸을 휴식으로 채우고 한 칸씩 민다. 당기기와 구간 반복도 저장된다', async ({ page }) => {
    const { world } = await openEditor(page);
    await setTurns(page, world, [{ commandKey: 'farm' }, { commandKey: 'commerce' }, { commandKey: 'security' }]);
    await page.reload();
    await expect(row(page, 1)).toContainText('농지 개간');

    await editor(page).getByRole('button', { name: '밀기', exact: true }).click();
    await expect(row(page, 1)).toContainText('휴식');
    await expect(row(page, 2)).toContainText('농지 개간');
    await expect(row(page, 3)).toContainText('상업 투자');
    await expect(row(page, 4)).toContainText('치안 강화');

    await editor(page).getByLabel('칸 수').fill('2');
    await editor(page).getByRole('button', { name: '당기기', exact: true }).click();
    await expect(row(page, 1)).toContainText('상업 투자');
    await expect(row(page, 2)).toContainText('치안 강화');

    await row(page, 1).click();
    await row(page, 2).click({ modifiers: ['Shift'] });
    await editor(page).getByLabel('반복 횟수').fill('2');
    await editor(page).getByRole('button', { name: '고른 구간 반복', exact: true }).click();
    await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 3건');
    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    const saved = await turns(page, world);
    expect(saved.slots.slice(0, 7).map((s) => s.commandKey)).toEqual([
      'commerce',
      'security',
      'commerce',
      'security',
      'commerce',
      'security',
      'rest',
    ]);
  });

  test('마우스 없이 3칸에 명령을 넣고 저장한다', async ({ page }) => {
    const { world } = await openEditor(page);
    // 첫 칸에 키보드 초점이 올 때까지 Tab으로 옮긴다.
    for (let i = 0; i < 40; i++) {
      if (await row(page, 1).evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(row(page, 1)).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(editor(page).getByTestId('selection')).toHaveText('선택: 1~3번 칸');
    await page.keyboard.press('Enter');
    await expect(editor(page).getByLabel('명령 찾기')).toBeFocused();
    await page.keyboard.type('상업');
    await page.keyboard.press('Enter');
    for (const slot of [1, 2, 3]) await expect(row(page, slot)).toContainText('상업 투자');
    await expect(row(page, 3)).toBeFocused();

    for (let i = 0; i < 20; i++) {
      if (await saveButton(page).evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Shift+Tab');
    }
    await expect(saveButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    const saved = await turns(page, world);
    expect(saved.slots.slice(0, 4).map((s) => s.commandKey)).toEqual(['commerce', 'commerce', 'commerce', 'rest']);
  });

  test('인자가 있는 명령은 대상을 고르고, 빠진 인자는 넣기 전에 막는다', async ({ page }) => {
    const { world } = await openEditor(page);
    await row(page, 1).click();
    await pick(page, '이동');
    const city = editor(page).getByRole('combobox', { name: '대상 도시' });
    await expect(editor(page).getByRole('button', { name: '1번 칸에 넣기 (사용 불가)' })).toBeVisible();
    await city.selectOption({ label: '낙양' });
    await editor(page).getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
    await expect(row(page, 1)).toContainText('이동');
    await expect(row(page, 1)).toContainText('낙양');

    await row(page, 1).click();
    await row(page, 2).click();
    await pick(page, '모병');
    await editor(page).getByRole('spinbutton', { name: '수량' }).fill('0');
    await editor(page).getByRole('button', { name: '2번 칸에 넣기 (사용 불가)' }).click();
    await expect(editor(page).getByRole('note')).toHaveText('수량 칸을 채우세요.');
    await editor(page).getByRole('spinbutton', { name: '수량' }).fill('100');
    await editor(page).getByRole('button', { name: '2번 칸에 넣기', exact: true }).click();
    await expect(row(page, 2)).toContainText('모병');
    await expect(row(page, 2)).toContainText('수량 100');

    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    const saved = await turns(page, world);
    expect(saved.slots[0]).toMatchObject({ commandKey: 'move', args: { cityKey: expect.any(Number) } });
    expect(saved.slots[1]).toMatchObject({ commandKey: 'recruit', args: { amount: 100 } });
  });

  test('두 탭에서 저장하면 늦은 탭에 충돌 안내와 최신 목록을 보이고, 내 편집을 다시 적용해 저장한다', async ({
    page,
  }) => {
    const { world } = await openEditor(page);
    const other = await page.context().newPage();
    await other.goto(`/w/${world}/turns`);
    await expect(row(other, 30)).toBeVisible();

    // 늦은 탭이 먼저 편집을 시작한다. 이 편집은 지금 revision을 기준으로 한다.
    await row(other, 2).click();
    await pick(other, '상업 투자');
    await editor(other).getByRole('button', { name: '2번 칸에 넣기' }).click();

    await row(page, 1).click();
    await pick(page, '농지 개간');
    await editor(page).getByRole('button', { name: '1번 칸에 넣기' }).click();
    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();

    await saveButton(other).click();
    const alert = editor(other).getByTestId('stale-alert');
    await expect(alert).toContainText('다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.');
    await expect(alert).toContainText('내 편집 1건');
    await expect(row(other, 1)).toContainText('농지 개간');
    await expect(row(other, 2)).toContainText('휴식');
    await other.screenshot({ path: 'test-results/t1-15-turns-stale.png', fullPage: true });

    await alert.getByRole('button', { name: '내 편집 다시 적용' }).click();
    await expect(row(other, 1)).toContainText('농지 개간');
    await expect(row(other, 2)).toContainText('상업 투자');
    await saveButton(other).click();
    await expect(editor(other).getByText('저장했습니다.')).toBeVisible();
    const saved = await turns(page, world);
    expect(saved.slots.slice(0, 3).map((s) => s.commandKey)).toEqual(['farm', 'commerce', 'rest']);
    await other.close();
  });

  test('세션이 끊기면 다시 로그인한 뒤 저장하지 않은 편집을 이어서 저장한다', async ({ page }) => {
    const { email, world } = await openEditor(page);
    await row(page, 1).click();
    await pick(page, '치안 강화');
    await editor(page).getByRole('button', { name: '1번 칸에 넣기' }).click();

    await page.context().clearCookies();
    await saveButton(page).click();
    await expect(editor(page).getByRole('alert')).toContainText('로그인이 풀렸습니다.');
    await editor(page).getByRole('link', { name: '다시 로그인' }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await login(page, email);

    await expect(page).toHaveURL(`/w/${world}/turns`);
    await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(row(page, 1)).toContainText('치안 강화');
    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    expect((await turns(page, world)).slots[0]!.commandKey).toBe('security');
  });

  test('턴이 실행되면 실패 이유가 최근 실행 결과에 남고 예턴이 한 칸 당겨진다', async ({ page }) => {
    test.setTimeout(240_000);
    const { world } = await openEditor(page);
    await row(page, 1).click();
    await row(page, 2).click();
    await pick(page, '농지 개간');
    await editor(page).getByRole('button', { name: '1~2번 칸에 넣기' }).click();
    await saveButton(page).click();
    await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
    const before = await turns(page, world);
    expect(before.slots.slice(0, 2).map((s) => s.commandKey)).toEqual(['farm', 'farm']);

    await waitNextTurn(page, world);
    // 실행 때 다시 검사해 실패한 이유가 장수 로그로 남는다 (AC-M1-09). 화면은 15초마다 다시 묻는다.
    const results = page.getByTestId('recent-results');
    await expect(results).toContainText('국가에 소속되어야 합니다.', { timeout: 150_000 });
    await expect(results).toContainText('실패');
    const after = await turns(page, world);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.slots[0]!.commandKey).toBe('farm');
    expect(after.slots[1]!.commandKey).toBe('rest');
    await expect(row(page, 2)).toContainText('휴식', { timeout: 15_000 });
    await page.screenshot({ path: 'test-results/t1-15-turns-executed.png', fullPage: true });
  });
});

test('장수가 없으면 예턴 대신 장수 생성으로 안내한다', async ({ page }) => {
  await signUpByApi(page, newEmail());
  const world = await e2eWorld(page);
  await page.goto(`/w/${world}/turns`);
  await expect(page.getByText('이 월드에 내 장수가 없습니다')).toBeVisible();
  await page.getByRole('link', { name: '장수 만들기' }).click();
  await expect(page).toHaveURL(`/w/${world}/create`);
});
