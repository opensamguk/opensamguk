import type { Page, Response } from '@playwright/test';
import { isInactive } from '../packages/rules/src/policy/index';
import { TEST_PASSWORD } from './account';
import {
  advance,
  expect,
  HUMAN_ID,
  myGeneral,
  processInputs,
  test,
  waitPendingPolicy,
  type PolicyWorld,
} from './policyFixture';
import {
  capitalCity,
  EXACT_FOURTEEN_DAYS_TICK,
  FOLLOW_RESERVED_DUE,
  FOLLOW_REST_DUE,
  INACTIVE_DUE,
  inputLedger,
  ownLogAt,
  ownTurnState,
  placeAtInactiveBoundary,
  prepareOwnTurn,
  worldClock,
  type OwnShape,
} from './policyInactiveFixture';

// T2-13 · AC-M2-17 화면: 14일 넘게 들어오지 않은 사람 장수의 예턴을 실제 화면·서버·DB·TurnLoop로 본다.
// 승인 U63-1대로 빈 칸만 기본 방침 명령으로 실행하고 직접 넣은 휴식과 예약 명령은 그대로 실행한다. NPC 선택으로 바뀌지 않는다.
// 승인 U63-2대로 정지 시간을 뺀 월드 시간이 14일을 넘어야 미접속이다. 정확히 14일은 미접속이 아니다. 이 월드는 정지하지 않는다.
// policyFixture가 이 파일만의 새 _test DB와 API·Vite 서버를 띄운다. 시험마다 새 계정과 월드를 쓰고 화면 로그인으로 세션을 얻는다.
// 엔진은 시험이 쥔 실행권으로 실제 TurnLoop.advanceTo만 돈다. 시계를 건너뛰거나 실행 기록을 만들어 넣지 않는다.
// 기대 명령은 승인된 표를 글자 그대로 적는다. choosePolicyCommand·policyOptions로 만들지 않는다.
// policyInactiveFixture의 행 쓰기는 시험 조건을 만드는 fixture 데이터이고 제품 동작의 증거가 아니다.
// 증거 JSON은 policyFixture의 evidence가 제목 번호(81~88)로 남기고 화면은 testInfo.outputPath에 남긴다.

// trace·video는 로그인 요청 본문과 쿠키·토큰을 담을 수 있어 끈다.
test.use({ screenshot: 'only-on-failure', trace: 'off', video: 'off' });

type Json = Record<string, unknown>;
type Slot = { commandKey: string; args: Json; explicit: boolean; name: string };
type TurnList = { revision: number; slots: Slot[] };
type PolicyKey = 'farm' | 'commerce' | 'security' | 'defend' | 'drill' | 'none';

const TURN_TERM_MINUTES = 1440;
// 1440분 턴의 월드 하루는 10000 tick이다. 14일은 140000 tick이다.
const TICKS_PER_WORLD_DAY = 10_000;
// 방침 후보가 아닌 명령. 실행 결과가 이 중 하나면 안 된다.
const NOT_POLICY = ['attack', 'move', 'join', 'return'];

const IMPLICIT: Slot = { commandKey: 'rest', args: {}, explicit: false, name: '휴식' };
const EXPLICIT_REST: Slot = { commandKey: 'rest', args: {}, explicit: true, name: '휴식' };
const RESERVED: Slot = { commandKey: 'farm', args: {}, explicit: true, name: '농지 개간' };
const SENTINEL: Slot = { commandKey: 'commerce', args: {}, explicit: true, name: '상업 투자' };
const tail = (count: number) => Array.from({ length: count }, () => IMPLICIT);

const RICH = { gold: 10_000, rice: 10_000, injury: 0 };

interface Case {
  no: number;
  title: string;
  policy: PolicyKey;
  policyName: string;
  // 승인된 표의 실행 명령과 그 이름.
  expected: string;
  commandName: string;
  // 실행 기록 둘째 줄(없음 방침은 유일한 줄).
  resultLine: RegExp;
  // 화면 30칸 편집기의 빈 칸 표시.
  emptyLabel: string;
  shape: OwnShape;
}

