import type { Page, Request, Response } from '@playwright/test';
import { test, expect, type LegalStack } from './legalFixture';
import { sanctionCalls } from './adminSanctionSetup';
import { createActor, prepareCreation, reviewCreationPage, applyCreation, createdResult } from './adminCreateSetup';
import { initializeSan10Resources } from '../tools/san10-resources';
import { hashState } from '../packages/shared/src/node/hashState';
import type { CreateInput } from '../apps/web/src/admin/adminCreateModel';

// T4-90 / AC-P2-27 화면 몫: 관리자 생성 양식이 게시 판 목록을 읽어 칸마다 고르고, 고른 정규형 키가 접수·저장까지 가는지 본다.
// 로컬 자기 DB에서만 돈다(R50). 서버 판 목록·조합 검사는 T4-79 구현을 그대로 쓰며 이 시험이 대신하지 않는다.
test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ page, legalStack }, info) => {
  try {
    await page.close();
  } catch {
    legalStack.failed = true;
  }
  if (info.status !== info.expectedStatus) legalStack.failed = true;
  if (!legalStack.failed) {
    try {
      expect(await legalStack.db.worldCreateRequest.count({ where: { status: 'PENDING' } })).toBe(0);
    } catch {
      legalStack.failed = true;
      throw new Error('판 고르기 시험의 대기 요청이 남아 자기 DB를 보존합니다.');
    }
  }
});

// 게시된 1판을 내용 그대로 2판으로 게시한다. 이름(id)이 같아 조합 검사를 통과하고, 키만 정규형 `이름@2`가 된다.
async function publishSecondVersion(stack: LegalStack, kind: 'SCENARIO' | 'MAP' | 'UNIT_SET', name: string) {
  const source = await stack.db.gameResource.findUniqueOrThrow({
    where: { kind_name_version: { kind, name, version: 1 } },
  });
  expect(source.status).toBe('PUBLISHED');
  expect(hashState(source.content)).toBe(source.contentHash);
  await stack.db.gameResource.create({
    data: {
      kind,
      name,
      version: 2,
      status: 'PUBLISHED',
      content: source.content as never,
      contentHash: source.contentHash,
      source: `${source.source} · T4-90 시험용 2판 복사`,
      publishedAt: new Date(),
    },
  });
}
const procedureCount = (request: Request, name: string) =>
  new URL(request.url()).pathname
    .split('/')
    .at(-1)!
    .split(',')
    .filter((entry) => entry === name).length;
function watch(page: Page) {
  const writes: Request[] = [],
    versionReads = { count: 0 };
  page.on('request', (request) => {
    if (request.method() === 'POST' && sanctionCalls(request, 'admin.world.create')) writes.push(request);
    // tRPC 묶음 요청은 한 HTTP 요청에 여러 조회를 싣는다. 조회 수는 절차 이름으로 센다.
    versionReads.count += procedureCount(request, 'admin.world.creationVersions');
  });
  return { writes, versionReads };
}
const isCreateWrite = (item: Response) =>
  item.request().method() === 'POST' && sanctionCalls(item.request(), 'admin.world.create');
async function statusReply(response: Response) {
  const names = new URL(response.url()).pathname.split('/').at(-1)!.split(',');
  type Packet = { result?: { data: { status: string; error: { code: string; message: string } | null } } };
  const body = (await response.json()) as Packet | Packet[];
  const packet = Array.isArray(body) ? body[names.indexOf('admin.world.createStatus')] : body;
  return packet?.result?.data;
}

test('T4-90 게시한 2판 시나리오·지도를 화면에서 따로 골라 정확한 키로 접수·저장한다', async ({ page, legalStack }) => {
  const db = legalStack.db;
  const actor = await createActor(page, legalStack);
  await publishSecondVersion(legalStack, 'SCENARIO', 'integration191');
  await publishSecondVersion(legalStack, 'MAP', 'integration');
  const worldsBefore = await db.world.count();
  const { writes, versionReads } = watch(page);

  const controls = await prepareCreation(page, legalStack, 'T4-90 판 고르기');
  const scenario = controls.getByLabel('시나리오 자원 판', { exact: true });
  const map = controls.getByLabel('지도 자원 판', { exact: true });
  await expect(scenario).toBeEnabled();
  await expect(map).toBeEnabled();
  // 다섯 종류를 각자 읽는다. 기본값은 프로필의 1판이다.
  expect(versionReads.count).toBe(5);
  await expect(scenario).toHaveValue('integration191');
  await expect(map).toHaveValue('integration');
  const optionValues = (select: typeof scenario) =>
    select.locator('option').evaluateAll((rows) => rows.map((row) => (row as HTMLOptionElement).value));
  expect(
    (await optionValues(scenario)).filter((key) => key === 'integration191' || key.startsWith('integration191@')),
  ).toEqual(['integration191', 'integration191@2']);
  expect((await optionValues(map)).filter((key) => key === 'integration' || key.startsWith('integration@'))).toEqual([
    'integration',
    'integration@2',
  ]);
  for (const label of ['병종 자원 판', '능력치 자원 판', '초상 자원 판'])
    await expect(controls.getByLabel(label, { exact: true })).toBeEnabled();

  await scenario.selectOption('integration191@2');
  await map.selectOption('integration@2');
  // 칸을 바꾸면 기본 프로필의 연도·수치 요약을 보이지 않는다.
  await expect(controls.getByText(/191년 · 21국/)).toHaveCount(0);
  const dialog = await reviewCreationPage(page);
  await expect(dialog.getByText('integration191@2', { exact: true })).toBeVisible();
  await expect(dialog.getByText('integration@2', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/자원 판 일부 변경/)).toBeVisible();
  await expect(dialog.getByText(/191년 · 21국/)).toHaveCount(0);
  expect(writes).toHaveLength(0);
  expect(await db.worldCreateRequest.count({ where: { requestedBy: actor.id } })).toBe(0);

  const [response] = await Promise.all([
    page.waitForResponse(isCreateWrite, { timeout: 10_000 }),
    dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(writes).toHaveLength(1);
  const input = (writes[0]!.postDataJSON() as Record<string, CreateInput>)['0']!;
  expect(input).toMatchObject({
    expectedUserId: actor.id,
    name: 'T4-90 판 고르기',
    scenarioKey: 'integration191@2',
    mapKey: 'integration@2',
    unitSetKey: 'basic',
    statRulesKey: 'five-stats',
    portraitMapKey: '191-map',
    presetKey: 'regular',
  });
  // 칸을 바꾼 요청은 ruleFeatures를 생략하고 서버가 판에서 기능을 계산한다.
  expect(Object.keys(input)).not.toContain('ruleFeatures');
  expect(Object.keys(input)).not.toContain('featureProfileKey');
  const request = await db.worldCreateRequest.findFirstOrThrow({ where: { requestedBy: actor.id } });
  expect(request.status).toBe('PENDING');
  expect(request.intent).toMatchObject({
    scenarioKey: 'integration191@2',
    mapKey: 'integration@2',
    ruleFeatures: null,
  });

  const result = await applyCreation(legalStack, actor.id);
  expect(result).toMatchObject({ status: 'DONE', errorCode: null, worldId: request.plannedWorldId });
  const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId! } });
  expect(world).toMatchObject({ status: 'PREOPEN', scenarioKey: 'integration191@2', mapKey: 'integration@2' });
  expect(result.resolution).toMatchObject({
    selection: { scenario: 'integration191@2', map: 'integration@2', unitSet: 'basic' },
  });
  expect(await db.world.count()).toBe(worldsBefore + 1);
  await createdResult(page, result);
});

