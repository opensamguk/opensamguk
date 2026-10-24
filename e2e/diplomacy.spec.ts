import { expect, test, type Browser, type Page } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import { createGeneralByApi, e2eWorld, mutate, query, stubPortraits } from './game';

// T2-08 · AC-M2-06, AC-M2-14 화면: 외교실 조약서와 예턴 편집의 교역 대상.
// treaty 라우터(T2-07, Codex)가 main에 들어오기 전에는 이 시험이 돌지 않는다. 그 전의 결과는 증거로 세지 않는다.
// 계약: docs/plans/T2-07.md API 계약, 화면: docs/plans/T2-08.md.

test.describe.configure({ timeout: 180_000 });

interface Ruler {
  page: Page;
  generalId: number;
  nationId: number;
}

interface MapData {
  cities: Array<{ key: number; name: string; nationId: number | null; links: number[] }>;
  nations: Array<{ id: number; name: string }>;
}

// 새 계정·장수를 만들고 DB에서 그 장수를 nationId 국가의 직책자로 둔다. 군주 12, 참모 11, 수뇌 5~10 (T2-05 표).
async function officer(browser: Browser, world: string, nationId: number, officerLevel: number): Promise<Ruler> {
  const page = await (await browser.newContext()).newPage();
  await stubPortraits(page);
  await createAccount(page);
  const general = await createGeneralByApi(page, world);
  await withE2eDb(async (db) => {
    const city = await db.city.findFirstOrThrow({ where: { worldId: world, nationId }, select: { cityKey: true } });
    await db.general.update({
      where: { worldId_id: { worldId: world, id: general.id } },
      data: { nationId, officerLevel, cityKey: city.cityKey },
    });
  });
  return { page, generalId: general.id, nationId };
}

async function nations(page: Page, world: string): Promise<MapData> {
  return query<MapData>(page, 'world.map', { worldId: world });
}

const setGold = (world: string, nationId: number, gold: number) =>
  withE2eDb((db) => db.nation.update({ where: { worldId_id: { worldId: world, id: nationId } }, data: { gold } }));

const card = (page: Page) => page.getByTestId('treaty-card').first();

// API로 제안하고 엔진 처리 결과까지 기다린다. 화면 시험의 준비 단계다.
// treaty.propose 입력은 worldId·requestId·toNationId·clauses뿐이다. 제안 기한은 엔진이 정하고 다른 키는 서버가 거부한다.
async function proposeByApi(page: Page, world: string, toNationId: number, clauses: unknown[]) {
  const requestId = crypto.randomUUID();
  const outcome = await mutate<{ status: string }>(page, 'treaty.propose', {
    worldId: world,
    requestId,
    toNationId,
    clauses,
  });
  if (outcome.status === 'pending')
    await expect
      .poll(async () => (await query<{ status: string }>(page, 'treaty.request', { worldId: world, requestId })).status)
      .toBe('applied');
}

async function acceptByApi(page: Page, world: string) {
  const list = await query<{ items: Array<{ id: string; status: string; incoming: boolean }> }>(page, 'treaty.list', {
    worldId: world,
  });
  const treatyId = list.items.find((t) => t.status === 'PROPOSED' && t.incoming)!.id;
  const requestId = crypto.randomUUID();
  await mutate(page, 'treaty.respond', { worldId: world, requestId, treatyId, accept: true });
  await expect
    .poll(async () => (await query<{ status: string }>(page, 'treaty.request', { worldId: world, requestId })).status)
    .toBe('applied');
  return treatyId;
}