const CASES: Case[] = [
  {
    no: 81,
    title: '권농 방침이면 농지 개간을 한다',
    policy: 'farm',
    policyName: '권농',
    expected: 'farm',
    commandName: '농지 개간',
    resultLine: /^농지 개간: \d+$/,
    emptyLabel: '(권농) 농지 개간',
    shape: { general: RICH, city: { agriculture: 500, agricultureMax: 1000 } },
  },
  {
    no: 82,
    title: '중상 방침이면 상업 투자를 한다',
    policy: 'commerce',
    policyName: '중상',
    expected: 'commerce',
    commandName: '상업 투자',
    resultLine: /^상업 투자: \d+$/,
    emptyLabel: '(중상) 상업 투자',
    shape: { general: RICH, city: { commerce: 500, commerceMax: 1000 } },
  },
  {
    no: 83,
    title: '치안 방침이면 치안 강화를 한다',
    policy: 'security',
    policyName: '치안',
    expected: 'security',
    commandName: '치안 강화',
    resultLine: /^치안 강화: \d+$/,
    emptyLabel: '(치안) 치안 강화',
    shape: { general: RICH, city: { security: 500, securityMax: 1000 } },
  },
  {
    no: 84,
    title: '수비 방침에서 수비가 최대 아래면 수비 강화를 한다',
    policy: 'defend',
    policyName: '수비',
    expected: 'defence',
    commandName: '수비 강화',
    resultLine: /^수비 강화: \d+$/,
    emptyLabel: '(수비) 수비 강화',
    shape: { general: RICH, city: { defence: 500, defenceMax: 1000 } },
  },
  {
    no: 85,
    title: '수비 방침에서 수비가 최대면 성벽 보수를 한다',
    policy: 'defend',
    policyName: '수비',
    expected: 'wall',
    commandName: '성벽 보수',
    resultLine: /^성벽 보수: \d+$/,
    emptyLabel: '(수비) 수비 강화',
    shape: { general: RICH, city: { defence: 1000, defenceMax: 1000, wall: 500, wallMax: 1000 } },
  },
  {
    no: 86,
    title: '훈련 방침에서 훈련이 최대 아래면 훈련을 한다',
    policy: 'drill',
    policyName: '훈련',
    expected: 'train',
    commandName: '훈련',
    resultLine: /^훈련: 60$/,
    emptyLabel: '(훈련) 훈련',
    shape: { general: { ...RICH, crew: 1000, train: 50, atmos: 50 }, city: {} },
  },
  {
    no: 87,
    title: '훈련 방침에서 훈련이 최대면 사기진작을 한다',
    policy: 'drill',
    policyName: '훈련',
    expected: 'morale',
    commandName: '사기진작',
    resultLine: /^사기진작: 60$/,
    emptyLabel: '(훈련) 훈련',
    shape: { general: { ...RICH, crew: 1000, train: 100, atmos: 50 }, city: {} },
  },
  {
    no: 88,
    title: '없음 방침이면 휴식한다',
    policy: 'none',
    policyName: '없음',
    expected: 'rest',
    commandName: '휴식',
    resultLine: /^휴식$/,
    emptyLabel: '(빈 칸) 휴식',
    shape: { general: RICH, city: {} },
  },
];

const editor = (page: Page) => page.getByTestId('turn-editor');
const row = (page: Page, slot: number) => editor(page).locator(`tr[data-slot="${slot}"]`);
const commandCell = (page: Page, slot: number) => row(page, slot).getByRole('gridcell').nth(2);
const policySelect = (page: Page) => page.getByTestId('policy-bar').getByLabel('기본 방침');
const policyStatus = (page: Page) => page.getByTestId('policy-state');
const records = (page: Page) => page.locator('[data-main-area="general-records"] [data-record-kind="general"] li');

