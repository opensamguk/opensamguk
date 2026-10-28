import { createHash, randomBytes } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test as base, expect, apiMutate, type T210World } from './t210-fixture';
import { adminRole } from './adminSetup';
import { TEST_PASSWORD } from './account';
import { holdLease, type LeaseHold } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';

const test = base.extend<Record<never, never>, { worldEmailPolicy: void }>({
  worldEmailPolicy: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const saved = process.env.EMAIL_VERIFICATION_REQUIRED;
      process.env.EMAIL_VERIFICATION_REQUIRED = '1';
      try {
        await use();
      } finally {
        if (saved === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
        else process.env.EMAIL_VERIFICATION_REQUIRED = saved;
      }
    },
    { scope: 'worker', auto: true },
  ],
});
test.use({ actionTimeout: 10_000 });
const pending = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>) {
  pending.add(work);
  void work.finally(() => pending.delete(work)).catch(() => undefined);
  return work;
}
async function settled() {
  while (pending.size) await Promise.allSettled([...pending]);
}
test.beforeEach(settled);
test.afterEach(settled);
const calls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
async function fixture(world: T210World) {
  const admin = await world.user('ruler'),
    actor = await world.user('member');
  await adminRole(world, admin, 'grant');
  await world.hold.db.user.update({ where: { id: actor.userId }, data: { emailVerifiedAt: new Date() } });
  return { admin, actor, db: world.hold.db };
}
async function footprint(world: T210World) {
  const db = world.hold.db,
    hash = createHash('sha256');
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  for (const { tablename } of tables) {
    // 자기 실행권의 주기 갱신만 제외한다. 게임/입력/예약/감사/계정 표는 모두 비교한다.
    if (tablename === 'EngineLease') continue;
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const [row] = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t`,
    );
    hash.update(tablename + '\n' + row!.body + '\n');
  }
  return hash.digest('hex');
}

test('T3-06 AC-M3-04 실제 정식 두 월드·수동 조회·게임 불변·엔진 기록·네 폭', ({ world }) =>
  track(
    (async () => {
      test.setTimeout(120_000);
      const { admin, actor, db } = await fixture(world),
        page = admin.page,
        tag = randomBytes(5).toString('hex'),
        holds: LeaseHold[] = [],
        errors: unknown[] = [];
      let createdWorldId: string | null = null;
      try {
        const ids: string[] = [];
        for (const suffix of ['a', 'b']) {
          const initial = await loadInitialWorld({
            scenario: 'integration191',
            map: 'integration',
            statRules: 'five-stats',
            portraitMap: '191-map',
            seed: 'world-ui-' + tag + suffix,
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
          const { worldId } = await saveInitialWorld(db, initial, {
            name: suffix === 'a' ? '조회 정식191 ' + tag : '<img src=x onerror="window.worldInjected=1">' + tag,
            turnTermMinutes: suffix === 'a' ? 60 : 120,
            endYear: 201,
          });
          createdWorldId = worldId;
          const hold = await holdLease(worldId);
          holds.push(hold);
          createdWorldId = null;
          await controlClock(hold.db, worldId, 'start');
          await apiMutate(world, actor, 'general.create', {
            worldId,
            name: '조회장수',
            portraitId: null,
            leadership: 55,
            strength: 55,
            intel: 55,
            politics: 55,
            charm: 55,
          });
          await new TurnLoop(hold.db, hold.lease).advanceTo(0);
          expect(await db.nation.count({ where: { worldId } })).toBe(21);
          expect(await db.general.count({ where: { worldId, userId: null } })).toBe(491);
          expect(await db.general.count({ where: { worldId, userId: { not: null } } })).toBe(1);
          expect(await db.generalTurn.count({ where: { worldId } })).toBe(492 * 30);
          expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).ruleFeatures).toEqual(
            initial.ruleFeatures,
          );
          ids.push(worldId);
        }
        const [first, second] = ids as [string, string];
        const at = new Date('2026-10-28T01:02:03.000Z'),
          secretError = 'private-diagnostic-' + tag;
        await db.engineHeartbeat.deleteMany({ where: { worldId: { in: ids } } });
        // 조회용 진단 자료다. 상태 변경 실행기와 실제 엔진 지연의 증거로 세지 않는다.
        await db.engineHeartbeat.create({
          data: { worldId: first, at, lastTick: 37, lagMs: 123, lastError: secretError },
        });
        const requests: Request[] = [];
        page.on('request', (request) => {
          if (calls(request, 'admin.world.list')) requests.push(request);
        });
        const before = await footprint(world);
        await page.goto('/admin');
        await page.getByRole('link', { name: '월드 목록', exact: true }).click();
        await expect(page.getByRole('heading', { name: '월드 목록', exact: true })).toBeVisible();
        await expect(page.getByText('아직 조회하지 않았습니다.', { exact: true })).toBeVisible();
        await frames(page);
        expect(requests).toHaveLength(0);
        const button = page.getByRole('button', { name: '월드 조회', exact: true });
        await button.focus();
        await button.press('Enter');
        const list = page.getByRole('list', { name: '월드 조회 결과', exact: true });
        const card = (id: string) => list.locator(':scope > li').filter({ has: page.getByText(id, { exact: true }) });
        const value = (id: string, label: string) =>
          card(id).locator('dt').filter({ hasText: label }).locator('xpath=following-sibling::dd[1]');
        await expect(value(first, '월드 UUID')).toHaveText(first);
        await expect(value(first, '턴 간격')).toHaveText('60분');
        await expect(value(first, '사람 장수')).toHaveText('1명');
        await expect(value(first, '상태')).toHaveText('진행 중');
        await expect(value(first, '마지막 tick')).toHaveText('37');
        await expect(value(first, '엔진 지연')).toHaveText('123ms');
        await expect(value(first, '엔진 오류')).toHaveText('엔진 오류가 기록되어 있습니다.');
        await expect(card(first).locator('time')).toHaveAttribute('title', at.toISOString());
        await expect(card(first).locator('time')).toContainText('10:02:03');
        await expect(value(second, '턴 간격')).toHaveText('120분');
        await expect(value(second, '사람 장수')).toHaveText('1명');
        await expect(value(second, '엔진 기록')).toHaveText('기록 없음');
        await expect(card(second)).toContainText('<img src=x onerror="window.worldInjected=1">' + tag);
        expect(await list.locator('script,img').count()).toBe(0);
        expect(await page.evaluate(() => 'worldInjected' in window)).toBe(false);
        expect((await page.locator('body').innerText()).includes(secretError)).toBe(false);
        expect(requests).toHaveLength(1);
        expect(calls(requests[0]!, 'auth.me')).toBe(true);
        for (const width of [375, 768, 1024, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await frames(page);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(
            await page.locator('main button,main a').evaluateAll((elements) =>
              elements
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && (rect.width < 44 || rect.height < 44);
                })
                .map((element) => element.tagName),
            ),
          ).toEqual([]);
          await page.screenshot({ path: test.info().outputPath('admin-worlds-' + width + '.png'), fullPage: true });
        }
        expect(new URL(page.url()).search).toBe('');
        expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
        expect(await footprint(world)).toBe(before);
        for (const [status, label] of [
          ['PREOPEN', '개장 전'],
          ['PAUSED', '일시정지'],
          ['ENDED', '종료'],
        ] as const) {
          await db.world.update({ where: { id: first }, data: { status, presetKey: 'display-preset' } });
          const unchanged = await footprint(world);
          await button.click();
          await expect(value(first, '상태')).toHaveText(label);
          await expect(value(first, '프리셋')).toHaveText('display-preset');
          expect(await footprint(world)).toBe(unchanged);
        }
        expect(requests).toHaveLength(4);
        const checked = track(
          page.waitForResponse((response) => calls(response.request(), 'admin.whoami'), { timeout: 10_000 }),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await checked;
        await expect(list).toHaveCount(0);
        expect(requests).toHaveLength(4);
      } catch (error) {
        errors.push(error);
      } finally {
        for (const page of [admin.page, actor.page])
          try {
            await page.close();
          } catch (error) {
            errors.push(error);
          }
        for (const hold of holds.reverse())
          try {
            await cleanupHeldWorld(hold, world.stack.databaseUrl);
          } catch (error) {
            errors.push(error);
          }
        if (createdWorldId) errors.push(new Error('실행권 준비 실패로 자기 생성 월드를 보존합니다.'));
      }
      if (errors.length) throw new AggregateError(errors, '정식 월드 목록 검사와 자기 자원 정리 실패');
    })(),
  ));

test('T3-06 AC-M3-04 월드 조회 전송 실패·재시도·실제 권한 회수·USER·익명·미인증', ({ world }) =>
  track(
    (async () => {
      const { admin, actor, db } = await fixture(world),
        page = admin.page;
      await page.goto('/admin/worlds');
      const button = page.getByRole('button', { name: '월드 조회', exact: true }),
        list = page.getByRole('list', { name: '월드 조회 결과', exact: true });
      await button.click();
      await expect(list).toContainText(world.id);
      await page.route('**/trpc/**', (route) =>
        calls(route.request(), 'admin.world.list') ? route.abort('failed') : route.continue(),
      );
      const failures: unknown[] = [];
      try {
        await button.click();
        await expect(page.getByRole('alert')).toContainText('조회하지 못했습니다.');
        await expect(list).toHaveCount(0);
        await expect(page.locator('main')).not.toContainText(world.id);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await page.unrouteAll({ behavior: 'wait' });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, '조회 실패 반례와 전송 경계 정리 실패');
      await button.click();
      await expect(list).toContainText(world.id);
      await adminRole(world, admin, 'revoke');
      await button.click();
      await expect(page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(world.id);
      await actor.page.goto('/admin/worlds');
      await expect(actor.page.getByText('없는 주소입니다', { exact: true })).toBeVisible();
      await adminRole(world, admin, 'grant');
      await page.goto('/admin/worlds');
      await expect(page.getByRole('heading', { name: '월드 목록', exact: true })).toBeVisible();
      await db.user.update({ where: { id: admin.userId }, data: { emailVerifiedAt: null } });
      await page.goto('/admin/worlds');
      await expect(page.getByRole('heading', { name: '이메일 인증', exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/worlds');
      await admin.context.clearCookies();
      await page.goto('/admin/worlds');
      await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/worlds');
    })(),
  ));

test('T3-06 AC-M3-04 실제 지연 월드 응답 중 관리자 계정 전환은 이전 결과를 지운다', ({ world }) =>
  track(
    (async () => {
      const { admin, actor, db } = await fixture(world),
        page = admin.page;
      await adminRole(world, actor, 'grant');
      const { email } = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } });
      await page.goto('/admin/worlds');
      let release = () => {},
        observed = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readyTimer: ReturnType<typeof setTimeout>;
      const ready = track(
        new Promise<void>((resolve, reject) => {
          observed = resolve;
          readyTimer = setTimeout(() => reject(new Error('실제 월드 응답 관측 기한을 넘겼습니다.')), 10_000);
        }).finally(() => clearTimeout(readyTimer)),
      );
      const routes = new Set<Promise<unknown>>(),
        errors: unknown[] = [];
      await page.route('**/trpc/**', (route) => {
        if (!calls(route.request(), 'admin.world.list')) return route.continue();
        const work = (async () => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect((await response.text()).includes(world.id)).toBe(true);
          observed();
          await held;
          try {
            await route.fulfill({ response });
          } catch (error) {
            if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(route.request().failure()?.errorText ?? '')) throw error;
          }
        })();
        routes.add(work);
        void work.catch((error) => errors.push(error));
        void work.finally(() => routes.delete(work)).catch(() => undefined);
        return work;
      });
      try {
        await page.getByRole('button', { name: '월드 조회', exact: true }).click();
        await ready;
        const response = await page.request.post(world.stack.webOrigin + '/trpc/auth.login', {
          headers: { origin: world.stack.webOrigin },
          data: { email, password: TEST_PASSWORD },
        });
        expect(response.status()).toBe(200);
        const checked = track(
          page.waitForResponse((value) => calls(value.request(), 'admin.whoami'), { timeout: 10_000 }),
        );
        const aborted = track(
          page.waitForEvent('requestfailed', {
            predicate: (request) => calls(request, 'admin.world.list'),
            timeout: 10_000,
          }),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await checked;
        await aborted;
        await expect(page.getByText('아직 조회하지 않았습니다.', { exact: true })).toBeVisible();
        release();
        await Promise.allSettled([...routes]);
        await frames(page);
        await expect(page.getByRole('list', { name: '월드 조회 결과', exact: true })).toHaveCount(0);
        await expect(page.locator('main')).not.toContainText(world.id);
      } catch (error) {
        errors.push(error);
      } finally {
        release();
        await Promise.allSettled([...routes]);
        try {
          await page.unrouteAll({ behavior: 'wait' });
        } catch (error) {
          errors.push(error);
        }
        await Promise.allSettled([ready]);
      }
      if (errors.length) throw new AggregateError(errors, '지연 월드 응답과 정착 실패');
    })(),
  ));
