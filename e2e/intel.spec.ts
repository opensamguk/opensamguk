import { randomUUID } from 'node:crypto';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import type { Browser, Page, Response } from '@playwright/test';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeIntegrationResources } from '../tools/integration-resources';
import { ageLabel, crewText, levelLabel } from '../apps/web/src/intel/view';
import type { IntelRecordsResponse } from '../apps/web/src/intel/types';
import { test, expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';

// T4-13 AC-P2-07 기록 화면 몫. 공개 dist·실제 PG·HTTP·엔진 TurnLoop로 첩보를 실제로 실행한 기록을 본다.
// 원생성은 국가 둘·도시 넷·장수 셋으로 줄이고(저장 전 통제), 계정은 DB로 장수에 묶는다(t4-93 첫 고정물과 같은 통제).
// 기능은 월드 생성 옵션의 ruleFeatures로만 켠다. 제품 프리셋은 고치지 않는다.
const INTEL_FEATURES = ['five-stats', 'intel-v1', 'operational-map', 'policy'];
const PLAIN_FEATURES = ['five-stats', 'operational-map', 'policy'];
const NEAR_CREW = 6_000;

async function advanceWorld(stack: LegalStack, worldId: string, tick: number) {
  const lease = await acquireLease(stack.db, worldId);
  if (!lease) throw new Error('첩보 화면 시험 실행권을 얻지 못했습니다.');
  try {
    await new TurnLoop(stack.db, lease).advanceTo(tick);
  } finally {
    await releaseLease(stack.db, lease);
  }
}

function distances(cities: ReadonlyArray<{ cityKey: number; connections: readonly number[] }>, from: number) {
  const byKey = new Map(cities.map((city) => [city.cityKey, city]));
  const result = new Map([[from, 0]]);
  let frontier = [from];
  while (frontier.length) {
    const next: number[] = [];
    for (const key of frontier)
      for (const neighbor of byKey.get(key)?.connections ?? []) {
        if (result.has(neighbor) || !byKey.has(neighbor)) continue;
        result.set(neighbor, result.get(key)! + 1);
        next.push(neighbor);
      }
    frontier = next;
  }
  return result;
}

async function world(stack: LegalStack, features: string[], name: string) {
  const source = await loadInitialWorldFromDb(stack.db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'intel-records-ui',
  });
  source.ruleFeatures = [...features];
  const cityKinds = source.cities.filter((city) => city.kind !== 'PASS');
  let picked: { base: number; near: number; mid: number; far: number } | undefined;
  for (const city of cityKinds) {
    const map = distances(source.cities, city.cityKey);
    const at = (wanted: (distance: number) => boolean) =>
      cityKinds.find((other) => other.cityKey !== city.cityKey && wanted(map.get(other.cityKey) ?? Infinity))?.cityKey;
    const near = at((d) => d === 1),
      mid = at((d) => d === 2),
      far = at((d) => d >= 3 && d !== Infinity);
    if (near && mid && far) {
      picked = { base: city.cityKey, near, mid, far };
      break;
    }
  }
  if (!picked) throw new Error('거리 1·2·3 이상인 도시를 고를 수 없습니다.');
  const { base, near, mid, far } = picked;
  const [nationA, nationB] = [...source.nations].sort((a, b) => a.id - b.id);
  source.nations = [
    { ...nationA!, capitalCityKey: base },
    { ...nationB!, capitalCityKey: near },
  ];
  const kept = new Set(source.nations.map((nation) => nation.id));
  source.diplomacies = source.diplomacies.filter((row) => kept.has(row.nationA) && kept.has(row.nationB));
  for (const city of source.cities)
    city.nationId = city.cityKey === base ? nationA!.id : [near, mid, far].includes(city.cityKey) ? nationB!.id : null;
  const ruler = (nationId: number) =>
    source.generals.find((general) => general.nationId === nationId && general.officerLevel === 12)!;
  const spyRuler = {
    ...ruler(nationA!.id),
    cityKey: base,
    activeFromYear: source.startYear,
    crew: 0,
    gold: 10_000,
    rice: 10_000,
    nextTurnTick: 100,
  };
  const targetRuler = {
    ...ruler(nationB!.id),
    cityKey: near,
    activeFromYear: source.startYear,
    crew: NEAR_CREW,
    rice: 100_000,
    nextTurnTick: 1_000_000,
  };
  const ronin = {
    ...source.generals.find((general) => general.id !== spyRuler.id && general.id !== targetRuler.id)!,
    nationId: null,
    officerLevel: 0,
    cityKey: base,
    activeFromYear: source.startYear,
    nextTurnTick: 1_000_000,
  };
  source.generals = [spyRuler, targetRuler, ronin];
  const { worldId } = await saveInitialWorld(stack.db, source, {
    name,
    turnTermMinutes: 60,
    endYear: source.startYear + 10,
    replayFormat: 3,
    ruleFeatures: features,
  });
  await controlClock(stack.db, worldId, 'start');
  const nameOf = (key: number) => source.cities.find((city) => city.cityKey === key)!.name;
  return { worldId, base, near, mid, far, nameOf, spyRuler, targetRuler, ronin };
}

