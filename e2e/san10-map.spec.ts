import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { sanctionAccount } from './adminSanctionSetup';
import { holdLease, type LeaseHold } from './game';
import { releaseLease } from '../apps/engine/src/lease';
import { initializeSan10Resources } from '../tools/san10-resources';
import { loadInitialWorld, loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { hashState } from '../packages/shared/src/node/hashState';
import type { WorldMap } from '../apps/web/src/game/types';

// AC-INT-02/03/04/10: 새 지도 두 모드의 공개 dist·실제 PG·입력·월 정산·재생이다.
// 기존 61거점/132개월 인수는 이 152거점 판의 기수 완료로 세지 않는다.
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
];
type Run = {
  controller: AbortController;
  holds: LeaseHold[];
  body?: Promise<void>;
  requests: Set<Promise<unknown>>;
  errors: unknown[];
  worlds: string[];
  passed: boolean;
  scenario: string;
  timer: ReturnType<typeof setTimeout>;
};
let current: Run | undefined;
function track<T>(run: Run, work: () => Promise<T>): Promise<T> {
  const promise = Promise.resolve().then(work);
  run.requests.add(promise);
  void promise.then(
    () => run.requests.delete(promise),
    (error) => {
      run.errors.push(error);
      run.requests.delete(promise);
    },
  );
  return promise;
}
async function step<T>(run: Run, work: () => Promise<T>) {
  run.controller.signal.throwIfAborted();
  const result = await work();
  run.controller.signal.throwIfAborted();
  return result;
}
async function api<T>(run: Run, page: Page, stack: LegalStack, path: string, input: unknown, mutation = false) {
  return track(run, async () => {
    const response = mutation
      ? await page.request.post(stack.origin + '/trpc/' + path, {
          data: input,
          headers: { Origin: stack.origin },
          timeout: 15_000,
        })
      : await page.request.get(stack.origin + '/trpc/' + path + '?input=' + encodeURIComponent(JSON.stringify(input)), {
          timeout: 15_000,
        });
    const body = (await response.json()) as { result?: { data?: T }; error?: { data?: { code?: string } } };
    expect(response.status(), path).toBe(200);
    expect(body.error, path).toBeUndefined();
    expect(body.result?.data, path).toBeDefined();
    return body.result!.data!;
  });
}
test.afterEach(async ({ legalStack, page }, info) => {
  const run = current;
  if (!run) return;
  clearTimeout(run.timer);
  if (info.status !== info.expectedStatus) legalStack.failed = true;
  run.controller.abort();
  try {
    await page.close();
  } catch (error) {
    run.errors.push(error);
  }
  if (run.body) await Promise.allSettled([run.body]);
  while (run.requests.size) await Promise.allSettled([...run.requests]);
  for (const hold of run.holds.reverse()) {
    hold.done.abort();
    for (const close of [
      async () => {
        await hold.renewal;
        if (hold.lost) throw hold.lost;
      },
      () => releaseLease(hold.db, hold.lease),
      () => hold.db.$disconnect(),
    ])
      try {
        await close();
      } catch (error) {
        run.errors.push(error);
      }
  }
  const errors = [...new Set(run.errors)];
  if (errors.length || !run.passed) legalStack.failed = true;
  // 실패 월드·계정은 전용 legalStack DB 안에 보존한다. 성공 DB의 OID/연결0/DROP은 원 fixture가 판정한다.
  await mkdir('test-results', { recursive: true });
  try {
    await writeFile(
      join('test-results', `san10-${legalStack.database}-${run.scenario}.json`),
      JSON.stringify(
        {
          database: legalStack.database,
          scenario: run.scenario,
          worlds: run.worlds,
          publicBuild: true,
          bodyPassed: run.passed,
          bodySettled: true,
          pendingRequests: run.requests.size,
          leaseConnectionsClosed: errors.length === 0,
          errorCount: errors.length,
          failed: legalStack.failed,
          worldRowsPreservedUntilOwnedDatabaseCleanup: true,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  } catch (error) {
    errors.push(error);
    legalStack.failed = true;
  }
  current = undefined;
  if (errors.length) throw new AggregateError(errors, 'SAN10 본문·HTTP·실행권 정리 실패');
});

async function verifyMode(stack: LegalStack, page: Page, info: TestInfo, run: Run) {
  const db = stack.db,
    { scenario } = run,
    signal = run.controller.signal;
  const user = await step(run, () => sanctionAccount(stack, page));
  const existing = await step(run, () => db.gameResource.findMany({ orderBy: { id: 'asc' } }));
  const legacy = await step(run, () =>
    loadInitialWorld({
      map: 'integration',
      scenario: 'integration191',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'san10-old-isolation',
    }),
  );
  expect(legacy.cities).toHaveLength(61);
  const old = await step(run, () =>
    saveInitialWorld(db, legacy, {
      name: 'SAN10 기존 판 보존',
      turnTermMinutes: 60,
      endYear: 201,
    }),
  );
  run.worlds.push(old.worldId);
  const oldHash = hashState(await step(run, () => readWorldState(db, old.worldId)));
  await step(run, () => initializeSan10Resources(db));
  for (const row of existing)
    expect(await step(run, () => db.gameResource.findUniqueOrThrow({ where: { id: row.id } }))).toEqual(row);
  const selection = { map: 'san10', scenario, seed: `san10-e2e-${scenario}` };
  const initial = await step(run, () => loadInitialWorldFromDb(db, selection));
  expect(initial.cities).toHaveLength(152);
  expect(initial.operationalMap!.sites).toHaveLength(153);
  expect(initial.operationalMap!.routes).toHaveLength(200);
  expect([initial.startYear, initial.nations.length, initial.generals.length]).toEqual(
    scenario === 'san10-empty' ? [180, 0, 491] : [191, 21, 491],
  );
  expect(hashState(initial)).toBe(hashState(await step(run, () => loadInitialWorldFromDb(db, selection))));
  initial.ruleFeatures = [...features];
  const saved = await step(run, () =>
    saveInitialWorld(db, initial, {
      name: scenario,
      turnTermMinutes: 60,
      endYear: 300,
      ruleFeatures: [...features],
    }),
  );
  run.worlds.push(saved.worldId);
  const { worldId } = saved;
  const world = await step(run, () => db.world.findUniqueOrThrow({ where: { id: worldId } }));
  expect(world.replayFormat).toBe(3);
  expect(world.ruleFeatures).toEqual(features);
  const before = await step(run, () => db.$transaction((tx) => loadReplayState(tx, worldId)));
  expect(Object.keys(before.state.cityResources!.cities).sort()).toEqual(
    initial.cities.map((row) => String(row.cityKey)).sort(),
  );
  expect(Object.values(before.state.cityResources!.cities)).toHaveLength(152);
  for (const ledger of Object.values(before.state.cityResources!.cities))
    expect(ledger).toEqual({ gold: 0, rice: 0, garrison: [] });
  expect((await step(run, () => readWorldState(db, worldId))).operationalMap).toEqual(initial.operationalMap);
  const hold = await step(run, async () => {
    const acquired = await holdLease(worldId);
    run.holds.push(acquired);
    return acquired;
  });
  await step(run, () => controlClock(hold.db, worldId, 'start'));
  const creating = api<{ status: string }>(
    run,
    page,
    stack,
    'general.create',
    {
      worldId,
      name: '지도검증',
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    },
    true,
  );
  await step(run, () =>
    expect
      .poll(
        () => db.inputEvent.count({ where: { worldId, userId: user.id, kind: 'general.create', status: 'PENDING' } }),
        { timeout: 10_000 },
      )
      .toBe(1),
  );
  const loop = new TurnLoop(hold.db, hold.lease);
  await step(run, () => loop.advanceTo(0, signal));
  expect((await step(run, () => creating)).status).toBe('created');
  const human = await step(run, () =>
    db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.id } } }),
  );
  expect(await step(run, () => db.generalTurn.count({ where: { worldId, generalId: human.id } }))).toBe(30);
  expect(await step(run, () => db.general.count({ where: { worldId, userId: null } }))).toBe(491);
  // 실제 전체 NPC와 새 도시 원장으로 한 달을 정산하고 저장한 원본 입력을 재생한다.
  await step(run, () => loop.advanceTo(10_000, signal));
  if (hold.lost) throw hold.lost;
  const stored = await step(run, () => db.world.findUniqueOrThrow({ where: { id: worldId } }));
  expect(stored.monthlyTick).toBe(10_000);
  const live = await step(run, () => db.$transaction((tx) => loadReplayState(tx, worldId)));
  expect(Object.keys(live.state.cityResources!.cities).sort()).toEqual(
    Object.keys(before.state.cityResources!.cities).sort(),
  );
  const archive = await step(run, () => exportReplay(db, worldId));
  expect(archive.version).toBe(3);
  const months = replayArchive(archive, 1);
  const snapshot = await step(run, () =>
    db.yearbookSnapshot.findUniqueOrThrow({ where: { worldId_tick: { worldId, tick: 10_000 } } }),
  );
  expect(months).toEqual([{ tick: 10_000, stateHash: snapshot.stateHash }]);
  const data = await step(run, () => api<WorldMap>(run, page, stack, 'world.map', { worldId }));
  expect(data.cities).toHaveLength(152);
  expect(data.operationalMap!.sites).toHaveLength(153);
  expect(data.operationalMap!.routes).toHaveLength(200);
  expect(data.operationalMap!.routes.every((route) => route.enabled && route.mode === 'LAND')).toBe(true);
  expect(JSON.stringify(data.operationalMap)).not.toMatch(/"(?:population|initial|max|crew|gold|rice|generals)"/);
  await step(run, () => page.goto(`${stack.origin}/w/${worldId}/map`));
  const map = page.getByTestId('world-map');
  await step(run, () => expect(map).toBeVisible());
  await step(run, () => expect(page.getByRole('alert')).toHaveCount(0));
  // D-049: 항구 시설을 뺀 153표식을 모두 그린다.
  await step(run, () => expect(map.locator('[data-site-kind]')).toHaveCount(153));
  await step(run, () => expect(map.locator('[data-route-mode="LAND"]')).toHaveCount(200));
  const overview = await step(run, () => map.getAttribute('viewBox'));
  const [x, y, w, h] = overview!.split(' ').map(Number);
  for (const site of data.operationalMap!.sites) {
    expect(site.position.x).toBeGreaterThanOrEqual(x!);
    expect(site.position.x).toBeLessThanOrEqual(x! + w!);
    expect(site.position.y).toBeGreaterThanOrEqual(y!);
    expect(site.position.y).toBeLessThanOrEqual(y! + h!);
  }
  await step(run, () => page.setViewportSize({ width: 375, height: 812 }));
  const selector = page.getByRole('combobox', { name: '지도 거점' });
  await step(run, () => expect(selector.locator('option')).toHaveCount(153));
  const yamatai = data.cities.find((city) => city.name === '야마타이국')!;
  await step(run, () => selector.selectOption(String(yamatai.key)));
  await step(run, () => expect(map).toHaveAttribute('viewBox', overview!));
  const box = await step(run, () => map.boundingBox());
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  const screenshot = info.outputPath(`${scenario}-map-375.png`);
  await step(run, () =>
    page.screenshot({ path: screenshot, fullPage: true, mask: [page.getByText(user.email, { exact: false })] }),
  );
  await info.attach('새 지도 375px', { path: screenshot, contentType: 'image/png' });
  expect(hashState(await step(run, () => readWorldState(db, old.worldId)))).toBe(oldHash);
  expect(await step(run, () => initializeSan10Resources(db))).toEqual({ inserted: 0, existing: 3 });
  expect(await step(run, () => db.inputEvent.count({ where: { worldId, status: 'PENDING' } }))).toBe(0);
}

for (const scenario of ['san10-191', 'san10-empty']) {
  test(`D-045 ${scenario}: 실제 PG·공개 dist·152도시 원장·월 정산·재생·153표식과 200도로`, async ({
    legalStack,
    page,
  }, info) => {
    const controller = new AbortController();
    const run: Run = {
      controller,
      holds: [],
      requests: new Set(),
      errors: [],
      worlds: [],
      passed: false,
      scenario,
      timer: setTimeout(() => {
        legalStack.failed = true;
        controller.abort(new Error('SAN10 원120초 시험의 본문110초 정착 경계'));
      }, 110_000),
    };
    current = run;
    run.body = verifyMode(legalStack, page, info, run);
    try {
      await run.body;
      run.passed = true;
    } catch (error) {
      legalStack.failed = true;
      run.errors.push(error);
      throw error;
    }
  });
}
