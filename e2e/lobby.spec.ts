import { spawnSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { createAccount, e2eDatabaseUrl, newEmail, TEST_PASSWORD } from './account';
import { createGeneralByApi, e2eWorld, query } from './game';

// T2-04 · AC-M2-02: 로비에서 월드 목록을 보고 참가한다. 실제 서버·DB·엔진으로 돈다.
// lobby.worlds·lobby.notices(T2-03)가 main에 들어오기 전에는 이 파일의 결과를 증거로 세지 않는다.
// 그래서 로비 목록을 부르는 네 시험은 test.fixme로 보류한다. T2-03이 병합되면 test로 되돌린다 (docs/plans/T2-04.md).
// 로그인 뒤 이동 묶음은 로비 API 없이 돌아 그대로 실행한다.
// D-025(가오픈 생성·총정원)는 승인 전이라 승인 전 모습만 시험한다.

type LobbyWorld = { id: string; name: string; status: string; startedAt: string | null };

function run(args: string[]): string {
  e2eDatabaseUrl();
  const result = spawnSync('pnpm', ['-s', ...args], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} 실패: ${result.stderr}`);
  return result.stdout;
}

// 상태별 시험 월드. 만든 직후는 PREOPEN이다.
function createWorld(name: string): string {
  const out = run([
    'world:create',
    '--scenario',
    '1030',
    '--map',
    'che',
    '--seed',
    `e2e-lobby-${Date.now()}`,
    '--turn-term',
    '60',
    '--end-year',
    '300',
    '--name',
    name,
  ]);
  return (JSON.parse(out.trim().split('\n').at(-1)!) as { worldId: string }).worldId;
}

const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });

async function login(page: Page, email: string) {
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
}

test.fixme('로그인 → 로비 → 장수 만들기 → 메인 → 로비로 돌아오면 들어가기', async ({ page }) => {
  test.setTimeout(120_000);
  const email = await createAccount(page);
  const world = await e2eWorld(page);
  const worlds = await query<LobbyWorld[]>(page, 'lobby.worlds', {});
  const name = worlds.find((w) => w.id === world)!.name;
  await page.context().clearCookies();

  await page.goto('/login');
  await login(page, email);
  await expect(page).toHaveURL('/lobby');
  const target = card(page, name);
  await expect(target.getByText('진행 중')).toBeVisible();
  await expect(target.getByText('내 장수 없음')).toBeVisible();
  await target.getByRole('link', { name: '장수 만들기' }).click();
  await expect(page).toHaveURL(`/w/${world}/create`);

  // 생성 폼은 T1-11 시험이 본다. 여기서는 같은 API로 만들고 로비로 돌아오는 길만 본다.
  const general = await createGeneralByApi(page, world);
  await page.goto(`/w/${world}`);
  await expect(page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await page.getByRole('link', { name: '로비', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
  await expect(target.getByText(`내 장수: ${general.name} (재야)`)).toBeVisible();
  await target.getByRole('link', { name: '들어가기' }).click();
  await expect(page).toHaveURL(`/w/${world}`);
});

test.fixme('가오픈 월드는 승인 전이라 막힌 장수 만들기와 이유, 시작 전을 보인다', async ({ page }) => {
  test.setTimeout(120_000);
  await createAccount(page);
  const name = `E2E 가오픈 ${Date.now() % 100_000}`;
  createWorld(name);
  await page.goto('/lobby');
  const target = card(page, name);
  await expect(target.getByText('가오픈')).toBeVisible();
  await expect(target.getByText(/시작 전$/)).toBeVisible();
  await expect(target.getByRole('link')).toHaveCount(0);
  await target.getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ }).click();
  await expect(target.getByRole('note')).toHaveText('아직 열리지 않은 월드입니다');
});

test.fixme('상태 글자와 색: 진행 중·가오픈·멈춤, 끝난 월드는 기본으로 숨긴다', async ({ page }) => {
  test.setTimeout(180_000);
  await createAccount(page);
  await e2eWorld(page);
  const paused = `E2E 멈춤 ${Date.now() % 100_000}`;
  const id = createWorld(paused);
  run(['world:start', '--world', id]);
  run(['world:pause', '--world', id]);
  await page.goto('/lobby');
  await expect(page.getByText('진행 중').first()).toHaveAttribute('data-tone', 'accent');
  const target = card(page, paused);
  await expect(target.getByText('멈춤')).toHaveAttribute('data-tone', 'warning');
  await target.getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ }).click();
  await expect(target.getByRole('note')).toHaveText('멈춘 월드입니다');
  await expect(page.getByText('끝남', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/t2-04-lobby.png', fullPage: true });
});

test.fixme('로그인하지 않아도 목록을 보고 로그인하고 참가는 로그인 뒤 로비로 돌아온다', async ({ page }) => {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/lobby');
  await expect(page.getByRole('heading', { level: 1, name: '로비' })).toBeVisible();
  const join = page.getByRole('link', { name: '로그인하고 참가' }).first();
  await expect(join).toHaveAttribute('href', '/login?next=%2Flobby');
  await join.click();
  await expect(page).toHaveURL(/\/login\?next=%2Flobby$/);
  await login(page, email);
  await expect(page).toHaveURL('/lobby');
});

test.describe('로그인 뒤 이동', () => {
  for (const [next, expected] of [
    ['/w/1/turns', '/w/1/turns'],
    [null, '/lobby'],
    ['//evil.example', '/lobby'],
  ] as const) {
    test(`next=${next ?? '없음'} → ${expected}`, async ({ page }) => {
      const email = await createAccount(page, newEmail());
      await page.context().clearCookies();
      await page.goto(next === null ? '/login' : `/login?next=${encodeURIComponent(next)}`);
      await login(page, email);
      await expect(page).toHaveURL(expected);
      expect(new URL(page.url()).host).toBe('127.0.0.1:5173');
    });
  }
});
