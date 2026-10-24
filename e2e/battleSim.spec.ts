import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { simulateBattle, unitSetSchema } from '../packages/rules/src/index';
import { createRng } from '../packages/shared/src/index';
import { appOrigin, createAccount } from './account';
import { e2eWorld, setTurns, waitTurnWindow } from './game';
import { bindGeneral, query } from './world';

// T4-34 · AC-P2-16 일부: 실제 Chromium에서 전투 시뮬레이터가 진짜 Web Worker로 simulateBattle을 한 번 실행하는지 본다.
// 기대값은 손으로 적지 않고 Node에서 같은 packages/rules의 simulateBattle과 resources/unitset/basic.json으로 계산한다.
// 실제 PostgreSQL은 로그인과 메인 초안 경로에만 쓴다. 시뮬레이터는 서버를 부르지 않는다.

const STORAGE = 'test-results/t4-34-battle-sim-storage.json';
const ctx = { worldId: '' };
const unitSet = unitSetSchema.parse(
  JSON.parse(readFileSync(new URL('../resources/unitset/basic.json', import.meta.url), 'utf8')),
);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL: appOrigin(), storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await createAccount(page);
  ctx.worldId = await e2eWorld(page);
  const { user } = await query<{ user: { id: string } }>(context.request, 'auth.me');
  await bindGeneral(ctx.worldId, user.id);
  // pnpm dev는 Worker가 처음 import하는 의존성(rules의 zod 등)을 첫 요청 때 최적화하고 화면을 다시 읽을 수 있다.
  // 시험 본문이 그 재읽기에 걸리지 않도록 진짜 Worker로 한 번 계산해 둔다. 빌드 묶음에는 이 단계가 없다.
  await page.goto(`/w/${ctx.worldId}/simulator`);
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(page.getByRole('heading', { level: 1, name: '전투 시뮬레이터' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '실행', exact: true }).click();
    const done = await expect(page.getByTestId('battle-result'))
      .toHaveAttribute('data-state', 'done', { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (done) break;
  }
  await expect(page.getByTestId('battle-result')).toHaveAttribute('data-state', 'done');
  await context.storageState({ path: STORAGE });
  await context.close();
});

test.use({ storageState: STORAGE });

type Force = { crew: number; crewType: number; train: number; atmos: number };
type Case = {
  seed: string;
  attacker: Force;
  defender: Force;
  attackerTech: number;
  defenderTech: number;
  defence?: number;
};

const GENERAL_CASE: Case = {
  seed: 'e2e-장수',
  attacker: { crew: 4321, crewType: 1300, train: 80, atmos: 70 },
  defender: { crew: 3456, crewType: 1200, train: 60, atmos: 90 },
  attackerTech: 1500,
  defenderTech: 300,
};
const WALL_CASE: Case = {
  seed: 'e2e-성벽',
  attacker: { crew: 5000, crewType: 1100, train: 90, atmos: 85 },
  defender: { crew: 2500, crewType: 1000, train: 100, atmos: 100 },
  attackerTech: 0,
  defenderTech: 2000,
  defence: 1800,
};

function expected(c: Case) {
  const { seed, ...input } = c;
  return simulateBattle({ ...input, unitSet }, createRng(seed));
}

const group = (page: Page, name: '공격' | '수비') => page.getByRole('group', { name, exact: true });
const box = (page: Page, side: '공격' | '수비', name: string) =>
  group(page, side).getByRole('textbox', { name, exact: true });
const result = (page: Page) => page.getByTestId('battle-result');
// GameLayout이 원래 부르는 조회. 위쪽 띠의 세 조회와 메시지 단추의 안 읽음 수(MessageDock), 국가 공지 팝업(NationNotice)이다.
// 둘 다 권한 값이 정해지거나 SSE ready로 전체를 다시 받을 때 다시 묻는다. 시뮬레이터가 더하는 요청은 없어야 한다.
const TOPBAR_QUERIES = ['auth.me', 'home.get', 'world.summary', 'message.unread', 'notice.nation.get'];

async function openSimulatorFromMenu(page: Page) {
  await page.goto(`/w/${ctx.worldId}`);
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '전투 시뮬레이터' }).click();
  await expect(page).toHaveURL(`/w/${ctx.worldId}/simulator`);
  await expect(page.getByRole('heading', { level: 1, name: '전투 시뮬레이터' })).toBeVisible();
}

