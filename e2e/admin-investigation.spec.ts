import { randomBytes, randomUUID } from 'node:crypto';
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import { test as base, expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { sanctionAccount } from './adminSanctionSetup';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease } from './game';
import { releaseLease } from '../apps/engine/src/lease';
import { investigationFootprint, settleInvestigationRenewals } from './investigationObservation';

type User = { id: string; email: string; page: Page };
type OwnedWorld = { id: string; hold: Awaited<ReturnType<typeof holdLease>> };
type Journey = {
  stack: LegalStack;
  admin: User;
  peerAdmin: User;
  anonymous: Page;
  people: User[];
  worlds: OwnedWorld[];
  signal: AbortSignal;
  run: (work: () => Promise<void>) => Promise<void>;
  routeJobs: Set<Promise<unknown>>;
  routeErrors: unknown[];
};
const calls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;
const names = (request: Request) => new URL(request.url()).pathname.split('/').at(-1)?.split(',').sort() ?? [];
const noSecrets = (text: string, privateValues: string[]) =>
  !privateValues.some((value) => text.includes(value)) && !text.includes('127.0.0.1') && !/\b[0-9a-f]{64}\b/.test(text);

async function mutation(page: Page, stack: LegalStack, path: string, data: unknown) {
  const response = await page.request.post(stack.origin + '/trpc/' + path + '?batch=1', {
    data: data === undefined ? {} : { 0: data },
    headers: { origin: stack.origin },
    timeout: 15_000,
  });
  const [body] = (await response.json()) as Array<{
    result?: { data: { user?: { id: string; email: string } } };
    error?: { data?: { code?: string } };
  }>;
  expect(response.status()).toBe(200);
  if (!body) throw new Error('실제 변경 요청 응답이 필요합니다.');
  return body.result?.data;
}
async function me(page: Page, stack: LegalStack) {
  const response = await page.request.get(stack.origin + '/trpc/auth.me', { timeout: 15_000 });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { result: { data: { user: { id: string } | null } } };
  return body.result.data.user?.id;
}
async function signup(page: Page, stack: LegalStack): Promise<User> {
  const email = 'investigate-' + randomUUID() + '@example.test';
  const result = await mutation(page, stack, 'auth.signup', { email, password: TEST_PASSWORD });
  if (!result?.user) throw new Error('실제 가입 계정이 필요합니다.');
  return { ...result.user, page };
}
async function footprint(stack: LegalStack, excludeAudit = false) {
  const fingerprint = investigationFootprint();
  const tables = await stack.db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  for (const { tablename } of tables) {
    if (excludeAudit && tablename === 'AuditLog') continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const [row] = await stack.db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    fingerprint.table(tablename, row!.body);
  }
  return fingerprint.finish();
}
async function open(journey: Journey) {
  const page = journey.admin.page;
  await page.goto(journey.stack.origin + '/admin/users');
  const region = page.getByRole('region', { name: '다중계정 조사', exact: true });
  await expect(region).toBeVisible();
  return region;
}
async function prepare(journey: Journey, worldId = journey.worlds[0]!.id) {
  const region = await open(journey);
  await region.getByRole('button', { name: '조사할 월드 목록 조회', exact: true }).click();
  await expect(
    region
      .getByRole('combobox', { name: '조사할 월드', exact: true })
      .getByRole('option', { name: /조사 화면 정식191/ })
      .first(),
  ).toBeAttached();
  await region.getByRole('combobox', { name: '조사할 월드', exact: true }).selectOption(worldId);
  await region.getByRole('checkbox', { name: '필요한 월드와 기간의 개인정보만 확인합니다.', exact: true }).check();
  return region;
}
async function auditCount(stack: LegalStack) {
  return stack.db.auditLog.count({ where: { action: 'investigate.shared.view' } });
}
async function detailForm(journey: Journey) {
  const region = journey.admin.page.getByRole('region', { name: '사용자 상세', exact: true });
  await region.getByRole('textbox', { name: '상세 조회할 사용자 UUID', exact: true }).fill(journey.people[0]!.id);
  return region;
}

