import { execFileSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import { e2eWorld, query } from './game';

// T4-36 · AC-P2-17 (나). 기록 화면의 영토 재생 탭을 실제 서버·DB·엔진으로 본다. 응답은 지어내지 않는다.
// 지연이 필요한 시험만 실제 요청을 잡아 두었다가 그대로 흘려보낸다. 준비는 e2e/timelapseSeed.ts가 한다.
test.describe.configure({ mode: 'serial' });

// pnpm 대신 node로 tsx를 불러 Windows에서도 셸 없이 돈다.
function seed(...args: string[]): Record<string, unknown> {
  const node = ['--env-file-if-exists=.env', '--import', 'tsx', 'e2e/timelapseSeed.ts', ...args];
  const out = execFileSync(process.execPath, node, { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

interface Stored {
  nationId: number;
  name: string;
  color: string;
}
interface Seeded {
  paged: string;
  other: string;
  empty: string;
  missing: string;
  destroyed: {
    worldId: string;
    settled: Stored[];
    renamed: { id: number; name: string; color: string };
    removed: number;
  };
}

let context: BrowserContext;
let page: Page;
let worlds: Seeded | undefined;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  page = await context.newPage();
  // 장수 없는 계정이다. 기록은 로그인만으로 본다.
  await createAccount(page);
  // dev 엔진이 공용 E2E 월드에 먼저 묶이게 한다 (ranking.spec.ts와 같은 이유).
  await e2eWorld(page);
  worlds = seed('create') as unknown as Seeded;
});

test.afterAll(async () => {
  await context?.close();
  if (!worlds) return;
  const { paged, other, empty, missing, destroyed } = worlds;
  seed('remove', paged, other, empty, missing, destroyed.worldId);
});

// httpBatchLink는 한 요청에 여러 절차를 묶는다. 주소에서 timelapse.frames 입력만 꺼낸다.
type FramesInput = { worldId: string; cursor?: string };
function framesInputs(request: Request): FramesInput[] {
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/trpc/')) return [];
  const paths = decodeURIComponent(url.pathname.slice('/trpc/'.length)).split(',');
  const input = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<string, FramesInput>;
  return paths.flatMap((path, i) => (path === 'timelapse.frames' ? [input[i]!] : []));
}
// 끝까지 받은 요청과 취소·실패한 요청을 나눠 센다. 개발 모드의 React StrictMode는 패널을 붙였다 떼었다 다시 붙여
// 첫 요청이 한 번 취소된다(gcTime 0 정책 그대로). 화면이 쓴 것은 끝까지 받은 요청이다.
function recordFrames(target: Page) {
  const calls: FramesInput[] = [];
  const failed: FramesInput[] = [];
  const done = (request: Request) => calls.push(...framesInputs(request));
  const fail = (request: Request) => failed.push(...framesInputs(request));
  target.on('requestfinished', done);
  target.on('requestfailed', fail);
  return {
    calls,
    failed,
    stop: () => {
      target.off('requestfinished', done);
      target.off('requestfailed', fail);
    },
  };
}

const open = (target: Page, worldId: string) => target.goto(`/w/${worldId}/records?tab=timelapse`);
const date = (target: Page) => target.getByTestId('timelapse-date');
const legend = (target: Page) => target.getByLabel('이 달의 국가별 도시 수');
const button = (target: Page, name: string) => target.getByRole('button', { name, exact: true });
const position = async (target: Page) => Number((await date(target).innerText()).match(/\((\d+)\//)![1]);
const hexToRgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};
const ids = () => worlds!;

test('E1 위쪽 메뉴의 기록에서 영토 재생 탭으로 가고 새로고침해도 탭이 남는다', async () => {
  await page.goto(`/w/${ids().paged}`);
  await page.getByRole('link', { name: '기록', exact: true }).first().click();
  const tabs = page.getByRole('navigation', { name: '기록 종류' });
  await tabs.getByRole('link', { name: '영토 재생' }).click();
  await expect(page).toHaveURL(/\/records\?tab=timelapse$/);
  await expect(page.getByRole('heading', { name: '기록 · 영토 재생' })).toBeVisible();
  await expect(date(page)).toContainText('(1/35)');
  await page.reload();
  await expect(tabs.getByRole('link', { name: '영토 재생' })).toHaveAttribute('aria-current', 'page');
  await expect(date(page)).toContainText('(1/35)');
  for (const name of ['내 장수', '국가 역사', '월드 정세']) {
    await tabs.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name: `기록 · ${name}` })).toBeVisible();
    await expect(page.getByTestId('timelapse-date')).toHaveCount(0);
  }
});

test('E2 장수 없는 계정으로 두 페이지를 차례로 받아 35개월을 잇는다', async () => {
  const frames = recordFrames(page);
  await open(page, ids().paged);
  await expect(page.getByText('35개월 불러옴')).toBeVisible();
  frames.stop();
  // 개발 모드 StrictMode의 재마운트로 첫 페이지 요청이 한 번 더 나갈 수 있다. 앞 요청이 다른 절차와 한 묶음이면
  // 끊기지 않고 끝까지 오지만 그 결과는 지워진 쿼리의 것이라 쓰이지 않는다. 둘째 페이지는 정확히 한 번이다.
  const first = frames.calls.filter((input) => input.cursor === undefined);
  expect(first.length).toBeGreaterThanOrEqual(1);
  expect(first.length).toBeLessThanOrEqual(2);
  expect(first.every((input) => input.worldId === ids().paged)).toBe(true);
  expect(frames.calls.filter((input) => input.cursor !== undefined)).toEqual([
    { worldId: ids().paged, cursor: '300000' },
  ]);
  expect(frames.calls.at(-1)).toEqual({ worldId: ids().paged, cursor: '300000' });
  expect(frames.failed.every((input) => input.cursor === undefined)).toBe(true);
  const range = page.getByRole('slider', { name: '재생 위치' });
  await expect(range).toHaveAttribute('min', '0');
  await expect(range).toHaveAttribute('max', '34');
});

test('E3 오래된 달부터 재생하고 정지하면 멈추며 처음과 끝에서 버튼이 막힌다', async () => {
  test.setTimeout(60_000);
  await open(page, ids().paged);
  await expect(page.getByText('35개월 불러옴')).toBeVisible();
  await expect(date(page)).toContainText('(1/35)');
  await expect(button(page, '처음')).toBeDisabled();
  await expect(button(page, '이전')).toBeDisabled();

  await button(page, '재생').click();
  const seen = [await position(page)];
  await expect
    .poll(
      async () => {
        const now = await position(page);
        if (now !== seen.at(-1)) seen.push(now);
        return seen.length;
      },
      { timeout: 15_000, intervals: [200] },
    )
    .toBeGreaterThanOrEqual(6);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  await button(page, '정지').click();
  const stopped = await date(page).innerText();
  await page.waitForTimeout(1_500);
  await expect(date(page)).toHaveText(stopped);

  const at = await position(page);
  await button(page, '다음').click();
  await expect(date(page)).toContainText(`(${at + 1}/35)`);
  await button(page, '이전').click();
  await expect(date(page)).toContainText(`(${at}/35)`);
  await page.getByRole('slider', { name: '재생 위치' }).press('End');
  await expect(date(page)).toContainText('(35/35)');
  await expect(button(page, '다음')).toBeDisabled();
});

test('E4 출병으로 멸망한 국가의 도시는 정산 때 저장된 이름과 색으로 그린다', async () => {
  const { worldId, settled, removed } = ids().destroyed;
  const gone = settled.find(({ nationId }) => nationId === removed)!;
  // 엔진이 국가 행을 지웠고 지금 국가 목록에도 없다. 정산 직후 저장값은 준비 스크립트가 DB에서 읽어 둔 값이다.
  expect(await withE2eDb((db) => db.nation.findUnique({ where: { worldId_id: { worldId, id: removed } } }))).toBeNull();
  const response = await query<{
    items: Array<{ tick: number; nations: Array<{ id: number }> }>;
    currentNations: Array<{ id: number }>;
  }>(page, 'timelapse.frames', { worldId });
  expect(response.items.map(({ tick }) => tick)).toEqual([10000, 20000]);
  expect(response.currentNations.map(({ id }) => id)).not.toContain(removed);

  await open(page, worldId);
  await expect(date(page)).toContainText('(1/2)');
  await expect(legend(page)).toContainText(`${gone.name} 1`);
  const city = page.locator(`[data-testid="timelapse-map"] [data-city-key="2"]`);
  await expect(city).toHaveAttribute('data-nation-id', String(removed));
  await expect(city.locator('title')).toHaveText(`도시2, ${gone.name}`);
  await expect(city.locator('circle')).toHaveCSS('fill', hexToRgb(gone.color));

  await button(page, '다음').click();
  await expect(date(page)).toContainText('(2/2)');
  await expect(legend(page)).not.toContainText(gone.name);
  await expect(page.locator(`[data-testid="timelapse-map"] [data-nation-id="${removed}"]`)).toHaveCount(0);
});

test('E5 이름이 바뀐 국가의 옛 달은 지금 값이 아니라 그때 저장값으로 그린다', async () => {
  const { worldId, settled, renamed } = ids().destroyed;
  const before = settled.find(({ nationId }) => nationId === renamed.id)!;
  expect(before.name).not.toBe(renamed.name);
  const response = await query<{ currentNations: Array<{ id: number; name: string; color: string }> }>(
    page,
    'timelapse.frames',
    { worldId },
  );
  expect(response.currentNations.find(({ id }) => id === renamed.id)).toEqual(renamed);

  await open(page, worldId);
  await expect(date(page)).toContainText('(1/2)');
  await expect(legend(page)).toContainText(before.name);
  await expect(legend(page)).not.toContainText(renamed.name);
  await expect(page.locator('[data-testid="timelapse-map"] [data-city-key="1"] circle')).toHaveCSS(
    'fill',
    hexToRgb(before.color),
  );
  await button(page, '다음').click();
  await expect(legend(page)).toContainText(renamed.name);
});

test('E6 저장값이 없는 달은 지도 대신 기록 누락을 알리고 다른 달은 그린다', async () => {
  await open(page, ids().missing);
  await expect(date(page)).toContainText('(1/3)');
  await expect(page.getByTestId('timelapse-map')).toBeVisible();
  await button(page, '다음').click();
  await expect(date(page)).toContainText('(2/3) 국가 기록 없음');
  await expect(page.getByText('이 시점의 국가 기록이 없습니다.')).toBeVisible();
  await expect(page.getByTestId('timelapse-map')).toHaveCount(0);
  await expect(legend(page)).toHaveCount(0);
  await button(page, '다음').click();
  await expect(date(page)).toContainText('(3/3)');
  await expect(page.getByTestId('timelapse-map')).toBeVisible();
  await expect(page.getByText('이 시점의 국가 기록이 없습니다.')).toHaveCount(0);
});

test('E7 기록이 없으면 빈 상태, 깨진 첫 행이면 오류와 다시 시도', async () => {
  const worldId = ids().empty;
  await open(page, worldId);
  await expect(page.getByText('영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다')).toBeVisible();
  await withE2eDb((db) =>
    db.yearbookSnapshot.create({
      data: { worldId, tick: 10000, year: 190, month: 1, sequence: 0, data: { nations: [] }, stateHash: 'e2e-broken' },
    }),
  );
  try {
    await page.reload();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('불러오지 못했습니다', { timeout: 15_000 });
    await expect(alert.getByRole('button', { name: '다시 시도' })).toBeVisible();
  } finally {
    await withE2eDb((db) => db.yearbookSnapshot.deleteMany({ where: { worldId } }));
  }
});

test('E8 둘째 페이지가 깨지면 받은 30개월은 재생하고 이어 받기 오류를 보인다', async () => {
  const worldId = ids().paged;
  const tick = 310000;
  const original = await withE2eDb((db) =>
    db.yearbookSnapshot.findUniqueOrThrow({ where: { worldId_tick: { worldId, tick } }, select: { data: true } }),
  );
  await withE2eDb((db) =>
    db.yearbookSnapshot.update({ where: { worldId_tick: { worldId, tick } }, data: { data: { nations: [] } } }),
  );
  try {
    await open(page, worldId);
    await expect(page.getByText('다음 기록을 불러오지 못했습니다.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('30개월 불러옴')).toBeVisible();
    await button(page, '다음').click();
    await expect(date(page)).toContainText('(2/30)');
  } finally {
    await withE2eDb((db) =>
      db.yearbookSnapshot.update({
        where: { worldId_tick: { worldId, tick } },
        data: { data: original.data as object },
      }),
    );
  }
});

test('E9 첫 요청을 기다리는 동안 불러오는 중을 보인다', async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/trpc/**', async (route) => {
    if (framesInputs(route.request()).some((input) => input.worldId === ids().other)) await held;
    // 잡아 둔 사이 StrictMode 재마운트가 앞 요청을 끊었으면 이미 끝난 요청이다.
    await route.continue().catch(() => {});
  });
  try {
    await open(page, ids().other);
    await expect(page.getByRole('status').filter({ hasText: '불러오는 중' })).toBeVisible();
    await expect(date(page)).toHaveCount(0);
    release!();
    await expect(date(page)).toContainText('(1/3)');
  } finally {
    release!();
    await page.unroute('**/trpc/**');
  }
});

test('E10 재생 중 다른 월드로 가면 이전 월드의 요청이 끊기고 화면에 섞이지 않는다', async () => {
  const [a, b] = [ids().paged, ids().other];
  let heldRoute: Route | undefined;
  let heldRequest: Request | undefined;
  await page.route('**/trpc/**', async (route) => {
    if (framesInputs(route.request()).some((input) => input.worldId === a && input.cursor === '300000')) {
      heldRoute = route;
      heldRequest = route.request();
      return;
    }
    await route.continue();
  });
  const failed: Request[] = [];
  const onFailed = (request: Request) => failed.push(request);
  page.on('requestfailed', onFailed);
  try {
    await open(page, a);
    await expect(date(page)).toContainText('(1/30)');
    await expect.poll(() => heldRequest !== undefined).toBe(true);
    await button(page, '재생').click();
    await expect(date(page)).not.toContainText('(1/30)');

    await page.evaluate((path) => {
      history.pushState(null, '', path);
      dispatchEvent(new PopStateEvent('popstate'));
    }, `/w/${b}/records?tab=timelapse`);
    await expect(date(page)).toContainText('(1/3)');
    await expect(button(page, '재생')).toBeVisible();
    // 잡아 둔 A의 둘째 페이지는 브라우저가 취소해 실패로 끝난다.
    await expect.poll(() => failed.includes(heldRequest!), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1_500);
    await expect(date(page)).toContainText('(1/3)');
    await expect(page.getByText('3개월 불러옴')).toBeVisible();

    await page.unroute('**/trpc/**');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/w/${a}/records`));
    await expect(page.getByText('35개월 불러옴')).toBeVisible();
    await expect(date(page)).toContainText('(1/35)');
    await expect(button(page, '재생')).toBeVisible();
  } finally {
    page.off('requestfailed', onFailed);
    await heldRoute?.continue().catch(() => {});
    await page.unroute('**/trpc/**');
  }
});

test('E11 로그인하지 않으면 로그인 화면으로 보낸다', async ({ browser }, testInfo) => {
  const anonymous = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const guest = await anonymous.newPage();
    await open(guest, ids().paged);
    await expect(guest).toHaveURL(/\/login\?next=/);
  } finally {
    await anonymous.close();
  }
});

test('E12 키보드로 재생·정지하고 지도 이름에 지금 날짜가 있다', async () => {
  await open(page, ids().other);
  await expect(date(page)).toContainText('(1/3)');
  const first = (await date(page).innerText()).replace(/ \(.*$/, '');
  await expect(page.getByRole('img', { name: `${first} 영토 지도, 도시 4개` })).toBeVisible();
  await page.getByRole('navigation', { name: '기록 종류' }).getByRole('link', { name: '영토 재생' }).focus();
  const play = button(page, '재생');
  for (let i = 0; i < 10 && !(await play.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(play).toBeFocused();
  await page.keyboard.press('Space');
  await expect(button(page, '정지')).toBeFocused();
  await expect(date(page)).toHaveAttribute('aria-live', 'off');
  await page.keyboard.press('Space');
  await expect(button(page, '재생')).toBeFocused();
  await expect(date(page)).toHaveAttribute('aria-live', 'polite');
});

test('E13 다른 탭에 갔다가 다시 열면 첫 페이지부터 받아 새 달이 나온다', async () => {
  const worldId = ids().paged;
  const tick = 360000;
  await open(page, worldId);
  await expect(page.getByText('35개월 불러옴')).toBeVisible();
  const tabs = page.getByRole('navigation', { name: '기록 종류' });
  await tabs.getByRole('link', { name: '월드 정세' }).click();
  await withE2eDb(async (db) => {
    const last = await db.yearbookSnapshot.findUniqueOrThrow({
      where: { worldId_tick: { worldId, tick: 350000 } },
      include: { nations: true },
    });
    await db.yearbookSnapshot.create({
      data: {
        worldId,
        tick,
        year: last.month === 12 ? last.year + 1 : last.year,
        month: last.month === 12 ? 1 : last.month + 1,
        sequence: 0,
        data: last.data as object,
        stateHash: 'e2e-timelapse',
        nations: { create: last.nations.map(({ nationId, name, color }) => ({ nationId, name, color })) },
      },
    });
  });
  try {
    const frames = recordFrames(page);
    await tabs.getByRole('link', { name: '영토 재생' }).click();
    await expect(page.getByText('36개월 불러옴')).toBeVisible();
    frames.stop();
    expect(frames.calls[0]).toEqual({ worldId });
    await expect(date(page)).toContainText('(1/36)');
  } finally {
    await withE2eDb((db) => db.yearbookSnapshot.deleteMany({ where: { worldId, tick } }));
  }
});
