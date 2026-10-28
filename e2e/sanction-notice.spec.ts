import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Route, TestInfo } from '@playwright/test';
import { test, expect, apiMutate, apiQuery, type T210World } from './t210-fixture';
import { TEST_PASSWORD } from './account';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

const executions = new Set<Promise<unknown>>();
async function settled() {
  while (executions.size) await Promise.allSettled([...executions]);
}
function scenario(name: string, body: (args: { world: T210World }, info: TestInfo) => Promise<void>) {
  test(name, ({ world }, info) => {
    const execution = Promise.resolve().then(() => body({ world }, info));
    executions.add(execution);
    void execution.finally(() => executions.delete(execution)).catch(() => undefined);
    return execution;
  });
}
test.beforeEach(settled);
test.afterEach(settled);
async function runWithCleanup(body: () => Promise<void>, actions: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  try {
    await body();
  } catch (error) {
    errors.push(error);
  }
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, '제재 안내 시험 본문·정리 실패');
}

async function prepare(world: T210World) {
  const db = world.hold.db;
  const admin = await world.user('ruler'),
    actor = await world.user('member'),
    peer = await world.user('ronin');
  await db.user.update({ where: { id: admin.userId }, data: { emailVerifiedAt: new Date() } });
  const account = await db.user.findUniqueOrThrow({ where: { id: admin.userId } });
  const cli = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../tools/admin-role.ts', import.meta.url)), 'grant'],
    {
      env: { ...process.env, DATABASE_URL: world.stack.databaseUrl },
      windowsHide: true,
      timeout: 10_000,
      killSignal: 'SIGTERM',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  cli.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  cli.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    let failure: Error | undefined;
    cli.once('error', (error) => {
      failure = error;
    });
    cli.once('close', (code) => (failure ? reject(failure) : resolve(code)));
  });
  cli.stdin.on('error', () => {});
  cli.stdin.end(JSON.stringify({ email: account.email, reason: '제재 안내 실제 화면 검사' }));
  expect(await closed).toBe(0);
  expect(JSON.parse(output).role).toBe('ADMIN');
  expect(await apiQuery(admin, 'admin.whoami')).toEqual({ admin: true });
  const holds: Awaited<ReturnType<typeof holdLease>>[] = [];
  const worldIds: string[] = [];
  async function close() {
    await runWithCleanup(async () => {}, [
      ...holds.map((hold) => () => releaseHold(hold)),
      ...worldIds.map((worldId) => async () => {
        // 자기 worker의 폐기 DB만 정리한다. 운영 기록에는 이 경로를 쓰지 않는다.
        await db.sanction.deleteMany({ where: { worldId } });
        await db.world.delete({ where: { id: worldId } });
      }),
    ]);
  }
  try {
    for (let index = 0; index < 2; index++) {
      const initial = await loadInitialWorld({
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: `sanction-notice-${index}`,
      });
      initial.ruleFeatures = [
        'campaign-v1',
        'five-stats',
        'operational-map',
        'personnel',
        'policy',
        'stratagem-basic',
        'treaty',
      ];
      expect(initial.nations).toHaveLength(21);
      expect(initial.generals).toHaveLength(491);
      const { worldId } = await saveInitialWorld(db, initial, {
        name: `제재 안내 정식191 ${index}`,
        turnTermMinutes: 60,
        endYear: 201,
      });
      worldIds.push(worldId);
      const hold = await holdLease(worldId);
      holds.push(hold);
      await controlClock(hold.db, worldId, 'start');
      for (const [human, user] of [actor, peer].entries()) {
        await apiMutate(world, user, 'general.create', {
          worldId,
          name: `안내장수${human}`,
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
        });
        await new TurnLoop(hold.db, hold.lease).advanceTo(0);
        expect(await db.general.count({ where: { worldId, userId: user.userId } })).toBe(1);
      }
      expect(await db.generalTurn.count({ where: { worldId } })).toBe(493 * 30);
    }
  } catch (error) {
    await runWithCleanup(async () => {
      throw error;
    }, [close]);
    throw error;
  }
  return {
    db,
    admin,
    actor,
    peer,
    worldIds,
    close,
  };
}

