import type { Page, Response } from '@playwright/test';
import { TEST_PASSWORD } from './account';
import {
  advance,
  allInputs,
  closeWorldForRejection,
  expect,
  HUMAN_ID,
  HUMAN_TURN,
  myCity,
  myGeneral,
  myLogs,
  policyInputs,
  processInputs,
  readWorld,
  test,
  waitPendingPolicy,
  type PolicyWorld,
} from './policyFixture';

// T2-14 · AC-M2-17 화면: 메인의 기본 방침 고르기와 30칸 편집기의 빈 칸 표시를 실제 서버·DB·엔진으로 본다.
// policyFixture가 이 파일만의 새 _test DB와 그 DB를 쓰는 API·Vite 서버를 띄운다. 시험마다 새 계정과 새 월드를 만들고
// 화면 로그인으로 정상 세션을 얻는다. 엔진은 시험이 쥔 실행권으로 실제 TurnLoop.advanceTo만 돈다.
// 기대값은 화면 변환 함수로 만들지 않고 서버 규칙의 값을 직접 적는다.

// trace는 로그인 요청 본문과 쿠키·토큰까지 담을 수 있어 끈다. 증거는 정책·예턴·home 응답과 DB 결과 JSON만 남긴다.
test.use({ screenshot: 'only-on-failure', trace: 'off' });

type Json = Record<string, unknown>;
type Slot = { commandKey: string; args: Json; explicit: boolean; name: string };
type TurnList = { revision: number; slots: Slot[] };

// 서버 방침 표의 기대값 (packages/rules/src/policy/index.ts의 이름과 명령 이름).
const OPTIONS = [
  { key: 'farm', name: '권농', emptyCommand: { key: 'farm', name: '농지 개간' }, thenCommand: null },
  { key: 'commerce', name: '중상', emptyCommand: { key: 'commerce', name: '상업 투자' }, thenCommand: null },
  { key: 'security', name: '치안', emptyCommand: { key: 'security', name: '치안 강화' }, thenCommand: null },
  {
    key: 'defend',
    name: '수비',
    emptyCommand: { key: 'defence', name: '수비 강화' },
    thenCommand: { key: 'wall', name: '성벽 보수' },
  },
  {
    key: 'drill',
    name: '훈련',
    emptyCommand: { key: 'train', name: '훈련' },
    thenCommand: { key: 'morale', name: '사기진작' },
  },
  { key: 'none', name: '없음', emptyCommand: { key: 'rest', name: '휴식' }, thenCommand: null },
];
const INACTIVE_AFTER_DAYS = 14;
const INACTIVE_TEXT =
  '정지한 시간을 빼고 월드 시간으로 14일 넘게 들어오지 않아도 직접 넣은 명령과 휴식은 그대로 하고 빈 칸만 기본 방침대로 합니다.';
const REST = { commandKey: 'rest', args: {}, name: '휴식' };

const policyState = (
  current: string,
  pending: string | null = null,
  lastRejected: { policy: string; reason: string } | null = null,
) => ({ current, pending, lastRejected, options: OPTIONS, inactiveAfterDays: INACTIVE_AFTER_DAYS });

const editor = (page: Page) => page.getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);
const policySelect = (page: Page) => page.getByTestId('policy-bar').getByLabel('기본 방침');
const policyStatus = (page: Page) => page.getByTestId('policy-state');
const sentence = (page: Page) => page.getByTestId('policy-sentence');
const policyCell = (page: Page) =>
  page
    .locator('[data-main-area="general"] dl > div')
    .filter({ has: page.locator('dt', { hasText: /^기본 방침$/ }) })
    .locator('dd');
const records = (page: Page) => page.locator('[data-main-area="general-records"] [data-record-kind="general"] li');

// httpBatchLink라 같은 때 보낸 요청이 한 주소로 묶여 올 수 있다. 주소의 경로 목록에서 순서를 찾는다.
const pathsOf = (url: string) => new URL(url).pathname.split('/').pop()!.split(',');

