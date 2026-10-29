import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './legalFixture';
import { sanctionAccount, sanctionCalls } from './adminSanctionSetup';
import {
  createActor,
  prepareCreation,
  reviewCreationPage,
  submitCreation,
  createRequest,
  applyCreation,
  createdResult,
  creationSource,
  responsiveCreation,
  creationRateServer,
} from './adminCreateSetup';
import { endFootprint } from './adminEndSetup';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';
import { creationFeatures, creationSelection } from '../apps/server/src/admin/worldCreateOptions';

test.describe.configure({ mode: 'serial' });
const closers: Array<() => Promise<unknown>> = [];
const jobs = new Set<Promise<unknown>>(),
  errors: unknown[] = [];
function track(work: () => Promise<unknown>) {
  const pending = Promise.resolve().then(work);
  jobs.add(pending);
  void pending.then(
    () => jobs.delete(pending),
    (error) => {
      jobs.delete(pending);
      errors.push(error);
    },
  );
  return pending;
}
async function actualRoute(page: Page, path: string, effect: (route: Route) => Promise<unknown>) {
  let once = true;
  const handler = (route: Route) => {
    if (!once || !sanctionCalls(route.request(), path)) return route.continue();
    once = false;
    return track(() => effect(route));
  };
  await page.route('**/trpc/**', handler);
  return () => page.unroute('**/trpc/**', handler);
}
async function withRestoration(body: () => Promise<void>, restore: () => Promise<void>) {
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  }
  try {
    await restore();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, '생성 시험 본문과 주입 복원 실패');
}
test.afterEach(async ({ page, legalStack }, info) => {
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...jobs]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('생성 화면 응답 작업이 남았습니다.')), 15_000);
      }),
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
  }
  for (const close of closers.splice(0).reverse()) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        track(close),
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('자기 생성 시험 서버를 닫지 못했습니다.')), 15_000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(closeTimer);
    }
  }
  if (info.status !== info.expectedStatus || errors.length || jobs.size) legalStack.failed = true;
  if (errors.length || jobs.size) throw new AggregateError(errors.splice(0), '생성 화면 본문 또는 응답 정리 실패');
  if (!legalStack.failed) {
    try {
      expect(await legalStack.db.worldCreateRequest.count({ where: { status: 'PENDING' } })).toBe(0);
    } catch {
      legalStack.failed = true;
      throw new Error('생성 화면의 대기 요청이 남아 자기 DB를 보존합니다.');
    }
  }
});

