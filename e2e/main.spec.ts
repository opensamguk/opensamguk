import { expect, test, type Page } from '@playwright/test';
import { signUpByApi } from './account';
import { e2eWorld, setTurns, turns, waitNextTurn, waitTurnWindow } from './game';
import { bindGeneral, query } from './world';

// T1-16 · AC-M1-19: 실제 PostgreSQL·서버·엔진·Chromium으로 메인 작업 화면을 검증한다.
// 소유자 UI 정정(2026-10-21)에 따라 지도·명령 목록·도시·국가·장수·기록이 한 메인 화면에 함께 있고,
// 지도에서 도시를 골라도 메인을 떠나지 않는다. 명령 목록 칸은 T1-15의 30칸 편집기이며 같은 메인에서 입력·저장·충돌 안내를 본다.
// 월드는 pnpm dev 엔진이 돌리는 첫 RUNNING 월드(e2eWorld, 턴 1분)라 실제 엔진이 시험 중에 턴과 월간 정산을 처리한다.

interface MapData {
  cities: Array<{ key: number; name: string; nationId: number | null; supplied: boolean; links: number[] }>;
  nations: Array<{ id: number; name: string; color: string }>;
}
interface HomeData {
  general: { id: number; name: string; cityKey: number; nationId: number | null };
  nation: { id: number; name: string } | null;
  nextTurnAt: string | null;
  turnsPreview: unknown[];
  recentLogs: unknown[];
}

const BASE = 'http://127.0.0.1:5173';
// beforeAll에서 만든 로그인 상태. 각 시험의 브라우저 문맥은 beforeAll 뒤에 만들어지므로 이 파일을 읽는다.
const STORAGE = 'test-results/t1-16-main-storage.json';
const ctx: { worldId: string; home: HomeData; map: MapData } = {
  worldId: '',
  home: undefined as unknown as HomeData,
  map: undefined as unknown as MapData,
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  // 이 파일의 test.use(storageState)가 아직 없는 파일을 읽지 않도록 빈 상태로 시작한다.
  const context = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signUpByApi(page);
  ctx.worldId = await e2eWorld(page);
  const { user } = await query<{ user: { id: string } }>(context.request, 'auth.me');
  await bindGeneral(ctx.worldId, user.id);
  ctx.home = await query<HomeData>(context.request, 'home.get', { worldId: ctx.worldId });
  ctx.map = await query<MapData>(context.request, 'world.map', { worldId: ctx.worldId });
  await context.storageState({ path: STORAGE });
  await context.close();
  expect(ctx.home.general.nationId).not.toBeNull();
  expect(ctx.map.cities).toHaveLength(94);
});

async function openMain(page: Page, search = '') {
  await page.goto(`/w/${ctx.worldId}${search}`);
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await expect(page.getByTestId('world-map').locator('[data-city-key]')).toHaveCount(94);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
}

// 적 도시: 소유국이 있고 내 국가가 아니며 내 장수가 없는 도시
function enemyCity() {
  const mine = ctx.home.general;
  const city = ctx.map.cities.find(
    (c) => c.nationId !== null && c.nationId !== mine.nationId && c.key !== mine.cityKey,
  );
  if (!city) throw new Error('적 도시가 없습니다');
  return city;
}

// 메인 명령 목록 칸 안의 30칸 편집기
const editor = (page: Page) => page.getByRole('region', { name: '명령 목록', exact: true }).getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);
const draftState = (page: Page) => editor(page).getByTestId('draft-state');

async function pick(page: Page, command: string) {
  await editor(page).getByLabel('명령 찾기').fill(command);
  await editor(page).getByRole('radio', { name: command }).check();
}

async function save(page: Page) {
  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
  await expect(draftState(page)).toHaveText('저장된 목록');
}

