import type { Browser, Download, Page, Response } from '@playwright/test';
import { createAccount, TEST_PASSWORD } from './account';
import {
  dateOf,
  dotCenter,
  expect,
  PNG_HEIGHT,
  PNG_SIGNATURE,
  PNG_WIDTH,
  pixelOf,
  readPng,
  rgbOf,
  SAVED,
  test,
  type PreparedWorld,
} from './timelapseSeed';

// T4-37 (나) · AC-P2-17 2차 공유 몫: 종료 월드 공유 화면 E4~E7 (docs/plans/T4-37.md 4.2).
// 공유 화면은 로그인 없는 새 브라우저 문맥에서 연다. 서버 공개 조회 timelapse.publicFrames(T4-91)의 실제 응답을 쓰고
// 응답을 지어내거나 바꾸지 않는다. 내려받기는 Chromium 실제 다운로드로 받고 PNG 바이트를 직접 읽는다.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const PUBLIC = 'timelapse.publicFrames';
interface PublicInput {
  worldId: string;
  cursor?: string;
}
interface BatchEntry {
  result?: { data: unknown };
  error?: { data?: { code?: string; httpStatus?: number } };
}

const pathsOf = (url: string) => new URL(url).pathname.split('/').pop()!.split(',');
function publicInput(url: string): PublicInput | undefined {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/trpc/')) return undefined;
  const index = pathsOf(url).indexOf(PUBLIC);
  if (index < 0) return undefined;
  const raw = parsed.searchParams.get('input');
  return ((raw ? JSON.parse(raw) : {}) as Record<string, PublicInput>)[String(index)];
}
async function publicEntry(response: Response): Promise<BatchEntry | undefined> {
  const body = (await response.json()) as BatchEntry[];
  return body[pathsOf(response.url()).indexOf(PUBLIC)];
}
const firstPublicPage = (page: Page, worldId: string) =>
  page.waitForResponse((response) => {
    const input = publicInput(response.url());
    return input?.worldId === worldId && input.cursor === undefined;
  });

const shareUrl = (world: PreparedWorld) => `/share/timelapse/${world.id}`;
const shared = (page: Page) => page.getByRole('region', { name: '공유 영토 재생', exact: true });
const dateLine = (page: Page) => page.getByTestId('timelapse-date');

// 쿠키 없는 새 문맥. 공유 화면은 로그인 가드 밖이라 로그인 화면으로 가지 않아야 한다.
async function anonymous(browser: Browser, webOrigin: string) {
  const context = await browser.newContext({ baseURL: webOrigin, acceptDownloads: true });
  return { context, page: await context.newPage() };
}

async function login(page: Page) {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
}

// 응답 전체를 훑어 키 이름을 모은다. 공개 범위 밖 키가 섞였는지 본다.
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysOf(item, into);
    }
  return into;
}

