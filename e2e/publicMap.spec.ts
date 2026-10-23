import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import type { PublicMapsResponse } from '../apps/web/src/game/types';
import { delayText, snapshotTimeText, toPublicMaps, type PublicMaps } from '../apps/web/src/publicMap/publicMaps';
import type { Prisma, PrismaClient } from '../packages/db/src/index';
import type { WorldState } from '../packages/rules/src/index';
import { withE2eDb } from './account';
import { holdLease, releaseHold, type LeaseHold } from './game';

// T2-25 · AC-M2-20: 로그인 화면의 지연 공개 지도. 실제 서버의 world.publicMaps(T2-24)를 화면이 받은 응답 그대로 대조한다.
// httpBatchLink라 같은 때 보낸 health와 한 요청으로 묶여 올 수 있다. 주소의 경로 목록에서 순서를 찾는다.
// 시작 전에 이 파일 전용 월드 둘을 E2E 전용 DB에 만든다.
// 지연 월드는 시험이 엔진 실행권을 쥔 RUNNING 월드다. 감독이 띄운 엔진은 이 월드를 돌리지 못하고, 사본은 시험이
// 엔진의 사본 함수(persistPublicMap)에 시각을 직접 넣어(manual 시계) 찍는다. 다른 하나는 사본 없이 멈춘 PAUSED 월드다.
// 빈 상태 중 월드 0개와 좁은 화면의 넓은 지도만 응답의 publicMaps 칸을 바꿔 화면 동작을 본다. 이 둘은 지연·공개 범위의 증거가 아니다.

const PATH = 'world.publicMaps';

const isPublicMaps = (response: Response) =>
  new URL(response.url()).pathname.split('/').pop()!.split(',').includes(PATH);

async function readPublicMaps(response: Response): Promise<PublicMaps> {
  const paths = new URL(response.url()).pathname.split('/').pop()!.split(',');
  const body = (await response.json()) as Array<{ result?: { data: PublicMapsResponse } }>;
  const entry = body[paths.indexOf(PATH)];
  if (!entry?.result) throw new Error(`${PATH} 응답이 없습니다`);
  return toPublicMaps(entry.result.data);
}

async function openLogin(page: Page): Promise<PublicMaps> {
  const response = page.waitForResponse(isPublicMaps);
  await page.goto('/login');
  return readPublicMaps(await response);
}

