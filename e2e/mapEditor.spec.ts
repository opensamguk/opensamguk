import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';

// T4-80 · AC-P2-27 일부: 지도 편집 캔버스 한 흐름. 서버를 부르지 않는다 (개발 화면 /dev/map-editor).
// che 불러오기 → 도시 추가·끌어서 이동·삭제 → 연결 → 강 그리기 → 검증 오류 → 고치기 → v2 내려받기 → 다시 불러와 같음.
// T4-77이 resources/map/che.json을 지우면 이 입력을 DB에서 내보낸 che로 바꾼다 (docs/plans/T4-80.md).
const CHE_PATH = new URL('../resources/map/che.json', import.meta.url).pathname;
type Che = { cities: Array<{ id: number; name: string; position: { x: number; y: number }; connections: number[] }> };
const che = JSON.parse(readFileSync(CHE_PATH, 'utf8')) as Che;
type Exported = Che & { version: number; terrain: { rivers: Array<{ points: number[][] }> } };

// 도시와 겹치지 않는 빈자리. 도시에서 가장 먼 격자점부터 서로 40 이상 떨어진 것을 고른다.
function emptySpots(count: number): Array<[number, number]> {
  const candidates: Array<{ p: [number, number]; d: number }> = [];
  for (let x = 30; x <= 670; x += 10)
    for (let y = 30; y <= 470; y += 10) {
      const d = Math.min(...che.cities.map((c) => Math.hypot(c.position.x - x, c.position.y - y)));
      candidates.push({ p: [x, y], d });
    }
  candidates.sort((a, b) => b.d - a.d);
  const picked: Array<[number, number]> = [];
  for (const { p } of candidates) {
    if (picked.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= 40)) picked.push(p);
    if (picked.length === count) break;
  }
  return picked;
}

// 캔버스 전체가 창 안에 들어와야 좌표로 누를 수 있다. 기본 1280×720은 캔버스 아래가 잘린다.
test.use({ viewport: { width: 1600, height: 1200 } });

async function screen(page: Page, x: number, y: number) {
  return page.getByTestId('map-editor-canvas').evaluate(
    (svg, [mx, my]) => {
      const p = new DOMPoint(mx, my).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
      return { x: p.x, y: p.y };
    },
    [x, y] as const,
  );
}
async function clickMap(page: Page, x: number, y: number) {
  const p = await screen(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function dragMap(page: Page, from: [number, number], to: [number, number]) {
  const a = await screen(page, ...from);
  const b = await screen(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}
async function downloadOf(page: Page, name: string): Promise<{ download: Download; path: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name }).click()]);
  return { download, path: (await download.path())! };
}
const tool = (page: Page, name: string) =>
  page.getByRole('group', { name: '도구' }).getByRole('button', { name, exact: true }).click();
const issues = (page: Page) => page.getByTestId('issues');

