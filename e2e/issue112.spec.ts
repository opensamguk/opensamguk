import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createAccount } from './account';
import { createGeneralByApi, e2eWorld, query, setTurns, waitTurnWindow } from './game';

// GitHub #112 · T1-15 · AC-M1-19: 메인 오른쪽 좁은 명령 칸에서 바뀜 태그가 바/뀜 두 줄로 갈라지던 결함.
// main.spec.ts의 초안 시험은 이동 한 칸을 본다. 여기서는 긴 실제 인자(모병 수량·병종 번호)와 이름이 가장 긴 대상 도시로
// 태그를 실제 줄 상자로 재고, 명령·인자와 겹치거나 칸 밖으로 잘리지 않는지, 표 안 세로 스크롤과 메인 가로 넘침을 본다.
// 실제 서버·PostgreSQL·엔진(pnpm dev)과 Chromium을 쓴다. 저장은 하지 않는다 (저장은 main.spec.ts가 본다).

const editor = (page: Page) => page.getByRole('region', { name: '명령 목록', exact: true }).getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);

async function pick(page: Page, command: string) {
  await editor(page).getByLabel('명령 찾기').fill(command);
  await editor(page).getByRole('radio', { name: command }).check();
}

// 태그의 줄 상자 수와 같은 칸 안의 위치를 잰다. 겹침·잘림은 0.5px 넘게 어긋날 때만 센다.
async function tagLayout(page: Page, slot: number) {
  return row(page, slot)
    .getByText('바뀜', { exact: true })
    .evaluate((tag) => {
      const cell = tag.closest('td')!;
      const wrap = tag.closest('table')!.parentElement!;
      const box = tag.getBoundingClientRect();
      const cellBox = cell.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(tag);
      const others = [...cell.children].filter((el) => el !== tag);
      const inside = (r: DOMRect) => r.left >= cellBox.left - 0.5 && r.right <= cellBox.right + 0.5;
      return {
        lineBoxes: tag.getClientRects().length,
        textLines: text.getClientRects().length,
        overlapsCommandOrArgs: others.some((el) =>
          [...el.getClientRects()].some(
            (r) =>
              r.left < box.right - 0.5 &&
              box.left < r.right - 0.5 &&
              r.top < box.bottom - 0.5 &&
              box.top < r.bottom - 0.5,
          ),
        ),
        allInsideCell: [box, ...others.flatMap((el) => [...el.getClientRects()])].every(inside),
        tableScrollsSideways: wrap.scrollWidth > wrap.clientWidth,
        tableScrollsDown: wrap.scrollHeight > wrap.clientHeight && getComputedStyle(wrap).overflowY === 'auto',
        pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
}

test('좁은 메인 명령 칸에서 긴 인자와 긴 대상 도시 이름에도 바뀜 태그가 한 줄이고 겹치거나 넘치지 않는다', async ({
  page,
}) => {
  test.setTimeout(200_000);
  await createAccount(page);
  const world = await e2eWorld(page);
  await createGeneralByApi(page, world);
  const map = await query<{ cities: Array<{ key: number; name: string }> }>(page, 'world.map', { worldId: world });
  const longest = map.cities.reduce((a, b) => (b.name.length > a.name.length ? b : a));
  // 다음 턴이 시험 도중에 실행되면 서버 목록이 당겨져 바뀜 칸이 달라진다. 여유가 있을 때 시작한다.
  await waitTurnWindow(page, world, 45_000);
  await setTurns(page, world, []);
  await page.goto(`/w/${world}`);
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await expect(row(page, 30)).toBeVisible();

  await row(page, 1).click();
  await pick(page, '모병');
  await editor(page).getByRole('spinbutton', { name: '수량' }).fill('1000000');
  await editor(page).getByRole('spinbutton', { name: '병종 번호' }).fill('1100');
  await editor(page).getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
  await editor(page).getByRole('button', { name: '선택 해제' }).click();
  await row(page, 2).click();
  await pick(page, '이동');
  await editor(page).getByRole('combobox', { name: '대상 도시' }).selectOption({ label: longest.name });
  await editor(page).getByRole('button', { name: '2번 칸에 넣기', exact: true }).click();
  await expect(row(page, 1)).toContainText('모병');
  await expect(row(page, 1)).toContainText('수량 1000000');
  await expect(row(page, 2)).toContainText(longest.name);
  await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 2건');

  // 단언하기 전에 그림과 잰 값을 남긴다. 고치기 전 코드에서 실패해도 같은 순간의 화면을 비교할 수 있다.
  const layouts = [await tagLayout(page, 1), await tagLayout(page, 2)];
  writeFileSync(test.info().outputPath('issue112-layout.json'), JSON.stringify({ city: longest.name, layouts }));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath('issue112-main-long-args.png'), fullPage: true });
  await page
    .getByRole('region', { name: '명령 목록', exact: true })
    .screenshot({ path: test.info().outputPath('issue112-command-region.png') });
  for (const layout of layouts)
    expect(layout).toEqual({
      lineBoxes: 1,
      textLines: 1,
      overlapsCommandOrArgs: false,
      allInsideCell: true,
      tableScrollsSideways: false,
      tableScrollsDown: true,
      pageScrollsSideways: false,
    });
});