test.describe('장수가 있는 계정', () => {
  test.use({ storageState: STORAGE });

  test('첫 주소는 첫 RUNNING 월드로 보낸다', async ({ page }) => {
    const { worlds } = await query<{ worlds: Array<{ id: string }> }>(page.request, 'world.list');
    expect(worlds.length).toBeGreaterThan(0);
    await page.goto('/');
    await expect(page).toHaveURL(`/w/${worlds[0]!.id}`);
  });

  test('메인 한 화면에 지도·명령 목록·도시·국가·장수·기록이 함께 있다', async ({ page }) => {
    await openMain(page);
    for (const name of [
      '지도',
      '명령 목록',
      '도시 정보',
      '국가 정보',
      '장수 정보',
      '개인 기록',
      '국가 기록',
      '중원 정세',
    ])
      await expect(page.getByRole('region', { name, exact: true })).toBeVisible();

    // 원작 R1 배치: 지도 오른쪽에 명령 목록, 지도 아래 도시 정보
    const mapBox = (await page.getByRole('region', { name: '지도', exact: true }).boundingBox())!;
    const cmdBox = (await page.getByRole('region', { name: '명령 목록', exact: true }).boundingBox())!;
    const cityBox = (await page.getByRole('region', { name: '도시 정보', exact: true }).boundingBox())!;
    expect(cmdBox.x).toBeGreaterThan(mapBox.x + mapBox.width - 1);
    expect(Math.abs(cmdBox.y - mapBox.y)).toBeLessThan(2);
    expect(cityBox.y).toBeGreaterThan(mapBox.y + mapBox.height - 1);

    // 지도: 94도시, 소유국 색, 연결선, 보급, 내 위치
    const map = page.getByTestId('world-map');
    const owned = new Map<number, number>();
    for (const c of ctx.map.cities) if (c.nationId !== null) owned.set(c.nationId, (owned.get(c.nationId) ?? 0) + 1);
    for (const [nationId, count] of owned)
      await expect(map.locator(`[data-nation-id="${nationId}"]`)).toHaveCount(count);
    const firstOwned = ctx.map.cities.find((c) => c.nationId !== null)!;
    const color = ctx.map.nations.find((n) => n.id === firstOwned.nationId)!.color;
    const fill = await map
      .locator(`[data-city-key="${firstOwned.key}"] circle`)
      .last()
      .evaluate((el) => getComputedStyle(el).fill);
    const hex = color.replace('#', '');
    const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
    expect(fill).toBe(rgb);
    expect(await map.locator('line').count()).toBeGreaterThan(90);
    // 보급 끊김은 국가 도시만 표시한다. 공백지는 늘 보급이 없다.
    const cut = ctx.map.cities.filter((c) => !c.supplied && c.nationId !== null).length;
    await expect(map.locator('[data-cut="true"]')).toHaveCount(cut);
    await expect(map.locator('[data-mine="true"]')).toHaveAttribute('data-city-key', String(ctx.home.general.cityKey));

    // 명령 목록은 30칸 편집기, 장수·국가·도시 정보
    await expect(editor(page).locator('tr[data-slot]')).toHaveCount(30);
    const general = page.getByRole('region', { name: '장수 정보', exact: true });
    await expect(general.getByText(ctx.home.general.name, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: '국가 정보', exact: true }).getByText(ctx.home.nation!.name).first(),
    ).toBeVisible();
    const city = page.getByRole('region', { name: '도시 정보', exact: true });
    await expect(city.locator('[data-visibility="detail"]')).toBeVisible();
    await expect(city.getByRole('meter', { name: /^주민 / })).toBeVisible();
    await expect(page.getByTestId('game-date')).toHaveText(/^\d+년 \d+월$/);
    await expect(page.getByTestId('next-turn')).toHaveText(/다음 턴까지 \d+:\d\d|턴 처리 중/);
    await shot(page, '01-main.png');
  });

  test('지도에서 적 도시를 고르면 메인을 떠나지 않고 도시 정보만 바뀌며 수치는 보이지 않는다', async ({ page }) => {
    await openMain(page);
    const city = page.getByRole('region', { name: '도시 정보', exact: true });
    await expect(city.locator(`[data-city-key="${ctx.home.general.cityKey}"]`)).toBeVisible();
    await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
    const enemy = enemyCity();
    const keyPattern = new RegExp(`%22cityKey%22%3A${enemy.key}(?!\\d)`);
    const response = page.waitForResponse((r) => r.url().includes('city.get') && keyPattern.test(r.url()));
    await page.getByTestId('world-map').locator(`[data-city-key="${enemy.key}"]`).click();
    // 서버 응답 자체에 적 도시 수치와 적 장수 상세가 없어야 한다 (화면에서 숨기기만 하는 것이 아님).
    const res = await response;
    const procedures = new URL(res.url()).pathname.replace('/trpc/', '').split(',');
    const payload = (await res.json()) as unknown[];
    const cityPayload = JSON.stringify(payload[procedures.indexOf('city.get')]);
    expect(cityPayload).toContain(`"key":${enemy.key}`);
    expect(cityPayload).not.toContain('population');
    expect(cityPayload).not.toContain('leadership');

    await expect(page).toHaveURL(new RegExp(`/w/${ctx.worldId}\\?city=${enemy.key}$`));
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    await expect(city.locator(`[data-city-key="${enemy.key}"][data-visibility="public"]`)).toBeVisible();
    await expect(city.getByText(enemy.name, { exact: true })).toBeVisible();
    await expect(city.getByRole('note')).toContainText('다른 국가의 도시입니다');
    await expect(city.getByRole('meter')).toHaveCount(0);
    await expect(city.locator('td[title="다른 국가의 도시입니다"]').first()).toHaveText('—');
    await expect(page.getByRole('region', { name: '명령 목록', exact: true })).toBeVisible();
    await shot(page, '02-main-enemy-city.png');

    await page.getByRole('button', { name: '내 도시로' }).click();
    await expect(city.locator(`[data-city-key="${ctx.home.general.cityKey}"][data-visibility="detail"]`)).toBeVisible();
  });

  test('메인 명령 칸에서 넣은 편집은 지도 도시 선택과 재조회 뒤에도 남고, 고른 도시가 대상 기본값이 되며 저장된다', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // 다음 턴이 시험 도중에 실행되면 서버 목록이 바뀌어 저장이 충돌 안내로 간다. 여유가 있을 때 시작한다.
    await waitTurnWindow(page, ctx.worldId, 45_000);
    await setTurns(page, ctx.worldId, []);
    await openMain(page);
    await expect(row(page, 30)).toBeVisible();
    await expect(row(page, 1)).toContainText('휴식');
    await page.evaluate(() => Object.assign(window, { __sameDocument: true }));

    await row(page, 1).click();
    await row(page, 3).click({ modifiers: ['Shift'] });
    await expect(editor(page).getByTestId('selection')).toHaveText('선택: 1~3번 칸');
    await pick(page, '농지 개간');
    await editor(page).getByRole('button', { name: '1~3번 칸에 넣기' }).click();
    await expect(draftState(page)).toHaveText('저장하지 않은 편집 1건');

    // 지도에서 다른 도시를 고르고 조회가 다시 돌아도 같은 편집기가 남는다. 초안·고른 칸이 그대로다.
    const enemy = enemyCity();
    const refetched = Promise.all([
      page.waitForResponse((r) => r.url().includes('home.get') && r.ok(), { timeout: 30_000 }),
      page.waitForResponse((r) => r.url().includes('turns.get') && r.ok(), { timeout: 30_000 }),
    ]);
    await page.getByTestId('world-map').locator(`[data-city-key="${enemy.key}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/w/${ctx.worldId}\\?city=${enemy.key}$`));
    await expect(
      page.getByRole('region', { name: '도시 정보', exact: true }).locator(`[data-city-key="${enemy.key}"]`),
    ).toBeVisible();
    await refetched;
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    await expect(draftState(page)).toHaveText('저장하지 않은 편집 1건');
    await expect(editor(page).getByTestId('selection')).toHaveText('선택: 1~3번 칸');
    for (const slot of [1, 2, 3]) await expect(row(page, slot)).toContainText('농지 개간');

    // 지도에서 고른 도시는 대상 도시의 기본값일 뿐이다. 넣기 전에는 칸이 바뀌지 않는다.
    await editor(page).getByRole('button', { name: '선택 해제' }).click();
    await row(page, 4).click();
    await pick(page, '이동');
    await expect(editor(page).getByRole('combobox', { name: '대상 도시' })).toHaveValue(String(enemy.key));
    await expect(row(page, 4)).toContainText('휴식');
    await editor(page).getByRole('button', { name: '4번 칸에 넣기', exact: true }).click();
    await expect(row(page, 4)).toContainText(enemy.name);
    await expect(draftState(page)).toHaveText('저장하지 않은 편집 2건');
    await shot(page, '10-main-turn-draft.png');

    await save(page);
    const saved = await turns(page, ctx.worldId);
    expect(saved.slots.slice(0, 5).map((slot) => slot.commandKey)).toEqual(['farm', 'farm', 'farm', 'move', 'rest']);
    expect(saved.slots[3]!.args).toMatchObject({ cityKey: enemy.key });
    await page.reload();
    await expect(row(page, 4)).toContainText(enemy.name);
    await expect(draftState(page)).toHaveText('저장된 목록');
  });

  test('같은 메인을 연 두 탭에서 저장하면 늦은 탭이 충돌 안내를 보고 내 편집을 다시 적용해 저장한다', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await waitTurnWindow(page, ctx.worldId, 45_000);
    await setTurns(page, ctx.worldId, []);
    await openMain(page);
    await expect(row(page, 1)).toContainText('휴식');
    const other = await page.context().newPage();
    await openMain(other);
    await expect(row(other, 1)).toContainText('휴식');

    // 늦은 탭이 먼저 편집을 시작한다. 이 편집은 지금 revision을 기준으로 한다.
    await row(other, 2).click();
    await pick(other, '상업 투자');
    await editor(other).getByRole('button', { name: '2번 칸에 넣기' }).click();

    await row(page, 1).click();
    await pick(page, '농지 개간');
    await editor(page).getByRole('button', { name: '1번 칸에 넣기' }).click();
    await save(page);

    await editor(other).getByRole('button', { name: '저장', exact: true }).click();
    const alert = editor(other).getByTestId('stale-alert');
    await expect(alert).toContainText('다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.');
    await expect(alert).toContainText('내 편집 1건');
    await expect(row(other, 1)).toContainText('농지 개간');
    await expect(row(other, 2)).toContainText('휴식');
    // 충돌 안내도 지도와 같은 메인 화면 안에 있다.
    await expect(other.getByTestId('world-map')).toBeVisible();
    await shot(other, '11-main-turn-stale.png');

    await alert.getByRole('button', { name: '내 편집 다시 적용' }).click();
    await expect(row(other, 1)).toContainText('농지 개간');
    await expect(row(other, 2)).toContainText('상업 투자');
    await save(other);
    const saved = await turns(page, ctx.worldId);
    expect(saved.slots.slice(0, 3).map((slot) => slot.commandKey)).toEqual(['farm', 'commerce', 'rest']);
    await other.close();
  });

  test('저장한 예턴을 엔진이 실행하면 같은 메인에서 개인 기록에 결과가 쌓이고 편집기 칸이 당겨진다', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await waitTurnWindow(page, ctx.worldId, 30_000);
    await setTurns(page, ctx.worldId, [{ commandKey: 'farm' }, { commandKey: 'commerce' }]);
    const before = await turns(page, ctx.worldId);
    const logsBefore = await query<{ items: Array<{ id: string }> }>(page.request, 'records.general', {
      worldId: ctx.worldId,
    });
    await openMain(page);
    await expect(row(page, 1)).toContainText('농지 개간');
    await expect(row(page, 2)).toContainText('상업 투자');

    await waitNextTurn(page, ctx.worldId);
    // 엔진이 첫 칸을 실행하면 편집기가 새 목록을 받아 한 칸 당긴다 (turns.get 10초 주기).
    await expect(row(page, 1)).toContainText('상업 투자', { timeout: 150_000 });
    await expect(row(page, 2)).toContainText('휴식');
    const after = await turns(page, ctx.worldId);
    expect(after.revision).toBeGreaterThan(before.revision);

    let latest: { id: string; text: string } | undefined;
    await expect
      .poll(
        async () => {
          const { items } = await query<{ items: Array<{ id: string; text: string }> }>(
            page.request,
            'records.general',
            { worldId: ctx.worldId },
          );
          latest = items[0];
          return latest?.id ?? null;
        },
        { timeout: 60_000 },
      )
      .not.toBe(logsBefore.items[0]?.id ?? null);
    const records = page.getByRole('region', { name: '개인 기록', exact: true });
    await expect(records).toContainText(latest!.text, { timeout: 60_000 });
    await shot(page, '12-main-turn-result.png');
  });

  test('국가 정보에서 소속 장수·소유 도시 표를 펼치고 정렬한다', async ({ page }) => {
    await openMain(page);
    const nation = page.getByRole('region', { name: '국가 정보', exact: true });
    await nation.getByRole('button', { name: '소속 장수·도시 펼치기' }).click();
    await expect(nation.getByRole('table').filter({ hasText: '소속 장수' })).toBeVisible();
    await expect(nation.getByRole('table').filter({ hasText: '소유 도시' })).toBeVisible();
    await nation.getByRole('button', { name: /^병력/ }).click();
    await expect(nation.getByRole('columnheader', { name: /^병력/ })).toHaveAttribute('aria-sort', 'descending');
    await shot(page, '03-main-nation-tables.png');
  });

  test('다음 턴 0초가 되면 다시 조회해 새 시각과 엔진이 쓴 내 기록을 보여 준다', async ({ page }) => {
    test.setTimeout(150_000);
    await openMain(page);
    const nextTurn = page.getByTestId('next-turn');
    // 이미 지난 시각을 받은 직후라면 첫 재조회를 놓칠 수 있다. 미래 시각이 보일 때부터 잰다.
    await expect
      .poll(async () => Date.parse((await nextTurn.getAttribute('data-next-turn-at')) ?? '') - Date.now(), {
        timeout: 90_000,
      })
      .toBeGreaterThan(3_000);
    const before = (await nextTurn.getAttribute('data-next-turn-at'))!;
    const dueIn = Date.parse(before) - Date.now();
    const refetch = page.waitForRequest(
      (r) => r.url().includes('home.get') && Date.now() >= Date.parse(before) - 1_000,
      {
        timeout: Math.max(dueIn, 0) + 20_000,
      },
    );
    await refetch;
    await expect
      .poll(async () => Date.parse((await nextTurn.getAttribute('data-next-turn-at')) ?? before), { timeout: 60_000 })
      .toBeGreaterThan(Date.parse(before));
    const logs = page.getByRole('region', { name: '개인 기록', exact: true }).locator('li');
    await expect(logs.first()).toBeVisible({ timeout: 30_000 });
  });

  test('월간 정산 뒤 국가 기록과 중원 정세가 메인에 쌓인다', async ({ page }) => {
    test.setTimeout(180_000);
    await expect
      .poll(
        async () =>
          (await query<{ items: unknown[] }>(page.request, 'records.world', { worldId: ctx.worldId })).items.length,
        {
          timeout: 150_000,
          intervals: [2_000],
        },
      )
      .toBeGreaterThan(0);
    await openMain(page);
    const world = page.getByRole('region', { name: '중원 정세', exact: true });
    await expect(world.locator('li').first()).toContainText(/\d+년 \d+월/);
    const nationRecords = page.getByRole('region', { name: '국가 기록', exact: true });
    await expect(nationRecords.locator('tbody tr').first()).toBeVisible();
    await world.scrollIntoViewIfNeeded();
    await shot(page, '04-main-records.png');
  });

  test('보조 주소도 같은 실제 데이터로 열린다', async ({ page }) => {
    const enemy = enemyCity();
    await page.goto(`/w/${ctx.worldId}/map`);
    await expect(page.getByTestId('world-map').locator('[data-city-key]')).toHaveCount(94);
    await shot(page, '05-map.png');

    await page.goto(`/w/${ctx.worldId}/city/${enemy.key}`);
    await expect(page.getByRole('heading', { level: 1, name: `도시 정보 · ${enemy.name}` })).toBeVisible();
    await expect(page.locator('[data-visibility="public"]')).toBeVisible();
    await shot(page, '06-city.png');

    await page.goto(`/w/${ctx.worldId}/nation/${enemy.nationId}`);
    await expect(page.getByRole('heading', { level: 1, name: /^국가 정보 · / })).toBeVisible();
    await expect(page.getByRole('note').first()).toContainText('다른 국가 정보');
    await expect(page.locator('[title="다른 국가 정보"] dd').first()).toHaveText('—');
    await shot(page, '07-nation-other.png');

    await page.goto(`/w/${ctx.worldId}/records?tab=world`);
    await expect(page.getByRole('heading', { level: 1, name: '기록 · 월드 정세' })).toBeVisible();
    await shot(page, '08-records.png');

    await page.goto(`/w/${ctx.worldId}/turns`);
    await expect(page.getByRole('heading', { level: 1, name: '예턴 편집' })).toBeVisible();
    await expect(page.getByTestId('turn-editor').locator('tr[data-slot]')).toHaveCount(30);
    await shot(page, '09-turns.png');
  });
});

