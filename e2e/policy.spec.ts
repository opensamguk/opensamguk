import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createAccount } from './account';
import {
  createGeneralByApi,
  e2eWorld,
  idleWorld,
  releaseIdleWorld,
  startEngine,
  stubPortraits,
  waitTurnWindow,
} from './game';

// T2-14 · AC-M2-17 화면: 메인의 기본 방침 고르기와 30칸 편집기의 빈 칸 표시를 실제 서버·엔진으로 본다.
// T2-13(Codex)의 general.policy·general.setPolicy와 칸의 explicit이 main에 들어오기 전에는 돌리지 않는다.
// 그 전의 결과는 증거가 아니다. 들어오면 아래 건너뛰기를 지운다.
const hasPolicyApi = readFileSync(new URL('../apps/server/src/routers/general.ts', import.meta.url), 'utf8').includes(
  'setPolicy',
);
test.skip(!hasPolicyApi, 'T2-13 API(general.setPolicy)가 아직 없다');
test.describe.configure({ timeout: 200_000 });

const editor = (page: Page) => page.getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);
const policySelect = (page: Page) => page.getByTestId('policy-bar').getByLabel('기본 방침');

async function openMain(page: Page) {
  await createAccount(page);
  const world = await e2eWorld(page);
  await createGeneralByApi(page, world);
  await waitTurnWindow(page, world);
  await page.goto(`/w/${world}`);
  await expect(row(page, 30)).toBeVisible();
  return world;
}

async function putRest(page: Page, slot: number) {
  await row(page, slot).click();
  await editor(page).getByLabel('명령 찾기').fill('휴식');
  await editor(page).getByRole('radio', { name: '휴식' }).check();
  await editor(page)
    .getByRole('button', { name: `${slot}번 칸에 넣기` })
    .click();
  await row(page, slot).click();
}

test.beforeEach(async ({ page }) => stubPortraits(page));
test.afterAll(releaseIdleWorld);

test('고른 방침은 바로 보내지고 새로고침 뒤에도 남는다. 장수 정보에도 보인다', async ({ page }) => {
  await openMain(page);
  await policySelect(page).selectOption({ label: '권농' });
  await expect(page.getByTestId('policy-state')).toHaveText('바꿨습니다', { timeout: 30_000 });
  await page.reload();
  await expect(policySelect(page)).toHaveValue('farm');
  await expect(page.getByTestId('policy-sentence')).toHaveText('빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다.');
  await expect(page.locator('[data-main-area="general"]')).toContainText('권농');
});

test('빈 칸은 방침을 따라 흐리게, 직접 넣은 휴식은 진하게 보이고 저장·새로고침 뒤에도 그대로다', async ({ page }) => {
  await openMain(page);
  await putRest(page, 1);
  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(page).getByText('저장했습니다.')).toBeVisible();

  await page.reload();
  await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
  await expect(row(page, 1)).toContainText('휴식');
  await expect(row(page, 2)).toHaveAttribute('data-empty', 'true');
  await expect(row(page, 2)).toContainText('(빈 칸) 휴식');

  await policySelect(page).selectOption({ label: '중상' });
  await expect(page.getByTestId('policy-state')).toHaveText('바꿨습니다', { timeout: 30_000 });
  await expect(row(page, 2)).toContainText('(중상) 상업 투자');
  await expect(row(page, 1)).not.toContainText('상업 투자');
});

test('저장하지 않은 편집은 방침을 바꿔도 남고, 다른 탭 저장과 부딪히면 충돌 안내가 나온다', async ({
  page,
  context,
}) => {
  const world = await openMain(page);
  await putRest(page, 3);
  await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

  await policySelect(page).selectOption({ label: '치안' });
  await expect(page.getByTestId('policy-state')).toHaveText('바꿨습니다', { timeout: 30_000 });
  await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

  const other = await context.newPage();
  await other.goto(`/w/${world}`);
  await expect(row(other, 30)).toBeVisible();
  await putRest(other, 5);
  await editor(other).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(other).getByText('저장했습니다.')).toBeVisible();

  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(page).getByTestId('stale-alert')).toContainText('내 편집 1건은 버리지 않고 보관했습니다.');
});

test('엔진이 처리하기 전에는 처리 중이고, 엔진이 돌면 확정된다', async ({ page }) => {
  await createAccount(page);
  const world = await idleWorld(page);
  const stopCreate = await startEngine(world);
  await createGeneralByApi(page, world);
  await stopCreate();

  await page.goto(`/w/${world}`);
  await policySelect(page).selectOption({ label: '훈련' });
  await expect(page.getByTestId('policy-state')).toHaveText('처리 중', { timeout: 10_000 });
  await expect(policySelect(page)).toBeDisabled();

  const stop = await startEngine(world);
  try {
    await expect(page.getByTestId('policy-state')).toHaveText('바꿨습니다', { timeout: 30_000 });
    await expect(policySelect(page)).toHaveValue('drill');
  } finally {
    await stop();
  }
});

// 남은 검증(계획 T2-14 검증 표): 엔진 거절 시 이유와 원래 방침, manual 시계로 턴을 돌려 최근 기록에 방침 명령이 남는지.
// 둘 다 거절을 일으키는 방법과 manual 시계 도우미가 T2-13 구현에 있어야 쓸 수 있다.