// httpBatchLink라 같은 때 보낸 요청이 한 주소로 묶여 올 수 있다. 주소의 경로 목록에서 순서를 찾는다.
const pathsOf = (url: string) => new URL(url).pathname.split('/').pop()!.split(',');

// 화면이 보낸 요청의 입력과 받은 응답 원문을 그대로 읽는다. 바꾸거나 대신 돌려주지 않는다.
// 실패 문장에는 경로 이름만 넣고 주소·본문은 넣지 않는다.
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
  const body = (await response.json()) as Array<{ result?: { data: T } }>;
  const entry = body[index];
  if (!entry?.result) throw new Error(`${path} 응답이 없습니다.`);
  return { input: inputs[String(index)], data: entry.result.data };
}

// 화면과 같은 세션으로 서버 응답 원문을 읽는다.
async function api<T>(page: Page, path: string, worldId: string): Promise<T> {
  const response = await page.request.get(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ worldId }))}`);
  const body = (await response.json()) as { result?: { data: T } };
  if (!response.ok() || !body.result) throw new Error(`${path} 응답이 없습니다(HTTP ${response.status()}).`);
  return body.result.data;
}

// 활동 기준을 만드는 유일한 로그인이다. 미접속 기간에는 다시 로그인하지 않는다.
async function openMain(page: Page, world: PolicyWorld) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(world.email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
  await page.goto(`/w/${world.id}`);
  await expect(row(page, 30)).toBeVisible();
  await expect(policySelect(page)).toBeEnabled();
}

// 방침을 고르고 API가 입력을 PENDING으로 접수하면 그때 엔진이 시계 0에서 입력만 처리한다.
async function choosePolicy(page: Page, world: PolicyWorld, key: PolicyKey) {
  const responded = nextTrpc<Json>(page, 'general.setPolicy');
  await policySelect(page).selectOption(key);
  await waitPendingPolicy(world);
  await processInputs(world);
  const outcome = await responded;
  expect(outcome.input).toEqual({ worldId: world.id, policy: key });
  expect(outcome.data).toMatchObject({
    status: 'applied',
    policy: { current: key, pending: null, lastRejected: null },
  });
  await expect(policyStatus(page)).toHaveText('바꿨습니다');
  return outcome;
}

// 고른 칸에 인자 없는 명령 하나를 넣고 칸 선택을 푼다.
async function putCommand(page: Page, slot: number, name: string) {
  await row(page, slot).click();
  await editor(page).getByLabel('명령 찾기').fill(name);
  await editor(page).getByRole('radio', { name, exact: true }).check();
  await editor(page)
    .getByRole('button', { name: `${slot}번 칸에 넣기` })
    .click();
  await row(page, slot).click();
}

async function save(page: Page) {
  await editor(page).getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor(page).getByText('저장했습니다.')).toBeVisible();
}

// 기록 한 줄이 기대 명령의 기록인지 본다. 없음 방침의 빈 칸 실행은 기본 방침 문구 없이 휴식으로만 남는다.
async function expectPolicyRecord(page: Page, index: number, c: Case) {
  const line = records(page).nth(index);
  await expect(line).toHaveAttribute('data-log-kind', 'success');
  if (c.policy === 'none') {
    await expect(line).toContainText('휴식');
    await expect(line).not.toContainText('기본 방침');
  } else {
    await expect(line).toContainText(`기본 방침(${c.policyName})으로 ${c.commandName}`);
  }
}

for (const c of CASES) {
  test(`${c.no} 14일 넘게 들어오지 않은 사람 장수의 빈 칸은 ${c.title}. 직접 휴식과 예약 명령은 그대로 실행한다`, async ({
    page,
    policyWorld,
    evidence,
  }, testInfo) => {
    const world = await policyWorld('nation');
    evidence.world = { id: world.id, kind: world.kind, generalId: world.generalId };
    evidence.case = { policy: c.policy, expected: c.expected, commandName: c.commandName };

    // 1. tick 0의 유일한 로그인과 화면 저장. 엔진이 시계 0에서 입력을 처리해 활동 기준이 0이 된다.
    await openMain(page, world);
    await processInputs(world);
    const policies: PolicyKey[] = c.policy === 'none' ? ['farm', 'none'] : [c.policy];
    // 없음은 새 장수의 기본값이라 고르기 칸이 바뀌지 않는다. 다른 방침을 거쳐 없음을 다시 골라 적용 입력을 남긴다.
    const setPolicy: Json[] = [];
    for (const key of policies) setPolicy.push((await choosePolicy(page, world, key)).data);
    evidence.setPolicy = setPolicy;

    const initial = await api<TurnList>(page, 'turns.get', world.id);
    evidence.turnsInitial = initial;
    expect(initial.slots).toEqual(tail(30));
    await putCommand(page, 2, '휴식');
    await putCommand(page, 3, '농지 개간');
    await putCommand(page, 4, '상업 투자');
    const saved = nextTrpc<TurnList & { ok: boolean }>(page, 'turns.set');
    await save(page);
    const set = await saved;
    evidence.turnsSet = set;
    expect(set.input).toEqual({
      worldId: world.id,
      revision: initial.revision,
      slots: [
        null,
        { commandKey: 'rest', args: {} },
        { commandKey: 'farm', args: {} },
        { commandKey: 'commerce', args: {} },
        ...Array.from({ length: 26 }, () => null),
      ],
    });
    expect(set.data).toMatchObject({ ok: true });
    expect(set.data.slots).toEqual([IMPLICIT, EXPLICIT_REST, RESERVED, SENTINEL, ...tail(26)]);
    await processInputs(world);

    // 2. 기준 확인. 로그인 활동, 방침, 예턴 저장 입력이 모두 시계 0에서 적용됐고 남은 입력은 없다.
    const ledger = await inputLedger(world);
    evidence.ledgerBaseline = ledger;
    expect(ledger).toEqual([
      { kind: 'general.active', status: 'APPLIED', generalId: HUMAN_ID, result: { activeTick: 0 } },
      ...policies.map((policy) => ({
        kind: 'general.setPolicy',
        status: 'APPLIED',
        generalId: HUMAN_ID,
        result: { policy, activeTick: 0 },
      })),
      {
        kind: 'turns.set',
        status: 'APPLIED',
        generalId: HUMAN_ID,
        result: { revision: initial.revision + 1, activeTick: 0 },
      },
    ]);
    const baseline = await ownTurnState(world);
    const clock0 = await worldClock(world);
    evidence.baseline = { ...baseline, userId: undefined, userIdMatches: baseline.userId === world.userId, clock0 };
    expect(baseline.userId).toBe(world.userId);
    expect(baseline.userId).not.toBeNull();
    expect(baseline).toMatchObject({ defaultPolicy: c.policy, lastActiveTick: 0, nationId: 1, officerLevel: 1 });
    expect(clock0).toEqual({
      clockTick: 0,
      status: 'RUNNING',
      clockMode: 'REALTIME',
      turnTermMinutes: TURN_TERM_MINUTES,
    });
    const before = await api<TurnList>(page, 'turns.get', world.id);
    evidence.turnsBefore = before;
    expect(before.slots).toEqual([IMPLICIT, EXPLICIT_REST, RESERVED, SENTINEL, ...tail(26)]);

    // 3. fixture 경계. 자기 장수의 첫 턴을 140001로, 다른 장수 턴을 지평 밖으로 둔다.
    evidence.boundary = await placeAtInactiveBoundary(world);

    // 4. 실제 TurnLoop로 정확히 14일(140000)까지 간다. 월간 정산 14번만 돌고 아무 장수도 턴을 쓰지 않는다.
    const toFourteen = await advance(world, EXACT_FOURTEEN_DAYS_TICK);
    evidence.toFourteen = toFourteen;
    expect(toFourteen).toEqual([]);
    const clock14 = await worldClock(world);
    expect(clock14).toMatchObject({ clockTick: EXACT_FOURTEEN_DAYS_TICK, status: 'RUNNING' });
    const atFourteen = await ownTurnState(world);
    expect(atFourteen).toMatchObject({
      userId: world.userId,
      defaultPolicy: c.policy,
      lastActiveTick: 0,
      nextTurnTick: INACTIVE_DUE,
    });
    // 14일 경계를 산술과 실제 판정 함수로 따로 본다. 기준 0에서 140000은 정확히 14일이라 미접속이 아니다.
    expect((EXACT_FOURTEEN_DAYS_TICK - 0) / TICKS_PER_WORLD_DAY).toBe(14);
    expect((EXACT_FOURTEEN_DAYS_TICK - 0) * TURN_TERM_MINUTES).toBe(14 * 1440 * TICKS_PER_WORLD_DAY);
    expect((INACTIVE_DUE - 0) * TURN_TERM_MINUTES).toBeGreaterThan(14 * 1440 * TICKS_PER_WORLD_DAY);
    expect(isInactive(0, EXACT_FOURTEEN_DAYS_TICK, TURN_TERM_MINUTES)).toBe(false);
    expect(isInactive(0, INACTIVE_DUE, TURN_TERM_MINUTES)).toBe(true);
    // 수도의 보급은 월간 정산이 정한 값이다. 여기서 쓰지 않는다.
    const capitalAt14 = await capitalCity(world);
    evidence.capitalAt14 = capitalAt14;
    expect(capitalAt14).toMatchObject({ nationId: 1, supplied: true });

    // 5. fixture 자원 맞추기. 기대 갈래가 성공할 자원과 최대치만 쓴다.
    evidence.prepared = await prepareOwnTurn(world, c.shape, INACTIVE_DUE);

    // 6. 실제 TurnLoop로 140001. 빈 칸이 승인된 표의 명령으로 실행된다.
    const first = await advance(world, INACTIVE_DUE);
    const firstLogs = await ownLogAt(world, INACTIVE_DUE);
    const afterFirst = await ownTurnState(world);
    evidence.first = { executions: first, logs: firstLogs, capital: await capitalCity(world) };
    expect(first).toEqual([{ generalId: HUMAN_ID, tick: INACTIVE_DUE, commandKey: c.expected }]);
    expect(NOT_POLICY).not.toContain(first[0]!.commandKey);
    expect(firstLogs).toHaveLength(1);
    expect(firstLogs[0]).toMatchObject({ tick: INACTIVE_DUE, commandKey: c.expected, kind: 'success' });
    const firstLines = firstLogs[0]!.text.split('\n');
    if (c.policy === 'none') expect(firstLines).toEqual(['휴식']);
    else
      expect(firstLines).toEqual([
        `기본 방침(${c.policyName})으로 ${c.commandName}`,
        expect.stringMatching(c.resultLine),
      ]);
    expect(afterFirst).toMatchObject({
      userId: world.userId,
      defaultPolicy: c.policy,
      lastActiveTick: 0,
      nextTurnTick: FOLLOW_REST_DUE,
    });

    // 7. 같은 세션으로 다시 읽는다. 로그인·저장·방침 바꾸기를 하지 않는다.
    await page.reload();
    await expect(row(page, 30)).toBeVisible();
    await expect(policySelect(page)).toHaveValue(c.policy);
    await expect(records(page)).toHaveCount(1);
    await expectPolicyRecord(page, 0, c);
    await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
    await expect(commandCell(page, 1)).toHaveText('휴식');
    await expect(commandCell(page, 2)).toHaveText('농지 개간');
    await expect(commandCell(page, 3)).toHaveText('상업 투자');
    for (const slot of [4, 30]) {
      await expect(row(page, slot)).toHaveAttribute('data-empty', 'true');
      await expect(row(page, slot)).toContainText(c.emptyLabel);
    }
    const afterFirstTurns = await api<TurnList>(page, 'turns.get', world.id);
    evidence.turnsAfterFirst = afterFirstTurns;
    expect(afterFirstTurns.slots).toEqual([EXPLICIT_REST, RESERVED, SENTINEL, ...tail(27)]);

    // 8. 다음 자기 턴 둘. 미접속이어도 직접 넣은 휴식과 예약 명령이 그대로 실행된다. 이 사이에는 fixture를 쓰지 않는다.
    const second = await advance(world, FOLLOW_REST_DUE);
    const secondLogs = await ownLogAt(world, FOLLOW_REST_DUE);
    evidence.second = { executions: second, logs: secondLogs };
    expect(isInactive(0, FOLLOW_REST_DUE, TURN_TERM_MINUTES)).toBe(true);
    expect(second).toEqual([{ generalId: HUMAN_ID, tick: FOLLOW_REST_DUE, commandKey: 'rest' }]);
    expect(secondLogs).toEqual([{ tick: FOLLOW_REST_DUE, commandKey: 'rest', kind: 'success', text: '휴식' }]);

    const third = await advance(world, FOLLOW_RESERVED_DUE);
    const thirdLogs = await ownLogAt(world, FOLLOW_RESERVED_DUE);
    evidence.third = { executions: third, logs: thirdLogs };
    expect(isInactive(0, FOLLOW_RESERVED_DUE, TURN_TERM_MINUTES)).toBe(true);
    expect(third).toEqual([{ generalId: HUMAN_ID, tick: FOLLOW_RESERVED_DUE, commandKey: 'farm' }]);
    expect(thirdLogs).toHaveLength(1);
    expect(thirdLogs[0]).toMatchObject({ tick: FOLLOW_RESERVED_DUE, commandKey: 'farm', kind: 'success' });
    expect(thirdLogs[0]!.text).toMatch(/^농지 개간: \d+$/);

    const final = await ownTurnState(world);
    const finalLedger = await inputLedger(world);
    evidence.final = { ...final, userId: undefined, userIdMatches: final.userId === world.userId };
    evidence.ledgerFinal = finalLedger;
    expect(final).toMatchObject({ userId: world.userId, defaultPolicy: c.policy, lastActiveTick: 0 });
    // 미접속 기간과 다시 읽기에서 활동·방침 입력이 새로 생기지 않았다.
    expect(finalLedger).toEqual(ledger);
    expect((await myGeneral(world)).lastActiveTick).toBe(0);

    // 9. 다시 읽은 화면. 기록은 최신순이고 남은 칸은 지킴 칸 하나와 빈 칸이다.
    await page.reload();
    await expect(row(page, 30)).toBeVisible();
    await expect(policySelect(page)).toHaveValue(c.policy);
    await expect(records(page)).toHaveCount(3);
    await expect(records(page).nth(0)).toContainText('농지 개간');
    await expect(records(page).nth(0)).not.toContainText('기본 방침');
    await expect(records(page).nth(1)).toContainText('휴식');
    await expect(records(page).nth(1)).not.toContainText('기본 방침');
    await expectPolicyRecord(page, 2, c);
    await expect(row(page, 1)).not.toHaveAttribute('data-empty', 'true');
    await expect(commandCell(page, 1)).toHaveText('상업 투자');
    for (const slot of [2, 30]) {
      await expect(row(page, slot)).toHaveAttribute('data-empty', 'true');
      await expect(row(page, slot)).toContainText(c.emptyLabel);
    }
    const finalTurns = await api<TurnList>(page, 'turns.get', world.id);
    evidence.turnsFinal = finalTurns;
    expect(finalTurns.slots).toEqual([SENTINEL, ...tail(29)]);
    await page.screenshot({ path: testInfo.outputPath(`t2-13-inactive-${c.no}.png`), fullPage: true });
  });
}
