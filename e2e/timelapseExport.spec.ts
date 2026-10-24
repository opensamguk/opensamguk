import type { Download, Page } from '@playwright/test';
import { createAccount, TEST_PASSWORD, withE2eDb } from './account';
import { query } from './game';
import {
  dateOf,
  createLegendWorld,
  dotCenter,
  expect,
  NEUTRAL,
  LEGEND_NATIONS,
  PNG_HEIGHT,
  PNG_SIGNATURE,
  PNG_WIDTH,
  pixelOf,
  readPng,
  rgbOf,
  test,
  type PreparedWorld,
} from './timelapseSeed';

// T4-37 (가) · AC-P2-17 2차 공유 몫: 로그인 재생 화면의 지금 달 PNG 내려받기 E1~E3 (docs/plans/T4-37.md 4.2).
// timelapseSeed의 worker fixture가 이 파일만의 새 _test DB와 API·Vite 서버를 띄운다. 응답을 지어내지 않는다.
// 내려받은 파일은 Chromium 실제 다운로드로 받고 PNG 머리·IHDR·픽셀을 직접 읽는다. 기대값은 준비 값에서 직접 적는다.
// 그림 크기 기대값은 계약 크기(700×656 CSS 픽셀, 배율 2)를 숫자로 적는다. 화면 변환 함수에서 가져오지 않는다.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

async function login(page: Page) {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
}

const tabUrl = (world: PreparedWorld) => `/w/${world.id}/records?tab=timelapse`;
const panel = (page: Page) => page.getByRole('region', { name: '영토 재생', exact: true }).first();
const dateLine = (page: Page) => page.getByTestId('timelapse-date');
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });

async function fileNameOf(world: PreparedWorld, tick: number) {
  const { toGameDate } = await import('../packages/rules/src/index');
  const { year, month } = toGameDate(world.startYear, tick);
  return `opensamguk-${world.name}-${year}-${month}.png`;
}

async function downloadShown(page: Page) {
  const waiting = page.waitForEvent('download');
  await button(page, '이 달 그림 내려받기').click();
  return waiting;
}