test('T4-90 짝이 맞지 않는 시나리오·지도는 서버 FAILED 메시지를 그대로 보이고 월드를 만들지 않는다', async ({
  page,
  legalStack,
}) => {
  const db = legalStack.db;
  const actor = await createActor(page, legalStack);
  await initializeSan10Resources(db);
  const worldsBefore = await db.world.count();
  const { writes } = watch(page);

  const controls = await prepareCreation(page, legalStack, 'T4-90 짝 불일치');
  const scenario = controls.getByLabel('시나리오 자원 판', { exact: true });
  await expect(scenario).toBeEnabled();
  // 화면은 짝을 검사하지 않는다(D-071). SAN10 시나리오를 통합판 지도에 짝지어도 접수까지 간다.
  await scenario.selectOption('san10-191');
  const dialog = await reviewCreationPage(page);
  const [response] = await Promise.all([
    page.waitForResponse(isCreateWrite, { timeout: 10_000 }),
    dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(writes).toHaveLength(1);
  const input = (writes[0]!.postDataJSON() as Record<string, CreateInput>)['0']!;
  expect(input).toMatchObject({ scenarioKey: 'san10-191', mapKey: 'integration' });
  expect(Object.keys(input)).not.toContain('ruleFeatures');

  const result = await applyCreation(legalStack, actor.id);
  expect(result.status).toBe('FAILED');
  expect(result.worldId).toBeNull();
  expect(['INPUT_INVALID', 'RESOURCE_INVALID']).toContain(result.errorCode);
  expect(await db.world.count()).toBe(worldsBefore);

  // 화면은 서버 응답의 error.message를 그대로 보인다.
  const [status] = await Promise.all([
    page.waitForResponse((item) => sanctionCalls(item.request(), 'admin.world.createStatus'), { timeout: 10_000 }),
    page.getByRole('button', { name: '요청 상태 확인', exact: true }).click(),
  ]);
  const reply = await statusReply(status);
  expect(reply?.status).toBe('FAILED');
  expect(reply?.error?.code).toBe(result.errorCode);
  expect(reply?.error?.message.length).toBeGreaterThan(0);
  await expect(page.getByText(`생성하지 않음 · ${reply!.error!.message}`, { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test('T4-90 통합판 확장의 병종 판을 바꿔도 서버가 묶음 기능을 보존한다', async ({ page, legalStack }) => {
  const actor = await createActor(page, legalStack);
  await publishSecondVersion(legalStack, 'UNIT_SET', 'basic');
  const controls = await prepareCreation(page, legalStack, 'T4-90 통합판 확장 판 고르기');
  await controls.getByLabel('시나리오', { exact: true }).selectOption('integration-v01-expanded');
  await controls.getByLabel('프리셋', { exact: true }).selectOption('regular');
  await expect(controls.getByLabel('시나리오 자원 판', { exact: true })).toBeDisabled();
  await expect(controls.getByLabel('지도 자원 판', { exact: true })).toBeDisabled();
  await controls.getByLabel('병종 자원 판', { exact: true }).selectOption('basic@2');
  const dialog = await reviewCreationPage(page);
  await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
  const result = await applyCreation(legalStack, actor.id);
  expect(result.intent).toMatchObject({
    featureProfileKey: 'expanded-191-v3',
    unitSetKey: 'basic@2',
    ruleFeatures: expect.arrayContaining(['logistics-v1', 'treaty']),
  });
  expect(result.resolution).toMatchObject({ selection: { unitSet: 'basic@2' } });
  await createdResult(page, result);
});
