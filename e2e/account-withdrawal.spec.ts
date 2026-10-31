import { randomUUID, createHash } from 'node:crypto';
import type { Page, Request, Route } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { newAccountToken } from '../apps/server/src/auth/accountToken';
import type { LegalPolicy } from '../apps/server/src/legal/policy';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import { notifyWorld } from '../packages/db/src/index';

const executions = new Set<Promise<unknown>>();
const bodyFailures: unknown[] = [];
function track<T>(action: () => Promise<T>) {
  return observe(Promise.resolve().then(action));
}
function observe<T>(pending: Promise<T>) {
  executions.add(pending);
  void pending.then(
    () => executions.delete(pending),
    (error) => {
      bodyFailures.push(error);
      executions.delete(pending);
    },
  );
  return pending;
}
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}
test.beforeEach(settled);
test.afterEach(async ({ page, legalStack }) => {
  const errors: unknown[] = [];
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await settled();
  } catch (error) {
    errors.push(error);
  }
  errors.push(...bodyFailures.splice(0));
  if (errors.length) {
    legalStack.failed = true;
    throw new AggregateError(errors, '탈퇴 시험 본문 또는 페이지·본문 정착 실패');
  }
});
const calls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;
const policy = (tag: string): LegalPolicy => ({
  terms: { version: 'test-terms-' + tag, effectiveAt: '2026-01-01T00:00:00.000Z', bodyText: '시험 이용약관 ' + tag },
  privacy: {
    version: 'test-privacy-' + tag,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    bodyText: '시험 개인정보처리방침 ' + tag + '\n계정 탈퇴 후 게임 기록을 보존하는 시험 문서입니다.',
  },
});
async function approved(stack: LegalStack, tag: string) {
  const value = policy(tag);
  await stack.restart(value, false, { scheme: 'tombstone-v1', privacyVersion: value.privacy.version });
  return value;
}
let hash: Promise<string> | undefined;
async function account(stack: LegalStack, page: Page, role: 'USER' | 'ADMIN' = 'USER', install = true) {
  hash ??= hashPassword(TEST_PASSWORD);
  const session = newSession(Date.now());
  const user = await stack.db.user.create({
    data: {
      email: `withdraw-ui-${randomUUID()}@example.test`,
      passwordHash: await hash,
      emailVerifiedAt: new Date(),
      role,
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  if (install)
    await page
      .context()
      .addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return { ...user, token: session.token };
}
async function show(page: Page, stack: LegalStack) {
  await page.goto(stack.origin + '/account');
  await expect(page.getByLabel('현재 비밀번호', { exact: true })).toBeVisible();
}
async function fill(page: Page, password = TEST_PASSWORD) {
  await page.getByLabel('현재 비밀번호', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: '현재 계정의 탈퇴와 복구 불가를 확인했습니다.' }).check();
}
const confirm = (page: Page) => page.getByRole('button', { name: '계정 탈퇴 확정', exact: true });
async function footprint(stack: LegalStack, omitAccount = false) {
  const tables = await stack.db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const digest = createHash('sha256');
  for (const { tablename } of tables) {
    if (
      tablename === '_prisma_migrations' ||
      tablename === 'EngineLease' ||
      (omitAccount && ['User', 'Session', 'AccountToken'].includes(tablename))
    )
      continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const [row] = await stack.db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    digest.update(tablename + '\n' + row!.body + '\n');
  }
  return digest.digest('hex');
}
async function noPassword(page: Page, secret = TEST_PASSWORD) {
  expect(await page.locator('input[type=password]').count()).toBe(0);
  const evidence = await page.evaluate((password) => {
    type QueryClient = { getQueryCache(): { getAll(): unknown[] }; getMutationCache(): { getAll(): unknown[] } };
    type Fiber = { child?: Fiber; sibling?: Fiber; memoizedProps?: { client?: QueryClient } };
    const root = document.getElementById('root')! as HTMLElement & Record<string, unknown>;
    const key = Object.keys(root).find((item) => item.startsWith('__reactContainer$'));
    const container = key ? (root[key] as { stateNode?: { current?: Fiber } }) : undefined;
    const clients: QueryClient[] = [];
    const visit = (node: Fiber | undefined) => {
      if (!node) return;
      const client = node.memoizedProps?.client;
      if (client?.getMutationCache) clients.push(client);
      visit(node.child);
      visit(node.sibling);
    };
    visit(container?.stateNode?.current);
    if (!clients.length) throw new Error('실제 공개 React QueryClient를 찾지 못했습니다.');
    const values = {
      url: location.href,
      storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      dom: document.body.innerHTML,
      queries: clients
        .flatMap((client) => client.getQueryCache().getAll())
        .map((entry) => (entry as { state: unknown }).state),
      mutations: clients
        .flatMap((client) => client.getMutationCache().getAll())
        .map((entry) => (entry as { state: unknown }).state),
    };
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, JSON.stringify(value).includes(password)]),
    );
  }, secret);
  expect(Object.values(evidence).some(Boolean), 'DOM·주소·저장소·Query/MutationCache 비밀번호 잔존 여부').toBe(false);
  return evidence;
}
async function mobile(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator('main a,main button,main input').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
        })
        .map((element) => element.tagName),
    ),
  ).toEqual([]);
}
function gate() {
  let release!: () => void, arrive!: () => void;
  return {
    released: new Promise<void>((resolve) => (release = resolve)),
    arrived: new Promise<void>((resolve) => (arrive = resolve)),
    release: () => release(),
    arrive: () => arrive(),
  };
}
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('자기 실제 요청 지연을 관측하지 못했습니다.')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 응답 내용은 실제 서버에서 받고 지연·유실만 만든다.
async function intercept(
  page: Page,
  pattern: string,
  handler: (route: Route) => Promise<void>,
  body: () => Promise<void>,
) {
  const jobs = new Set<Promise<void>>(),
    errors: unknown[] = [];
  const callback = (route: Route) => {
    const job = Promise.resolve().then(() => handler(route));
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      (error) => {
        jobs.delete(job);
        errors.push(error);
      },
    );
    return job;
  };
  await page.route(pattern, callback);
  try {
    await body();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await page.unroute(pattern, callback);
    } catch (error) {
      errors.push(error);
    }
    while (jobs.size) await Promise.allSettled([...jobs]);
  }
  if (errors.length) throw new AggregateError(errors, '실제 요청 지연 시험 또는 정착 실패');
}