async function fillCase(page: Page, c: Case) {
  await group(page, '공격').getByRole('combobox', { name: '병종' }).selectOption(String(c.attacker.crewType));
  await box(page, '공격', '병력').fill(String(c.attacker.crew));
  await box(page, '공격', '훈련').fill(String(c.attacker.train));
  await box(page, '공격', '사기').fill(String(c.attacker.atmos));
  await box(page, '공격', '기술').fill(String(c.attackerTech));
  if (c.defence === undefined) {
    await group(page, '수비').getByRole('radio', { name: '장수' }).check();
    await group(page, '수비').getByRole('combobox', { name: '병종' }).selectOption(String(c.defender.crewType));
    await box(page, '수비', '병력').fill(String(c.defender.crew));
    await box(page, '수비', '훈련').fill(String(c.defender.train));
    await box(page, '수비', '사기').fill(String(c.defender.atmos));
  } else {
    await group(page, '수비').getByRole('radio', { name: '성벽' }).check();
    await box(page, '수비', '성벽').fill(String(c.defender.crew));
    await box(page, '수비', '수비').fill(String(c.defence));
  }
  await box(page, '수비', '기술').fill(String(c.defenderTech));
  await page.getByRole('textbox', { name: '시드', exact: true }).fill(c.seed);
}

async function shown(page: Page) {
  if ((await result(page).getAttribute('data-state')) !== 'done') return null;
  const read = async (side: 'attacker' | 'defender', row: 'crew' | 'atmos') =>
    Number(
      await result(page)
        .getByTestId(`result-${side}`)
        .locator(`tr[data-row="${row}"] td[data-value]`)
        .getAttribute('data-value'),
    );
  return {
    seed: await result(page).getByTestId('result-seed').textContent(),
    unitSet: await result(page).getByTestId('result-unitset').textContent(),
    attacker: { crew: await read('attacker', 'crew'), atmos: await read('attacker', 'atmos') },
    defender: { crew: await read('defender', 'crew'), atmos: await read('defender', 'atmos') },
  };
}

function summary(c: Case) {
  const e = expected(c);
  return {
    seed: c.seed,
    unitSet: 'basic',
    attacker: { crew: e.attacker.crew, atmos: e.attacker.atmos },
    defender: { crew: e.defender.crew, atmos: e.defender.atmos },
  };
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
}

test('메뉴로 들어가 진짜 Worker가 계산한 결과가 Node의 simulateBattle과 같고 다시 실행해도 같다', async ({ page }) => {
  const workers: Worker[] = [];
  page.on('worker', (w) => workers.push(w));
  await openSimulatorFromMenu(page);
  // 시뮬레이터는 tRPC를 부르지 않는다. 위쪽 띠가 원래 부르는 조회(1분 턴이 바뀌면 다시 받는다)만 허용한다.
  const trpc: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.includes('/trpc/')) trpc.push(path.replace(/^.*\/trpc\//, ''));
  });

  await fillCase(page, GENERAL_CASE);
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(() => shown(page), { timeout: 15_000 }).toEqual(summary(GENERAL_CASE));
  const first = await shown(page);
  expect(workers.some((w) => w.url().includes('battle.worker'))).toBe(true);
  await expect(result(page).getByTestId('result-stale')).toHaveCount(0);
  await shot(page, 't4-34-general-result.png');

  // 같은 값으로 다시 실행하면 시드와 숫자가 같다.
  await result(page).getByRole('button', { name: '같은 값으로 다시 실행' }).click();
  await expect.poll(() => shown(page)).toEqual(first);

  // 시드를 바꾸면 결과가 달라지는 입력. 기대값도 Node에서 다르게 나오는지 먼저 확인한다.
  const reseeded = { ...GENERAL_CASE, seed: 'e2e-장수-2' };
  expect(summary(reseeded)).not.toEqual({ ...summary(GENERAL_CASE), seed: reseeded.seed });
  await page.getByRole('textbox', { name: '시드', exact: true }).fill(reseeded.seed);
  await expect(result(page).getByTestId('result-stale')).toBeVisible();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(() => shown(page)).toEqual(summary(reseeded));

  // 성벽 교전 모양
  await fillCase(page, WALL_CASE);
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(() => shown(page)).toEqual(summary(WALL_CASE));
  await expect(result(page).getByTestId('result-defender')).toContainText('수비 1,800');
  await shot(page, 't4-34-wall-result.png');

  const procedures = trpc.flatMap((p) => p.split(','));
  expect(procedures.filter((p) => !TOPBAR_QUERIES.includes(p))).toEqual([]);
});

test('병력에 1.5·-1·10001·빈칸을 넣으면 이유가 보이고 실행은 점선이며 Worker가 생기지 않는다', async ({ page }) => {
  const workers: Worker[] = [];
  page.on('worker', (w) => workers.push(w));
  await openSimulatorFromMenu(page);
  const crew = box(page, '공격', '병력');
  const field = group(page, '공격').locator('[data-field="attacker.crew"]');
  for (const [value, reason] of [
    ['1.5', '정수로 넣어 주세요.'],
    ['-1', '1~10,000 사이로 넣어 주세요.'],
    ['10001', '1~10,000 사이로 넣어 주세요.'],
    ['', '값을 넣어 주세요.'],
  ] as const) {
    await crew.fill(value);
    await expect(field.locator('[data-problem="true"]')).toHaveText(reason);
    await expect(crew).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: '실행', exact: true })).toHaveCount(0);
    const dashed = page.getByRole('button', { name: '실행 (사용 불가)' });
    await expect(dashed).toHaveAttribute('data-unavailable', 'true');
    expect(await dashed.evaluate((el) => getComputedStyle(el).borderStyle)).toBe('dashed');
    await dashed.click();
    await expect(page.getByRole('note').filter({ hasText: '표시한 칸을 고치면' })).toBeVisible();
    await dashed.click();
  }
  await expect(result(page)).toHaveAttribute('data-state', 'idle');
  expect(workers.filter((w) => w.url().includes('battle.worker'))).toEqual([]);
});

