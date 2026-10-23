import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import { ApiError, e2eWorld, mutate, query } from './game';
import { bindGeneral } from './world';

// T2-10 · AC-M2-04, AC-M2-07: 실제 서버·DB·엔진과 두 사용자 브라우저로 메시지와 실시간 갱신을 본다.
// AC-M2-07은 여기 두 시험(실시간 2초, 턴 결과 2초)으로 판정한다. 가짜 EventSource만으로는 인수하지 않는다 (계획 T2-10 검증).
// T2-09(Codex)의 message·notice 라우터와 /sse가 main에 들어오기 전에는 이 파일 전체를 건너뛴다. 건너뛴 결과는 증거가 아니다.

const BASE = 'http://127.0.0.1:5173';

interface Home {
  general: { id: number; name: string; nationId: number | null };
}
interface Unread {
  PRIVATE: number | null;
  NATION: number | null;
  DIPLOMACY: number | null;
  WORLD: number | null;
}
interface User {
  context: BrowserContext;
  page: Page;
  home: Home;
}

let worldId = '';

async function apiReady(page: Page): Promise<boolean> {
  try {
    await query(page, 'message.unread', { worldId });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND' && error.status === 404) return false;
    throw error;
  }
}

// 계정마다 브라우저 문맥을 따로 연다. ruler면 군주에, nationId를 주면 그 국가의 일반 장수에 붙인다.
async function newUser(browser: Browser, ruler = false, nationId?: number): Promise<User> {
  const context = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await createAccount(page);
  worldId = await e2eWorld(page);
  const { user } = await query<{ user: { id: string } }>(page, 'auth.me');
  if (ruler) await bindOwner(worldId, user.id, { nationId: null, minLevel: 12, maxLevel: 12 });
  else if (nationId !== undefined) await bindOwner(worldId, user.id, { nationId, minLevel: 0, maxLevel: 10 });
  else await bindGeneral(worldId, user.id);
  const home = await query<Home>(page, 'home.get', { worldId });
  return { context, page, home };
}