test('T3-03 AC-M3-02 기본 미승인은 실행 폼과 탈퇴 쓰기0이며 직접 요청도503이다', ({ page, legalStack: stack }) =>
  track(async () => {
    await stack.restart(null);
    const user = await account(stack, page),
      before = await footprint(stack);
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'account.withdraw')) writes++;
    });
    await page.goto(stack.origin + '/account');
    await expect(page.getByText('탈퇴 처리 기준을 준비하고 있습니다.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('현재 비밀번호')).toHaveCount(0);
    expect(writes).toBe(0);
    const response = await page.request.post(stack.origin + '/trpc/account.withdraw', {
      headers: { Origin: stack.origin },
      data: { expectedUserId: user.id, password: TEST_PASSWORD },
    });
    expect(response.status()).toBe(503);
    expect(await footprint(stack)).toBe(before);
  }));

test('T3-03 AC-M3-02 확인 체크·4화면폭44px·키보드와 실제 ADMIN 본인 탈퇴·캐시 비밀번호0', ({
  page,
  legalStack: stack,
}, info) =>
  track(async () => {
    await approved(stack, 'admin');
    const user = await account(stack, page, 'ADMIN');
    const logs: string[] = [];
    page.on('console', (entry) => logs.push(entry.text()));
    await show(page, stack);
    await expect(confirm(page)).toBeDisabled();
    await page.getByLabel('현재 비밀번호').fill(TEST_PASSWORD);
    await expect(confirm(page)).toBeDisabled();
    for (const width of [375, 768, 1024, 1440]) {
      await mobile(page, width);
      await page.screenshot({ path: info.outputPath(`withdrawal-form-${width}.png`), fullPage: true });
    }
    await mobile(page, 375);
    await page.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(confirm(page)).toBeEnabled();
    await page.getByLabel('현재 비밀번호').fill(TEST_PASSWORD + 'x');
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await fill(page);
    await page.getByRole('checkbox').focus();
    await page.keyboard.press('Tab');
    await expect(confirm(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '탈퇴 완료', exact: true })).toBeVisible();
    await noPassword(page);
    expect(
      logs.some((entry) => entry.includes(TEST_PASSWORD)),
      '콘솔 비밀번호 잔존 여부',
    ).toBe(false);
    expect((await stack.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('WITHDRAWN');
    await page.screenshot({ path: info.outputPath('withdrawal-complete-375.png'), fullPage: true });
  }));

test('T3-03 AC-M3-02 잘못된 암호401은 성공으로 추측하지 않고 자동 재접수0·창 전환 입력 소거', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await approved(stack, 'wrong');
    const user = await account(stack, page);
    await show(page, stack);
    await fill(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.getByLabel('현재 비밀번호')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: '현재 정보 다시 확인', exact: true }).click();
    await expect(page.getByLabel('현재 비밀번호')).toHaveValue('');
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    const before = await footprint(stack);
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'account.withdraw')) writes++;
    });
    await fill(page, 'wrong-ui-password');
    await confirm(page).click();
    await expect(page.getByRole('alert')).toContainText('처리 결과를 확인할 수 없습니다');
    await expect(page.getByRole('heading', { name: '탈퇴 완료' })).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    await noPassword(page, 'wrong-ui-password');
    expect(writes).toBe(1);
    expect(await footprint(stack)).toBe(before);
    expect((await stack.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
  }));