test('Worker 파일을 못 받으면 오류와 다시 실행이 보이고 풀면 같은 결과가 나오며 메인으로 가면 Worker가 닫힌다', async ({
  page,
}) => {
  await openSimulatorFromMenu(page);
  await fillCase(page, GENERAL_CASE);
  await page.route('**/battle.worker*', (route) => route.abort());
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(result(page)).toHaveAttribute('data-state', 'error');
  await expect(result(page).getByRole('alert')).toContainText('계산 Worker를 실행하지 못했습니다.');
  await shot(page, 't4-34-worker-error.png');

  await page.unroute('**/battle.worker*');
  const workerPromise = page.waitForEvent('worker', (w) => w.url().includes('battle.worker'));
  await result(page).getByRole('button', { name: '다시 실행', exact: true }).click();
  const worker = await workerPromise;
  await expect.poll(() => shown(page)).toEqual(summary(GENERAL_CASE));

  const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '메인' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await closed;
});

test('계산 중에도 입력 칸은 막히지 않고 취소하면 대기로 돌아간다', async ({ page }) => {
  await openSimulatorFromMenu(page);
  // Worker 파일 응답을 잠시 붙잡아 계산 중 상태를 만든다.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/battle.worker*', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(result(page)).toHaveAttribute('data-state', 'running');
  await expect(result(page).getByRole('status')).toHaveText('계산 중');
  const seed = page.getByRole('textbox', { name: '시드', exact: true });
  await expect(seed).toBeEditable();
  await seed.fill('계산 중 입력');
  await expect(seed).toHaveValue('계산 중 입력');
  await result(page).getByRole('button', { name: '취소' }).click();
  await expect(result(page)).toHaveAttribute('data-state', 'idle');
  release();
  await page.unroute('**/battle.worker*');
});

test('메인의 저장하지 않은 편집은 시뮬레이터를 다녀와도 그대로다', async ({ page }) => {
  test.setTimeout(180_000);
  await waitTurnWindow(page, ctx.worldId, 45_000);
  await setTurns(page, ctx.worldId, []);
  await page.goto(`/w/${ctx.worldId}`);
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  const editor = page.getByRole('region', { name: '명령 목록', exact: true }).getByTestId('turn-editor');
  await expect(editor.locator('tr[data-slot="30"]')).toBeVisible();
  await editor.locator('tr[data-slot="1"]').click();
  await editor.getByLabel('명령 찾기').fill('농지 개간');
  await editor.getByRole('radio', { name: '농지 개간' }).check();
  await editor.getByRole('button', { name: '1번 칸에 넣기', exact: true }).click();
  await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  const storage = () => page.evaluate(() => JSON.stringify(Object.entries(sessionStorage).sort()));
  const before = await storage();
  expect(before).toContain('opensamguk.turnDraft.v1');

  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '전투 시뮬레이터' }).click();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(result(page)).toHaveAttribute('data-state', 'done');
  expect(await storage()).toBe(before);

  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '메인' }).click();
  await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  await expect(editor.locator('tr[data-slot="1"]')).toContainText('농지 개간');
  expect(await storage()).toBe(before);
  await shot(page, 't4-34-main-draft-kept.png');
});

test('375px 폭에서 시뮬레이터 본문이 넘치지 않고 누르는 대상은 44px 이상이다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/w/${ctx.worldId}/simulator`);
  await expect(page.getByRole('heading', { level: 1, name: '전투 시뮬레이터' })).toBeVisible();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(result(page)).toHaveAttribute('data-state', 'done');
  const section = page.getByRole('region', { name: '전투 시뮬레이터', exact: true });
  const size = await section.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.client);
  expect(size.right).toBeLessThanOrEqual(375);
  const targets = section.locator('input[type="text"], select, button');
  const count = await targets.count();
  expect(count).toBeGreaterThan(10);
  for (let i = 0; i < count; i++) {
    const rect = (await targets.nth(i).boundingBox())!;
    expect(rect.height, await targets.nth(i).evaluate((el) => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
  }
  for (const radio of await section.getByRole('radio').all()) {
    const label = (await radio.locator('xpath=..').boundingBox())!;
    expect(label.height).toBeGreaterThanOrEqual(44);
  }
  await shot(page, 't4-34-narrow.png');
});