// 화면이 보낸 요청의 입력과 받은 응답 원문을 그대로 읽는다. 바꾸거나 대신 돌려주지 않는다.
async function nextTrpc<T>(page: Page, path: string): Promise<{ input: unknown; data: T }> {
  const response: Response = await page.waitForResponse(
    (entry) => entry.url().includes('/trpc/') && pathsOf(entry.url()).includes(path),
  );
  const index = pathsOf(response.url()).indexOf(path);
  const request = response.request();
  const inputs = (
    request.method() === 'POST'
      ? request.postDataJSON()
      : JSON.parse(new URL(request.url()).searchParams.get('input') ?? '{}')
  ) as Record<string, unknown>;
  const body = (await response.json()) as Array<{ result?: { data: T }; error?: unknown }>;
  const entry = body[index];
  if (!entry?.result) throw new Error(`${path} 응답이 없습니다: ${JSON.stringify(entry)}`);
  return { input: inputs[String(index)], data: entry.result.data };
}

// 화면과 같은 세션으로 서버 응답 원문을 읽는다.
async function api<T>(page: Page, path: string, worldId: string): Promise<T> {
  const response = await page.request.get(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ worldId }))}`);
  const body = (await response.json()) as { result?: { data: T } };
  if (!response.ok() || !body.result) throw new Error(`${path}: HTTP ${response.status()} ${JSON.stringify(body)}`);
  return body.result.data;
}

async function login(page: Page, world: PolicyWorld) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(world.email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
}

async function openMain(page: Page, world: PolicyWorld) {
  await login(page, world);
  await page.goto(`/w/${world.id}`);
  await expect(row(page, 30)).toBeVisible();
  await expect(policySelect(page)).toBeEnabled();
}

// 고른 칸에 직접 휴식을 넣는다. keep이면 칸 선택을 그대로 둔다.
async function putRest(page: Page, slot: number, keep = false) {
  await row(page, slot).click();
  await editor(page).getByLabel('명령 찾기').fill('휴식');
  await editor(page).getByRole('radio', { name: '휴식', exact: true }).check();
  await editor(page)
    .getByRole('button', { name: `${slot}번 칸에 넣기` })
    .click();
  if (!keep) await row(page, slot).click();
}

async function save(page: Page) {
  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
}

// 방침을 고르고 API가 입력을 PENDING으로 접수하면 그때 엔진이 입력만 처리한다. setPolicy는 5초 대기 안에 applied를 준다.
async function choosePolicyWithEngine(page: Page, world: PolicyWorld, key: string) {
  const responded = nextTrpc<Json>(page, 'general.setPolicy');
  await policySelect(page).selectOption(key);
  const pending = await waitPendingPolicy(world);
  await processInputs(world);
  const outcome = await responded;
  expect(outcome.input).toEqual({ worldId: world.id, policy: key });
  expect(outcome.data).toEqual({ status: 'applied', policy: policyState(key) });
  await expect(policyStatus(page)).toHaveText('바꿨습니다');
  return { pending, outcome };
}

test('1 고른 방침은 엔진 적용으로 바로 확정되고 새로고침 뒤에도 남는다. 미접속 안내와 장수 정보도 응답과 같다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  const before = await api<Json>(page, 'general.policy', world.id);
  evidence.policyBefore = before;
  expect(before).toEqual(policyState('none'));
  await expect(policySelect(page)).toHaveValue('none');
  await expect(policyCell(page)).toHaveText('없음');

  const { pending, outcome } = await choosePolicyWithEngine(page, world, 'farm');
  evidence.pendingInput = pending;
  evidence.setPolicy = outcome;
  expect(pending).toMatchObject({ status: 'PENDING', payload: { policy: 'farm' }, generalId: HUMAN_ID });

  await page.reload();
  await expect(policySelect(page)).toHaveValue('farm');
  const after = await api<Json>(page, 'general.policy', world.id);
  const home = await api<{ general: { policy: Json } }>(page, 'home.get', world.id);
  evidence.policyAfter = after;
  evidence.homePolicy = home.general.policy;
  expect(after).toEqual(policyState('farm'));
  expect(home.general.policy).toEqual({ key: 'farm', name: '권농' });
  await expect(sentence(page)).toHaveText('빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다.');
  await expect(page.getByTestId('policy-inactive')).toHaveText(INACTIVE_TEXT);
  await expect(policyCell(page)).toHaveText('권농');
  await expect(row(page, 1)).toHaveAttribute('data-empty', 'true');
  await expect(row(page, 1)).toContainText('(권농) 농지 개간');

  const inputs = await policyInputs(world);
  const general = await myGeneral(world);
  evidence.db = { inputs, general };
  expect(inputs).toEqual([
    {
      kind: 'general.setPolicy',
      status: 'APPLIED',
      payload: { policy: 'farm' },
      result: { policy: 'farm', activeTick: 0 },
      userId: world.userId,
      generalId: HUMAN_ID,
    },
  ]);
  expect(general).toMatchObject({ defaultPolicy: 'farm', userId: world.userId });
  await page.screenshot({ path: 'test-results/t2-14-e2e-1.png', fullPage: true });
});

test('2 엔진이 처리하기 전에는 처리 중이고 5초 뒤 pending을 받는다. 엔진이 적용하면 다시 읽기로 확정되고 장수 정보도 바뀐다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);

  const responded = nextTrpc<Json>(page, 'general.setPolicy');
  await policySelect(page).selectOption('drill');
  await expect(policyStatus(page)).toHaveText('처리 중');
  await expect(policySelect(page)).toBeDisabled();
  await expect(policySelect(page)).toHaveValue('drill');
  await expect(sentence(page)).toHaveText('빈 칸은 휴식합니다. 엔진이 처리하면 훈련으로 바뀝니다.');
  const outcome = await responded;
  evidence.setPolicy = outcome;
  expect(outcome).toEqual({ input: { worldId: world.id, policy: 'drill' }, data: { status: 'pending' } });

  const waiting = await api<Json>(page, 'general.policy', world.id);
  const waitingInputs = await policyInputs(world);
  evidence.policyWaiting = waiting;
  evidence.inputsWaiting = waitingInputs;
  expect(waiting).toEqual(policyState('none', 'drill'));
  expect(waitingInputs).toEqual([
    {
      kind: 'general.setPolicy',
      status: 'PENDING',
      payload: { policy: 'drill' },
      result: null,
      userId: world.userId,
      generalId: HUMAN_ID,
    },
  ]);
  await expect(policyStatus(page)).toHaveText('처리 중');
  await expect(policyCell(page)).toHaveText('없음');
  await expect(row(page, 1)).toContainText('(빈 칸) 휴식');

  await processInputs(world);
  // 2초 다시 읽기로 확정된다. 새로고침하지 않는다.
  await expect(policyStatus(page)).toHaveText('바꿨습니다');
  await expect(policySelect(page)).toBeEnabled();
  await expect(policySelect(page)).toHaveValue('drill');
  await expect(sentence(page)).toHaveText('빈 칸은 훈련을 합니다. 이미 최대면 사기진작을 합니다. 실패하면 휴식합니다.');
  await expect(row(page, 1)).toContainText('(훈련) 훈련');
  // 확정 시점에 home.get을 다시 읽어 장수 정보 칸도 바뀐다 (계획 정정 3).
  await expect(policyCell(page)).toHaveText('훈련');

  const applied = await api<Json>(page, 'general.policy', world.id);
  const inputs = await policyInputs(world);
  evidence.policyApplied = applied;
  evidence.db = { inputs, general: await myGeneral(world) };
  expect(applied).toEqual(policyState('drill'));
  expect(inputs).toEqual([
    {
      kind: 'general.setPolicy',
      status: 'APPLIED',
      payload: { policy: 'drill' },
      result: { policy: 'drill', activeTick: 0 },
      userId: world.userId,
      generalId: HUMAN_ID,
    },
  ]);
  await page.screenshot({ path: 'test-results/t2-14-e2e-2.png', fullPage: true });
});

test('3 빈 칸과 직접 넣은 휴식은 저장과 새로고침을 거쳐도 구분되고 방침이 바뀌면 빈 칸만 따른다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  const before = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsBefore = before;
  expect(before.slots).toEqual(Array.from({ length: 30 }, () => ({ ...REST, explicit: false })));

  await putRest(page, 1);
  await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
  const saved = nextTrpc<TurnList & { ok: boolean }>(page, 'turns.set');
  await save(page);
  const set = await saved;
  evidence.turnsSet = set;
  expect(set.input).toEqual({
    worldId: world.id,
    revision: before.revision,
    slots: [{ commandKey: 'rest', args: {} }, ...Array.from({ length: 29 }, () => null)],
  });
  expect(set.data).toMatchObject({ ok: true });
  const setSlots = set.data.slots;
  expect(setSlots[0]).toEqual({ ...REST, explicit: true });
  expect(setSlots.slice(1)).toEqual(Array.from({ length: 29 }, () => ({ ...REST, explicit: false })));

  await page.reload();
  await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
  await expect(row(page, 1).getByRole('gridcell').nth(2)).toHaveText('휴식');
  await expect(row(page, 2)).toHaveAttribute('data-empty', 'true');
  await expect(row(page, 2)).toContainText('(빈 칸) 휴식');
  const after = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsAfter = after;
  expect(after.slots.map((slot) => slot.explicit)).toEqual([true, ...Array.from({ length: 29 }, () => false)]);

  const { outcome } = await choosePolicyWithEngine(page, world, 'commerce');
  evidence.setPolicy = outcome;
  await expect(row(page, 2)).toContainText('(중상) 상업 투자');
  await expect(row(page, 30)).toContainText('(중상) 상업 투자');
  await expect(row(page, 1).getByRole('gridcell').nth(2)).toHaveText('휴식');
  await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
  // 방침 바꾸기는 예턴을 저장하지 않는다.
  const unchanged = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsAfterPolicy = unchanged;
  expect(unchanged).toEqual(after);
  await page.screenshot({ path: 'test-results/t2-14-e2e-3.png', fullPage: true });
});

test('4 저장하지 않은 편집과 고른 칸은 방침을 바꿔도 남고 다른 탭 저장과 부딪히면 편집을 보관한다', async ({
  page,
  context,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  await putRest(page, 3, true);
  await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  await expect(editor(page).getByTestId('selection')).toHaveText('선택: 3번 칸');

  const { outcome } = await choosePolicyWithEngine(page, world, 'security');
  evidence.setPolicy = outcome;
  await expect(editor(page).getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  await expect(editor(page).getByTestId('selection')).toHaveText('선택: 3번 칸');
  await expect(row(page, 3)).not.toHaveAttribute('data-empty', 'true');
  await expect(row(page, 4)).toContainText('(치안) 치안 강화');
  await expect(policyCell(page)).toHaveText('치안');
  const server = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsAfterPolicy = server;
  expect(server.slots.every((slot) => !slot.explicit)).toBe(true);

  const other = await context.newPage();
  await other.goto(`/w/${world.id}`);
  await expect(row(other, 30)).toBeVisible();
  await putRest(other, 5);
  await save(other);

  const staleSave = nextTrpc<Json>(page, 'turns.set');
  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  const stale = await staleSave;
  evidence.staleSet = stale;
  expect(stale.data).toMatchObject({ ok: false, reason: 'STALE' });
  await expect(editor(page).getByTestId('stale-alert')).toContainText('내 편집 1건은 버리지 않고 보관했습니다.');
  await expect(row(page, 5)).not.toHaveAttribute('data-empty', 'true');
  await expect(row(page, 3)).toHaveAttribute('data-empty', 'true');
  await expect(policySelect(page)).toHaveValue('security');

  const latest = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsLatest = latest;
  expect(latest.slots.map((slot) => slot.explicit)).toEqual(Array.from({ length: 30 }, (_, i) => i === 4));
  await page.screenshot({ path: 'test-results/t2-14-e2e-4.png', fullPage: true });
});

test('5 소속 장수의 빈 칸은 엔진 턴에서 권농 방침의 농지 개간을 하고 최근 기록에 남는다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  await choosePolicyWithEngine(page, world, 'farm');
  await putRest(page, 2);
  await save(page);

  const general = await myGeneral(world);
  const cityBefore = await myCity(world);
  evidence.generalBefore = general;
  evidence.cityBefore = cityBefore;
  expect(general).toMatchObject({ nationId: 1, officerLevel: 1, nextTurnTick: HUMAN_TURN, defaultPolicy: 'farm' });
  expect(cityBefore).toEqual({ nationId: 1, agriculture: 200, agricultureMax: 1000, supplied: true });

  const executions = await advance(world, general.nextTurnTick);
  evidence.executions = executions;
  expect(executions).toContainEqual({ generalId: HUMAN_ID, tick: HUMAN_TURN, commandKey: 'farm' });
  const logs = await myLogs(world);
  const cityAfter = await myCity(world);
  evidence.db = { logs, cityAfter, clock: await readWorld(world) };
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ tick: HUMAN_TURN, commandKey: 'farm', kind: 'success' });
  expect(logs[0]!.text).toMatch(/^기본 방침\(권농\)으로 농지 개간\n농지 개간: \d+$/);

  await page.reload();
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText('기본 방침(권농)으로 농지 개간');
  await expect(records(page).first()).toHaveAttribute('data-log-kind', 'success');
  // 1번 칸은 당겨진 직접 휴식, 나머지는 빈 칸이다.
  await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
  await expect(row(page, 1).getByRole('gridcell').nth(2)).toHaveText('휴식');
  await expect(row(page, 30)).toHaveAttribute('data-empty', 'true');
  await expect(row(page, 30)).toContainText('(권농) 농지 개간');
  const turns = await api<TurnList>(page, 'turns.get', world.id);
  evidence.turnsAfter = turns;
  expect(turns.slots[0]).toEqual({ ...REST, explicit: true });
  expect(turns.slots.slice(1).every((slot) => !slot.explicit)).toBe(true);
  await page.screenshot({ path: 'test-results/t2-14-e2e-5.png', fullPage: true });
});

test('6 재야 장수의 빈 칸은 방침 명령이 실패하면 휴식하고 직접 넣은 휴식과 기록이 다르다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('ronin');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  await choosePolicyWithEngine(page, world, 'farm');
  await putRest(page, 2);
  await save(page);

  const general = await myGeneral(world);
  evidence.generalBefore = general;
  expect(general).toMatchObject({ nationId: null, officerLevel: 0, nextTurnTick: HUMAN_TURN, defaultPolicy: 'farm' });

  const first = await advance(world, general.nextTurnTick);
  const afterFirst = await myLogs(world);
  evidence.first = { executions: first, logs: afterFirst };
  expect(first).toContainEqual({ generalId: HUMAN_ID, tick: HUMAN_TURN, commandKey: 'rest' });
  expect(afterFirst).toEqual([
    { tick: HUMAN_TURN, commandKey: 'rest', kind: 'success', text: '기본 방침 실패: 국가에 소속되어야 합니다. → 휴식' },
  ]);

  const second = await advance(world, general.nextTurnTick + 10_000);
  const afterSecond = await myLogs(world);
  evidence.second = { executions: second, logs: afterSecond, clock: await readWorld(world) };
  expect(second).toContainEqual({ generalId: HUMAN_ID, tick: HUMAN_TURN + 10_000, commandKey: 'rest' });
  expect(afterSecond).toEqual([
    { tick: HUMAN_TURN, commandKey: 'rest', kind: 'success', text: '기본 방침 실패: 국가에 소속되어야 합니다. → 휴식' },
    { tick: HUMAN_TURN + 10_000, commandKey: 'rest', kind: 'success', text: '휴식' },
  ]);

  await page.reload();
  // 최근 기록은 최신순이다. 직접 휴식 줄에는 기본 방침 문구가 없다.
  await expect(records(page)).toHaveCount(2);
  await expect(records(page).nth(0)).toContainText('휴식');
  await expect(records(page).nth(0)).not.toContainText('기본 방침');
  await expect(records(page).nth(1)).toContainText('기본 방침 실패: 국가에 소속되어야 합니다. → 휴식');
  for (const slot of [1, 2, 30]) {
    await expect(row(page, slot)).toHaveAttribute('data-empty', 'true');
    await expect(row(page, slot)).toContainText('(권농) 농지 개간');
  }
  await page.screenshot({ path: 'test-results/t2-14-e2e-6.png', fullPage: true });
});

test('7 접수된 방침을 엔진이 거절하면 이유를 문장으로 보이고 고르기 칸은 원래 방침으로 돌아간다', async ({
  page,
  policyWorld,
  evidence,
}) => {
  const world = await policyWorld('nation');
  evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
  await openMain(page, world);
  // 로그인 활동 입력을 먼저 처리해 거절 조건에서 남은 입력이 방침 입력 하나뿐이게 한다.
  await processInputs(world);

  const responded = nextTrpc<Json>(page, 'general.setPolicy');
  await policySelect(page).selectOption('farm');
  await expect(policyStatus(page)).toHaveText('처리 중');
  const outcome = await responded;
  evidence.setPolicy = outcome;
  expect(outcome).toEqual({ input: { worldId: world.id, policy: 'farm' }, data: { status: 'pending' } });

  // UI 거절 조건 fixture. 월드 상태 전환의 제품 증거가 아니다. 거절 자체는 아래 엔진 처리가 만든다.
  evidence.rejectionCondition = await closeWorldForRejection(world);
  await processInputs(world);

  const inputs = await allInputs(world);
  evidence.db = { inputs, clock: await readWorld(world), general: await myGeneral(world) };
  expect(inputs.filter((input) => input.kind === 'general.setPolicy')).toEqual([
    {
      kind: 'general.setPolicy',
      status: 'REJECTED',
      payload: { policy: 'farm' },
      result: { code: 'WORLD_CLOSED', message: '종료된 월드입니다.' },
      userId: world.userId,
      generalId: HUMAN_ID,
    },
  ]);
  expect(inputs.filter((input) => input.status === 'PENDING')).toEqual([]);

  await expect(page.getByTestId('policy-rejected')).toHaveText('권농으로 바꾸지 못했습니다. 종료된 월드입니다.');
  await expect(page.getByTestId('policy-rejected')).not.toContainText('WORLD_CLOSED');
  await expect(policySelect(page)).toHaveValue('none');
  await expect(policyStatus(page)).toHaveText('');
  await expect(sentence(page)).toHaveText('빈 칸은 휴식합니다.');
  await expect(policyCell(page)).toHaveText('없음');
  const rejected = await api<Json>(page, 'general.policy', world.id);
  evidence.policyRejected = rejected;
  expect(rejected).toEqual(policyState('none', null, { policy: 'farm', reason: 'WORLD_CLOSED' }));
  await page.screenshot({ path: 'test-results/t2-14-e2e-7.png', fullPage: true });
});
