import { readFile } from 'node:fs/promises';
import type { Page, Request, Response, TestInfo } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { sanctionCalls } from './adminSanctionSetup';
import { createActor, creationSource, reviewCreationPage, applyCreation, createdResult } from './adminCreateSetup';
import { endFootprint } from './adminEndSetup';
import { initializeSan10Resources } from '../tools/san10-resources';
import { initializeExpandedResources } from '../tools/expanded-resources';
import { loadReplayState } from '../apps/engine/src/monthly';
import { hashState } from '../packages/shared/src/node/hashState';
import { creationFeatures } from '../apps/server/src/admin/worldCreateOptions';
import type { CreateInput, CreateOptions, CreateReply } from '../apps/web/src/admin/adminCreateModel';
import type { WorldMap } from '../apps/web/src/game/types';

// AC-M3-04/AC-INT-04: 관리자 화면 선택→접수→원생성→지도 연결만 검사한다.
// 인접 san10-map의 월 정산·재생·도로·기수 인수와 기존 legacy12의 인수 주장을 대신하지 않는다.
// AC-P2-23: san10-191-expanded(expanded-191-v4)도 같은 실제 선택→접수→원생성→지도 경로로 검사한다.
// AC-P2-08·09: san10-191-lifecycle(expanded-191-v5)도 같은 경로로 검사한다. v4 선택과 19기능 단언은 그대로 둔다.
test.describe.configure({ mode: 'serial' });
type FeatureProfileSource = { key: string; ruleFeatures: string[]; featureData: Record<string, unknown> };
// resources/feature-profile/expanded-191-v4.json의 ruleFeatures 정확 목록(19개). 아래에서 파일 원문과도 대조한다.
const v4Features = [
  'battle-affinity-v2',
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'city-scale-v1',
  'equipment-v1',
  'five-stats',
  'governance-v1',
  'heritage-v1',
  'lineage-v1',
  'logistics-v1',
  'nation-strategy-v1',
  'operational-map',
  'personnel',
  'policy',
  'reputation-v1',
  'stratagem-basic',
  'stratagem-cards-v1',
  'treaty',
] as const;
const v4FeatureData = [
  'equipment-v1',
  'governance-v1',
  'heritage-v1',
  'lineage-v1',
  'logistics-v1',
  'stratagem-cards-v1',
] as const;
// resources/feature-profile/expanded-191-v5.json의 ruleFeatures 정확 목록(20개). v4의 19개에 nation-lifecycle-v1만 더한 정렬 목록이다.
const v5Features = [
  'battle-affinity-v2',
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'city-scale-v1',
  'equipment-v1',
  'five-stats',
  'governance-v1',
  'heritage-v1',
  'lineage-v1',
  'logistics-v1',
  'nation-lifecycle-v1',
  'nation-strategy-v1',
  'operational-map',
  'personnel',
  'policy',
  'reputation-v1',
  'stratagem-basic',
  'stratagem-cards-v1',
  'treaty',
] as const;
const featureCounts = { 'expanded-191-v3': 15, 'expanded-191-v4': 19, 'expanded-191-v5': 20 } as const;
const modes = [
  { id: 'san10-191', year: 191, nations: 21, preset: 'regular', endYear: 201, anchors: 155, profile: null },
  { id: 'san10-empty', year: 180, nations: 0, preset: 'empty', endYear: 190, anchors: 155, profile: null },
  {
    id: 'integration-v01-expanded',
    year: 191,
    nations: 21,
    preset: 'regular',
    endYear: 231,
    anchors: 61,
    profile: 'expanded-191-v3',
  },
  {
    id: 'san10-191-expanded',
    year: 191,
    nations: 21,
    preset: 'regular',
    endYear: 231,
    anchors: 155,
    profile: 'expanded-191-v4',
  },
  {
    id: 'san10-191-lifecycle',
    year: 191,
    nations: 21,
    preset: 'regular',
    endYear: 231,
    anchors: 155,
    profile: 'expanded-191-v5',
  },
] as const;
type Mode = (typeof modes)[number];
type Run = {
  info: TestInfo;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  errors: Set<unknown>;
  timer: ReturnType<typeof setTimeout>;
  body?: Promise<void>;
  passed: boolean;
  receipt: Record<string, unknown>;
};
let current: Run | undefined;
function step<T>(run: Run, work: () => Promise<T>): Promise<T> {
  run.controller.signal.throwIfAborted();
  const promise = Promise.resolve()
    .then(work)
    .then((value) => {
      run.controller.signal.throwIfAborted();
      return value;
    });
  run.pending.add(promise);
  void promise.then(
    () => run.pending.delete(promise),
    (error) => {
      run.errors.add(error);
      run.pending.delete(promise);
    },
  );
  return promise;
}
async function data<T>(response: Response, path: string): Promise<T> {
  const names = new URL(response.url()).pathname.split('/').at(-1)!.split(',');
  const index = names.indexOf(path);
  expect(index).toBeGreaterThanOrEqual(0);
  type Packet = { result?: { data: T }; error?: unknown };
  const body = (await response.json()) as Packet | Packet[];
  const packet = Array.isArray(body) ? body[index] : body;
  expect(packet?.error).toBeUndefined();
  expect(packet?.result?.data).toBeDefined();
  return packet!.result!.data;
}