async function account(stack: LegalStack, worldId: string, generalId: number) {
  const id = randomUUID(),
    email = `${id}@example.test`,
    session = newSession(Date.now());
  await stack.db.user.create({
    data: {
      id,
      email,
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(TEST_PASSWORD),
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  await stack.db.general.update({
    where: { worldId_id: { worldId, id: generalId } },
    data: { userId: id, lastActiveTick: 0, lastActiveAt: new Date() },
  });
  return { id, email, token: session.token, cookie: `sid=${session.token}` };
}

async function rpc(stack: LegalStack, route: string, input: unknown, cookie: string) {
  const response = await fetch(`${stack.origin}/trpc/${route}?batch=1`, {
    method: 'POST',
    headers: { origin: stack.origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ 0: input }),
  });
  const [body] = (await response.json()) as Array<{ result?: { data: unknown }; error?: unknown }>;
  return { status: response.status, data: body?.result?.data, error: body?.error };
}

// httpBatchLink 주소 /trpc/a,b?batch=1에 intel.records가 들었는가.
const callsIntelRecords = (url: string) =>
  new URL(url).pathname.split(/[/,]/).map(decodeURIComponent).includes('intel.records');
const isIntelRecords = (response: Response) => callsIntelRecords(response.url());

async function intelData(response: Response): Promise<{ raw: unknown; data: IntelRecordsResponse }> {
  const paths = new URL(response.url()).pathname.slice('/trpc/'.length).split(',').map(decodeURIComponent);
  const body = (await response.json()) as Array<{ result?: { data: IntelRecordsResponse }; error?: unknown }>;
  const entry = body[paths.indexOf('intel.records')];
  if (!entry?.result) throw new Error(`intel.records 응답이 없습니다: ${JSON.stringify(entry)}`);
  return { raw: entry, data: entry.result.data };
}

async function loginByForm(page: Page, email: string) {
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

async function cookiePage(browser: Browser, stack: LegalStack, token: string) {
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'sid', value: token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return { context, page: await context.newPage() };
}

const panel = (page: Page) => page.getByRole('region', { name: '첩보 기록', exact: true });

test.setTimeout(240_000);

test('AC-P2-07 실제 첩보 기록을 자기 국가만 보고 세션이 바뀌면 남은 기록을 그리지 않는다', async ({
  legalStack: stack,
  browser,
}, info) => {
  await initializeIntegrationResources(stack.db);
  const game = await world(stack, INTEL_FEATURES, 'T4-13 첩보 기록 화면');
  const { worldId, near, mid, far, nameOf } = game;
  const [spy, target, ronin] = [
    await account(stack, worldId, game.spyRuler.id),
    await account(stack, worldId, game.targetRuler.id),
    await account(stack, worldId, game.ronin.id),
  ];
  await info.attach('intel-fixture-scope', {
    body: JSON.stringify({
      worldId,
      cities: { base: game.base, near, mid, far },
      realPostgres: true,
      realHttp: true,
      publicDist: true,
      realTurnsSet: true,
      engineTurnLoopSpy: true,
      controlledOrigin: true,
      controlledAccountBinding: true,
      presetChanged: false,
    }),
    contentType: 'application/json',
  });

  // 실제 turns.set으로 첩보 세 칸을 넣고 엔진이 달마다 한 칸씩 실행한다.
  const { turnRevision } = await stack.db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId, id: game.spyRuler.id } },
  });
  const commands = [near, mid, far].map((cityKey) => ({ commandKey: 'spy', args: { cityKey } }));
  const saved = await rpc(
    stack,
    'turns.set',
    { worldId, revision: turnRevision, slots: Array.from({ length: 30 }, (_, slot) => commands[slot] ?? null) },
    spy.cookie,
  );
  expect(saved.status, JSON.stringify(saved.error)).toBe(200);
  await advanceWorld(stack, worldId, 20_100);
  const stored = async () => {
    const row = await stack.db.worldExtSlice.findUnique({ where: { worldId_key: { worldId, key: 'intel' } } });
    return ((row?.value ?? {}) as Record<string, Record<string, { crew: number; level: number }>>)[
      String(game.spyRuler.nationId)
    ];
  };
  await expect.poll(async () => Object.keys((await stored()) ?? {}).length).toBe(3);
  const ledger = (await stored())!;

  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    const recordsUrl = `/w/${worldId}/records?tab=intel`;
    const atRecords = new RegExp(`/w/${worldId}/records\\?tab=intel$`);

    // 무인증은 로그인 화면으로 가고, 로그인하면 같은 탭으로 돌아온다.
    await page.goto(recordsUrl);
    await expect(page).toHaveURL(/\/login\?next=/);
    const spyResponse = page.waitForResponse(isIntelRecords);
    await loginByForm(page, spy.email);
    await expect(page).toHaveURL(atRecords);
    const { raw, data } = await intelData(await spyResponse);
    expect(data.enabled).toBe(true);
    const byKey = (a: number, b: number) => a - b;
    expect(data.items.map((item) => item.cityKey).sort(byKey)).toEqual([near, mid, far].sort(byKey));

    // 응답의 병력은 구간뿐이고 저장된 정확한 값이 그 안에 있다.
    for (const item of data.items) {
      expect(Object.keys(item.crew).sort()).toEqual(['max', 'min']);
      const exact = ledger[String(item.cityKey)]!.crew;
      expect(exact).toBeGreaterThanOrEqual(item.crew.min);
      if (item.crew.max !== null) expect(exact).toBeLessThanOrEqual(item.crew.max);
    }
    expect(JSON.stringify(raw)).not.toContain(`"crew":${ledger[String(near)]!.crew}`);
    const levels = Object.fromEntries(data.items.map((item) => [item.cityKey, item.level]));
    expect(levels).toEqual({ [near]: 1, [mid]: 2, [far]: 3 });

    const view = panel(page);
    await expect(view.getByRole('table', { name: '첩보 기록 3곳', exact: true })).toBeVisible();
    for (const item of data.items) {
      const row = view.getByRole('row', {
        name: `${nameOf(item.cityKey)} 첩보 기록, ${ageLabel(item.ageMonths)}, 정보 ${levelLabel(item.level)}`,
        exact: true,
      });
      await expect(row).toBeVisible();
      await expect(row).toContainText(`${item.year}년 ${item.month}월 · ${ageLabel(item.ageMonths)}`);
      await expect(row).toContainText(crewText(item.crew));
    }
    const nearRow = view.getByRole('row', { name: new RegExp(`^${nameOf(near)} 첩보 기록`) });
    await expect(nearRow).not.toContainText(NEAR_CREW.toLocaleString('ko-KR'));
    const farRow = view.getByRole('row', { name: new RegExp(`^${nameOf(far)} 첩보 기록`) });
    await expect(farRow.locator('td[title="정보를 어느 정도 이상 얻었을 때만 기록됩니다"]')).toHaveCount(5);
    await expect(farRow.locator('td[title="정보를 많이 얻었을 때만 기록됩니다"]')).toHaveCount(2);

    // 도시 이름은 메인 지도의 그 도시로 간다.
    await view.getByRole('button', { name: `${nameOf(near)}, 지도에서 보기`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${worldId}\\?city=${near}$`));

    // 새로고침·직접 주소로도 같은 탭이다.
    await page.goto(recordsUrl);
    await page.reload();
    await expect(panel(page).getByRole('table', { name: '첩보 기록 3곳', exact: true })).toBeVisible();

    // 한 달 뒤 같은 기록을 다시 읽으면 기록 당시 값은 같고 표시 나이만 늘어난다.
    await advanceWorld(stack, worldId, 20_100 + TICKS_PER_MONTH);
    const refreshResponse = page.waitForResponse(isIntelRecords);
    await panel(page).getByRole('button', { name: '다시 불러오기', exact: true }).click();
    const refreshed = await intelData(await refreshResponse);
    expect(refreshed.data.items).toEqual(data.items.map((item) => ({ ...item, ageMonths: item.ageMonths + 1 })));
    for (const item of refreshed.data.items) {
      const row = panel(page).getByRole('row', {
        name: `${nameOf(item.cityKey)} 첩보 기록, ${ageLabel(item.ageMonths)}, 정보 ${levelLabel(item.level)}`,
        exact: true,
      });
      await expect(row).toContainText(`${item.year}년 ${item.month}월 · ${ageLabel(item.ageMonths)}`);
    }

    // 같은 탭에서 로그아웃하고 다른 국가로 로그인한다. 그 국가의 응답이 오기 전에도 앞 계정의 기록을 그리지 않는다.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/trpc/**', async (route) => {
      if (callsIntelRecords(route.request().url())) await held;
      await route.continue();
    });
    await page.goto('/lobby');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page).toHaveURL('/login');
    await page.goto(`/login?next=${encodeURIComponent(recordsUrl)}`);
    const targetResponse = page.waitForResponse(isIntelRecords);
    await loginByForm(page, target.email);
    await expect(page).toHaveURL(atRecords);
    await expect(page.getByRole('heading', { name: '기록 · 첩보 기록', exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /첩보 기록, / })).toHaveCount(0);
    await expect(page.getByText(nameOf(far), { exact: true })).toHaveCount(0);
    release();
    const other = await intelData(await targetResponse);
    expect(other.data).toMatchObject({ enabled: true, items: [] });
    await expect(panel(page).getByText('아직 첩보 기록이 없습니다', { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /첩보 기록, / })).toHaveCount(0);
    await page.unroute('**/trpc/**');
  } finally {
    await context.close();
  }

  // 재야는 국가 소속 안내다.
  const roninView = await cookiePage(browser, stack, ronin.token);
  try {
    await roninView.page.goto(`/w/${worldId}/records?tab=intel`);
    await expect(
      panel(roninView.page).getByText('국가에 소속되면 나라의 첩보 기록을 봅니다', { exact: true }),
    ).toBeVisible();
  } finally {
    await roninView.context.close();
  }

  // 첩보를 켜지 않은 월드는 안내만 나온다.
  const plain = await world(stack, PLAIN_FEATURES, 'T4-13 첩보 꺼진 월드');
  const plainUser = await account(stack, plain.worldId, plain.spyRuler.id);
  const plainView = await cookiePage(browser, stack, plainUser.token);
  try {
    const response = plainView.page.waitForResponse(isIntelRecords);
    await plainView.page.goto(`/w/${plain.worldId}/records?tab=intel`);
    expect((await intelData(await response)).data).toEqual({ enabled: false, items: [] });
    await expect(panel(plainView.page).getByText('이 월드에서는 첩보를 쓰지 않습니다', { exact: true })).toBeVisible();
  } finally {
    await plainView.context.close();
  }
});