// e2e/world.ts의 bindGeneral과 같이 월드 행을 잠근 트랜잭션에서 조건에 맞는, 아직 주인이 없는 소속 장수에 붙인다.
async function bindOwner(
  world: string,
  userId: string,
  { nationId, minLevel, maxLevel }: { nationId: number | null; minLevel: number; maxLevel: number },
) {
  const count = await withE2eDb((db) =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${world} FOR UPDATE`;
      return tx.$executeRaw`UPDATE "General" SET "userId" = ${userId}
WHERE "worldId" = ${world} AND "id" = (
  SELECT g."id" FROM "General" g
  WHERE g."worldId" = ${world} AND g."userId" IS NULL AND g."nationId" IS NOT NULL
    AND (${nationId}::int IS NULL OR g."nationId" = ${nationId})
    AND g."officerLevel" BETWEEN ${minLevel} AND ${maxLevel}
  ORDER BY g."id" LIMIT 1
)`;
    }),
  );
  if (count !== 1) throw new Error('조건에 맞는 장수를 찾지 못했습니다');
}

async function openMessages(page: Page) {
  await page.goto(`/w/${worldId}/messages`);
  await expect(page.getByRole('heading', { level: 1, name: '메시지' })).toBeVisible();
  await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-realtime', 'open');
}

async function sendPrivate(page: Page, to: Home, body: string) {
  await page.getByRole('tab', { name: /^개인/ }).click();
  await page.getByRole('combobox', { name: '받는 장수' }).selectOption(String(to.general.id));
  await page.getByRole('textbox', { name: '메시지 내용' }).fill(body);
  const sent = page.waitForResponse((response) => response.url().includes('message.send') && response.ok());
  await page.getByRole('button', { name: '보내기' }).click();
  await sent;
}

test.describe('메시지와 실시간 갱신', () => {
  let a: User;
  let b: User;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    a = await newUser(browser, true);
    b = await newUser(browser);
    test.skip(!(await apiReady(a.page)), 'T2-09 메시지 API가 아직 main에 없다');
  });

  test.afterAll(async () => {
    await a?.context.close();
    await b?.context.close();
  });

  test('A가 보낸 개인 메시지가 B 화면에 새로고침 없이 2초 안에 보인다', async () => {
    await openMessages(a.page);
    await openMessages(b.page);
    const body = `실시간 시험 ${Date.now()}`;
    await sendPrivate(a.page, b.home, body);
    const committed = Date.now();
    await expect(b.page.getByText(body)).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - committed).toBeLessThan(2_000);
    // 보낸 쪽은 send 응답 행 하나만 보인다.
    await expect(a.page.getByText(body)).toHaveCount(1);
  });

  test('내 턴 결과가 메인 개인 기록에 새로고침 없이 2초 안에 보인다', async () => {
    test.setTimeout(150_000);
    const page = b.page;
    await page.goto(`/w/${worldId}`);
    await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-realtime', 'open');
    type Logs = { items: Array<{ id: string; text: string }> };
    const before = (await query<Logs>(page, 'records.general', { worldId })).items[0]?.id;
    // API로 새 기록이 읽히는 때를 commit 시각으로 본다 (100ms 간격).
    let fresh: { id: string; text: string } | undefined;
    await expect
      .poll(
        async () => {
          fresh = (await query<Logs>(page, 'records.general', { worldId })).items[0];
          return fresh && fresh.id !== before ? fresh.id : null;
        },
        { timeout: 130_000, intervals: [100] },
      )
      .not.toBeNull();
    const committed = Date.now();
    await expect(page.locator('[data-record-kind="general"]').getByText(fresh!.text).first()).toBeVisible({
      timeout: 2_000,
    });
    expect(Date.now() - committed).toBeLessThan(2_000);
  });

  test('외교 탭은 군주·참모에게만 보인다', async () => {
    for (const user of [a, b]) {
      const unread = await query<Unread>(user.page, 'message.unread', { worldId });
      await openMessages(user.page);
      await expect(user.page.getByRole('tab', { name: /^외교/ })).toHaveCount(unread.DIPLOMACY === null ? 0 : 1);
    }
    await expect(a.page.getByRole('tab', { name: /^외교/ })).toHaveCount(1);
  });

  test('연결을 끊었다 이으면 전체를 다시 읽고 작성 중인 글과 목록이 그대로다', async () => {
    const page = b.page;
    await openMessages(page);
    await page.getByRole('tab', { name: /^개인/ }).click();
    const box = page.getByRole('textbox', { name: '메시지 내용' });
    await box.fill('끊긴 동안 쓰던 글');
    const rowsBefore = await page
      .locator('[data-message-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));
    await page.context().setOffline(true);
    await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-realtime', 'reconnecting', {
      timeout: 10_000,
    });
    const refetched = page.waitForRequest((request) => request.url().includes('message.unread'));
    await page.context().setOffline(false);
    await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-realtime', 'open', { timeout: 30_000 });
    await refetched;
    await expect(box).toHaveValue('끊긴 동안 쓰던 글');
    const rowsAfter = await page
      .locator('[data-message-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));
    expect(new Set(rowsAfter).size).toBe(rowsAfter.length);
    expect(rowsAfter.slice(0, rowsBefore.length)).toEqual(rowsBefore);
  });

  test('공지를 고치면 소속 장수가 다음 접속 때 팝업을 한 번 보고, 닫을 때 띄운 판을 보낸다', async ({ browser }) => {
    const nationId = a.home.general.nationId!;
    const body = `국가 공지 시험 ${Date.now()}`;
    const saved = await mutate<{ nationId: number; revision: number }>(a.page, 'notice.nation.set', { worldId, body });
    const member = await newUser(browser, false, nationId);
    try {
      await member.page.goto(`/w/${worldId}`);
      const popup = member.page.getByTestId('nation-notice-popup');
      await expect(popup).toContainText(body);
      const seen = member.page.waitForRequest((request) => request.url().includes('notice.nation.markSeen'));
      await popup.getByRole('button', { name: '확인' }).click();
      expect((await seen).postDataJSON()).toMatchObject({ worldId, nationId, revision: saved.revision });
      await expect(popup).toHaveCount(0);
      await member.page.reload();
      await expect(member.page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
      await expect(popup).toHaveCount(0);
    } finally {
      await member.context.close();
    }
  });
});