test('E4 로그인하지 않은 새 문맥에서 종료 월드 공유 주소를 열면 재생이 보이고 연월·국가 이름이 공개 응답과 같으며 비공개 키가 없다', async ({
  browser,
  timelapseStack,
}) => {
  const { e, eResult } = timelapseStack.worlds;
  const { context, page } = await anonymous(browser, timelapseStack.webOrigin);
  try {
    const response = firstPublicPage(page, e.id);
    await page.goto(shareUrl(e));
    const entry = await publicEntry(await response);
    const data = entry?.result?.data as {
      world: { name: string; endedYear: number; endedMonth: number };
      map: { cities: unknown[] } | null;
      items: Array<{ year: number; month: number; nations: Array<{ name: string }> }>;
      nextCursor: string | null;
    };
    expect(data.world).toEqual({ name: e.name, ...eResult });
    expect(data.map?.cities.length).toBeGreaterThan(0);
    expect(data.items).toHaveLength(3);
    expect(data.nextCursor).toBeNull();
    for (const banned of ['currentNations', 'gold', 'rice', 'power', 'generals', 'population', 'level', 'supplied'])
      expect(keysOf(data).has(banned)).toBe(false);

    await expect(page).toHaveURL(shareUrl(e));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${e.name} · 영토 재생`);
    await expect(page.getByText(`${eResult.endedYear}년 ${eResult.endedMonth}월 종료`)).toBeVisible();
    const first = data.items[0]!;
    await expect(dateLine(page)).toHaveText(`${first.year}년 ${first.month}월 (1/3)`);
    await expect(dateLine(page)).toHaveText(`${await dateOf(e, e.ticks[0]!)} (1/3)`);
    const legend = shared(page).getByLabel('이 달의 국가별 도시 수');
    for (const { name } of first.nations) await expect(legend).toContainText(name);
    await expect(shared(page).getByTestId('timelapse-map')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('E5 같은 공유 화면에서 내려받은 PNG도 계약 크기이고 도시 점 색이 그 달 저장 색이다', async ({
  browser,
  timelapseStack,
}) => {
  const { e } = timelapseStack.worlds;
  const { context, page } = await anonymous(browser, timelapseStack.webOrigin);
  try {
    await page.goto(shareUrl(e));
    await expect(dateLine(page)).toContainText('(1/3)');
    const waiting = page.waitForEvent('download');
    await shared(page).getByRole('button', { name: '이 달 그림 내려받기', exact: true }).click();
    const download: Download = await waiting;
    const { toGameDate } = await import('../packages/rules/src/index');
    const { year, month } = toGameDate(e.startYear, e.ticks[0]!);
    expect(download.suggestedFilename()).toBe(`opensamguk-${e.name}-${year}-${month}.png`);
    const png = await readPng(download);
    expect(png.signature).toEqual(PNG_SIGNATURE);
    expect(png.chunk).toBe('IHDR');
    expect([png.width, png.height]).toEqual([PNG_WIDTH, PNG_HEIGHT]);
    // E의 첫 달: 도시 1은 국가 1(위), 도시 2는 국가 2(오)다 (timelapseSeed eFrame).
    const one = await dotCenter(e.id, 1);
    const two = await dotCenter(e.id, 2);
    expect(await pixelOf(page, png.bytes, one.x, one.y)).toEqual(rgbOf(SAVED.wei.color));
    expect(await pixelOf(page, png.bytes, two.x, two.y)).toEqual(rgbOf(SAVED.wu.color));
  } finally {
    await context.close();
  }
});

test('E6 진행 중·정지·개시 전 월드의 공유 주소는 FORBIDDEN이고 거부 문구만 보이며 지도와 프레임이 없다', async ({
  browser,
  timelapseStack,
}) => {
  const { r, p, a } = timelapseStack.worlds;
  const { context, page } = await anonymous(browser, timelapseStack.webOrigin);
  try {
    for (const world of [r, p, a]) {
      const response = firstPublicPage(page, world.id);
      await page.goto(shareUrl(world));
      const entry = await publicEntry(await response);
      expect(entry?.error?.data).toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
      expect(entry?.result).toBeUndefined();
      await expect(page).toHaveURL(shareUrl(world));
      await expect(shared(page).getByText('종료된 월드만 로그인 없이 볼 수 있습니다.')).toBeVisible();
      await expect(shared(page).getByRole('link', { name: '로그인' })).toHaveAttribute('href', '/login');
      await expect(shared(page).locator('svg')).toHaveCount(0);
      await expect(dateLine(page)).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('영토 재생');
    }
  } finally {
    await context.close();
  }
});

test('E7 로그인 재생 탭에는 종료 월드에만 공유 링크 버튼이 있고 누르면 공유 주소가 클립보드에 들어간다', async ({
  page,
  timelapseStack,
}) => {
  const { e, r } = timelapseStack.worlds;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: timelapseStack.webOrigin });
  await login(page);
  await page.goto(`/w/${e.id}/records?tab=timelapse`);
  await expect(dateLine(page)).toContainText('(1/3)');
  const share = page.getByRole('button', { name: '공유 링크 복사', exact: true });
  await expect(share).toBeVisible();
  await share.click();
  await expect(page.getByText('공유 링크를 복사했습니다. 로그인 없이 볼 수 있습니다.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${timelapseStack.webOrigin}/share/timelapse/${e.id}`,
  );

  await page.goto(`/w/${r.id}/records?tab=timelapse`);
  await expect(dateLine(page)).toContainText('(1/1)');
  await expect(page.getByRole('button', { name: '공유 링크 복사', exact: true })).toHaveCount(0);
});
