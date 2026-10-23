import { expect, test, type Page, type Response } from '@playwright/test';
import { delayText, snapshotTimeText, toPublicMaps, type PublicMaps } from '../apps/web/src/publicMap/publicMaps';

// T2-25 · AC-M2-20: 로그인 화면의 지연 공개 지도. 실제 서버의 world.publicMaps(T2-24)를 화면이 받은 응답 그대로 대조한다.
// httpBatchLink라 같은 때 보낸 health와 한 요청으로 묶여 올 수 있다. 주소의 경로 목록에서 순서를 찾는다.
// 빈 상태 두 가지는 응답의 publicMaps 칸만 바꿔 화면 동작을 본다. 이 둘은 화면 시험이고 지연·공개 범위의 증거는 아니다.

const PATH = 'world.publicMaps';

const isPublicMaps = (response: Response) =>
  new URL(response.url()).pathname.split('/').pop()!.split(',').includes(PATH);

async function readPublicMaps(response: Response): Promise<PublicMaps> {
  const paths = new URL(response.url()).pathname.split('/').pop()!.split(',');
  const body = (await response.json()) as Array<{ result?: { data: unknown }; error?: { data?: { code?: string } } }>;
  const entry = body[paths.indexOf(PATH)];
  // T2-24가 main에 들어오기 전에는 서버에 절차가 없다. 그동안은 건너뛰고 증거로 세지 않는다.
  test.skip(entry?.error?.data?.code === 'NOT_FOUND', `${PATH}(T2-24)가 아직 서버에 없다`);
  if (!entry?.result) throw new Error(`${PATH} 응답이 없습니다`);
  return toPublicMaps(entry.result.data);
}

async function openLogin(page: Page): Promise<PublicMaps> {
  const response = page.waitForResponse(isPublicMaps);
  await page.goto('/login');
  return readPublicMaps(await response);
}

// 서버 응답은 그대로 받고 publicMaps 칸만 바꿔 돌려준다.
async function overridePublicMaps(page: Page, data: PublicMaps) {
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

test('로그아웃 상태 로그인 화면의 탭이 공개 월드와 같고 탭마다 그 월드의 지도나 안내를 보여 준다', async ({ page }) => {
  const data = await openLogin(page);
  const area = page.getByTestId('public-map');
  if (data.worlds.length === 0) {
    await expect(area).toHaveAttribute('data-empty', 'true');
    await expect(area).toHaveText('');
    return;
  }
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(data.worlds.length);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  for (const [i, world] of data.worlds.entries()) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('data-world-id', world.id);
    if (world.map === null) {
      await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
      await expect(page.getByTestId('world-map')).toHaveCount(0);
      continue;
    }
    await expect(page.getByTestId('world-map')).toHaveCount(1);
    await expect(page.getByTestId('public-map-when')).toHaveText(
      snapshotTimeText(world.map, new Date()) + delayText(data.delayMinutes),
    );
  }
});

test('공개 지도에는 장수·병력·보급 표시가 없고 도시를 눌러도 이동하지 않는다', async ({ page }) => {
  const data = await openLogin(page);
  const index = data.worlds.findIndex((world) => world.map !== null);
  test.skip(index < 0, '공개 사본이 있는 월드가 아직 없다. 이 결과는 증거가 아니다');
  await page.getByRole('tab').nth(index).click();
  const map = page.getByTestId('world-map');
  await expect(map.getByRole('button')).toHaveCount(0);
  await expect(map.locator('[data-cut], [data-supplied], [data-mine]')).toHaveCount(0);
  await expect(page.getByTestId('public-map')).not.toContainText(/보급|내 위치|병력|장수/);
  await map.getByRole('img').first().click();
  await expect(page).toHaveURL('/login');
});

test('방향키로 탭을 옮기고 aria-selected가 따라간다', async ({ page }) => {
  const data = await openLogin(page);
  test.skip(data.worlds.length < 2, '공개 월드가 둘 이상이어야 한다. 이 결과는 증거가 아니다');
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
  await overridePublicMaps(page, {
    delayMinutes: 10,
    worlds: [{ id: 'none', name: '사본 없는 천하', status: 'RUNNING', map: null }],
  });
  await page.goto('/login');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
  const withWorld = await page.getByLabel('이메일').boundingBox();

  await page.unrouteAll({ behavior: 'wait' });
  await overridePublicMaps(page, { delayMinutes: 10, worlds: [] });
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
    delayMinutes: 10,
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
            { key: 1, name: '서량', level: 8, x: 25, y: 20, nationId: 1, links: [2] },
            { key: 2, name: '건업', level: 8, x: 680, y: 480, nationId: null, links: [1] },
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

// 계획의 지연 검증(실제 엔진·DB, manual 시계). 사본을 찍는 엔진 함수가 T2-24로 들어오면 그 함수로 사본 A를 찍고
// 도시 소유를 바꾼 뒤 사본 B를 찍는다. 지연 시간이 B에 닿기 전에는 화면 색이 A 그대로인지 본다.
test.fixme('지연 시간이 지나기 전에는 바뀐 도시 소유가 화면에 나오지 않는다', async () => {});