test('T3-03 AC-M3-02 유효한 처리방침 본문·시행일 교체와 미승인 전환은 실제 fresh 조회 후 접수0', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    for (const mode of ['body', 'effective', 'version', 'pending'] as const) {
      const initial = await approved(stack, 'change-' + mode);
      await account(stack, page);
      await show(page, stack);
      await fill(page);
      const changed =
        mode === 'pending'
          ? null
          : {
              ...initial,
              privacy: {
                ...initial.privacy,
                version: initial.privacy.version + '-next',
                ...(mode === 'body'
                  ? { bodyText: '바뀐 실제 시험 개인정보 본문' }
                  : mode === 'version'
                    ? { version: initial.privacy.version + '-next' }
                    : { effectiveAt: '2026-02-01T00:00:00.000Z' }),
              },
            };
      await stack.restart(
        changed,
        false,
        changed ? { scheme: 'tombstone-v1', privacyVersion: changed.privacy.version } : null,
      );
      const before = await footprint(stack);
      let writes = 0;
      const listener = (request: Request) => {
        if (calls(request, 'account.withdraw')) writes++;
      };
      page.on('request', listener);
      await confirm(page).click();
      await expect(page.getByRole('alert')).toContainText('처리 기준이 바뀌었습니다');
      await noPassword(page);
      expect(writes).toBe(0);
      expect(await footprint(stack)).toBe(before);
      page.off('request', listener);
    }
  }));