test.describe('외교실', () => {
  let world: string;
  let map: MapData;

  test.beforeEach(async ({ page }) => {
    await createAccount(page);
    world = await e2eWorld(page);
    map = await nations(page, world);
  });

  test('군주 A가 불가침을 제안하고 군주 B가 수락하면 결과가 정해진 뒤에만 양쪽에 진행 중으로 보인다', async ({
    browser,
  }) => {
    const [x, y] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    const b = await officer(browser, world, y!.id, 12);
    await setGold(world, x!.id, 100_000);
    await setGold(world, y!.id, 100_000);

    await a.page.goto(`/w/${world}/diplomacy?tab=write`);
    await a.page.getByLabel('상대').selectOption(String(y!.id));
    await a.page.getByLabel('불가침').check();
    await a.page.getByLabel('기간(개월)').fill('24');
    await expect(a.page.getByTestId('treaty-cost')).toContainText('비용 우리 금');
    await a.page.getByRole('button', { name: '제안 보내기' }).click();
    // 엔진이 처리하기 전에는 성공 문구가 없다.
    const requests = a.page.getByTestId('treaty-requests');
    await expect(requests.locator('[data-result="applied"]')).toContainText('제안을 보냈습니다');

    await b.page.goto(`/w/${world}/diplomacy?tab=incoming`);
    await expect(card(b.page)).toContainText('불가침 24개월');
    await card(b.page).getByRole('button', { name: '수락' }).click();
    await expect(b.page.getByTestId('treaty-requests').locator('[data-result="applied"]')).toContainText(
      '조약을 맺었습니다',
    );

    for (const page of [a.page, b.page]) {
      await page.goto(`/w/${world}/diplomacy?tab=active`);
      await expect(card(page)).toContainText('진행 중');
    }
  });

  test('국고가 모자라면 수락만 잠기고 이유를 보이며 거절은 누를 수 있다', async ({ browser }) => {
    const [x, y] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    const b = await officer(browser, world, y!.id, 12);
    await setGold(world, x!.id, 100_000);
    await proposeByApi(a.page, world, y!.id, [{ kind: 'nonAggression', months: 12 }]);
    await setGold(world, y!.id, 0);

    await b.page.goto(`/w/${world}/diplomacy?tab=incoming`);
    const accept = card(b.page).getByRole('button', { name: /^수락\s*\(사용 불가\)$/ });
    await accept.click();
    await expect(card(b.page).getByRole('note')).toBeVisible();
    await card(b.page).getByRole('button', { name: '거절', exact: true }).click();
    await expect(b.page.getByTestId('treaty-requests').locator('[data-result="applied"]')).toContainText(
      '제안을 거절했습니다',
    );
  });

  test('수락을 보낸 뒤 국고가 줄어 엔진이 거절하면 성공 문구 없이 이유만 보인다', async ({ browser }) => {
    const [x, y] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    const b = await officer(browser, world, y!.id, 12);
    await setGold(world, x!.id, 100_000);
    await setGold(world, y!.id, 100_000);
    await proposeByApi(a.page, world, y!.id, [{ kind: 'nonAggression', months: 12 }]);

    await b.page.goto(`/w/${world}/diplomacy?tab=incoming`);
    await expect(card(b.page).getByRole('button', { name: '수락' })).toBeVisible();
    // 화면이 받은 canAccept는 아직 ok다. 그 뒤 국고를 비워 엔진의 최종 판정에서 거절되게 한다.
    await setGold(world, y!.id, 0);
    await card(b.page).getByRole('button', { name: '수락' }).click();
    const requests = b.page.getByTestId('treaty-requests');
    await expect(requests.locator('[data-result="rejected"]')).toContainText('수락 요청이 거절되었습니다');
    await expect(requests).not.toContainText('조약을 맺었습니다');
  });

  test('응답을 잃으면 같은 requestId로 다시 보내고 입력은 하나만 생긴다', async ({ browser }) => {
    const [x, y] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    const b = await officer(browser, world, y!.id, 12);
    await setGold(world, x!.id, 100_000);
    await setGold(world, y!.id, 100_000);
    // 엔진은 첫 세 조항(종전·불가침·기록)만 잇는다. 교역 조항은 CLAUSE_NOT_CONNECTED로 거절되어 받은 제안이 생기지 않는다.
    await proposeByApi(a.page, world, y!.id, [{ kind: 'nonAggression', months: 12 }]);

    // 첫 응답만 서버에 닿게 한 뒤 브라우저에는 끊긴 것으로 보인다.
    const sent: string[] = [];
    let dropped = false;
    await b.page.route('**/trpc/treaty.respond**', async (route) => {
      sent.push((route.request().postDataJSON() as { requestId: string }).requestId);
      if (dropped) return route.continue();
      dropped = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await b.page.goto(`/w/${world}/diplomacy?tab=incoming`);
    await card(b.page).getByRole('button', { name: '수락' }).click();
    await b.page.getByRole('button', { name: '같은 요청 다시 보내기' }).click();
    await expect(b.page.getByTestId('treaty-requests').locator('[data-result="applied"]')).toBeVisible();
    expect(new Set(sent).size).toBe(1);
    const count = await withE2eDb((db) =>
      db.inputEvent.count({ where: { worldId: world, idempotencyKey: `treaty.respond:${sent[0]}` } }),
    );
    expect(count).toBe(1);
  });

  test('처리 중에 새로 고치거나 다시 로그인해도 같은 요청의 결과를 되찾는다', async ({ browser }) => {
    const [x, y] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    await setGold(world, x!.id, 100_000);
    await a.page.goto(`/w/${world}/diplomacy?tab=write`);
    await a.page.getByLabel('상대').selectOption(String(y!.id));
    // 교역 허용은 서버가 아직 잇지 않은 조항이라 화면에서 고를 수 없다. 화면이 보낼 수 있는 불가침으로 제안한다.
    await a.page.getByLabel('불가침').check();
    await a.page.getByLabel('기간(개월)').fill('12');
    // 보내기 요청을 붙잡아 둔 채 새로 고친다. 저장된 requestId로 결과를 묻는다.
    await a.page.route('**/trpc/treaty.propose**', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    });
    await a.page.getByRole('button', { name: '제안 보내기' }).click();
    await a.page.reload();
    await expect(a.page.getByTestId('treaty-requests').locator('[data-result="applied"]')).toContainText(
      '제안을 보냈습니다',
    );
  });

  test('수뇌는 조약서와 수락 단추 없이 읽기만 한다', async ({ browser }) => {
    const [x] = map.nations;
    const chief = await officer(browser, world, x!.id, 5);
    await chief.page.goto(`/w/${world}/diplomacy?tab=write`);
    await expect(chief.page.getByText(/읽기만 합니다/)).toBeVisible();
    await expect(chief.page.getByRole('button', { name: '제안 보내기' })).toHaveCount(0);
    await chief.page.goto(`/w/${world}/diplomacy?tab=incoming`);
    await expect(chief.page.getByRole('button', { name: '수락' })).toHaveCount(0);
  });

  test('파기하면 신의 기록 +1이 제3국 화면에 보인다', async ({ browser }) => {
    const [x, y, z] = map.nations;
    const a = await officer(browser, world, x!.id, 12);
    const b = await officer(browser, world, y!.id, 12);
    const c = await officer(browser, world, z!.id, 12);
    await setGold(world, x!.id, 100_000);
    await setGold(world, y!.id, 100_000);
    await proposeByApi(a.page, world, y!.id, [{ kind: 'nonAggression', months: 12 }]);
    await acceptByApi(b.page, world);

    const before = await query<{ items: Array<{ nation: { id: number }; brokenTreaties: number }> }>(
      c.page,
      'treaty.trust',
      { worldId: world },
    );
    const was = before.items.find((r) => r.nation.id === x!.id)?.brokenTreaties ?? 0;

    await a.page.goto(`/w/${world}/diplomacy?tab=active`);
    await card(a.page).getByRole('button', { name: '파기' }).click();
    await a.page.getByRole('button', { name: '파기 확정' }).click();
    await expect(a.page.getByTestId('treaty-requests').locator('[data-result="applied"]')).toContainText(
      '신의 기록에 남았습니다',
    );

    await c.page.goto(`/w/${world}/diplomacy?tab=trust`);
    await expect(c.page.getByTestId('trust-table').getByRole('row', { name: new RegExp(x!.name) })).toContainText(
      `${was + 1}회`,
    );
  });
});

test.describe('예턴 편집의 교역 대상', () => {
  test('교역 조약 뒤 메인 편집기에서 교역 대상을 고르고, 외교실에 갔다 와도 초안과 선택이 남는다', async ({
    browser,
    page,
  }) => {
    await createAccount(page);
    const world = await e2eWorld(page);
    const map = await nations(page, world);
    // 서로 이웃한 두 국가 도시를 찾는다.
    const pair = map.cities
      .filter((c) => c.nationId !== null)
      .flatMap((c) => c.links.map((k) => [c, map.cities.find((d) => d.key === k)!] as const))
      .find(([c, d]) => d && d.nationId !== null && d.nationId !== c.nationId)!;
    const [home, away] = pair;
    const a = await officer(browser, world, home.nationId!, 12);
    const b = await officer(browser, world, away.nationId!, 12);
    await withE2eDb((db) =>
      db.general.update({ where: { worldId_id: { worldId: world, id: a.generalId } }, data: { cityKey: home.key } }),
    );
    await setGold(world, home.nationId!, 100_000);
    await setGold(world, away.nationId!, 100_000);
    await proposeByApi(a.page, world, away.nationId!, [{ kind: 'trade', months: 12 }]);
    await acceptByApi(b.page, world);

    const editor = a.page.getByTestId('turn-editor');
    await a.page.goto(`/w/${world}`);
    await editor.locator('tr[data-slot="3"]').click();
    await editor.getByLabel('명령 찾기').fill('훈련');
    await editor.getByRole('radio', { name: '훈련' }).check();
    await editor.getByRole('button', { name: /3번 칸에 넣기/ }).click();
    await editor.locator('tr[data-slot="5"]').click();
    await editor.getByLabel('명령 찾기').fill('교역');
    await editor.getByRole('radio', { name: '교역' }).check();
    await expect(editor.getByRole('combobox', { name: /대상 도시/ })).toContainText(away.name);

    // 외교실에 갔다 돌아와도 저장하지 않은 편집과 고른 칸이 그대로다.
    await a.page.goto(`/w/${world}/diplomacy`);
    await a.page.goBack();
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.getByTestId('selection')).toContainText('3, 5번 칸');
  });

  test('교역 조약이 없으면 대상 도시 칸에 서버가 준 이유가 보인다', async ({ browser, page }) => {
    await createAccount(page);
    const world = await e2eWorld(page);
    const map = await nations(page, world);
    const a = await officer(browser, world, map.nations[0]!.id, 1);
    const editor = a.page.getByTestId('turn-editor');
    await a.page.goto(`/w/${world}`);
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByLabel('명령 찾기').fill('교역');
    await editor.getByRole('radio', { name: '교역' }).check();
    await expect(editor.getByRole('note')).toBeVisible();
  });
});
