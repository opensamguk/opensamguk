import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });
test('edits and round trips a campaign draft, retains invalid-file state, and previews directed routes', async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.goto('/dev/campaign-map-editor');
  await expect(page.getByRole('heading', { name: '통합 지도 편집기', exact: true })).toBeVisible();
  await expect(page.getByText('도시 53 · 관문 8 · 항구 6 · 전장 13 · 경로 0', { exact: true })).toBeVisible();
  await expect(page.getByTestId('route-preview')).toContainText('경로가 없습니다');
  await page.getByLabel('거점 이름', { exact: true }).fill('장안 시험');
  await page.getByLabel('X 좌표', { exact: true }).fill('250');
  await expect(page.getByTestId('city:4')).toHaveAttribute('transform', /translate\(250,/);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(page.getByLabel('X 좌표', { exact: true })).not.toHaveValue('250');
  await page.getByRole('button', { name: '다시 적용', exact: true }).click();
  await page.getByRole('button', { name: '두 거점 경로 추가', exact: true }).click();
  await expect(page.getByTestId('route-preview')).toContainText('1개 연결 구간');
  await page.getByRole('combobox', { name: '방향', exact: true }).selectOption('FORWARD');
  await page.getByRole('combobox', { name: '출발', exact: true }).selectOption('city:3');
  await page.getByRole('combobox', { name: '도착', exact: true }).selectOption('city:4');
  await expect(page.getByTestId('route-preview')).toContainText('경로가 없습니다');
  await page.getByRole('combobox', { name: '출발', exact: true }).selectOption('city:4');
  await page.getByRole('combobox', { name: '도착', exact: true }).selectOption('city:3');
  await page.getByRole('combobox', { name: '경로 도착', exact: true }).selectOption('city:4');
  await expect(page.getByRole('button', { name: 'JSON 내보내기', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '경로 도착', exact: true }).selectOption('city:3');
  // SVG coordinates stay correct after zoom; pointer interaction uses the real canvas matrix.
  await page.getByRole('button', { name: '확대', exact: true }).click();
  await page.getByRole('combobox', { name: '편집 대상', exact: true }).selectOption('city:4');
  const center = await page.getByTestId('city:4').evaluate((el) => {
    const p = new DOMPoint(0, 0).matrixTransform((el as SVGGraphicsElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 30, center.y + 20, { steps: 3 });
  await page.mouse.up();
  const movedX = Number(await page.getByLabel('X 좌표', { exact: true }).inputValue());
  expect(movedX).toBeGreaterThan(250);
  await page.getByRole('button', { name: '전체 보기', exact: true }).click();
  await page.getByRole('combobox', { name: '도구', exact: true }).selectOption('terrain');
  const canvas = page.getByRole('img', { name: '통합 지도 캔버스' });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  for (const [x, y] of [
    [0.05, 0.05],
    [0.15, 0.05],
    [0.1, 0.15],
  ])
    await page.mouse.click(box!.x + box!.width * x!, box!.y + box!.height * y!);
  await page.getByRole('button', { name: '지형 확정 (3점)', exact: true }).click();
  await expect(page.getByTestId('terrain:1')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, 'utf8');
  const draft = JSON.parse(text);
  expect(draft.sites).toHaveLength(80);
  expect(draft.routes[0].direction).toBe('FORWARD');
  expect(draft.routes[0]).not.toHaveProperty('distanceKm');
  expect(draft.terrain).toHaveLength(1);
  await page
    .getByLabel('v3 파일 불러오기', { exact: true })
    .setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":2}') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('terrain:1')).toBeVisible();
  await page
    .getByLabel('v3 파일 불러오기', { exact: true })
    .setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('terrain:1')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('campaign-editor.png'), fullPage: true });
  expect(failures).toEqual([]);
});

test('edits a water route; city deletion removes dependent port links and undo restores them', async ({ page }) => {
  await page.goto('/dev/campaign-map-editor');
  await page.getByRole('combobox', { name: '출발', exact: true }).selectOption('port:13');
  await page.getByRole('combobox', { name: '도착', exact: true }).selectOption('port:52');
  await page.getByRole('button', { name: '두 거점 경로 추가', exact: true }).click();
  await page.getByRole('combobox', { name: '이동 방식', exact: true }).selectOption('RIVER');
  await expect(page.getByTestId('route-preview')).toContainText('경로가 없습니다');
  await page.getByLabel('수로 포함', { exact: true }).check();
  await expect(page.getByTestId('route-preview')).toContainText('1개 연결 구간');
  await page.getByRole('combobox', { name: '편집 대상', exact: true }).selectOption('city:13');
  await page.getByRole('button', { name: '선택 삭제', exact: true }).click();
  await expect(page.getByTestId('port:13')).toHaveCount(0);
  await expect(page.getByText('도시 52 · 관문 8 · 항구 5 · 전장 13 · 경로 0', { exact: true })).toBeVisible();
  await expect(page.getByText('52도시 초안', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(page.getByTestId('port:13')).toBeVisible();
  await expect(page.getByText('도시 53 · 관문 8 · 항구 6 · 전장 13 · 경로 1', { exact: true })).toBeVisible();
});

test('renders the GIS basemap and all site kinds with the same coordinate controls', async ({ page }, testInfo) => {
  await page.goto('/dev/campaign-map-editor');
  await expect(page.getByTestId('geographic-basemap')).toBeVisible();
  await expect(page.getByTestId('geographic-basemap').locator('path').first()).toHaveAttribute('fill-opacity', '0');
  await expect(page.getByTestId('geographic-relief')).toBeVisible();
  for (const [kind, count] of [
    ['city', 53],
    ['pass', 8],
    ['port', 6],
    ['field', 13],
  ] as const)
    await expect(page.getByTestId(`site-icon-${kind}`)).toHaveCount(count);
  expect(
    await page
      .getByTestId('site-icon-city')
      .first()
      .evaluate((el) => getComputedStyle(el).imageRendering),
  ).toBe('pixelated');
  await expect(page.getByTestId('city:4')).toBeVisible();
  await expect(page.getByTestId('pass:75')).toBeVisible();
  await page.getByRole('combobox', { name: '편집 대상', exact: true }).selectOption('pass:75');
  await expect(page.getByLabel('X 좌표', { exact: true })).toBeVisible();
  await expect(page.getByText(/지리 좌표 미확인|현대 도시 기준/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('geographic-editor.png'), fullPage: true });
  await page.getByRole('combobox', { name: '도구', exact: true }).selectOption('site');
  const canvas = page.getByRole('img', { name: '통합 지도 캔버스' });
  await canvas.click({ position: { x: 10, y: 10 } });
  await expect(page.getByTestId('city:custom-1')).toBeVisible();
  await expect(page.getByText('54도시 초안', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: '도구', exact: true }).selectOption('site');
  await page.getByRole('combobox', { name: '새 거점 종류', exact: true }).selectOption('PORT');
  await canvas.click({ position: { x: 40, y: 40 } });
  await expect(page.getByTestId('port:custom-1')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '소속 도시', exact: true })).toHaveValue('city:custom-1');
  // With a port selected, the next port must use the nearest city instead.
  await page.getByRole('combobox', { name: '도구', exact: true }).selectOption('site');
  await canvas.click({ position: { x: 15, y: 15 } });
  await expect(page.getByTestId('port:custom-2')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '소속 도시', exact: true })).toHaveValue('city:custom-1');
});
