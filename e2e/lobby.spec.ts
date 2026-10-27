import { spawnSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { pnpmCli } from '../tools/node-cli';
import { appOrigin, createAccount, e2eDatabaseUrl, newEmail, TEST_PASSWORD, withE2eDb } from './account';
import { createGeneralByApi, e2eWorld, query } from './game';

// T2-04 · AC-M2-02: 로비에서 월드 목록을 보고 참가한다. 실제 서버·DB·엔진으로 돈다.
// D-025(가오픈 생성·총정원)는 승인 전이라 승인 전 모습만 시험한다.

type LobbyWorld = { id: string; name: string; status: string; startedAt: string | null };

function run(args: string[]): string {
  e2eDatabaseUrl();
  const result = spawnSync(...pnpmCli(['-s', ...args]), { encoding: 'utf8', env: process.env });
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
// 상태 배지는 글자가 정확히 같은 칸 하나다. 부분 일치로 찾으면 상태 글자가 든 월드 이름(h3)까지 잡는다.
const badge = (scope: Page | Locator, text: string) => scope.getByText(text, { exact: true });

async function login(page: Page, email: string) {
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
}

test('로그인 → 로비 → 장수 만들기 → 메인 → 로비로 돌아오면 들어가기', async ({ page }) => {
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
  await expect(badge(target, '진행 중')).toBeVisible();
  await expect(badge(target, '진행 중')).toHaveAttribute('data-tone', 'accent');
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

test('가오픈 월드는 승인 전이라 막힌 장수 만들기와 이유, 시작 전을 보인다', async ({ page }) => {
  test.setTimeout(120_000);
  await createAccount(page);
  const name = `E2E 가오픈 ${Date.now() % 100_000}`;
  createWorld(name);
  await page.goto('/lobby');
  const target = card(page, name);
  await expect(badge(target, '가오픈')).toBeVisible();
  await expect(badge(target, '가오픈')).toHaveAttribute('data-tone', 'info');
  await expect(target.getByRole('heading', { level: 3 })).toHaveText(name);
  await expect(target.getByText(/시작 전$/)).toBeVisible();
  await expect(target.getByRole('link')).toHaveCount(0);
  await target.getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ }).click();
  await expect(target.getByRole('note')).toHaveText('아직 열리지 않은 월드입니다');
});

test('상태 글자와 색: 진행 중·가오픈·멈춤, 끝난 월드는 기본으로 숨긴다', async ({ page }) => {
  test.setTimeout(180_000);
  await createAccount(page);
  await e2eWorld(page);
  const paused = `E2E 멈춤 ${Date.now() % 100_000}`;
  const id = createWorld(paused);
  run(['world:start', '--world', id]);
  run(['world:pause', '--world', id]);
  // 끝난 월드 fixture: 이 시험이 만든 월드 한 행만 DB에서 ENDED로 바꾼다. 엔진의 종료 경로를 시험하지 않는다.
  const ended = `E2E 끝남 ${Date.now() % 100_000}`;
  const endedId = createWorld(ended);
  const saved = await withE2eDb(async (db) => {
    await db.world.update({ where: { id: endedId }, data: { status: 'ENDED' } });
    return db.world.findUnique({ where: { id: endedId }, select: { status: true } });
  });
  expect(saved).toEqual({ status: 'ENDED' });
  await page.goto('/lobby');
  await expect(badge(page, '진행 중').first()).toHaveAttribute('data-tone', 'accent');
  const target = card(page, paused);
  await expect(badge(target, '멈춤')).toBeVisible();
  await expect(badge(target, '멈춤')).toHaveAttribute('data-tone', 'warning');
  await target.getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ }).click();
  await expect(target.getByRole('note')).toHaveText('멈춘 월드입니다');
  // 목록이 그려진 뒤에 본다. 화면은 includeEnded를 보내지 않으므로 서버 기본값대로 끝난 월드가 빠진다.
  await expect(card(page, ended)).toHaveCount(0);
  await expect(page.getByText('끝남', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/t2-04-lobby.png', fullPage: true });
});

test('로그인하지 않아도 목록을 보고 로그인하고 참가는 로그인 뒤 로비로 돌아온다', async ({ page }) => {
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

// 공지는 로그인 없이 읽는다. 이 시험이 넣은 LOBBY 공지 두 행만 쓰고 지운다. 다른 공지는 건드리지 않는다.
test('공지: 서버 순서대로 놓고 최신 1개를 펼치며 한 번에 하나만 연다', async ({ page }) => {
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const older = { title: `E2E 지난 공지 ${tag}`, body: `E2E 지난 공지 본문 ${tag}` };
  const newer = { title: `E2E 새 공지 ${tag}`, body: `E2E 새 공지 본문 ${tag}` };
  const ids: string[] = [];
  try {
    await withE2eDb(async (db) => {
      // 서버는 최근 20개만 준다. 이미 있는 공지보다 늦은 시각을 써서 두 행이 맨 앞 두 줄이 되게 한다.
      const latest = await db.notice.findFirst({
        where: { scope: 'LOBBY', worldId: null },
        orderBy: { publishedAt: 'desc' },
        select: { publishedAt: true },
      });
      const base = Math.max(Date.now(), latest?.publishedAt.getTime() ?? 0) + 60_000;
      // 오래된 행을 먼저 넣는다. 화면 순서가 넣은 순서가 아니라 서버의 publishedAt 정렬에서 와야 한다.
      for (const [notice, at] of [
        [older, base],
        [newer, base + 60_000],
      ] as const) {
        const row = await db.notice.create({
          data: {
            scope: 'LOBBY',
            worldId: null,
            title: notice.title,
            body: notice.body,
            pinned: false,
            publishedAt: new Date(at),
          },
          select: { id: true },
        });
        ids.push(row.id);
      }
    });
    const [olderId, newerId] = ids;

    const notices = await query<Array<{ id: string }>>(page, 'lobby.notices');
    expect(notices.slice(0, 2).map((n) => n.id)).toEqual([newerId, olderId]);

    await page.goto('/lobby');
    const board = page.getByRole('region', { name: '공지', exact: true });
    const heads = board.getByRole('button');
    await expect(heads.nth(0)).toContainText(newer.title);
    await expect(heads.nth(1)).toContainText(older.title);
    const newerHead = board.getByRole('button', { name: newer.title });
    const olderHead = board.getByRole('button', { name: older.title });
    const newerBody = board.getByText(newer.body, { exact: true });
    const olderBody = board.getByText(older.body, { exact: true });
    await expect(newerHead).toHaveAttribute('aria-expanded', 'true');
    await expect(newerBody).toBeVisible();
    await expect(olderHead).toHaveAttribute('aria-expanded', 'false');
    await expect(olderBody).toBeHidden();
    await expect(board.getByRole('button', { expanded: true })).toHaveCount(1);

    await olderHead.click();
    await expect(olderHead).toHaveAttribute('aria-expanded', 'true');
    await expect(olderBody).toBeVisible();
    await expect(newerHead).toHaveAttribute('aria-expanded', 'false');
    await expect(newerBody).toBeHidden();
    await expect(board.getByRole('button', { expanded: true })).toHaveCount(1);
  } finally {
    if (ids.length > 0) await withE2eDb((db) => db.notice.deleteMany({ where: { id: { in: ids } } }));
  }
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
      expect(new URL(page.url()).origin).toBe(appOrigin());
    });
  }
});