test.afterEach(async ({ page, legalStack }, info) => {
  const run = current;
  if (!run) return;
  clearTimeout(run.timer);
  if (info.status !== info.expectedStatus || !run.passed) legalStack.failed = true;
  run.controller.abort();
  try {
    await page.close();
  } catch (error) {
    run.errors.add(error);
  }
  if (run.body) await Promise.allSettled([run.body]);
  while (run.pending.size) await Promise.allSettled([...run.pending]);
  if (run.errors.size) legalStack.failed = true;
  if (!legalStack.failed) {
    try {
      expect(await legalStack.db.worldCreateRequest.count({ where: { status: 'PENDING' } })).toBe(0);
    } catch (error) {
      run.errors.add(error);
      legalStack.failed = true;
    }
  }
  try {
    await info.attach('관리자 프로필 선택 인수', {
      body: Buffer.from(
        JSON.stringify({
          ...run.receipt,
          database: legalStack.database,
          bodyPassed: run.passed,
          bodySettled: true,
          pendingSteps: run.pending.size,
          cleanupErrorCount: run.errors.size,
          failed: legalStack.failed,
          cleanupOwner:
            'legalFixture: failed/uncertain DB preserved; clean success requires same OID and zero connections',
        }),
      ),
      contentType: 'application/json',
    });
  } catch (error) {
    run.errors.add(error);
    legalStack.failed = true;
  }
  current = undefined;
  // 행을 직접 지우지 않는다. 실패·불확실 정리의 자기 DB는 원 fixture가 보존한다.
  if (run.errors.size) throw new AggregateError([...run.errors], '관리자 프로필 선택 본문 또는 정착 실패');
});

