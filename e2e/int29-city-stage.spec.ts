import { expect, test } from '@playwright/test';
import { createAccount } from './account';
import { createGeneralByApi, e2eWorld, mine, mutate, newGeneralName, stubPortraits } from './game';

// INT-29 D-106: 게임 화면(?ui=map)의 첫 화면은 내 성 화면이다. 성 화면에만 맨 아래 명령 띠가 있고,
// 전체 지도로 가면 띠가 사라지고 예턴은 보기만 한다. 다시 성으로 돌아오면 띠가 돌아온다.
test('성 화면이 첫 화면이고 전체 지도와 오가며 명령 띠는 성 화면에만 있다', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await stubPortraits(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createAccount(page);
  // 로컬에서 엔진이 도는 월드를 고를 때 INT29_WORLD로 넘긴다. 없으면 기본 시험 월드.
  const world = process.env.INT29_WORLD ?? (await e2eWorld(page));
  if (process.env.INT29_WORLD) {
    // san10 정식 프리셋 월드는 다섯 능력(합 275)으로 만든다.
    await mutate(page, 'general.create', {
      worldId: world,
      name: newGeneralName(),
      sex: 'MALE',
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
      portraitId: null,
    });
    await expect.poll(async () => (await mine(page, world)).general, { timeout: 90_000 }).not.toBeNull();
  } else await createGeneralByApi(page, world);
  await page.goto(`/w/${world}?ui=map`);

  const stage = page.getByTestId('map-stage');
  await expect(stage).toHaveAttribute('data-view', 'city');
  await expect(page.getByTestId('city-scene').or(page.getByTestId('camp-scene'))).toBeVisible();
  await expect(page.getByRole('region', { name: '축소 지도' })).toBeVisible();
  // 가운데 성을 누르면 성 안 창이 뜬다(성 없는 거점이면 건너뛴다).
  const castle = page.getByTestId('city-castle');
  if (await castle.count()) {
    await castle.click();
    await expect(page.getByTestId('castle-window')).toBeVisible();
    await expect(page.getByRole('list', { name: '성 안에 지을 수 있는 건물' }).getByRole('listitem')).toHaveCount(16);
    await page.screenshot({ path: testInfo.outputPath('castle.png') });
    await page.getByTestId('castle-window').getByRole('button', { name: '닫기' }).click();
  }
  // 아군 성(서버 land가 있을 때)이면 성 밖 자리를 눌러 건설 창을 연다. 재야 장수는 자리 단추가 없다.
  const lots = page.getByTestId('city-lots').getByRole('button');
  if (await lots.count()) {
    // 맨 위 자리는 위쪽 띠에 가릴 수 있어 클릭 이벤트를 바로 보낸다.
    await lots.first().dispatchEvent('click');
    const lotWindow = page.getByTestId('lot-window');
    await expect(lotWindow).toBeVisible();
    await expect(lotWindow.getByRole('list', { name: '성 밖에 지을 수 있는 건물' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('lot.png') });
    await lotWindow.getByRole('button', { name: '닫기' }).click();
  }
  const band = page.getByTestId('stage-band');
  await expect(band.getByRole('group', { name: '명령 분류' })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('city.png') });

  await page.getByTestId('stage-view').click();
  await expect(stage).toHaveAttribute('data-view', 'overview');
  await expect(page.getByTestId('stage-band')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '명령 분류' })).toHaveCount(0);
  await expect(page.getByLabel('내 예턴 앞 다섯 칸')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview.png') });

  await page.getByRole('button', { name: /^내 성으로/ }).click();
  await expect(stage).toHaveAttribute('data-view', 'city');
  await expect(page.getByTestId('stage-band').getByRole('group', { name: '명령 분류' })).toBeVisible();
});