scenario('T3-06 AC-M3-04 정식 두 월드 제재·403·30칸 초안·해제·6개 폭·조회 실패·만료', async ({ world }, info) => {
  test.setTimeout(120_000);
  const fixture = await prepare(world);
  const {
    db,
    admin,
    actor,
    peer,
    worldIds: [worldId, otherId],
  } = fixture;
  const page = actor.page;
  const notice = page.getByRole('status', { name: '이 월드의 이용 제한' });
  const reason = '<script>window.sanctionInjected=true</script>' + '긴 제재 사유 '.repeat(15);
  await runWithCleanup(async () => {
    await page.goto(`/w/${worldId}`);
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    await editor.locator('tr[data-slot="30"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: '30번 칸에 넣기', exact: true }).click();
    const draft = await page.evaluate(() => Object.entries(sessionStorage));
    const before = await db.generalTurn.findMany({
      where: { worldId },
      orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
    });
    const created = await apiMutate<{ sanctionId: string }>(world, admin, 'admin.sanction.create', {
      userId: actor.userId,
      worldId,
      reason,
      expiresAt: null,
    });
    const denied = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/trpc/turns.set'));
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    expect((await denied).status()).toBe(403);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(reason);
    await expect(notice).toContainText('기한 없음');
    expect(await page.evaluate(() => Object.entries(sessionStorage))).toEqual(draft);
    expect(
      await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
    ).toEqual(before);
    expect(await page.evaluate(() => 'sanctionInjected' in window)).toBe(false);
    for (const width of [375, 390, 767, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(notice).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const rect = await notice.getByRole('button').boundingBox();
      expect(rect!.width).toBeGreaterThanOrEqual(44);
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: info.outputPath(`sanction-notice-${width}.png`), fullPage: true });
    }
    const refresh = notice.getByRole('button', { name: '제재 상태 다시 확인' });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(notice).toBeVisible();
    await peer.page.goto(`/w/${worldId}`);
    await expect(peer.page.getByRole('heading', { name: '메인', exact: true })).toBeVisible();
    await expect(peer.page.getByRole('status', { name: '이 월드의 이용 제한' })).toHaveCount(0);
    await page.goto(`/w/${otherId}`);
    await expect(page.getByRole('heading', { name: '메인', exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await page.goto(`/w/${worldId}`);
    await expect(notice).toBeVisible();
    await page.route('**/trpc/**', (route) =>
      route.request().url().includes('sanction.mine') ? route.abort('failed') : route.continue(),
    );
    await notice.getByRole('button').click();
    await expect(page.getByRole('alert').filter({ hasText: '제재 상태를 확인하지 못했습니다.' })).toBeVisible();
    await page.unroute('**/trpc/**');
    await page.getByRole('region', { name: '제재 상태 확인' }).getByRole('button', { name: '다시 확인' }).click();
    await expect(notice).toBeVisible();
    await apiMutate(world, admin, 'admin.sanction.lift', { sanctionId: created.sanctionId, reason: '화면 검증 해제' });
    await notice.getByRole('button').click();
    await expect(notice).toHaveCount(0);
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    const human = await db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId: worldId!, userId: actor.userId } },
    });
    expect(
      (
        await db.generalTurn.findUniqueOrThrow({
          where: { worldId_generalId_slot: { worldId: worldId!, generalId: human.id, slot: 29 } },
        })
      ).commandKey,
    ).toBe('farm');
    const expiresAt = new Date(Date.now() + 4000).toISOString();
    await apiMutate(world, admin, 'admin.sanction.create', {
      userId: actor.userId,
      worldId,
      reason: '만료 검증',
      expiresAt,
    });
    await page.reload();
    await expect(notice).toContainText('만료 검증');
    await expect(notice.locator('time')).toHaveAttribute('datetime', expiresAt);
    await expect(notice.locator('time')).toContainText('한국 시각');
    await expect(notice).toHaveCount(0, { timeout: 36_000 });
  }, [() => fixture.close()]);
});

