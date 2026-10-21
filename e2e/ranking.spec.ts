import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { newEmail, signUpByApi } from './account';

// T2-23 · AC-M2-19 (화면). 실제 DB에 월드를 만들고 엔진으로 첫 월간 정산을 돌린 뒤 순위 화면과 API를 함께 본다.
// 준비는 e2e/rankingSeed.ts가 한다. dev 서버와 같은 DATABASE_URL(.env)을 쓴다.
test.describe.configure({ mode: 'serial' });

function seed(...args: string[]): Record<string, unknown> {
  const out = execFileSync('pnpm', ['exec', 'tsx', '--env-file-if-exists=.env', 'e2e/rankingSeed.ts', ...args], {
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

interface GeneralRow {
  rank: number;
  generalId: number;
  name: string;
}
interface GeneralsResponse {
  top: GeneralRow[];
  me: GeneralRow | null;
  at: { tick: number; year: number; month: number } | null;
}
interface NationsResponse {
  items: Array<Record<string, unknown>>;
  at: GeneralsResponse['at'];
}

async function query<T>(page: Page, path: string, input: object): Promise<T> {
  const response = await page.request.get(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

const generalsTable = (page: Page) => page.getByRole('table', { name: '장수 순위' });
// 상위 목록(첫 tbody)의 장수 이름. 「나」 칩은 이름 옆 다른 span이라 빠진다.
const topNames = (page: Page, count: number) =>
  generalsTable(page)
    .locator('tbody')
    .first()
    .locator('tr td:nth-child(2) > span:first-child')
    .allInnerTexts()
    .then((names) => names.slice(0, count));

// 숫자 머리글은 값과 같이 오른쪽에 붙고 정렬 단추도 오른쪽 끝에 있다 (GitHub #56).
async function expectNumericHeadersRight(table: Locator, labels: string[]) {
  for (const label of labels) {
    const header = table.getByRole('columnheader', { name: new RegExp(`^${label}`) });
    await expect(header).toHaveCSS('text-align', 'right');
    const button = header.getByRole('button');
    if ((await button.count()) === 0) continue;
    const [cell, inner] = await Promise.all([header.boundingBox(), button.boundingBox()]);
    expect(cell!.x + cell!.width - (inner!.x + inner!.width)).toBeLessThan(12);
  }
}

const contexts: BrowserContext[] = [];
const pages: Record<'top' | 'outside' | 'newcomer', Page> = {} as never;
const worlds = { fresh: '', settled: '' };

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const emails: string[] = [];
  for (const who of ['top', 'outside', 'newcomer'] as const) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    contexts.push(context);
    pages[who] = await context.newPage();
    emails.push(await signUpByApi(pages[who], newEmail()));
  }
  worlds.fresh = String(seed('fresh').worldId);
  worlds.settled = String(seed('settled', ...emails).worldId);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  const ids = Object.values(worlds).filter(Boolean);
  if (ids.length > 0) seed('remove', ...ids);
});

test('첫 정산 전에는 at이 null이고 아직 월간 정산 전이라고 알린다', async () => {
  const page = pages.top;
  const worldId = worlds.fresh;
  expect(await query(page, 'ranking.generals', { worldId, by: 'dedication' })).toEqual({
    top: [],
    me: null,
    at: null,
  });
  expect(await query(page, 'ranking.nations', { worldId, by: 'cities' })).toEqual({ items: [], at: null });

  await page.goto(`/w/${worldId}/ranking`);
  await expect(page.getByText('아직 월간 정산 전이라 순위가 없습니다')).toBeVisible();
  await page.getByRole('navigation', { name: '순위 종류' }).getByRole('link', { name: '국가' }).click();
  await expect(page).toHaveURL(`/w/${worldId}/ranking?tab=nations&by=cities`);
  await expect(page.getByText('아직 월간 정산 전이라 순위가 없습니다')).toBeVisible();
});

test('머리글을 누르면 주소의 by와 순서가 바뀌고 새로고침해도 남는다', async () => {
  const page = pages.top;
  const worldId = worlds.settled;
  const byDedication = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'dedication' });
  const byExperience = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'experience' });
  const first = (r: GeneralsResponse) => r.top.slice(0, 5).map((g) => g.name);
  expect(first(byDedication)).not.toEqual(first(byExperience));

  await page.goto(`/w/${worldId}/ranking?tab=generals&by=dedication`);
  await expect(page.getByText('191년 1월 정산 기준')).toBeVisible();
  await expect.poll(() => topNames(page, 5)).toEqual(first(byDedication));

  await page.getByRole('button', { name: /경험/ }).click();
  await expect(page).toHaveURL(`/w/${worldId}/ranking?tab=generals&by=experience`);
  await expect.poll(() => topNames(page, 5)).toEqual(first(byExperience));
  await expect(page.getByRole('columnheader', { name: /경험/ })).toHaveAttribute('aria-sort', 'descending');

  await page.reload();
  await expect(page).toHaveURL(`/w/${worldId}/ranking?tab=generals&by=experience`);
  await expect.poll(() => topNames(page, 5)).toEqual(first(byExperience));
  await expect(page.getByRole('columnheader', { name: /경험/ })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('columnheader', { name: /공헌/ })).toHaveAttribute('aria-sort', 'none');
  await expectNumericHeadersRight(generalsTable(page), ['순위', '공헌', '경험', '전공']);
});