test('T3-03 AC-M3-02 마지막 fresh me 뒤 실제 세션 교체는 expected UUID401·두 계정 무변경이다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await approved(stack, 'race');
    const first = await account(stack, page),
      second = await account(stack, page, 'USER', false);
    await show(page, stack);
    await fill(page);
    const wait = gate();
    let count = 0;
    await intercept(
      page,
      '**/trpc/auth.me*',
      async (route) => {
        count++;
        if (count !== 2) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        wait.arrive();
        await wait.released;
        await route.fulfill({ response });
      },
      async () => {
        try {
          await confirm(page).click();
          await bounded(wait.arrived);
          await page
            .context()
            .addCookies([{ name: 'sid', value: second.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
          wait.release();
          await expect(page.getByRole('alert')).toContainText('처리 결과를 확인할 수 없습니다');
          await noPassword(page);
          expect(await stack.db.user.count({ where: { id: { in: [first.id, second.id] }, status: 'ACTIVE' } })).toBe(2);
        } finally {
          wait.release();
        }
      },
    );
  }));

test('T3-03 AC-M3-02 실제 account.get B 응답을 A 세션으로 돌려도 ABA 계정 자료 노출0·접수0', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await approved(stack, 'aba');
    const first = await account(stack, page),
      second = await account(stack, page, 'USER', false);
    const wait = gate();
    let held = false,
      leaked = false,
      writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'account.withdraw')) writes++;
    });
    await page.addInitScript((email) => {
      new MutationObserver(() => {
        if (document.body?.textContent?.includes(email)) (window as unknown as { leaked: boolean }).leaked = true;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, second.email);
    await intercept(
      page,
      '**/trpc/account.get*',
      async (route) => {
        if (held) {
          await route.continue();
          return;
        }
        held = true;
        await page
          .context()
          .addCookies([{ name: 'sid', value: second.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
        const response = await page.request.get(route.request().url());
        expect((await response.json())[0].result.data.userId).toBe(second.id);
        await page
          .context()
          .addCookies([{ name: 'sid', value: first.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
        wait.arrive();
        await wait.released;
        await route.fulfill({ response });
      },
      async () => {
        try {
          await page.goto(stack.origin + '/account');
          await bounded(wait.arrived);
          wait.release();
          await expect(page.getByRole('alert')).toContainText('계정이 바뀌었습니다');
          leaked = await page.evaluate(() => (window as unknown as { leaked?: boolean }).leaked ?? false);
          expect(leaked).toBe(false);
          await expect(page.getByText(second.email, { exact: true })).toHaveCount(0);
          expect(writes).toBe(0);
        } finally {
          wait.release();
        }
      },
    );
  }));

test('T3-03 AC-M3-02 실제 성공 응답 유실과 늦은 응답은 재접수·성공 추측·다른 계정 노출0', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    for (const mode of ['lost', 'late'] as const) {
      await approved(stack, 'response-' + mode);
      const user = await account(stack, page),
        other = await account(stack, page, 'USER', false);
      await show(page, stack);
      await fill(page);
      let writes = 0;
      const listener = (request: Request) => {
        if (calls(request, 'account.withdraw')) writes++;
      };
      page.on('request', listener);
      const wait = gate();
      await intercept(
        page,
        '**/trpc/account.withdraw*',
        async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          wait.arrive();
          await wait.released;
          if (mode === 'lost') await route.abort('failed');
          else await route.fulfill({ response });
        },
        async () => {
          try {
            await confirm(page).click();
            await bounded(wait.arrived);
            if (mode === 'late') {
              await page
                .context()
                .addCookies([{ name: 'sid', value: other.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
              await page.evaluate(() => {
                window.dispatchEvent(new Event('blur'));
                window.dispatchEvent(new Event('focus'));
              });
            }
            wait.release();
            await expect(page.getByRole('alert')).toContainText('처리 결과를 확인할 수 없습니다');
            await expect(page.getByRole('heading', { name: '탈퇴 완료' })).toHaveCount(0);
            await noPassword(page);
            await expect(page.getByRole('button')).toHaveCount(0);
            expect(writes).toBe(1);
            expect((await stack.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('WITHDRAWN');
            expect((await stack.db.user.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('ACTIVE');
          } finally {
            wait.release();
          }
        },
      );
      page.off('request', listener);
    }
  }));

test('T3-03 AC-M3-02 실제429는 Retry-After까지 재조회·입력·자동 재접수0', ({ page, legalStack: stack }) =>
  track(async () => {
    await approved(stack, 'limit');
    const user = await account(stack, page);
    for (let index = 0; index < 5; index++) {
      const response = await page.request.post(stack.origin + '/trpc/account.withdraw', {
        headers: { Origin: stack.origin },
        data: { expectedUserId: user.id, password: 'wrong' },
      });
      expect(response.status()).toBe(401);
    }
    await show(page, stack);
    await fill(page);
    const before = await footprint(stack);
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'account.withdraw')) writes++;
    });
    const response = observe(page.waitForResponse((item) => calls(item.request(), 'account.withdraw')));
    await confirm(page).click();
    expect((await response).status()).toBe(429);
    expect((await response).headers()['retry-after']).toMatch(/^\d+$/);
    await expect(page.getByRole('button', { name: /초 뒤 현재 정보 다시 확인/ })).toBeDisabled();
    await noPassword(page);
    expect(writes).toBe(1);
    expect(await footprint(stack)).toBe(before);
  }));

test('T3-03 AC-M3-02 정식191 두 월드·사람30칸을 UI로 만든 뒤 실제 탈퇴·두 API 실시간 종료와 다른 계정·게임 보존', ({
  page,
  legalStack: stack,
}, info) =>
  track(async () => {
    test.setTimeout(180_000);
    const current = await approved(stack, 'formal');
    const user = await account(stack, page),
      other = await account(stack, page, 'USER', false);
    const sessions = [newSession(Date.now()), newSession(Date.now())];
    for (const sid of sessions)
      await stack.db.session.create({ data: { id: sid.id, userId: user.id, expiresAt: sid.expiresAt } });
    for (const purpose of ['VERIFY_EMAIL', 'RESET_PASSWORD'] as const) {
      const token = newAccountToken(purpose, Date.now());
      await stack.db.accountToken.create({
        data: { id: token.id, userId: user.id, purpose, expiresAt: token.expiresAt },
      });
    }
    for (const actor of [user, other])
      for (const docType of ['TERMS', 'PRIVACY'] as const) {
        const response = await page.request.post(stack.origin + '/trpc/legal.agree', {
          headers: { Origin: stack.origin, Cookie: 'sid=' + actor.token },
          data: {
            docType,
            version: current[docType === 'TERMS' ? 'terms' : 'privacy'].version,
            expectedUserId: actor.id,
          },
        });
        expect(response.status()).toBe(200);
      }
    const worlds: Array<{ id: string; hold: Awaited<ReturnType<typeof holdLease>> }> = [];
    const errors: unknown[] = [],
      observations: Promise<unknown>[] = [];
    const streams: Array<{ controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }> = [];
    let peer: Awaited<ReturnType<LegalStack['peer']>> | undefined;
    const evidence: Record<string, unknown> = { scenario: 'integration191', npcPerWorld: 491, nationPerWorld: 21 };
    try {
      for (let index = 0; index < 2; index++) {
        const initial = await loadInitialWorld({
          scenario: 'integration191',
          map: 'integration',
          statRules: 'five-stats',
          portraitMap: '191-map',
          seed: 'withdrawal-ui-formal-191-' + index,
        });
        initial.ruleFeatures = [
          'campaign-assignment-v2',
          'campaign-v1',
          'five-stats',
          'operational-map',
          'personnel',
          'policy',
          'stratagem-basic',
          'treaty',
        ];
        expect(initial.generals).toHaveLength(491);
        expect(initial.nations).toHaveLength(21);
        const { worldId } = await saveInitialWorld(stack.db, initial, {
          name: '탈퇴 화면 정식191-' + index,
          turnTermMinutes: 60,
          endYear: 201,
        });
        const hold = await holdLease(worldId);
        worlds.push({ id: worldId, hold });
        await controlClock(hold.db, worldId, 'start');
        await page.goto(stack.origin + '/w/' + worldId + '/create');
        await expect(page.getByRole('spinbutton')).toHaveCount(5);
        await page.getByLabel('이름', { exact: true }).fill('탈퇴장수' + index);
        await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
        await expect
          .poll(() => stack.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
          .toBe(1);
        await new TurnLoop(hold.db, hold.lease).advanceTo(0);
        await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
        const creation = page.request.post(stack.origin + '/trpc/general.create', {
          headers: { Origin: stack.origin, Cookie: 'sid=' + other.token },
          data: {
            worldId,
            name: '보존장수' + index,
            leadership: 55,
            strength: 55,
            intel: 55,
            politics: 55,
            charm: 55,
            portraitId: null,
          },
        });
        observations.push(creation);
        void creation.catch(() => undefined);
        await expect
          .poll(() => stack.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
          .toBe(1);
        await new TurnLoop(hold.db, hold.lease).advanceTo(0);
        expect((await creation).status()).toBe(200);
        for (const actor of [user, other]) {
          const general = await stack.db.general.findUniqueOrThrow({
            where: { worldId_userId: { worldId, userId: actor.id } },
          });
          expect(await stack.db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
        }
        expect(await stack.db.general.count({ where: { worldId, userId: null } })).toBe(491);
        expect(await stack.db.generalTurn.count({ where: { worldId } })).toBe(493 * 30);
      }
      // 읽기 화면을 떠나 페이지의 기존 SSE를 정리한 뒤 세 연결을 각각 실제로 연다.
      await show(page, stack);
      await stack.db.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId: user.id,
          action: 'test.withdrawal-ui-retention',
          targetType: 'User',
          targetId: user.id,
          payload: { test: true },
        },
      });
      const before = await footprint(stack, true);
      const others = async () =>
        createHash('sha256')
          .update(
            JSON.stringify(
              await Promise.all([
                stack.db.user.findMany({ where: { id: { not: user.id } }, orderBy: { id: 'asc' } }),
                stack.db.session.findMany({ where: { userId: { not: user.id } }, orderBy: { id: 'asc' } }),
                stack.db.accountToken.findMany({ where: { userId: { not: user.id } }, orderBy: { id: 'asc' } }),
              ]),
            ),
          )
          .digest('hex');
      const otherBefore = await others();
      peer = await stack.peer();
      const open = async (origin: string, token: string) => {
        const controller = new AbortController();
        try {
          const response = await fetch(origin + '/sse?worldId=' + worlds[0]!.id, {
            headers: { origin: stack.origin, cookie: 'sid=' + token },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          });
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          streams.push({ controller, reader });
          expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
          return reader;
        } catch (error) {
          controller.abort();
          throw error;
        }
      };
      const own = await open(stack.origin, user.token),
        remote = await open(peer.origin, sessions[0]!.token),
        retained = await open(peer.origin, other.token);
      await page
        .context()
        .addCookies([{ name: 'did', value: randomUUID(), url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
      await fill(page);
      const response = page.waitForResponse((item) => calls(item.request(), 'account.withdraw'));
      observations.push(response);
      void response.catch(() => undefined);
      const started = Date.now();
      await confirm(page).click();
      expect((await response).status()).toBe(200);
      const clearedCookies = await (await response).headerValues('set-cookie');
      expect(
        clearedCookies.some((cookie) => cookie.startsWith('sid=;')),
        '본인 sid 쿠키 소거 응답',
      ).toBe(true);
      expect(
        clearedCookies.some((cookie) => cookie.startsWith('did=;')),
        '본인 did 쿠키 소거 응답',
      ).toBe(true);
      expect((await Promise.all([own.read(), remote.read()])).map((value) => value.done)).toEqual([true, true]);
      evidence.actualSessionCloseMs = Date.now() - started;
      await expect(page.getByRole('heading', { name: '탈퇴 완료', exact: true })).toBeVisible();
      expect((await page.context().cookies()).filter((cookie) => ['sid', 'did'].includes(cookie.name))).toEqual([]);
      const saved = await stack.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(saved.status).toBe('WITHDRAWN');
      expect(saved.email).toBe('withdrawn+' + user.id + '@invalid');
      expect(saved.passwordHash !== user.passwordHash, '탈퇴 뒤 비밀번호 해시 변경 여부').toBe(true);
      expect(saved.emailVerifiedAt).toBeNull();
      expect(await stack.db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(await stack.db.accountToken.count({ where: { userId: user.id } })).toBe(0);
      for (const token of [user.token, ...sessions.map((value) => value.token)])
        expect(
          (
            await page.request.get(stack.origin + '/trpc/account.get', { headers: { Cookie: 'sid=' + token } })
          ).status(),
        ).toBe(401);
      expect(await footprint(stack, true)).toBe(before);
      expect(await others()).toBe(otherBefore);
      const general = await stack.db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId: worlds[0]!.id, userId: other.id } },
      });
      expect(
        await notifyWorld(stack.db, worlds[0]!.id, { kind: 'turn.result', target: { generalId: general.id } }),
      ).toBe(true);
      const retainedFrame = await retained.read();
      expect(retainedFrame.done).toBe(false);
      expect(new TextDecoder().decode(retainedFrame.value)).toContain('event: turn.result');
      await noPassword(page);
      await page.screenshot({ path: info.outputPath('formal-withdrawal-complete.png'), fullPage: true });
      evidence.worldIds = worlds.map((world) => world.id);
      evidence.gameAndReservationsPreserved = true;
      evidence.otherAccountPreserved = true;
      evidence.twoApiSessionClose = true;
      await info.attach('actual-formal-withdrawal-evidence', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      // 완료 뒤 다른 계정이 확인되면 이전 완료 결과를 숨긴다.
      await page
        .context()
        .addCookies([{ name: 'sid', value: other.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('heading', { name: '탈퇴 완료' })).toHaveCount(0);
      await expect(page.getByText(other.email, { exact: true })).toBeVisible();
    } catch (error) {
      errors.push(error);
    } finally {
      for (const stream of streams) stream.controller.abort();
      for (const result of await Promise.allSettled(streams.map((stream) => stream.reader.cancel())))
        if (result.status === 'rejected' && !(result.reason instanceof Error && result.reason.name === 'AbortError'))
          errors.push(result.reason);
      try {
        await peer?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await page.close();
      } catch (error) {
        errors.push(error);
      }
      for (const result of await Promise.allSettled(observations))
        if (result.status === 'rejected') errors.push(result.reason);
      for (const world of worlds.reverse())
        try {
          await cleanupHeldWorld(world.hold, process.env.DATABASE_URL!);
        } catch (error) {
          errors.push(error);
        }
    }
    if (errors.length) throw new AggregateError(errors, '정식 두 월드 탈퇴 화면 또는 자기 자원 정리 실패');
  }));

test('T3-03 AC-M3-02 실제200 응답 보류는 유한 기한 뒤 차단을 풀고 재접수·늦은 완료 표시 없이 복구로 간다', ({
  page,
  legalStack: stack,
}) =>
  track(async () => {
    await approved(stack, 'deadline');
    const user = await account(stack, page);
    await show(page, stack);
    await fill(page);
    const wait = gate();
    let writes = 0;
    page.on('request', (request) => {
      if (calls(request, 'account.withdraw')) writes++;
    });
    await intercept(
      page,
      '**/trpc/account.withdraw*',
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        wait.arrive();
        await wait.released;
        await route.fulfill({ response });
      },
      async () => {
        try {
          const started = Date.now();
          await confirm(page).click();
          await bounded(wait.arrived);
          await expect(page.getByRole('alert')).toContainText('처리 결과를 확인할 수 없습니다', { timeout: 40_000 });
          expect(Date.now() - started).toBeLessThan(40_000);
          await noPassword(page);
          await expect(page.getByRole('button')).toHaveCount(0);
          expect(writes).toBe(1);
          expect((await stack.db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('WITHDRAWN');
          wait.release();
          await page.getByRole('link', { name: '비밀번호 재설정', exact: true }).click();
          await expect(page).toHaveURL(stack.origin + '/forgot-password');
          await expect(page.getByRole('heading', { name: '탈퇴 완료', exact: true })).toHaveCount(0);
          expect(writes).toBe(1);
        } finally {
          wait.release();
        }
      },
    );
  }));