test('장수 생성 API로 만든 재야 장수는 메인에서 바로 재야 상태로 보인다', async ({ page }) => {
  test.setTimeout(60_000);
  await signUpByApi(page);
  const name = `E${String(Date.now() % 100_000).padStart(5, '0')}`;
  const created = await page.request.post('/trpc/general.create', {
    data: { worldId: ctx.worldId, name, leadership: 55, strength: 55, intel: 55, portraitId: null },
  });
  expect(created.ok()).toBe(true);
  await expect
    .poll(
      async () => (await query<{ general: unknown }>(page.request, 'general.mine', { worldId: ctx.worldId })).general,
      {
        timeout: 30_000,
      },
    )
    .not.toBeNull();
  await openMain(page);
  const general = page.getByRole('region', { name: '장수 정보', exact: true });
  await expect(general.getByText(name, { exact: true })).toBeVisible();
  await expect(general.getByText('재야').first()).toBeVisible();
  await expect(page.getByRole('region', { name: '국가 정보', exact: true }).getByText('재야입니다')).toBeVisible();
  await expect(
    page.getByRole('region', { name: '국가 기록', exact: true }).getByText('소속 국가가 없습니다'),
  ).toBeVisible();
  await expect(editor(page).locator('tr[data-slot]')).toHaveCount(30);
  await expect(page.getByTestId('world-map').locator('[data-mine="true"]')).toHaveCount(1);
});

test('장수가 없는 계정은 장수 만들기 안내와 공개 지도를 본다', async ({ page }) => {
  await signUpByApi(page);
  await openMain(page);
  await expect(
    page.getByRole('region', { name: '명령 목록', exact: true }).getByText('이 월드에 내 장수가 없습니다'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '장수 만들기' }).first()).toHaveAttribute(
    'href',
    `/w/${ctx.worldId}/create`,
  );
  await expect(page.getByTestId('next-turn')).toHaveText('내 장수 없음');
  await expect(page.getByRole('region', { name: '중원 정세', exact: true })).toBeVisible();
});

test('없는 월드는 안내를 보여 준다', async ({ page }) => {
  await signUpByApi(page);
  await page.goto(`/w/${crypto.randomUUID()}`);
  await expect(
    page.getByRole('region', { name: '지도', exact: true }).getByText('월드를 찾을 수 없습니다'),
  ).toBeVisible();
});