test('내 장수 행은 강조하고 「나」를 붙이며 내 순위로 이동한다', async () => {
  const page = pages.top;
  const worldId = worlds.settled;
  const data = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'dedication' });
  expect(data.me?.rank).toBe(1);

  await page.goto(`/w/${worldId}/ranking?tab=generals&by=dedication`);
  const mine = generalsTable(page).locator('tr[data-me]');
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(data.me!.name);
  await expect(mine.getByText('나', { exact: true })).toBeVisible();
  await expect(generalsTable(page).locator('tbody').first().locator('tr').first()).toHaveAttribute('data-me', 'true');
  await page.getByRole('button', { name: '내 순위로' }).click();
  await expect(mine).toBeFocused();
});

test('상위 100위 밖이면 표 끝에 따로 한 줄 두고 내 순위로 이동한다', async () => {
  const page = pages.outside;
  const worldId = worlds.settled;
  const data = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'dedication' });
  expect(data.top).toHaveLength(100);
  expect(data.me!.rank).toBeGreaterThan(100);
  expect(data.top.some((g) => g.generalId === data.me!.generalId)).toBe(false);

  await page.goto(`/w/${worldId}/ranking?tab=generals&by=dedication`);
  await expect(generalsTable(page).locator('tbody').first().locator('tr')).toHaveCount(100);
  const last = generalsTable(page).locator('tr').last();
  await expect(last).toHaveAttribute('data-me', 'true');
  await expect(last).toContainText(data.me!.name);
  await expect(last.locator('td').first()).toHaveText(String(data.me!.rank));
  await expect(last.getByText('나', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '내 순위로' }).click();
  await expect(last).toBeFocused();
});

test('국가 표와 응답에 국고·군량이 없다', async () => {
  const page = pages.top;
  const worldId = worlds.settled;
  const data = await query<NationsResponse>(page, 'ranking.nations', { worldId, by: 'cities' });
  expect(data.items.length).toBeGreaterThan(0);
  for (const item of data.items) {
    expect(Object.keys(item).sort()).toEqual(
      ['cities', 'color', 'generals', 'name', 'nationId', 'power', 'rank', 'value'].sort(),
    );
  }
  expect(JSON.stringify(data)).not.toMatch(/gold|rice|국고|군량/);
  const generals = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'merit' });
  expect(JSON.stringify(generals)).not.toMatch(/gold|rice|국고|군량/);

  await page.goto(`/w/${worldId}/ranking`);
  await page.getByRole('navigation', { name: '순위 종류' }).getByRole('link', { name: '국가' }).click();
  await expect(page).toHaveURL(`/w/${worldId}/ranking?tab=nations&by=cities`);
  const table = page.getByRole('table', { name: '국가 순위' });
  await expect(table.getByRole('columnheader')).toHaveText(['순위', '국가', '도시▼', '장수', '국력']);
  await expect(table.locator('tbody tr')).toHaveCount(data.items.length);
  await expectNumericHeadersRight(table, ['순위', '도시', '장수', '국력']);
  await expect(page.getByText(/국고|군량/)).toHaveCount(0);
});

test('정산 뒤에 만든 새 장수는 me가 null이고 내 행이 없다', async () => {
  const page = pages.newcomer;
  const worldId = worlds.settled;
  const mine = await query<{ general: { name: string } | null }>(page, 'general.mine', { worldId });
  expect(mine.general?.name).toBe('새장수');
  const data = await query<GeneralsResponse>(page, 'ranking.generals', { worldId, by: 'dedication' });
  expect(data.at).not.toBeNull();
  expect(data.me).toBeNull();

  await page.goto(`/w/${worldId}/ranking?tab=generals&by=dedication`);
  await expect(generalsTable(page).locator('tbody').first().locator('tr')).toHaveCount(100);
  await expect(generalsTable(page).locator('tr[data-me]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '내 순위로' })).toHaveCount(0);
});
