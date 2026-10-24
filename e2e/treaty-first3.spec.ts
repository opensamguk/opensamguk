import { expect, test, type Locator, type Page } from '@playwright/test';
import { query } from './game';
import {
  PAIRS,
  TreatyFixture,
  dropFirstResponse,
  proposeByHttp,
  requestIdsOf,
  watchTrpc,
  type Actor,
  type Clause,
  type StoredEvent,
} from './treatyWorld';

// T2-07 · AC-M2-06 첫 세 조항(종전·불가침·기록만 남길 약속)의 외교실 브라우저 시험.
// 사례와 기대는 E 전용 실행 계약(accepted-f1-contract.md 4절)의 B1~B11·B13~B15다. 양성 결과는 화면이나 실제 HTTP로 접수하고
// 실행 중인 감독이 띄운 엔진이 처리한 것만 쓴다. 저장 확인은 읽기만 한다. fixture 쓰기는 treatyWorld.ts에 모았다.
// 두 월드를 함께 쓰고 P1(B1→B2)·P3(B4→B9)은 순서가 있는 흐름이라 직렬로 돈다. 제한 시간·재시도는 기본값 그대로다.

test.describe.configure({ mode: 'serial' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAP12: Clause[] = [{ kind: 'nonAggression', months: 12 }];
const READ_ONLY = '이 직책은 외교 문서를 읽기만 합니다.';
const UNSUPPORTED = '아직 지원하지 않는 조항입니다.';
const RECENT = 'section[aria-label="최근 처리된 내 요청"]';
const won = (value: number) => value.toLocaleString('ko-KR');

type Allowed = { ok: true } | { ok: false; code: string; reason: string };
type ListItem = {
  id: string;
  status: string;
  estimate: { mine: number; theirs: number } | null;
  canAccept: Allowed | null;
  canReject: Allowed | null;
};
type ListPage = { canPropose: Allowed; items: ListItem[] };
type Applied = {
  outcome: string;
  by?: string;
  tick: number;
  treatyId: string;
  cost?: { from: number; to: number };
  endTick?: number | null;
};
type Kind = 'treaty.propose' | 'treaty.respond';

const panel = (page: Page) => page.getByTestId('treaty-requests');
const finished = (page: Page, result: string, outcome?: string) => {
  const exact = outcome === undefined ? '' : `[data-outcome="${outcome}"]`;
  return panel(page).locator(`li[data-result="${result}"]${exact}`);
};
const card = (page: Page, id: number) => page.locator(`[data-testid="treaty-card"][data-treaty-id="${id}"]`);
const recent = (page: Page, id: string) => page.locator(RECENT).locator(`li[data-request-id="${id}"]`);

async function requestIdOf(item: Locator): Promise<string> {
  const id = await item.getAttribute('data-request-id');
  expect(id).toMatch(UUID);
  return id!;
}

function single(events: StoredEvent[]): StoredEvent & { result: Applied } {
  expect(events).toHaveLength(1);
  return events[0] as StoredEvent & { result: Applied };
}

// 화면의 끝난 요청 줄이 가리키는 입력 행. 같은 종류·키의 행이 정확히 하나여야 한다.
async function eventOf(f: TreatyFixture, kind: Kind, item: Locator) {
  return single(await f.eventsByKey(`${kind}:${await requestIdOf(item)}`));
}

async function statuses(f: TreatyFixture, key: string) {
  return (await f.eventsByKey(key)).map((e) => `${e.kind}:${e.status}`);
}

// 같은 세션의 목록 조회(읽기 전용 HTTP)에서 조약 한 건을 찾는다.
async function listed(actor: Actor, treatyId: number) {
  const page = await query<ListPage>(actor.page, 'treaty.list', { worldId: actor.worldId });
  return { page, item: page.items.find((item) => item.id === String(treatyId)) };
}

async function openComposer(actor: Actor, toNationId: number) {
  await actor.page.goto(`/w/${actor.worldId}/diplomacy?tab=write`);
  await actor.page.getByLabel('상대').selectOption(String(toNationId));
}

async function checkNonAggression(actor: Actor, months: number) {
  await actor.page.getByLabel('불가침', { exact: true }).check();
  await actor.page.getByLabel('기간(개월)').fill(String(months));
}

async function sendProposal(actor: Actor) {
  await actor.page.getByRole('button', { name: '제안 보내기', exact: true }).click();
}

test.describe('첫 세 조항 외교실', () => {
  let f: TreatyFixture;
  let p1: { treatyId: number } | undefined;
  let p3: { treatyId: number } | undefined;

  test.beforeAll(async () => {
    f = await TreatyFixture.open();
  });

  test.beforeAll(async () => {
    await f.waitEngines();
  });

  test.afterAll(async () => {
    await f?.close();
  });

  test('B1 조약서로 보낸 불가침은 엔진 처리 뒤에만 보냈다고 알린다', async ({ browser }) => {
    const a = await f.actor(browser, 'p1a');
    const calls = watchTrpc(a.page);
    await openComposer(a, PAIRS.P1.b);
    await checkNonAggression(a, 24);
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    // 보내기 전에는 요청 칸 자체가 없다.
    await expect(panel(a.page)).toHaveCount(0);

    await sendProposal(a);
    const proposed = finished(a.page, 'applied', 'PROPOSED');
    await expect(proposed).toContainText('제안을 보냈습니다');
    const requestId = await requestIdOf(proposed);
    expect(requestIdsOf(calls, 'POST', 'treaty.propose')).toEqual([requestId]);

    const event = single(await f.eventsByKey(`treaty.propose:${requestId}`));
    expect(event).toMatchObject({
      kind: 'treaty.propose',
      status: 'APPLIED',
      generalId: a.generalId,
      result: { outcome: 'PROPOSED' },
    });
    const treatyId = Number(event.result.treatyId);
    expect(await f.treaty(treatyId)).toMatchObject({
      status: 'PROPOSED',
      fromNationId: PAIRS.P1.a,
      toNationId: PAIRS.P1.b,
    });
    p1 = { treatyId };
  });

  test('B2 수락하면 조약을 맺고 두 화면에 국가별 낸 비용이 보인다', async ({ browser }) => {
    if (!p1) throw new Error('B1 사례의 제안이 없어 B2를 진행할 수 없습니다.');
    const a = await f.actor(browser, 'p1a');
    const b = await f.actor(browser, 'p1b');
    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    const incoming = card(b.page, p1.treatyId);
    await expect(incoming).toContainText('불가침 24개월');
    await incoming.getByRole('button', { name: '수락', exact: true }).click();
    const accepted = finished(b.page, 'applied', 'ACCEPTED');
    await expect(accepted).toContainText('조약을 맺었습니다');

    const event = await eventOf(f, 'treaty.respond', accepted);
    expect(event).toMatchObject({
      kind: 'treaty.respond',
      status: 'APPLIED',
      generalId: b.generalId,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', treatyId: String(p1.treatyId) },
    });
    const cost = event.result.cost!;
    const treaty = await f.treaty(p1.treatyId);
    expect(treaty).toMatchObject({ status: 'ACTIVE', costFrom: cost.from, costTo: cost.to });
    expect(treaty?.endTick).toBe(treaty!.startTick! + 24 * 10_000);
    expect(await f.relation(PAIRS.P1.a, PAIRS.P1.b)).toEqual({ state: 'NON_AGGRESSION', untilTick: treaty!.endTick });

    const paid = `${f.nationName(PAIRS.P1.a)} 금 ${won(cost.from)} · ${f.nationName(PAIRS.P1.b)} 금 ${won(cost.to)}`;
    for (const actor of [a, b]) {
      await actor.page.goto(`/w/${actor.worldId}/diplomacy?tab=active`);
      const active = card(actor.page, p1.treatyId);
      await expect(active).toContainText('진행 중');
      await expect(active.getByTestId('treaty-cost-paid')).toHaveText(paid);
    }
    await f.closeActors('p1a', 'p1b');
  });

  test('B3 화면에서 거절하면 거절 결과와 최근 요청이 보이고 관계는 없다', async ({ browser }) => {
    const a = await f.actor(browser, 'p2a');
    const b = await f.actor(browser, 'p2b');
    const proposal = await proposeByHttp(a, PAIRS.P2.b, NAP12);

    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    await card(b.page, proposal.treatyId).getByRole('button', { name: '거절', exact: true }).click();
    const declined = finished(b.page, 'applied', 'DECLINED');
    await expect(declined).toContainText('제안을 거절했습니다');
    const requestId = await requestIdOf(declined);
    await expect(recent(b.page, requestId)).toHaveText('응답 · 받은 제안을 거절함');

    const event = single(await f.eventsByKey(`treaty.respond:${requestId}`));
    expect(event).toMatchObject({
      kind: 'treaty.respond',
      status: 'APPLIED',
      generalId: b.generalId,
      result: { outcome: 'DECLINED', by: 'HUMAN', treatyId: String(proposal.treatyId) },
    });
    expect((await f.treaty(proposal.treatyId))?.status).toBe('REJECTED');
    expect(await f.relation(PAIRS.P2.a, PAIRS.P2.b)).toBeNull();
    await f.closeActors('p2a', 'p2b');
  });

  test('B4 국고가 모자라면 수락만 이유를 보이고 화면을 열어도 행이 늘지 않는다', async ({ browser }) => {
    const a = await f.actor(browser, 'p3a');
    const b = await f.actor(browser, 'p3b');
    const proposal = await proposeByHttp(a, PAIRS.P3.b, NAP12);
    const before = { events: await f.eventCount(), treaties: await f.treatyCount() };

    const calls = watchTrpc(b.page);
    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    const { item } = await listed(b, proposal.treatyId);
    // 비용이 0이면 국고 안내를 증명할 수 없다.
    expect(item?.estimate?.mine).toBeGreaterThan(0);
    expect(item?.canAccept).toMatchObject({ ok: false, code: 'INSUFFICIENT_GOLD' });
    expect(item?.canReject).toEqual({ ok: true });
    const reason = (item!.canAccept as { reason: string }).reason;

    const incoming = card(b.page, proposal.treatyId);
    await expect(incoming.getByTestId('treaty-estimate')).toContainText(`우리 금 ${won(item!.estimate!.mine)}`);
    // 점선 단추는 수락이 아니라 이유 보기다. 눌러도 응답 요청을 보내지 않는다(아래 calls로 확인).
    await incoming.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ }).click();
    await expect(incoming.getByRole('note')).toHaveText(reason);
    const reject = incoming.getByRole('button', { name: '거절', exact: true });
    await expect(reject).toBeVisible();
    await expect(reject).not.toHaveAttribute('data-unavailable', 'true');

    expect(requestIdsOf(calls, 'POST', 'treaty.respond')).toEqual([]);
    expect(await f.eventCount()).toBe(before.events);
    expect(await f.treatyCount()).toBe(before.treaties);
    expect((await f.treaty(proposal.treatyId))?.status).toBe('PROPOSED');
    p3 = { treatyId: proposal.treatyId };
  });

  test('B5 안내 뒤 국고가 비면 엔진이 거절하고 성공 문구 없이 이유만 보인다', async ({ browser }) => {
    const a = await f.actor(browser, 'p4a');
    const b = await f.actor(browser, 'p4b');
    const proposal = await proposeByHttp(a, PAIRS.P4.b, NAP12);

    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    const { item } = await listed(b, proposal.treatyId);
    expect(item?.estimate?.mine).toBeGreaterThan(0);
    expect(item?.canAccept).toEqual({ ok: true });
    const incoming = card(b.page, proposal.treatyId);
    await expect(incoming.getByTestId('treaty-estimate')).toContainText(`우리 금 ${won(item!.estimate!.mine)}`);
    const accept = incoming.getByRole('button', { name: '수락', exact: true });
    await expect(accept).toBeVisible();

    await f.emptyTreasury(PAIRS.P4.b);
    const calls = watchTrpc(b.page);
    await accept.click();
    const rejected = finished(b.page, 'rejected');
    await expect(rejected).toContainText('수락 요청이 거절되었습니다');
    await expect(panel(b.page)).not.toContainText('조약을 맺었습니다');
    const requestId = await requestIdOf(rejected);
    expect(requestIdsOf(calls, 'POST', 'treaty.respond')).toEqual([requestId]);

    const event = single(await f.eventsByKey(`treaty.respond:${requestId}`));
    expect(event).toMatchObject({
      kind: 'treaty.respond',
      status: 'REJECTED',
      generalId: b.generalId,
      result: { code: 'INSUFFICIENT_GOLD' },
    });
    expect((await f.treaty(proposal.treatyId))?.status).toBe('PROPOSED');
    expect(await f.relation(PAIRS.P4.a, PAIRS.P4.b)).toBeNull();
    await f.closeActors('p4a', 'p4b');
  });

  test('B6 수락 응답을 잃으면 같은 requestId로 결과를 되찾고 입력 행은 하나다', async ({ browser }) => {
    const a = await f.actor(browser, 'p5a');
    const b = await f.actor(browser, 'p5b');
    const proposal = await proposeByHttp(a, PAIRS.P5.b, NAP12);

    const calls = watchTrpc(b.page);
    const drop = await dropFirstResponse(b.page, 'treaty.respond');
    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    await card(b.page, proposal.treatyId).getByRole('button', { name: '수락', exact: true }).click();
    const lost = panel(b.page).locator('li[data-phase="unknown"]');
    await expect(lost).toBeVisible();
    expect(drop.shapeErrors()).toEqual([]);
    const dropped = drop.get();
    expect(dropped?.fetchError).toBeUndefined();
    expect(dropped?.httpStatus).toBe(200);
    const requestId = dropped!.requestId;
    expect(requestId).toMatch(UUID);
    await expect(lost).toHaveAttribute('data-request-id', requestId);
    await drop.stop();

    // 브라우저가 응답을 받지 못한 요청도 서버는 한 번 접수했고 엔진이 처리했다.
    const key = `treaty.respond:${requestId}`;
    await expect.poll(() => statuses(f, key)).toEqual(['treaty.respond:APPLIED']);

    await lost.getByRole('button', { name: '같은 요청 다시 보내기' }).click();
    const accepted = finished(b.page, 'applied', 'ACCEPTED');
    await expect(accepted).toHaveAttribute('data-request-id', requestId);
    await expect(accepted).toContainText('조약을 맺었습니다');
    expect(requestIdsOf(calls, 'POST', 'treaty.respond')).toEqual([requestId, requestId]);

    const event = single(await f.eventsByKey(key));
    expect(event).toMatchObject({
      status: 'APPLIED',
      generalId: b.generalId,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', treatyId: String(proposal.treatyId) },
    });
    const cost = event.result.cost!;
    const treaty = await f.treaty(proposal.treatyId);
    expect(treaty).toMatchObject({ status: 'ACTIVE', costFrom: cost.from, costTo: cost.to });
    expect(await f.relation(PAIRS.P5.a, PAIRS.P5.b)).toEqual({ state: 'NON_AGGRESSION', untilTick: treaty!.endTick });
    await f.closeActors('p5a', 'p5b');
  });

  test('B7 제안 응답을 잃고 새로 고치면 같은 탭에 저장된 requestId로 결과를 되찾는다', async ({ browser }) => {
    const a = await f.actor(browser, 'p6a');
    await openComposer(a, PAIRS.P6.b);
    await checkNonAggression(a, 12);
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');

    const calls = watchTrpc(a.page);
    const drop = await dropFirstResponse(a.page, 'treaty.propose');
    await sendProposal(a);
    const lost = panel(a.page).locator('li[data-phase="unknown"]');
    await expect(lost).toBeVisible();
    expect(drop.shapeErrors()).toEqual([]);
    const dropped = drop.get();
    expect(dropped?.fetchError).toBeUndefined();
    expect(dropped?.httpStatus).toBe(200);
    const requestId = dropped!.requestId;
    expect(requestId).toMatch(UUID);
    await expect(lost).toHaveAttribute('data-request-id', requestId);
    await drop.stop();

    const key = `treaty.propose:${requestId}`;
    await expect.poll(() => statuses(f, key)).toEqual(['treaty.propose:APPLIED']);
    const storageKey = `opensamguk.treatyRequests.v2:${a.userId}:${a.worldId}`;
    const stored = await a.page.evaluate((k) => window.sessionStorage.getItem(k), storageKey);
    expect(JSON.parse(stored ?? 'null')).toEqual([
      { requestId, action: { kind: 'treaty.propose', input: { toNationId: PAIRS.P6.b, clauses: NAP12 } } },
    ]);

    await a.page.reload();
    const recovered = finished(a.page, 'applied', 'PROPOSED');
    await expect(recovered).toHaveAttribute('data-request-id', requestId);
    await expect(recovered).toContainText('제안을 보냈습니다');
    expect(requestIdsOf(calls, 'GET', 'treaty.request')).toContain(requestId);
    expect(requestIdsOf(calls, 'POST', 'treaty.propose')).toEqual([requestId]);
    expect(await a.page.evaluate((k) => window.sessionStorage.getItem(k), storageKey)).toBeNull();

    const event = single(await f.eventsByKey(key));
    expect(event).toMatchObject({ status: 'APPLIED', generalId: a.generalId, result: { outcome: 'PROPOSED' } });
    expect(await f.treaty(Number(event.result.treatyId))).toMatchObject({
      status: 'PROPOSED',
      fromNationId: PAIRS.P6.a,
      toNationId: PAIRS.P6.b,
    });
    await f.closeActors('p6a');
  });

  test('B8 기록만 남길 약속은 기록 구역에만 보이고 수락해도 관계가 생기지 않는다', async ({ browser }) => {
    const a = await f.actor(browser, 'p7a');
    const b = await f.actor(browser, 'p7b');
    const text = '해마다 사신을 보내 안부를 묻는다';
    await openComposer(a, PAIRS.P7.b);
    await a.page.getByLabel('기록만 남길 약속', { exact: true }).check();
    await a.page.getByLabel(/^문장 \(/).fill(text);
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금 0 · 상대 금 0');
    await sendProposal(a);
    const proposed = finished(a.page, 'applied', 'PROPOSED');
    await expect(proposed).toContainText('제안을 보냈습니다');
    const treatyId = Number((await eventOf(f, 'treaty.propose', proposed)).result.treatyId);

    await b.page.goto(`/w/${b.worldId}/diplomacy?tab=incoming`);
    const incoming = card(b.page, treatyId);
    await expect(incoming.getByRole('region', { name: '기록만 남는 조항' })).toContainText(
      `기록만 남길 약속 (${text})`,
    );
    await expect(incoming.getByRole('region', { name: '서버가 집행하는 조항' })).toHaveCount(0);
    await incoming.getByRole('button', { name: '수락', exact: true }).click();
    const accepted = finished(b.page, 'applied', 'ACCEPTED');
    await expect(accepted).toContainText('조약을 맺었습니다');

    expect(await eventOf(f, 'treaty.respond', accepted)).toMatchObject({
      status: 'APPLIED',
      generalId: b.generalId,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', cost: { from: 0, to: 0 }, endTick: null },
    });
    expect(await f.treaty(treatyId)).toMatchObject({ status: 'ACTIVE', endTick: null });
    expect(await f.relation(PAIRS.P7.a, PAIRS.P7.b)).toBeNull();

    await a.page.goto(`/w/${a.worldId}/diplomacy?tab=active`);
    const active = card(a.page, treatyId);
    await expect(active.getByRole('region', { name: '기록만 남는 조항' })).toContainText(text);
    await expect(active.getByRole('region', { name: '서버가 집행하는 조항' })).toHaveCount(0);
    await f.closeActors('p7a', 'p7b');
  });

  test('B9 권한 없는 직위는 서버가 NO_PERMISSION을 주고 읽기만 한다', async ({ browser }) => {
    if (!p3) throw new Error('B4 사례의 제안이 없어 B9를 진행할 수 없습니다.');
    const chief = await f.actor(browser, 'p3chief');
    const calls = watchTrpc(chief.page);
    const { page: list, item } = await listed(chief, p3.treatyId);
    expect(list.canPropose).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
    expect(item?.status).toBe('PROPOSED');
    expect(item?.canAccept).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
    expect(item?.canReject).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
    expect(item?.estimate?.mine).toBeGreaterThan(0);

    await chief.page.goto(`/w/${chief.worldId}/diplomacy?tab=incoming`);
    const incoming = card(chief.page, p3.treatyId);
    await expect(incoming.getByTestId('treaty-estimate')).toContainText(`우리 금 ${won(item!.estimate!.mine)}`);
    await expect(incoming).toContainText(`외교 문서는 군주와 참모가 답합니다. ${READ_ONLY}`);
    await expect(incoming.getByRole('button')).toHaveCount(0);

    await chief.page.goto(`/w/${chief.worldId}/diplomacy?tab=write`);
    const reason = (list.canPropose as { reason: string }).reason;
    const note = chief.page.getByRole('note').filter({ hasText: READ_ONLY });
    await expect(note).toHaveText(`${reason} ${READ_ONLY}`);
    await expect(chief.page.getByRole('columnheader', { name: '국가', exact: true })).toBeVisible();
    await expect(chief.page.getByRole('columnheader', { name: '우리와의 관계', exact: true })).toBeVisible();
    await expect(chief.page.getByRole('button', { name: /제안 보내기/ })).toHaveCount(0);

    expect(requestIdsOf(calls, 'POST', 'treaty.respond')).toEqual([]);
    expect(requestIdsOf(calls, 'POST', 'treaty.propose')).toEqual([]);
    expect(await f.eventCount({ generalId: chief.generalId, kinds: ['treaty.propose', 'treaty.respond'] })).toBe(0);
    expect((await f.treaty(p3.treatyId))?.status).toBe('PROPOSED');
    await f.closeActors('p3a', 'p3b', 'p3chief');
  });

  test('B10 뒤 네 조항은 고를 수 없고 지원하지 않는 조회를 부르지 않는다', async ({ browser }) => {
    const s = await f.actor(browser, 'screen');
    const calls = watchTrpc(s.page);
    await s.page.goto(`/w/${s.worldId}/diplomacy?tab=write`);
    const form = s.page.getByRole('form', { name: '조약서 쓰기' });
    for (const label of ['통행 허용', '정기 원조', '교역 허용', '도시 이양']) {
      await expect(form.getByLabel(label, { exact: true })).toBeDisabled();
      await expect(form.locator(`[data-clause="${label}"][data-unsupported="true"]`)).toContainText(UNSUPPORTED);
    }
    // 지원하는 조항으로 견적을 한 번 받아 조약서가 쓰는 조회를 모두 거치게 한다. 보내지는 않는다.
    await s.page.getByLabel('상대').selectOption(String(PAIRS.P1.a));
    await form.getByLabel('불가침', { exact: true }).check();
    await expect(s.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    for (const tab of ['incoming', 'active']) await s.page.goto(`/w/${s.worldId}/diplomacy?tab=${tab}`);
    await expect(s.page.getByRole('navigation', { name: '외교실 탭' })).toBeVisible();

    expect(calls.some((c) => c.procedure === 'treaty.list')).toBe(true);
    expect(calls.some((c) => c.procedure === 'treaty.quote')).toBe(true);
    const unsupported = ['treaty.trust', 'treaty.tradeTargets', 'treaty.break'];
    expect(calls.filter((c) => unsupported.includes(c.procedure)).map((c) => c.procedure)).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST' && c.procedure.startsWith('treaty.'))).toEqual([]);
    await f.closeActors('screen');
  });

  test('B11 형식 1 대조 월드는 빈 목록 대신 서버의 PRECONDITION_FAILED 문장을 보인다', async ({ browser }) => {
    const l = await f.actor(browser, 'legacy');
    const response = await l.page.request.get(
      `/trpc/treaty.list?input=${encodeURIComponent(JSON.stringify({ worldId: l.worldId }))}`,
    );
    expect(response.status()).toBe(412);
    const body = (await response.json()) as { error?: { message?: string; data?: { code?: string } } };
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    const message = body.error?.message ?? '';
    expect(message).not.toBe('');

    await l.page.goto(`/w/${l.worldId}/diplomacy`);
    await expect(l.page.getByTestId('treaty-unavailable')).toHaveText(message);
    await expect(l.page.getByText(/조약이 없습니다/)).toHaveCount(0);
    await f.closeActors('legacy');
  });

  test('B13 교전 상대와 종전만 맺으면 비용 0으로 수락되고 관계가 사라진다', async ({ browser }) => {
    const a = await f.actor(browser, 'p8a');
    const w = await f.actor(browser, 'p8b');
    await openComposer(a, PAIRS.P8.b);
    await expect(a.page.getByTestId('target-relation')).toHaveText('교전');
    const peace = a.page.getByLabel('종전', { exact: true });
    await expect(peace).toBeEnabled();
    await peace.check();
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금 0 · 상대 금 0');
    await sendProposal(a);
    const proposed = finished(a.page, 'applied', 'PROPOSED');
    await expect(proposed).toContainText('제안을 보냈습니다');
    const treatyId = Number((await eventOf(f, 'treaty.propose', proposed)).result.treatyId);

    await w.page.goto(`/w/${w.worldId}/diplomacy?tab=incoming`);
    const incoming = card(w.page, treatyId);
    await expect(incoming.getByTestId('treaty-estimate')).toContainText('우리 금 0 · 상대 금 0');
    await incoming.getByRole('button', { name: '수락', exact: true }).click();
    const accepted = finished(w.page, 'applied', 'ACCEPTED');
    await expect(accepted).toContainText('조약을 맺었습니다');

    expect(await eventOf(f, 'treaty.respond', accepted)).toMatchObject({
      status: 'APPLIED',
      generalId: w.generalId,
      result: { outcome: 'ACCEPTED', by: 'HUMAN', cost: { from: 0, to: 0 }, endTick: null },
    });
    expect(await f.treaty(treatyId)).toMatchObject({ status: 'ACTIVE', endTick: null, costFrom: 0, costTo: 0 });
    expect(await f.relation(PAIRS.P8.a, PAIRS.P8.b)).toBeNull();

    await w.page.goto(`/w/${w.worldId}/diplomacy?tab=active`);
    const active = card(w.page, treatyId);
    await expect(active).toContainText('진행 중');
    await expect(active.getByRole('region', { name: '서버가 집행하는 조항' })).toContainText('종전');
    await openComposer(a, PAIRS.P8.b);
    await expect(a.page.getByTestId('target-relation')).toHaveText('관계 없음');
    await f.closeActors('p8a', 'p8b');
  });

  test('B14 선포한 상대와 종전과 불가침을 맺으면 비용을 내고 불가침 관계가 된다', async ({ browser }) => {
    const a = await f.actor(browser, 'p9a');
    const d = await f.actor(browser, 'p9b');
    await openComposer(a, PAIRS.P9.b);
    await expect(a.page.getByTestId('target-relation')).toHaveText(
      `선포 (${f.yearMonth(PAIRS.P9.relation.untilTick)}까지)`,
    );
    await a.page.getByLabel('종전', { exact: true }).check();
    await checkNonAggression(a, 12);
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    await sendProposal(a);
    const proposed = finished(a.page, 'applied', 'PROPOSED');
    await expect(proposed).toContainText('제안을 보냈습니다');
    const treatyId = Number((await eventOf(f, 'treaty.propose', proposed)).result.treatyId);

    await d.page.goto(`/w/${d.worldId}/diplomacy?tab=incoming`);
    await card(d.page, treatyId).getByRole('button', { name: '수락', exact: true }).click();
    const accepted = finished(d.page, 'applied', 'ACCEPTED');
    await expect(accepted).toContainText('조약을 맺었습니다');

    const event = await eventOf(f, 'treaty.respond', accepted);
    expect(event).toMatchObject({ status: 'APPLIED', generalId: d.generalId, result: { outcome: 'ACCEPTED' } });
    expect(event.result.cost!.from).toBeGreaterThan(0);
    expect(event.result.cost!.to).toBeGreaterThan(0);
    const treaty = await f.treaty(treatyId);
    expect(treaty).toMatchObject({ status: 'ACTIVE', endTick: event.result.endTick });
    expect(await f.relation(PAIRS.P9.a, PAIRS.P9.b)).toEqual({ state: 'NON_AGGRESSION', untilTick: treaty!.endTick });

    await openComposer(a, PAIRS.P9.b);
    await expect(a.page.getByTestId('target-relation')).toHaveText(`불가침 (${f.yearMonth(treaty!.endTick!)}까지)`);
    await f.closeActors('p9a', 'p9b');
  });

  test('B15 국고가 빈 NPC 국가에 불가침을 보내면 엔진의 NPC 판단으로 곧바로 거절된다', async ({ browser }) => {
    const a = await f.actor(browser, 'p10a');
    await openComposer(a, PAIRS.P10.b);
    await checkNonAggression(a, 12);
    await expect(a.page.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    await sendProposal(a);
    const declined = finished(a.page, 'applied', 'DECLINED');
    await expect(declined).toContainText('상대가 제안을 거절했습니다');
    const requestId = await requestIdOf(declined);
    await expect(recent(a.page, requestId)).toHaveText('제안 · 상대가 거절함');

    const event = single(await f.eventsByKey(`treaty.propose:${requestId}`));
    expect(event).toMatchObject({
      kind: 'treaty.propose',
      status: 'APPLIED',
      generalId: a.generalId,
      result: { outcome: 'DECLINED', by: 'NPC' },
    });
    expect((await f.treaty(Number(event.result.treatyId)))?.status).toBe('REJECTED');
    expect(await f.relation(PAIRS.P10.a, PAIRS.P10.b)).toBeNull();
    await f.closeActors('p10a');
  });
});