const test = base.extend<{ investigation: Journey }>({
  investigation: [
    async ({ legalStack: stack, browser }, use, info) => {
      const controller = new AbortController(),
        contexts: BrowserContext[] = [],
        worlds: OwnedWorld[] = [],
        bodies = new Set<Promise<unknown>>(),
        routeJobs = new Set<Promise<unknown>>(),
        routeErrors: unknown[] = [],
        failures: unknown[] = [];
      const run = (work: () => Promise<void>) => {
        controller.signal.throwIfAborted();
        const promise = Promise.resolve().then(work);
        bodies.add(promise);
        void promise.then(
          () => bodies.delete(promise),
          () => bodies.delete(promise),
        );
        return promise;
      };
      const page = async () => {
        controller.signal.throwIfAborted();
        const context = await browser.newContext({ baseURL: stack.origin });
        contexts.push(context);
        return context.newPage();
      };
      try {
        const key = randomBytes(32).toString('hex');
        await stack.restart(null, false, null, { loginAudit: { key, version: 1 } });
        const sharedPage = await page(),
          firstSignup = await signup(sharedPage, stack);
        const did = (await sharedPage.context().cookies(stack.origin)).find((cookie) => cookie.name === 'did')?.value;
        expect(typeof did === 'string' && /^[0-9a-f]{32}$/.test(did), '실제 무작위 기기 쿠키').toBe(true);
        await mutation(sharedPage, stack, 'auth.logout', undefined);
        const second = await signup(sharedPage, stack);
        expect(
          (await sharedPage.context().cookies(stack.origin)).find((cookie) => cookie.name === 'did')?.value === did,
          '로그아웃 뒤 같은 기기',
        ).toBe(true);
        const firstPage = await page();
        await mutation(firstPage, stack, 'auth.login', { email: firstSignup.email, password: TEST_PASSWORD });
        const first = { ...firstSignup, page: firstPage },
          other = await signup(await page(), stack);
        const adminPage = await page(),
          peerPage = await page();
        // 관리자 계정·역할은 기존 통제 고정물이다. 조사 대상 기록은 실제 가입·로그인만 쓴다.
        const admin = { ...(await sanctionAccount(stack, adminPage, true)), page: adminPage },
          peerAdmin = { ...(await sanctionAccount(stack, peerPage, true)), page: peerPage };
        const people = [first, second, other];
        for (const index of [0, 1]) {
          controller.signal.throwIfAborted();
          const initial = await loadInitialWorld({
            scenario: 'integration191',
            map: 'integration',
            statRules: 'five-stats',
            portraitMap: '191-map',
            seed: 'investigation-screen-' + index,
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
          expect(initial.nations).toHaveLength(21);
          expect(initial.generals).toHaveLength(491);
          expect(initial.cities).toHaveLength(61);
          const { worldId } = await saveInitialWorld(stack.db, initial, {
            name: '조사 화면 정식191-' + index,
            turnTermMinutes: 60,
            endYear: 201,
          });
          const hold = await holdLease(worldId);
          worlds.push({ id: worldId, hold });
          await controlClock(hold.db, worldId, 'start');
          for (const person of index === 0 ? [first, second] : [other]) {
            await person.page.goto(stack.origin + '/w/' + worldId + '/create');
            await person.page
              .getByRole('textbox', { name: '이름', exact: true })
              .fill('조사사람' + people.indexOf(person));
            await person.page.getByRole('button', { name: '장수 만들기', exact: true }).click();
            await expect
              .poll(
                () =>
                  stack.db.inputEvent.count({
                    where: { worldId, userId: person.id, kind: 'general.create', status: 'PENDING' },
                  }),
                { timeout: 10_000 },
              )
              .toBe(1);
            await new TurnLoop(hold.db, hold.lease).advanceTo(0);
            await expect(person.page.getByRole('heading', { name: '메인', exact: true })).toBeVisible();
            const general = await stack.db.general.findUniqueOrThrow({
              where: { worldId_userId: { worldId, userId: person.id } },
            });
            expect(await stack.db.generalTurn.count({ where: { worldId, generalId: general.id } })).toBe(30);
          }
          expect(await stack.db.general.count({ where: { worldId, userId: null } })).toBe(491);
        }
        const anonymous = await page();
        // 본문은 API 읽기만 검사한다. 고정물의 리스 갱신도 비교 전에 정착시키며 행 전체는 계속 보호한다.
        await settleInvestigationRenewals(worlds.map(({ hold }) => hold));
        await use({
          stack,
          admin,
          peerAdmin,
          anonymous,
          people,
          worlds,
          signal: controller.signal,
          run,
          routeJobs,
          routeErrors,
        });
      } catch (error) {
        failures.push(error);
      } finally {
        if (info.status !== info.expectedStatus) stack.failed = true;
        controller.abort();
        // 시간 제한도 실제 페이지 요청과 응답 대기를 닫은 뒤 본문을 정착시킨다.
        for (const context of contexts)
          try {
            await context.close();
          } catch (error) {
            failures.push(error);
          }
        while (bodies.size || routeJobs.size) {
          const settled = await Promise.allSettled([...bodies, ...routeJobs]);
          for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
        }
        failures.push(...routeErrors);
        for (const { hold } of [...worlds].reverse()) {
          hold.done.abort();
          for (const action of [
            async () => {
              await hold.renewal;
              if (hold.lost) throw hold.lost;
            },
            () => releaseLease(hold.db, hold.lease),
            () => hold.db.$disconnect(),
          ])
            try {
              await action();
            } catch (error) {
              failures.push(error);
            }
        }
        if (failures.length) stack.failed = true;
        // 성공도 소유 행을 임의 삭제하지 않는다. legalStack이 연결0·OID 확인 뒤 자기 DB만 정리한다.
      }
      if (failures.length) throw new AggregateError([...new Set(failures)], '조사 화면 본문·자기 연결 정리 실패');
    },
    { timeout: 180_000 },
  ],
});

test('T3-06 AC-M3-05 실제 공유 기록·수동 조회·감사·두 월드 격리·세 폭·키보드', async ({
  investigation: journey,
}, info) =>
  journey.run(async () => {
    test.setTimeout(120_000);
    const page = journey.admin.page,
      requests: Request[] = [];
    page.on('request', (request) => {
      if (calls(request, 'admin.investigate.shared')) requests.push(request);
    });
    const region = await prepare(journey),
      before = await footprint(journey.stack, true),
      count = await auditCount(journey.stack);
    expect(requests).toHaveLength(0);
    await region.getByRole('button', { name: '공유 기록 조회', exact: true }).press('Enter');
    await expect(region.getByText('공유 묶음 2개', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(names(requests[0]!)).toEqual(['admin.investigate.shared', 'admin.whoami', 'auth.me'].sort());
    expect(await auditCount(journey.stack)).toBe(count + 1);
    const audit = await journey.stack.db.auditLog.findFirstOrThrow({
      where: { action: 'investigate.shared.view' },
      orderBy: { id: 'desc' },
      select: { actorUserId: true, worldId: true, payload: true },
    });
    expect(audit).toEqual({
      actorUserId: journey.admin.id,
      worldId: journey.worlds[0]!.id,
      payload: { days: 7, groupCount: 2 },
    });
    for (const person of journey.people.slice(0, 2))
      await expect(region.getByText(person.id, { exact: true })).toHaveCount(2);
    await expect(region.getByText(journey.people[2]!.id, { exact: true })).toHaveCount(0);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '가로 넘침 없음').toBe(
        true,
      );
      expect(
        await region
          .getByRole('button', { name: '공유 기록 조회', exact: true })
          .evaluate((element) => element.getBoundingClientRect().height >= 44),
        '44px 버튼',
      ).toBe(true);
      await page.screenshot({ path: info.outputPath('investigation-' + width + '.png'), fullPage: true });
    }
    const cookies = (await page.context().cookies(journey.stack.origin)).map((cookie) => cookie.value);
    expect(noSecrets(await region.innerText(), cookies), '조사 DOM에 원문·전체 해시 없음').toBe(true);
    await region.getByRole('combobox', { name: '조사할 월드', exact: true }).selectOption(journey.worlds[1]!.id);
    await expect(region.getByText('공유 묶음 2개', { exact: true })).toHaveCount(0);
    await region.getByRole('checkbox').check();
    await region.getByRole('button', { name: '공유 기록 조회', exact: true }).click();
    await expect(region.getByText('공유 묶음 0개', { exact: true })).toBeVisible();
    expect(await auditCount(journey.stack)).toBe(count + 2);
    expect(await footprint(journey.stack, true)).toEqual(before);
    const detail = await detailForm(journey);
    await detail.getByRole('button', { name: '상세 조회', exact: true }).click();
    await expect(detail.getByRole('list', { name: '최근 로그인 기록 목록', exact: true }).locator('li')).toHaveCount(2);
    const identity = detail
      .locator('dt')
      .filter({ hasText: /^사용자$/ })
      .locator('+ dd');
    await expect(identity).toBeVisible();
    await expect(identity).toHaveText(`${journey.people[0]!.email} ${journey.people[0]!.id}`, { useInnerText: true });
    await expect(detail.getByText('참가 장수', { exact: true })).toBeVisible();
    const privateValues = (await page.context().cookies(journey.stack.origin)).map((cookie) => cookie.value);
    expect(noSecrets(await detail.innerText(), privateValues), '최근 로그인 DOM의 원문·전체 해시 없음').toBe(true);
    const beforeFailedRead = await footprint(journey.stack);
    await journey.stack.db
      .$executeRawUnsafe(`CREATE FUNCTION investigation_ui_detail_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='user.view' THEN RAISE EXCEPTION 'private recent audit rejected'; END IF; RETURN NEW; END $$`);
    await journey.stack.db.$executeRawUnsafe(
      `CREATE TRIGGER investigation_ui_detail_block BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION investigation_ui_detail_block()`,
    );
    const failures: unknown[] = [];
    try {
      await detail.getByRole('button', { name: '상세 조회', exact: true }).click();
      await expect(detail.getByRole('alert')).toBeVisible();
      await expect(detail.getByRole('list', { name: '최근 로그인 기록 목록', exact: true })).toHaveCount(0);
      expect((await detail.innerText()).includes('private recent audit rejected'), '감사 오류 원문 없음').toBe(false);
      expect(await footprint(journey.stack)).toEqual(beforeFailedRead);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const sql of [
        'DROP TRIGGER investigation_ui_detail_block ON "AuditLog"',
        'DROP FUNCTION investigation_ui_detail_block()',
      ])
        try {
          await journey.stack.db.$executeRawUnsafe(sql);
        } catch (error) {
          failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, '실제 상세 감사 거부·trigger 정리 실패');
  }));

test('T3-06 AC-M3-05 일반·무인증·역할 회수는 실제 HTTP 거부이며 감사·자료가 없다', async ({ investigation: journey }) =>
  journey.run(async () => {
    test.setTimeout(120_000);
    const path =
      journey.stack.origin +
      '/trpc/admin.investigate.shared?input=' +
      encodeURIComponent(JSON.stringify({ worldId: journey.worlds[0]!.id }));
    for (const mode of ['ordinary', 'anonymous', 'revoked'] as const) {
      const page =
        mode === 'ordinary' ? journey.people[0]!.page : mode === 'anonymous' ? journey.anonymous : journey.admin.page;
      if (mode === 'revoked')
        await changeAdminRole(journey.stack.db, {
          email: journey.admin.email,
          role: 'USER',
          reason: '조사 화면 권한 회수 검사',
        });
      const before = await footprint(journey.stack);
      const response = await page.request.get(path, { timeout: 15_000 });
      const body = (await response.json()) as { result?: unknown; error?: { data?: { code?: string } } };
      expect(response.status()).toBe(mode === 'anonymous' ? 401 : 403);
      expect(body.result === undefined, '거부 결과 없음').toBe(true);
      expect(body.error?.data?.code).toBe(mode === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN');
      expect(await footprint(journey.stack)).toEqual(before);
      if (mode !== 'anonymous') {
        await page.goto(journey.stack.origin + '/admin/users');
        await expect(page.getByRole('region', { name: '다중계정 조사', exact: true })).toHaveCount(0);
      }
    }
  }));

async function holdActualReply(journey: Journey, page: Page, forwardAs?: Page, procedure = 'admin.investigate.shared') {
  let release!: () => void, received!: (value: Request) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<Request>((resolve, reject) => {
      received = resolve;
      rejectReady = reject;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  void ready.catch(() => undefined);
  const abort = () => {
    release();
    rejectReady(new Error('자기 조사 응답 대기가 중단됐습니다.'));
  };
  journey.signal.addEventListener('abort', abort, { once: true });
  const handler = (route: Route) => {
    if (!calls(route.request(), procedure)) return route.continue();
    const job = (async () => {
      // 다른 실제 브라우저 계정의 쿠키 저장소로 같은 GET batch를 보낸다.
      // 쿠키 원문을 요청 옵션·로그에 복사하지 않고 실제 응답 그대로 전달한다.
      const response = forwardAs
        ? await forwardAs.request.get(route.request().url(), { timeout: 15_000 })
        : await route.fetch({ timeout: 15_000 });
      received(route.request());
      await gate;
      if (journey.signal.aborted) await route.abort();
      else await route.fulfill({ response });
    })();
    journey.routeJobs.add(job);
    void job.then(
      () => journey.routeJobs.delete(job),
      (error) => {
        rejectReady(error);
        journey.routeErrors.push(error);
        journey.routeJobs.delete(job);
      },
    );
    return job;
  };
  await page.route('**/trpc/**', handler);
  return {
    ready,
    release,
    async close() {
      release();
      journey.signal.removeEventListener('abort', abort);
      await page.unroute('**/trpc/**', handler);
      while (journey.routeJobs.size) await Promise.allSettled([...journey.routeJobs]);
    },
  };
}

test('T3-06 AC-M3-05 실제 query batch의 쿠키 ABA와 역할 회수 뒤 늦은 응답을 버린다', async ({
  investigation: journey,
}) =>
  journey.run(async () => {
    test.setTimeout(120_000);
    const page = journey.admin.page;
    let region = await prepare(journey);
    expect(await me(page, journey.stack)).toBe(journey.admin.id);
    const aba = await holdActualReply(journey, page, journey.peerAdmin.page);
    try {
      await region.getByRole('button', { name: '공유 기록 조회', exact: true }).click();
      const request = await aba.ready;
      expect(names(request)).toEqual(['admin.investigate.shared', 'admin.whoami', 'auth.me'].sort());
      expect(await me(page, journey.stack)).toBe(journey.admin.id);
      aba.release();
      await expect(region.getByRole('combobox', { name: '조사할 월드', exact: true })).toHaveValue('');
      await expect(region.getByText('공유 묶음 2개', { exact: true })).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (
              await journey.stack.db.auditLog.findFirst({
                where: { action: 'investigate.shared.view' },
                orderBy: { id: 'desc' },
              })
            )?.actorUserId,
        )
        .toBe(journey.peerAdmin.id);
    } finally {
      await aba.close();
    }
    await open(journey);
    const detail = await detailForm(journey),
      detailAba = await holdActualReply(journey, page, journey.peerAdmin.page, 'admin.user.get');
    try {
      await detail.getByRole('button', { name: '상세 조회', exact: true }).click();
      const request = await detailAba.ready;
      expect([...new Set(names(request))]).toEqual(['admin.user.get', 'admin.whoami', 'auth.me'].sort());
      expect(await me(page, journey.stack)).toBe(journey.admin.id);
      detailAba.release();
      await expect(detail.getByRole('alert')).toBeVisible();
      await expect(detail.getByRole('list', { name: '최근 로그인 기록 목록', exact: true })).toHaveCount(0);
    } finally {
      await detailAba.close();
    }
    region = await prepare(journey);
    const late = await holdActualReply(journey, page);
    try {
      await region.getByRole('button', { name: '공유 기록 조회', exact: true }).click();
      await late.ready;
      await changeAdminRole(journey.stack.db, {
        email: journey.admin.email,
        role: 'USER',
        reason: '조사 응답 지연 중 역할 회수',
      });
      late.release();
      await expect(page.getByRole('region', { name: '다중계정 조사', exact: true })).toHaveCount(0);
    } finally {
      await late.close();
    }
  }));