test('AC-M3-04 CH-01 실제 생성은 PREOPEN·191·21국491NPC61거점·감사1회이며 기존 월드를 보존한다', async ({
  page,
  legalStack,
}) => {
  const actor = await createActor(page, legalStack),
    source = await creationSource(legalStack);
  await page.setViewportSize({ width: 375, height: 900 });
  await prepareCreation(page, legalStack);
  await submitCreation(page);
  const request = await applyCreation(legalStack, actor.id);
  expect(request.status).toBe('DONE');
  expect(request.worldId).not.toBeNull();
  const id = request.worldId!;
  expect(await legalStack.db.world.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: 'PREOPEN',
    clockTick: 0,
    startYear: 191,
    ruleFeatures: [...creationFeatures],
  });
  expect(await legalStack.db.nation.count({ where: { worldId: id } })).toBe(21);
  expect(await legalStack.db.city.count({ where: { worldId: id } })).toBe(61);
  expect(await legalStack.db.general.count({ where: { worldId: id, userId: null } })).toBe(491);
  expect(await legalStack.db.general.count({ where: { worldId: id, userId: { not: null } } })).toBe(0);
  expect(await legalStack.db.generalTurn.count({ where: { worldId: id } })).toBe(491 * 30);
  expect(
    await legalStack.db.auditLog.count({ where: { action: 'world.create.requested', targetId: request.id } }),
  ).toBe(1);
  expect(await legalStack.db.auditLog.count({ where: { action: 'world.create.applied', worldId: id } })).toBe(1);
  expect(await endFootprint(legalStack, source.id, true)).toBe(source.fingerprint);
  expect(await legalStack.db.inputEvent.count({ where: { worldId: source.id } })).toBe(0);
  await createdResult(page);
  await responsiveCreation(page, 'done');
});
test('AC-M3-04 CH-02 직접 시드·프리셋·수동 턴·종료연도 없음이 저장값과 같다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  const controls = await prepareCreation(page, legalStack, '직접 지정 생성');
  await controls.getByLabel('프리셋', { exact: true }).selectOption('speed');
  await controls.getByLabel('턴 간격 (분)', { exact: true }).fill('7');
  await controls.getByLabel('자동 종료', { exact: true }).selectOption('none');
  await controls.getByLabel('시드 선택', { exact: true }).selectOption('custom');
  await controls.getByLabel('시드', { exact: true }).fill('지정 seed 그대로');
  await submitCreation(page);
  const request = await applyCreation(legalStack, actor.id);
  expect(await legalStack.db.world.findUniqueOrThrow({ where: { id: request.worldId! } })).toMatchObject({
    presetKey: 'speed',
    turnTermMinutes: 7,
    endYear: null,
    seed: '지정 seed 그대로',
  });
  await createdResult(page);
});
test('AC-M3-04 CH-03 실제 읽기 응답의 표식 변경 주입은 POST0으로 확인을 해제한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  const dialog = await reviewCreationPage(page);
  const original = await legalStack.db.gameResource.findUniqueOrThrow({
    where: { kind_name_version: { kind: 'SCENARIO', name: 'integration191', version: 1 } },
  });
  // 게시 행 변경을 흉내 내지 않는다. 실제 조회를 통과한 표식 비교 분기만 시험한다.
  let injected = 0;
  const restore = await actualRoute(page, 'admin.world.creationOptions', async (route) => {
    const response = await route.fetch({ timeout: 10_000 });
    expect(response.status()).toBe(200);
    const body = await response.json();
    const index = new URL(route.request().url()).pathname
      .split('/')
      .at(-1)!
      .split(',')
      .indexOf('admin.world.creationOptions');
    const packet = Array.isArray(body) ? body[index] : body;
    expect(packet.result.data).toMatchObject({
      userId: actor.id,
      profiles: [{ available: true, ruleFeatures: [...creationFeatures] }],
    });
    packet.result.data.revision = 'explicit-test-stamp-' + packet.result.data.revision;
    injected++;
    await route.fulfill({ response, json: body });
  });
  await withRestoration(
    async () => {
      await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
      await expect(
        dialog.getByText('생성 설정이 바뀌었습니다. 현재 내용을 다시 확인하세요.', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('checkbox')).not.toBeChecked();
      expect(await legalStack.db.worldCreateRequest.count({ where: { requestedBy: actor.id } })).toBe(0);
      expect(injected).toBe(1);
    },
    async () => {
      await restore();
      expect(await legalStack.db.gameResource.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    },
  );
});
test('AC-M3-04 CH-04 실제 커밋 뒤 응답 유실과 수동 같은 요청은 한 번만 생성한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  await actualRoute(page, 'admin.world.create', async (route) => {
    const response = await route.fetch({ timeout: 10_000 });
    expect(response.status()).toBe(200);
    await response.body();
    await route.abort();
  });
  const dialog = await reviewCreationPage(page);
  await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
  await expect(page.getByRole('button', { name: '요청 상태 확인', exact: true })).toBeVisible();
  const before = await createRequest(legalStack, actor.id);
  await page.getByRole('button', { name: '요청 상태 확인', exact: true }).click();
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '같은 요청 접수 확인', exact: true }).click();
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
  expect(await legalStack.db.worldCreateRequest.count({ where: { requestedBy: actor.id } })).toBe(1);
  expect((await createRequest(legalStack, actor.id)).effectiveSeed).toBe(before.effectiveSeed);
  await applyCreation(legalStack, actor.id);
  await createdResult(page);
});
test('AC-M3-04 CH-05 중복 확정·대기 중 운영 조치와 focus의 자동 POST를 막는다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  let posts = 0;
  page.on('request', (request) => {
    if (sanctionCalls(request, 'admin.world.create')) posts++;
  });
  const dialog = await reviewCreationPage(page);
  await dialog
    .getByRole('button', { name: '개장 전 월드 생성 요청', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '월드 조회', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await page.getByRole('button', { name: '계정과 생성 설정 다시 확인', exact: true }).click();
  expect(posts).toBe(1);
  await applyCreation(legalStack, actor.id);
  await createdResult(page);
});
test('AC-M3-04 CH-06 POST 직전 다른 ADMIN 쿠키로 바뀌면 두 계정 모두 미접수다', async ({ page, legalStack }) => {
  const a = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  let bId = '';
  await actualRoute(page, 'admin.world.create', async (route) => {
    bId = (await sanctionAccount(legalStack, page, true)).id;
    await route.continue();
  });
  const response = page.waitForResponse((item) => sanctionCalls(item.request(), 'admin.world.create'), {
    timeout: 15_000,
  });
  const dialog = await reviewCreationPage(page);
  await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
  expect((await response).status()).toBe(401);
  await (await response).body();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => bId).not.toBe('');
  expect(await legalStack.db.worldCreateRequest.count({ where: { requestedBy: { in: [a.id, bId] } } })).toBe(0);
});
test('AC-M3-04 CH-07 접수 뒤 권한 회수는 엔진 거부이며 화면은 재인증한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  await submitCreation(page);
  await changeAdminRole(legalStack.db, { email: actor.email, role: 'USER', reason: '생성 화면 권한 회수 반례' });
  const request = await applyCreation(legalStack, actor.id);
  expect(request.status).toBe('FAILED');
  expect(request.worldId).toBeNull();
  await page.getByRole('button', { name: '요청 상태 확인', exact: true }).click();
  await expect(page.getByText('생성 완료 · 개장 전', { exact: true })).toHaveCount(0);
});
test('AC-M3-04 CH-08 호출 한정 자원 읽기 누락은 실제 엔진 FAILED와 고정 사유다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  await submitCreation(page);
  const row = await legalStack.db.gameResource.findUniqueOrThrow({
    where: { kind_name_version: { kind: 'SCENARIO', name: 'integration191', version: 1 } },
  });
  // 이 호출의 조회 결과에서만 시나리오를 뺀다. 원 DB·delegate·prototype은 변경하지 않는다.
  const db = legalStack.db;
  let injected = 0;
  const missing = new Proxy(db, {
    get(target, key) {
      if (key === 'gameResource')
        return new Proxy(target.gameResource, {
          get(delegate, method) {
            if (method === 'findMany')
              return async (...args: Parameters<typeof delegate.findMany>) => {
                const rows = await delegate.findMany(...args);
                injected++;
                return rows.filter((entry) => entry.kind !== 'SCENARIO' || entry.name !== 'integration191');
              };
            const value = Reflect.get(delegate, method);
            return typeof value === 'function' ? value.bind(delegate) : value;
          },
        });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await withRestoration(
    async () => {
      const request = await createRequest(legalStack, actor.id);
      expect(await db.worldCreateRequest.count({ where: { status: 'PENDING' } })).toBe(1);
      await processWorldCreateRequest(missing, AbortSignal.timeout(20_000));
      expect(injected).toBe(1);
      expect(await db.worldCreateRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
        status: 'FAILED',
        errorCode: 'RESOURCE_INVALID',
        worldId: null,
      });
      expect(await db.world.count({ where: { id: request.plannedWorldId } })).toBe(0);
      await page.getByRole('button', { name: '요청 상태 확인', exact: true }).click();
      await expect(
        page.getByText('생성하지 않음 · 고정한 생성 자원을 확인하지 못했습니다.', { exact: true }),
      ).toBeVisible();
    },
    async () => {
      expect(await db.gameResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    },
  );
});
test('AC-M3-04 CH-09 실제429의 기한 뒤에도 자동 POST 없이 같은 요청만 수동 접수한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  const rateServer = await creationRateServer(legalStack);
  closers.push(rateServer.close);
  await page.route('**/trpc/**', (route) =>
    track(async () => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: rateServer.origin + url.pathname + url.search, timeout: 10_000 });
      await route.fulfill({ response });
    }),
  );
  await prepareCreation(page, legalStack);
  const dialog = await reviewCreationPage(page);
  const input = {
    expectedUserId: actor.id,
    idempotencyKey: randomUUID(),
    name: 'rate 준비',
    ...creationSelection,
    ruleFeatures: [...creationFeatures],
    seed: 'rate-preload',
    turnTermMinutes: 60,
    endYear: 201,
  };
  for (let i = 0; i < 120; i++) {
    const response = await page.request.post(rateServer.origin + '/trpc/admin.world.create', {
      data: input,
      headers: { Origin: legalStack.origin },
      timeout: 5000,
    });
    expect(response.status()).toBe(200);
    await response.body();
  }
  await applyCreation(legalStack, actor.id);
  await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
  await expect(page.getByText('요청이 많습니다. 잠시 뒤 같은 요청을 직접 확인하세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '같은 요청 접수 확인', exact: true })).toBeDisabled();
  await page.clock.install();
  rateServer.advance(61_000);
  await page.clock.fastForward(61_000);
  expect(await legalStack.db.worldCreateRequest.count({ where: { requestedBy: actor.id } })).toBe(1);
  await page.getByRole('button', { name: '같은 요청 접수 확인', exact: true }).click();
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
  await applyCreation(legalStack, actor.id);
  await createdResult(page);
});
test('AC-M3-04 CH-10 reload는 본인 추적 번호로 수동 조회만 복구한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await prepareCreation(page, legalStack);
  await submitCreation(page);
  const request = await createRequest(legalStack, actor.id);
  await page.reload();
  await page.getByRole('button', { name: '새 월드 생성 준비', exact: true }).click();
  await expect(page.getByRole('button', { name: '요청 상태 확인', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '같은 요청 접수 확인', exact: true })).toHaveCount(0);
  expect((await createRequest(legalStack, actor.id)).id).toBe(request.id);
  await applyCreation(legalStack, actor.id);
  await createdResult(page);
});
test('AC-M3-04 CH-11 보관 정보 손상은 생성 폼을 막고 원문을 노출하지 않는다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await page.goto(legalStack.origin + '/admin/worlds');
  await page.evaluate(
    (id) => sessionStorage.setItem(`opensamguk:admin-create:v1:${id}`, 'not-json-private-canary'),
    actor.id,
  );
  await page.getByRole('button', { name: '새 월드 생성 준비', exact: true }).click();
  await expect(
    page.getByText('보관한 요청 정보를 읽지 못했습니다. 관리자 기록에서 접수 여부를 먼저 확인하세요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('월드 이름', { exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('not-json-private-canary');
  expect(await legalStack.db.worldCreateRequest.count({ where: { requestedBy: actor.id } })).toBe(0);
});
test('AC-M3-08 CH-12 375px·44px·확인 취소·키보드와 공개 이미지0', async ({ page, legalStack }) => {
  await createActor(page, legalStack);
  const images: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'image') images.push(new URL(request.url()).pathname);
  });
  await prepareCreation(page, legalStack, '긴한글이름'.repeat(80));
  await responsiveCreation(page, 'form');
  await reviewCreationPage(page);
  await responsiveCreation(page, 'review');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '현재 설정 검토', exact: true })).toBeFocused();
  expect(images).toEqual([]);
});