test('E1 로그인 재생 화면에서 셋째 달로 가서 내려받으면 실제 PNG 파일이 계약 크기로 내려온다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  await login(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  await button(page, '다음').click();
  await button(page, '다음').click();
  await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[2]!)} (3/35)`);

  const download = await downloadShown(page);
  expect(download.suggestedFilename()).toBe(await fileNameOf(a, a.ticks[2]!));
  const png = await readPng(download);
  expect(png.signature).toEqual(PNG_SIGNATURE);
  expect(png.chunk).toBe('IHDR');
  expect([png.width, png.height]).toEqual([PNG_WIDTH, PNG_HEIGHT]);
  expect(png.bytes.length).toBeGreaterThan(0);
  await expect(panel(page).getByTestId('timelapse-download-message')).toHaveCount(0);
});

test('E8 국가 16개와 공백지의 범례를 모두 그린 PNG는 1400×1352이고 마지막 범례와 꼬리말이 잘리지 않는다', async ({
  page,
}) => {
  type TextDraw = {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    right: number;
    ascent: number;
    descent: number;
  };
  await page.addInitScript(() => {
    const observed: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      left: number;
      right: number;
      ascent: number;
      descent: number;
    }> = [];
    Object.defineProperty(window, '__t437TextDraws', { value: observed });
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      const metrics = this.measureText(text);
      observed.push({
        text,
        x,
        y,
        width: this.canvas.width,
        height: this.canvas.height,
        left: metrics.actualBoundingBoxLeft,
        right: metrics.actualBoundingBoxRight,
        ascent: metrics.actualBoundingBoxAscent,
        descent: metrics.actualBoundingBoxDescent,
      });
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
  });
  const world = await withE2eDb(createLegendWorld);
  await login(page);
  const response = await query<{
    items: Array<{ nations: Array<{ id: number; name: string; color: string }>; cities: unknown[] }>;
  }>(page, 'timelapse.frames', { worldId: world.id });
  expect(response.items[0]!.nations).toEqual(LEGEND_NATIONS);
  expect(response.items[0]!.cities).toHaveLength(17);
  await page.goto(tabUrl(world));
  await expect(dateLine(page)).toContainText('(1/1)');
  const download = await downloadShown(page);
  await download.saveAs(test.info().outputPath('legend-16.png'));
  const png = await readPng(download);
  expect(png.signature).toEqual(PNG_SIGNATURE);
  expect(png.chunk).toBe('IHDR');
  expect([png.width, png.height]).toEqual([1400, 1352]);
  const drawn = await page.evaluate(() => (window as Window & { __t437TextDraws: TextDraw[] }).__t437TextDraws);
  await test.info().attach('png-text-draws', { body: JSON.stringify(drawn), contentType: 'application/json' });
  const note = '국가 이름과 색은 그 달에 기록된 값입니다. 오픈삼국';
  expect(drawn.map(({ text }) => text)).toEqual([
    `${world.name} · ${await dateOf(world, 10_000)}`,
    ...LEGEND_NATIONS.map(({ name }) => `${name} 1`),
    '공백지 1',
    note,
  ]);
  expect(drawn.at(-3)).toMatchObject({ text: '범례국16 1', y: 622 });
  expect(drawn.at(-2)).toMatchObject({ text: '공백지 1', y: 642 });
  expect(drawn.at(-1)).toMatchObject({ text: note, y: 668 });
  for (const draw of drawn) {
    expect([draw.width, draw.height]).toEqual([1400, 1352]);
    expect(draw.x - draw.left).toBeGreaterThanOrEqual(0);
    expect(draw.x + draw.right).toBeLessThanOrEqual(700);
    expect(draw.y - draw.ascent).toBeGreaterThanOrEqual(0);
    expect(draw.y + draw.descent).toBeLessThanOrEqual(676);
  }
});

test('E2 내려받은 그림의 도시 점 색은 그 달 저장 국가 색이고 공백지는 공백지 색이며 멸망한 국가의 달은 그 달 저장 색이다', async ({
  page,
  timelapseStack,
}) => {
  const { a, p, pSaved } = timelapseStack.worlds;
  await login(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  await button(page, '다음').click();
  await button(page, '다음').click();
  // A의 셋째 달(k = 2): 도시 1은 국가 1(위 #000080), 도시 3은 공백지다 (timelapseSeed aFrame).
  const aPng = await readPng(await downloadShown(page));
  const one = await dotCenter(a.id, 1);
  const three = await dotCenter(a.id, 3);
  expect(await pixelOf(page, aPng.bytes, one.x, one.y)).toEqual(rgbOf('#000080'));
  expect(await pixelOf(page, aPng.bytes, three.x, three.y)).toEqual(rgbOf(NEUTRAL));

  // P의 첫 달: 국가 2는 그 뒤 실제 출병으로 멸망했다. 그림은 첫 정산에 저장된 색이다.
  await page.goto(tabUrl(p));
  await expect(panel(page).locator('[data-frame-tick="10000"]')).toBeVisible();
  const pPng = await readPng(await downloadShown(page));
  const two = await dotCenter(p.id, 2);
  expect(await pixelOf(page, pPng.bytes, two.x, two.y)).toEqual(rgbOf(pSaved.removed.color));
});

test('E3 기록 없는 달의 버튼은 점선이고 누르면 이유가 보이며 내려받기가 일어나지 않는다', async ({
  page,
  timelapseStack,
}) => {
  const { m } = timelapseStack.worlds;
  await login(page);
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.goto(tabUrl(m));
  await button(page, '다음').click();
  await expect(dateLine(page)).toContainText('국가 기록 없음');
  const blocked = button(page, '이 달 그림 내려받기');
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled인 안내 버튼도 실제 포인터로 누르면 막힌 이유를 알 수 있다.
  const target = await blocked.boundingBox();
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
  await expect(panel(page).getByText('국가 기록이 없는 달은 내려받을 수 없습니다.')).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(downloads).toHaveLength(0);
});