scenario('T3-06 AC-M3-04 같은 HTTP 배치·다른 탭 로그인·이전 계정 지연 응답의 사유 격리', async ({ world }) => {
  test.setTimeout(120_000);
  const fixture = await prepare(world);
  const {
    db,
    admin,
    actor,
    peer,
    worldIds: [worldId],
  } = fixture;
  const page = actor.page;
  const secret = '이전 계정 전용 사유';
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: Promise<unknown>[] = [];
  let ready = () => {};
  let captureFailed: (error: unknown) => void = () => {};
  const captured = new Promise<void>((resolve, reject) => {
    ready = resolve;
    captureFailed = reject;
  });
  void captured.catch(() => undefined);
  let batched = false;
  let held = false;
  const handler = (route: Route) => {
    const task = (async () => {
      const paths = new URL(route.request().url()).pathname.split('/').at(-1)!.split(',');
      if (!paths.includes('sanction.mine') || held) {
        await route.continue();
        return;
      }
      held = true;
      batched = paths.includes('auth.me');
      const response = await route.fetch();
      expect(await response.text()).toContain(secret);
      ready();
      await gate;
      await route.fulfill({ response });
    })().catch((error) => {
      captureFailed(error);
      throw error;
    });
    requests.push(task);
    return task;
  };
  let other: Awaited<ReturnType<typeof actor.context.newPage>> | undefined;
  await runWithCleanup(async () => {
    other = await actor.context.newPage();
    await apiMutate(world, admin, 'admin.sanction.create', {
      userId: actor.userId,
      worldId,
      reason: secret,
      expiresAt: null,
    });
    await page.goto(`/w/${worldId}`);
    const notice = page.getByRole('status', { name: '이 월드의 이용 제한' });
    await expect(notice).toContainText(secret);
    await page.route('**/trpc/**', handler);
    await notice.getByRole('button').click();
    await captured;
    expect(batched).toBe(true);
    await expect(notice).toHaveCount(0);
    const account = await db.user.findUniqueOrThrow({ where: { id: peer.userId } });
    const result = await other.request.post('/trpc/auth.login', {
      headers: { Origin: world.stack.webOrigin },
      data: { email: account.email, password: TEST_PASSWORD },
    });
    expect(result.status()).toBe(200);
    await page.evaluate((forbidden) => {
      const observed = { leaked: false };
      Object.assign(window, { sanctionPrivacy: observed });
      const check = () => {
        if (document.body.textContent?.includes(forbidden)) observed.leaked = true;
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
    }, secret);
    await page.evaluate(async (moduleUrl) => {
      const { queryClient, trpc } = await import(moduleUrl);
      await queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryKey() });
    }, '/src/trpc.ts');
    // 서버에서 받은 새 계정의 batch가 클라이언트 캐시에 적용될 때까지 본다.
    await expect
      .poll(() =>
        page.evaluate(
          async ({ moduleUrl, userId, id }) => {
            const { queryClient } = await import(moduleUrl);
            const state = queryClient.getQueryState(['sanction-notice', userId, id]);
            return (
              state?.status === 'success' &&
              state.fetchStatus === 'idle' &&
              (state.data as { viewerId?: string } | undefined)?.viewerId === userId
            );
          },
          { moduleUrl: '/src/trpc.ts', userId: peer.userId, id: worldId },
        ),
      )
      .toBe(true);
    release();
    const results = await Promise.allSettled(requests);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    await expect
      .poll(async () => apiQuery<{ user: { id: string } }>(actor, 'auth.me').then((value) => value.user.id))
      .toBe(peer.userId);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ moduleUrl, userId, id }) => {
            const { queryClient } = await import(moduleUrl);
            return queryClient.getQueryState(['sanction-notice', userId, id])?.fetchStatus !== 'fetching';
          },
          { moduleUrl: '/src/trpc.ts', userId: actor.userId, id: worldId },
        ),
      )
      .toBe(true);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(notice).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { sanctionPrivacy: { leaked: boolean } }).sanctionPrivacy.leaked),
    ).toBe(false);
    await expect(page.getByRole('heading', { name: '메인', exact: true })).toBeVisible();
  }, [
    async () => {
      release();
      const results = await Promise.allSettled(requests);
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, '보류 응답 정리 실패');
    },
    () => page.unroute('**/trpc/**', handler),
    async () => other?.close(),
    () => fixture.close(),
  ]);
});