test('che를 불러와 고치고 v2로 내보낸 뒤 다시 불러오면 같다', async ({ page }) => {
  test.setTimeout(120_000);
  const [spotA, spotA2, spotB, ...riverSpots] = emptySpots(6) as [
    [number, number],
    [number, number],
    [number, number],
    ...Array<[number, number]>,
  ];
  const up = che.cities[0]!;
  expect(up.name).toBe('업');

  await page.goto('/dev/map-editor');
  await expect(page.getByRole('heading', { level: 1, name: '지도 편집기' })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('map-file').setInputFiles(CHE_PATH);
  await expect(page.getByTestId('map-meta')).toContainText('도시 94개');
  await expect(page.getByTestId('map-meta')).toContainText('불러온 형식 지금 형식');
  await expect(issues(page).getByRole('heading')).toHaveText('검증 0건');

  // 도시 추가: 연결이 없어 연결망 오류가 난다.
  await tool(page, '도시 추가');
  await clickMap(page, ...spotA);
  await expect(page.getByTestId('map-meta')).toContainText('도시 95개');
  const panel = page.getByTestId('city-panel');
  await expect(panel.getByLabel('이름')).toHaveValue('새 도시 95');
  await expect(panel).toContainText(`좌표 (${spotA[0]}, ${spotA[1]})`);
  await expect(issues(page).locator('[data-code="network-split"]')).toHaveCount(1);

  // 끌어서 이동
  await tool(page, '선택');
  await dragMap(page, spotA, spotA2);
  await expect(panel).toContainText(`좌표 (${spotA2[0]}, ${spotA2[1]})`);
  await expect(page.locator('[data-city-id="95"] circle').last()).toHaveAttribute('cx', String(spotA2[0]));

  // 두 번째 도시를 만들어 업과 잇고 삭제한다. 업의 연결에서도 빠져야 한다.
  await tool(page, '도시 추가');
  await clickMap(page, ...spotB);
  await expect(panel.getByLabel('이름')).toHaveValue('새 도시 96');
  await tool(page, '연결');
  await clickMap(page, ...spotB);
  await clickMap(page, up.position.x, up.position.y);
  await expect(panel.getByLabel('이름')).toHaveValue('업');
  await expect(panel.getByRole('button', { name: '새 도시 96 연결 끊기' })).toBeVisible();
  await page.getByLabel('도시 찾기').selectOption({ label: '새 도시 96 (ID 96)' });
  await panel.getByRole('button', { name: '도시 삭제' }).click();
  await expect(page.getByTestId('map-meta')).toContainText('도시 95개');
  await expect(page.locator('[data-city-id="96"]')).toHaveCount(0);

  // 연결: 새 도시를 업과 이으면 연결망 오류가 사라진다.
  await clickMap(page, ...spotA2);
  await clickMap(page, up.position.x, up.position.y);
  await page.getByLabel('도시 찾기').selectOption({ label: '새 도시 95 (ID 95)' });
  await expect(panel.getByRole('heading', { name: '연결 1개' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '업 연결 끊기' })).toBeVisible();
  await expect(issues(page).getByRole('heading')).toHaveText('검증 0건');

  // 강 하나 그리기
  await tool(page, '강');
  for (const spot of riverSpots) await clickMap(page, ...spot);
  await expect(page.getByRole('group', { name: '그리기' })).toContainText('강 점 3개');
  await page.getByRole('button', { name: '그리기 마치기' }).click();
  await expect(page.getByTestId('terrain-panel')).toContainText('강 1 · 점 3개');
  await expect(page.locator('[data-layer="rivers"] [data-shape-index="0"]')).toHaveCount(1);

  // 검증 오류: 새 도시 이름을 업으로 바꾸면 이름이 겹친다. 오류를 누르면 그 도시를 고른다.
  await tool(page, '선택');
  await page.getByLabel('도시 찾기').selectOption({ label: '새 도시 95 (ID 95)' });
  await panel.getByLabel('이름').fill('업');
  await panel.getByLabel('이름').press('Enter');
  const duplicate = issues(page).locator('[data-code="city-name-duplicate"]');
  await expect(duplicate).toHaveText('오류 도시 이름 업이 ID 1과 ID 95에 겹칩니다.');
  await page.getByLabel('도시 찾기').selectOption('');
  await expect(panel).toHaveCount(0);
  await duplicate.click();
  await expect(panel).toContainText('도시 ID 95');

  // 되돌리기·다시 하기를 거쳐 고친다.
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(panel.getByLabel('이름')).toHaveValue('새 도시 95');
  await expect(issues(page).getByRole('heading')).toHaveText('검증 0건');
  await page.getByRole('button', { name: '다시 하기', exact: true }).click();
  await expect(duplicate).toHaveCount(1);
  await panel.getByLabel('이름').fill('신도');
  await panel.getByLabel('이름').press('Enter');
  await expect(issues(page).getByRole('heading')).toHaveText('검증 0건');

  // v2 내려받기
  const first = await downloadOf(page, 'v2 JSON 내려받기');
  expect(first.download.suggestedFilename()).toBe('che-v2.json');
  const text = readFileSync(first.path, 'utf8');
  const exported = JSON.parse(text) as Exported;
  expect(exported.version).toBe(2);
  expect(exported.cities).toHaveLength(95);
  const added = exported.cities.find((c) => c.id === 95)!;
  expect(added).toMatchObject({ name: '신도', position: { x: spotA2[0], y: spotA2[1] }, connections: [1] });
  expect(exported.cities[0]!.connections).toEqual([...up.connections, 95]);
  expect(exported.cities.some((c) => c.id === 96 || c.connections.includes(96))).toBe(false);
  expect(exported.terrain.rivers).toEqual([{ points: riverSpots }]);

  // 다시 불러와 다시 내려받으면 글자열이 같다.
  await page.getByTestId('map-file').setInputFiles(first.path);
  await expect(page.getByTestId('map-meta')).toContainText('불러온 형식 v2');
  await expect(page.getByTestId('map-meta')).toContainText('도시 95개');
  await expect(issues(page).getByRole('heading')).toHaveText('검증 0건');
  const second = await downloadOf(page, 'v2 JSON 내려받기');
  expect(readFileSync(second.path, 'utf8')).toBe(text);

  // 밑그림 PNG: 2100×1500 팔레트 PNG, 팔레트 5칸
  const sketch = await downloadOf(page, '밑그림 PNG 내려받기');
  expect(sketch.download.suggestedFilename()).toBe('che-sketch.png');
  const png = readFileSync(sketch.path);
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([2100, 1500, 8, 3]);
  expect(png.subarray(37, 41).toString('latin1')).toBe('PLTE');
  expect(png.readUInt32BE(33)).toBe(15);
});

test('모양이 틀린 파일은 이유와 함께 거부한다', async ({ page }) => {
  await page.goto('/dev/map-editor');
  await page
    .getByTestId('map-file')
    .setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.getByRole('alert')).toHaveText(
    '지도 파일을 불러오지 못했습니다 (broken.json). JSON으로 읽을 수 없는 파일입니다.',
  );
  await expect(page.getByText('불러온 지도가 없습니다')).toBeVisible();
});