// 서버 응답은 그대로 받고 publicMaps 칸만 바꿔 돌려준다.
async function overridePublicMaps(page: Page, data: PublicMapsResponse) {
  await page.route('**/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const paths = url.pathname.split('/').pop()!.split(',');
    const index = paths.indexOf(PATH);
    if (index < 0) return route.continue();
    const others = paths.filter((path) => path !== PATH);
    const rest = others.length
      ? ((await (
          await route.fetch({
            url: route
              .request()
              .url()
              .replace(url.pathname, `/trpc/${others.join(',')}`),
          })
        ).json()) as unknown[])
      : [];
    const body = [...rest];
    body.splice(index, 0, { result: { data } });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

// playwright.config는 웹(5173)만 기다린다. API 서버가 뜨기 전에는 프록시가 502를 주므로 응답할 때까지 기다린다.
async function serverDelayMinutes(request: APIRequestContext): Promise<number> {
  let delay: number | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/trpc/${PATH}`);
        if (response.ok())
          delay = ((await response.json()) as { result: { data: PublicMapsResponse } }).result.data.delayMinutes;
        return response.status();
      },
      { message: `${PATH}가 응답하지 않습니다`, timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(200);
  return delay!;
}

// world:create와 같은 함수로 PREOPEN 월드를 만든다. e2e/game.ts의 createWorld는 pnpm을 띄워 Windows에서 돌지 않는다.
async function createWorld(name: string): Promise<string> {
  const { loadInitialWorld } = await import('../apps/engine/src/world/resources');
  const { saveInitialWorld } = await import('../apps/engine/src/world/persistence');
  const state = await loadInitialWorld({ scenario: '1030', map: 'che', seed: `e2e-public-map-${Date.now()}` });
  return withE2eDb(
    async (db) => (await saveInitialWorld(db, state, { name, turnTermMinutes: 1, endYear: 300 })).worldId,
  );
}

async function clock(db: PrismaClient, worldId: string, action: 'start' | 'pause') {
  const { controlClock } = await import('../apps/engine/src/world/clock');
  await controlClock(db, worldId, action);
}

interface Owner {
  id: number;
  name: string;
  color: string;
}

const MINUTE = 60_000;
const stamp = Date.now();
let delayMinutes = 0;
let hold: LeaseHold | undefined;
let delayed: { id: string; name: string; cityKey: number; cityName: string; before: Owner; after: Owner };
let paused: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  delayMinutes = await serverDelayMinutes(request);

  const pausedName = `공개 지도 사본 없음 ${stamp}`;
  const pausedId = await createWorld(pausedName);
  await withE2eDb(async (db) => {
    await clock(db, pausedId, 'start');
    await clock(db, pausedId, 'pause');
  });
  paused = { id: pausedId, name: pausedName };

  const name = `공개 지도 지연 ${stamp}`;
  const id = await createWorld(name);
  hold = await holdLease(id);
  const { db, lease } = hold;
  await clock(db, id, 'start');
  const { loadWorld } = await import('../apps/engine/src/worldLoader');
  const { persistPublicMap } = await import('../apps/engine/src/publicMap');
  const shoot = (now: number, change?: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    db.$transaction(async (tx) => {
      await change?.(tx);
      const state = await loadWorld(tx, id);
      if (!(await persistPublicMap(tx, lease, state, 0, now, { delayMinutes, intervalMinutes: 1 })))
        throw new Error('공개 지도 사본을 찍지 못했습니다');
      return state;
    });

  // 사본 A는 지연 시간의 두 배 전, 도시 소유를 바꾼 뒤의 사본 B는 1분 전이다. 서버는 지금 A를 보여 줘야 한다.
  const state: WorldState = await shoot(Date.now() - 2 * delayMinutes * MINUTE);
  const city = Object.values(state.cities).find((entry) => entry.nationId !== null)!;
  const nations = Object.values(state.nations);
  const before = nations.find((nation) => nation.id === city.nationId)!;
  const after = nations.find((nation) => nation.id !== city.nationId && nation.color !== before.color)!;
  await shoot(Date.now() - MINUTE, (tx) =>
    tx.city.update({
      where: { worldId_cityKey: { worldId: id, cityKey: city.cityKey } },
      data: { nationId: after.id },
    }),
  );
  const pick = ({ id, name, color }: Owner): Owner => ({ id, name, color });
  delayed = { id, name, cityKey: city.cityKey, cityName: city.name, before: pick(before), after: pick(after) };
});

// 두 월드는 PAUSED로 남긴다. 지연 월드도 멈춘 뒤 실행권을 놓아 감독이 띄운 엔진이 턴을 돌리지 않게 한다.
test.afterAll(async () => {
  if (!hold) return;
  try {
    await clock(hold.db, delayed.id, 'pause');
  } finally {
    await releaseHold(hold);
  }
});

const tabOf = (page: Page, data: PublicMaps, id: string) => {
  const index = data.worlds.findIndex((world) => world.id === id);
  expect(index, `${id} 월드가 공개 지도 탭에 없습니다`).toBeGreaterThanOrEqual(0);
  return page.getByRole('tab').nth(index);
};

// 브라우저가 계산한 색으로 비교한다. 국가 색은 #rrggbb지만 계산된 fill은 rgb(...)다.
const computedColor = (page: Page, color: string) =>
  page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  }, color);

test('로그아웃 상태 로그인 화면의 탭이 공개 월드와 같고 탭마다 그 월드의 지도나 안내를 보여 준다', async ({ page }) => {
  const data = await openLogin(page);
  expect(data.worlds.length).toBeGreaterThanOrEqual(2);
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(data.worlds.length);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  for (const [i, world] of data.worlds.entries()) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(i)).toHaveText(world.status === 'PAUSED' ? `${world.name}멈춤` : world.name);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('data-world-id', world.id);
    if (world.map === null) {
      await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
      await expect(page.getByTestId('world-map')).toHaveCount(0);
      continue;
    }
    await expect(page.getByTestId('world-map')).toHaveCount(1);
    await expect(page.getByTestId('world-map').getByRole('img')).toHaveCount(world.map.cities.length);
    await expect(page.getByTestId('public-map-when')).toHaveText(
      snapshotTimeText(world.map, new Date()) + delayText(data.delayMinutes),
    );
  }
});

test('공개 지도에는 장수·병력·보급 표시가 없고 도시를 눌러도 이동하지 않는다', async ({ page }) => {
  const data = await openLogin(page);
  await tabOf(page, data, delayed.id).click();
  const map = page.getByTestId('world-map');
  await expect(map.getByRole('img').first()).toBeVisible();
  await expect(map.getByRole('button')).toHaveCount(0);
  await expect(map.locator('[data-cut], [data-supplied], [data-mine]')).toHaveCount(0);
  await expect(page.getByTestId('public-map')).not.toContainText(/보급|내 위치|병력|장수/);
  await map.getByRole('img').first().click();
  await expect(page).toHaveURL('/login');
});

test('지연 시간이 지나기 전에는 바뀐 도시 소유가 화면에 나오지 않는다', async ({ page }) => {
  const data = await openLogin(page);
  await tabOf(page, data, delayed.id).click();
  const city = page.getByTestId('world-map').locator(`[data-city-key="${delayed.cityKey}"]`);
  await expect(city).toHaveAttribute('aria-label', `${delayed.cityName}, ${delayed.before.name}`);
  await expect(city).toHaveAttribute('data-nation-id', String(delayed.before.id));
  await expect(city.locator('circle')).toHaveCSS('fill', await computedColor(page, delayed.before.color));

  // 시계를 지연 시간만큼 기다리는 대신 사본 B의 시각을 지연 시간보다 앞으로 옮긴다. 그러면 서버가 B를 내주고 화면 색이 바뀐다.
  await withE2eDb((db) =>
    db.publicMapSnapshot.updateMany({
      where: { worldId: delayed.id, takenAt: { gt: new Date(Date.now() - delayMinutes * MINUTE) } },
      data: { takenAt: new Date(Date.now() - (delayMinutes + 1) * MINUTE) },
    }),
  );
  const moved = await openLogin(page);
  await tabOf(page, moved, delayed.id).click();
  await expect(city).toHaveAttribute('aria-label', `${delayed.cityName}, ${delayed.after.name}`);
  await expect(city.locator('circle')).toHaveCSS('fill', await computedColor(page, delayed.after.color));
});

test('방향키로 탭을 옮기고 aria-selected가 따라간다', async ({ page }) => {
  const data = await openLogin(page);
  expect(data.worlds.length).toBeGreaterThanOrEqual(2);
  const tabs = page.getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.last()).toBeFocused();
});

test('사본 없는 월드 탭은 안내만, 월드가 없으면 문구 없이 자리만 두고 양식 위치는 그대로다', async ({ page }) => {
  const data = await openLogin(page);
  const tab = tabOf(page, data, paused.id);
  await tab.click();
  await expect(tab).toHaveText(`${paused.name}멈춤`);
  await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
  await expect(page.getByTestId('world-map')).toHaveCount(0);
  const withWorld = await page.getByLabel('이메일').boundingBox();

  await overridePublicMaps(page, { delayMinutes, worlds: [] });
  await page.reload();
  const area = page.getByTestId('public-map');
  await expect(area).toHaveAttribute('data-empty', 'true');
  await expect(area).toHaveText('');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  expect(await page.getByLabel('이메일').boundingBox()).toEqual(withWorld);
});

test('375px에서는 양식 아래로 지도가 내려가고 가로 스크롤이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // 지도 끝(25, 20)과 (680, 480)에 도시를 두어 가로로 가장 넓게 그려지게 한다.
  await overridePublicMaps(page, {
    delayMinutes,
    worlds: [
      {
        id: 'wide',
        name: '넓은 천하',
        status: 'RUNNING',
        map: {
          takenAt: new Date().toISOString(),
          year: 190,
          month: 1,
          cities: [
            { key: '1', name: '서량', level: 8, x: 25, y: 20, nationId: 1, links: ['2'] },
            { key: '2', name: '건업', level: 8, x: 680, y: 480, nationId: null, links: ['1'] },
          ],
          nations: [{ id: 1, name: '위', color: '#000080' }],
        },
      },
    ],
  });
  await page.goto('/login');
  await expect(page.getByTestId('world-map')).toBeVisible();
  const form = await page.getByRole('button', { name: '로그인' }).boundingBox();
  const map = await page.getByTestId('public-map').boundingBox();
  expect(form && map && map.y >= form.y + form.height).toBe(true);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