async function verifySelection(page: Page, stack: LegalStack, mode: Mode, run: Run) {
  const db = stack.db;
  const expanded = mode.profile !== null;
  const unitSetKey = mode.id === 'integration-v01-expanded' ? 'basic' : 'expanded';
  const features =
    mode.profile === 'expanded-191-v5'
      ? [...v5Features]
      : mode.profile === 'expanded-191-v4'
        ? [...v4Features]
        : expanded
          ? [...creationFeatures, 'equipment-v1', 'governance-v1', 'heritage-v1', 'lineage-v1', 'logistics-v1'].sort()
          : [...creationFeatures];
  const actor = await step(run, () => createActor(page, stack));
  const legacy = await step(run, () => creationSource(stack));
  // 새 scenario san10-191@2 게시는 기존 SAN10 초기화를 포함하는 initializeExpandedResources로만 한다.
  if (mode.id === 'san10-191-expanded' || mode.id === 'san10-191-lifecycle')
    await step(run, () => initializeExpandedResources(db));
  else await step(run, () => initializeSan10Resources(db));
  const beforeWorlds = await step(run, () => db.world.findMany({ select: { id: true }, orderBy: { id: 'asc' } }));
  const writes: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && sanctionCalls(request, 'admin.world.create')) writes.push(request);
  });
  await step(run, () => page.goto(stack.origin + '/admin/worlds'));
  const controls = page.getByRole('region', { name: '새 월드 생성', exact: true });
  const [optionsResponse] = await Promise.all([
    step(run, () =>
      page.waitForResponse((item) => sanctionCalls(item.request(), 'admin.world.creationOptions'), { timeout: 10_000 }),
    ),
    step(run, () => controls.getByRole('button', { name: '새 월드 생성 준비', exact: true }).click()),
  ]);
  expect(optionsResponse.status()).toBe(200);
  const options = await step(run, () => data<CreateOptions>(optionsResponse, 'admin.world.creationOptions'));
  expect(options.userId).toBe(actor.id);
  expect(options.profiles.map((profile) => profile.id)).toEqual([
    'integration-v01',
    'san10-191',
    'san10-empty',
    'integration-v01-expanded',
    'san10-191-expanded',
    'san10-191-lifecycle',
    'san10-191-research',
    'san10-191-border-return',
  ]);
  const profile = options.profiles.find((entry) => entry.id === mode.id);
  expect(profile?.available).toBe(true);
  if (!profile?.available) throw new Error('실제 게시 SAN10 프로필을 확인하세요.');
  expect([profile.startYear, profile.counts.nations, profile.counts.generals]).toEqual([mode.year, mode.nations, 491]);
  expect(profile.ruleFeatures).toEqual(features);
  expect(profile.ruleFeatures).toHaveLength(mode.profile === null ? 10 : featureCounts[mode.profile]);
  expect(profile.resources).toHaveLength(5);
  expect(profile.selection.unitSetKey).toBe(unitSetKey);
  expect(profile.featureProfileKey).toBe(mode.profile ?? undefined);
  if (mode.id === 'san10-191-expanded' || mode.id === 'san10-191-lifecycle') {
    expect(profile.selection).toEqual({
      mapKey: 'san10',
      scenarioKey: 'san10-191@2',
      unitSetKey: 'expanded',
      statRulesKey: 'five-stats',
      portraitMapKey: '191-map',
    });
    expect([profile.counts.cities, profile.counts.gates, profile.counts.anchors]).toEqual([147, 8, 155]);
    expect(profile.suggestedEndYear).toBe(231);
    expect(profile.resources.find((ref) => ref.kind === 'SCENARIO')).toMatchObject({ key: 'san10-191', version: 2 });
    const sourceUrl = new URL(`../resources/feature-profile/${mode.profile}.json`, import.meta.url);
    const source = JSON.parse(await step(run, () => readFile(sourceUrl, 'utf8'))) as FeatureProfileSource;
    expect(source.key).toBe(mode.profile);
    expect(source.ruleFeatures).toEqual(features);
    expect(Object.keys(source.featureData).sort()).toEqual([...v4FeatureData]);
    if (mode.id === 'san10-191-lifecycle') {
      // v5 원본은 v4 원본과 key·nation-lifecycle-v1만 다르다. 자원 키 5개와 featureData 6개는 그대로다.
      const v4Url = new URL('../resources/feature-profile/expanded-191-v4.json', import.meta.url);
      const v4Source = JSON.parse(await step(run, () => readFile(v4Url, 'utf8'))) as FeatureProfileSource;
      expect(v4Source.ruleFeatures).toEqual([...v4Features]);
      expect(source).toEqual({ ...v4Source, key: 'expanded-191-v5', ruleFeatures: [...v5Features] });
      // 같은 목록의 기존 v4 선택은 같은 5자원·19기능으로 그대로 남는다.
      expect(options.profiles.find((entry) => entry.id === 'san10-191-expanded')).toMatchObject({
        available: true,
        featureProfileKey: 'expanded-191-v4',
        ruleFeatures: [...v4Features],
        selection: profile.selection,
        resources: profile.resources,
      });
    }
  }
  const published = await step(run, () => db.gameResource.findMany({ where: { status: 'PUBLISHED' } }));
  const pinned = profile.resources.map((ref) => {
    const matches = published.filter(
      (row) => row.kind === ref.kind && row.name === ref.key && row.version === ref.version,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.contentHash).toBe(ref.contentHash);
    expect(hashState(matches[0]!.content)).toBe(ref.contentHash);
    return { kind: ref.kind, name: ref.key, version: ref.version, contentHash: ref.contentHash };
  });
  const selector = controls.getByLabel('시나리오', { exact: true });
  await step(run, () => expect(selector).toBeEnabled());
  await step(run, () => expect(selector).toHaveValue('san10-191'));
  if (mode.id !== 'san10-191') await step(run, () => selector.selectOption(mode.id));
  await step(run, () => expect(selector).toHaveValue(mode.id));
  // 자원 요약 접힘·375/1440px 화면 검사는 기존 v3 프로필에만 유지한다. v4·v5 화면 문구는 UI 원문 미확인이라 단언하지 않는다.
  if (mode.id === 'integration-v01-expanded') {
    const resource = controls.getByText(profile.selection.scenarioKey, { exact: true });
    const resourceSummary = controls.getByText('사용 자원 확인', { exact: true });
    await step(run, () => expect(resource).toBeAttached());
    await step(run, () => expect(resource).not.toBeVisible());
    await step(run, () => resourceSummary.click());
    await step(run, () => expect(resource).toBeVisible());
    await step(run, () => resourceSummary.press('Enter'));
    await step(run, () => expect(resource).not.toBeVisible());
    const originalViewport = page.viewportSize();
    for (const width of [375, 1440]) {
      await step(run, () => page.setViewportSize({ width, height: 900 }));
      await step(run, () => expect(controls.getByText(/철·목재·말과 수송망/)).toBeVisible());
      await step(run, async () => {
        const screenshot = run.info.outputPath(`expanded-world-selection-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await run.info.attach(`확장 월드 선택 ${width}px`, {
          path: screenshot,
          contentType: 'image/png',
        });
      });
      expect(await step(run, () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))).toBe(true);
    }
    if (originalViewport) await step(run, () => page.setViewportSize(originalViewport));
  }
  const preset = controls.getByLabel('프리셋', { exact: true });
  expect(
    await step(run, () =>
      preset.locator('option').evaluateAll((rows) => rows.map((row) => (row as HTMLOptionElement).value)),
    ),
  ).toEqual(['', ...profile.presets.map((entry) => entry.key)]);
  await step(run, () => controls.getByLabel('월드 이름', { exact: true }).fill('관리자 선택 ' + mode.id));
  await step(run, () => preset.selectOption(mode.preset));
  await step(run, () =>
    expect(controls.getByLabel('종료 연도', { exact: true })).toHaveAttribute('min', String(mode.year)),
  );
  await step(run, () => expect(controls.getByLabel('종료 연도', { exact: true })).toHaveValue(String(mode.endYear)));
  await step(run, () => controls.getByLabel('시드 선택', { exact: true }).selectOption('custom'));
  const seed = 'admin-create-profile-' + mode.id;
  await step(run, () => controls.getByLabel('시드', { exact: true }).fill(seed));
  const dialog = await step(run, () => reviewCreationPage(page));
  await step(run, () => expect(dialog.getByText(profile.label, { exact: true })).toBeVisible());
  await step(run, () =>
    expect(dialog.getByText(new RegExp(`${mode.year}년 · ${mode.nations}국 · NPC 491명`))).toBeVisible(),
  );
  for (const ref of Object.values(profile.selection))
    await step(run, () => expect(dialog.getByText(ref, { exact: true })).toBeVisible());
  expect(writes).toHaveLength(0);
  expect(await step(run, () => db.worldCreateRequest.count({ where: { requestedBy: actor.id } }))).toBe(0);
  const [response] = await Promise.all([
    step(run, () =>
      page.waitForResponse(
        (item) => item.request().method() === 'POST' && sanctionCalls(item.request(), 'admin.world.create'),
        { timeout: 10_000 },
      ),
    ),
    step(run, () => dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click()),
  ]);
  expect(response.status()).toBe(200);
  await step(run, () =>
    expect(controls.getByRole('button', { name: '같은 요청 접수 확인', exact: true })).toBeEnabled(),
  );
  expect(writes).toHaveLength(1);
  const input = (writes[0]!.postDataJSON() as Record<string, CreateInput>)['0']!;
  expect(input.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(input).toEqual({
    expectedUserId: actor.id,
    idempotencyKey: input.idempotencyKey,
    name: '관리자 선택 ' + mode.id,
    ...profile.selection,
    ...(mode.profile === null ? {} : { featureProfileKey: mode.profile }),
    presetKey: mode.preset,
    recruitmentLocation: 'city',
    turnTermMinutes: profile.presets.find((entry) => entry.key === mode.preset)!.turnTermMinutes,
    endYear: mode.endYear,
    seed,
    ruleFeatures: features,
  });
  const requests = await step(run, () => db.worldCreateRequest.findMany({ where: { requestedBy: actor.id } }));
  expect(requests).toHaveLength(1);
  const pending = requests[0]!;
  expect(pending).toMatchObject({
    status: 'PENDING',
    worldId: null,
    idempotencyKey: input.idempotencyKey,
    effectiveSeed: seed,
  });
  expect(await step(run, () => data<CreateReply>(response, 'admin.world.create'))).toEqual({
    userId: actor.id,
    requestId: pending.id,
    idempotencyKey: input.idempotencyKey,
    status: 'PENDING',
    worldId: null,
    error: null,
  });
  Object.assign(run.receipt, { requestId: pending.id, nonce: input.idempotencyKey, legacyWorldId: legacy.id });
  expect(await step(run, () => db.world.findUnique({ where: { id: pending.plannedWorldId } }))).toBeNull();
  const result = await step(run, () => applyCreation(stack, actor.id));
  expect(result).toMatchObject({ id: pending.id, status: 'DONE', worldId: pending.plannedWorldId, errorCode: null });
  const worldId = result.worldId!;
  Object.assign(run.receipt, { worldId });
  const world = await step(run, () => db.world.findUniqueOrThrow({ where: { id: worldId } }));
  expect(world).toMatchObject({
    status: 'PREOPEN',
    clockTick: 0,
    monthlyTick: 0,
    startedAt: null,
    startYear: mode.year,
    scenarioKey: profile.selection.scenarioKey,
    mapKey: profile.selection.mapKey,
    unitSetKey,
    seed,
    presetKey: mode.preset,
    endYear: mode.endYear,
    ruleFeatures: features,
  });
  expect(result.resolution).toMatchObject({
    selection: {
      map: profile.selection.mapKey,
      scenario: profile.selection.scenarioKey,
      unitSet: unitSetKey,
      statRules: 'five-stats',
      portraitMap: '191-map',
    },
    presetKey: mode.preset,
    initialStateHash: world.initialStateHash,
  });
  if (mode.profile !== null)
    expect(result.resolution).toMatchObject({
      featureProfile: { key: mode.profile, contentHash: profile.featureProfileHash },
    });
  expect((result.resolution as { resources: unknown[] }).resources).toEqual(expect.arrayContaining(pinned));
  expect((result.resolution as { resources: unknown[] }).resources).toHaveLength(5);
  expect(await step(run, () => db.nation.count({ where: { worldId } }))).toBe(mode.nations);
  expect(await step(run, () => db.general.count({ where: { worldId, userId: null } }))).toBe(491);
  expect(await step(run, () => db.general.count({ where: { worldId, userId: { not: null } } }))).toBe(0);
  const cities = await step(run, () =>
    db.city.findMany({ where: { worldId }, select: { cityKey: true }, orderBy: { cityKey: 'asc' } }),
  );
  expect(cities).toHaveLength(profile.counts.cities + profile.counts.gates);
  const keys = cities.map((city) => String(city.cityKey)).sort();
  const replay = await step(run, () => db.$transaction((tx) => loadReplayState(tx, worldId)));
  if (expanded) {
    expect(replay.state.logistics).toBeDefined();
    expect(replay.state.governance).toBeDefined();
    expect(replay.state.lineage).toBeDefined();
  }
  expect(Object.keys(replay.state.cityResources!.cities).sort()).toEqual(keys);
  for (const row of Object.values(replay.state.cityResources!.cities))
    expect(row).toEqual({ gold: 0, rice: 0, garrison: [] });
  await step(run, () => createdResult(page, result));
  const [mapResponse] = await Promise.all([
    step(run, () => page.waitForResponse((item) => sanctionCalls(item.request(), 'world.map'), { timeout: 10_000 })),
    step(run, () => page.goto(stack.origin + '/w/' + worldId + '/map')),
  ]);
  // 같은 GET 묶음의 home NOT_FOUND는 207일 수 있다. world.map의 실제 packet 성공을 별도로 요구한다.
  expect([200, 207]).toContain(mapResponse.status());
  const mapData = await step(run, () => data<WorldMap>(mapResponse, 'world.map'));
  expect(mapData.cities.map((city) => String(city.key)).sort()).toEqual(keys);
  const map = page.getByTestId('world-map');
  await step(run, () => expect(map).toBeVisible());
  await step(run, () => expect(map.locator('g[data-city-key][data-anchor-key]')).toHaveCount(keys.length));
  expect(
    await step(run, () =>
      map
        .locator('g[data-city-key][data-anchor-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-city-key')).sort()),
    ),
  ).toEqual(keys);
  expect(
    await step(run, () =>
      map
        .locator('g[data-city-key][data-anchor-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-anchor-key')).sort()),
    ),
  ).toEqual(keys);
  const anchors = page.getByRole('combobox', { name: '지도 거점', exact: true });
  await step(run, () => expect(anchors.locator('option')).toHaveCount(keys.length + 1));
  expect(
    await step(run, () =>
      anchors.locator('option').evaluateAll((rows) =>
        rows
          .map((row) => (row as HTMLOptionElement).value)
          .filter(Boolean)
          .sort(),
      ),
    ),
  ).toEqual(keys);
  await step(run, () => anchors.selectOption(keys[0]!));
  await step(run, () => expect(map.locator(`g[data-city-key="${keys[0]}"]`)).toHaveAttribute('data-selected', 'true'));
  expect(await step(run, () => db.worldCreateRequest.count({ where: { requestedBy: actor.id } }))).toBe(1);
  expect(writes).toHaveLength(1);
  expect(
    await step(run, () => db.auditLog.count({ where: { action: 'world.create.requested', targetId: pending.id } })),
  ).toBe(1);
  expect(await step(run, () => db.auditLog.count({ where: { action: 'world.create.applied', worldId } }))).toBe(1);
  expect(await step(run, () => endFootprint(stack, legacy.id, true))).toBe(legacy.fingerprint);
  expect(await step(run, () => db.inputEvent.count({ where: { worldId: legacy.id } }))).toBe(0);
  expect(
    (await step(run, () => db.world.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))).map((row) => row.id),
  ).toEqual([...beforeWorlds.map((row) => row.id), worldId].sort());
  Object.assign(run.receipt, {
    engineStatus: result.status,
    worldStatus: world.status,
    pinned,
    ruleFeatures: world.ruleFeatures,
    zeroLedgerRows: keys.length,
    uiAnchorRows: keys.length,
    legacyFingerprint: legacy.fingerprint,
    createPosts: writes.length,
  });
}

for (const mode of modes) {
  test(`AC-M3-04 AC-INT-04 ${mode.id}: 관리자 선택·실제 원생성·${mode.anchors}개 빈 원장과 지도 연결`, async ({
    page,
    legalStack,
  }, info) => {
    const controller = new AbortController();
    const run: Run = {
      info,
      controller,
      pending: new Set(),
      errors: new Set(),
      passed: false,
      receipt: { profile: mode.id, actualExecutionScope: 'administrator profile selection and PREOPEN origin only' },
      timer: setTimeout(() => {
        legalStack.failed = true;
        controller.abort(new Error('SAN10 관리자 선택 원120초 사례의110초 정착 경계'));
      }, 110_000),
    };
    current = run;
    run.body = verifySelection(page, legalStack, mode, run);
    try {
      await run.body;
      run.passed = true;
    } catch (error) {
      legalStack.failed = true;
      run.errors.add(error);
      throw error;
    }
  });
}
