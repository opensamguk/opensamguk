import type { Page, Response } from '@playwright/test';
import {
  advanceTurn,
  apiMutate,
  apiQuery,
  expect,
  recordTrpc,
  refreshSignal,
  ROLES,
  seedPrivateMessages,
  setGeneral,
  setNationNotice,
  test,
  trpcCalls,
  trpcInputs,
  trpcResult,
  type T210User,
  type T210World,
} from './t210-fixture';

// T2-10 · AC-M2-04, AC-M2-07: 자기 DB·API·Vite 묶음(t210-fixture.ts)과 역할별 브라우저로 메시지·공지·실시간 갱신을 본다.
// AC-M2-07의 2초는 1번(메시지)과 2번(턴 결과)으로 판정한다. 시작점은 메시지면 [보내기]를 누르기 직전, 턴이면 엔진 트랜잭션의
// beforeCommit 안이다. 둘 다 실제 commit보다 이르므로 잰 시간은 commit부터 화면 표시까지의 상한이다.
// API가 없으면 건너뛰지 않고 실패한다. 가짜 EventSource만으로는 인수하지 않는다 (계획 T2-10 검증).

test.use({ trace: 'off', screenshot: 'only-on-failure' });

type Unread = Record<'PRIVATE' | 'NATION' | 'DIPLOMACY' | 'WORLD', number | null>;
interface NoticeView {
  nationId: number;
  revision: number;
  unseen: boolean;
}

// httpBatchLink 묶음 안에 path가 있는 성공 응답.
const isCall = (path: string) => (response: Response) =>
  trpcInputs(response.request(), path).length > 0 && response.ok();

// path의 결과가 check를 만족하는 성공 응답을 기다린다.
const waitResult = (page: Page, path: string, check: (data: unknown) => boolean) =>
  page.waitForResponse(async (response) => isCall(path)(response) && check(await trpcResult(response, path)));

const homeNation = (nationId: number | null) => (data: unknown) =>
  (data as { general?: { nationId: number | null } } | undefined)?.general?.nationId === nationId;

const realtime = (page: Page) => page.getByTestId('realtime-status');

async function expectOpen(page: Page) {
  await expect(realtime(page)).toHaveAttribute('data-realtime', 'open', { timeout: 15_000 });
}

// 메시지 전체 화면. 안 읽음 수 응답까지 받은 뒤 돌아온다.
async function openMessages(user: T210User, world: T210World) {
  const unread = user.page.waitForResponse(isCall('message.unread'));
  await user.page.goto(`/w/${world.id}/messages`);
  await expect(user.page.getByRole('heading', { level: 1, name: '메시지' })).toBeVisible();
  await unread;
  await expectOpen(user.page);
}

async function openMain(user: T210User, world: T210World) {
  await user.page.goto(`/w/${world.id}`);
  await expect(user.page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
  await expectOpen(user.page);
}

// 브라우저 문맥을 끊었다 잇는다. SSE가 다시 열리면 서버가 ready를 보낸다.
async function reconnect(page: Page) {
  await page.context().setOffline(true);
  await expect(realtime(page)).toHaveAttribute('data-realtime', 'reconnecting', { timeout: 10_000 });
  const since = Date.now();
  await page.context().setOffline(false);
  await expect(realtime(page)).toHaveAttribute('data-realtime', 'open', { timeout: 30_000 });
  return since;
}

// 팝업의 [확인]을 누르고 markSeen 응답까지 받는다. 화면은 응답 전에 팝업을 내리므로 저장이 끝난 것은 응답으로 확인한다.
async function closePopup(page: Page) {
  const answered = page.waitForResponse(isCall('notice.nation.markSeen'));
  await page.getByTestId('nation-notice-popup').getByRole('button', { name: '확인' }).click();
  const response = await answered;
  return {
    input: trpcInputs(response.request(), 'notice.nation.markSeen'),
    result: await trpcResult(response, 'notice.nation.markSeen'),
  };
}

const messageIds = (page: Page, scope = page.locator('body')) =>
  scope.locator('[data-message-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));

test.describe('메시지와 실시간 갱신', () => {
  test('1 A가 보낸 개인 메시지가 B 화면에 새로고침 없이 2초 안에 보인다', async ({ world }) => {
    const a = await world.user('ruler');
    const b = await world.user('member');
    await openMessages(a, world);
    await openMessages(b, world);
    const body = `실시간 시험 ${Date.now()}`;
    await a.page.getByRole('tab', { name: /^개인/ }).click();
    await a.page.getByRole('combobox', { name: '받는 장수' }).selectOption(String(b.generalId));
    await a.page.getByRole('textbox', { name: '메시지 내용' }).fill(body);
    const started = Date.now();
    await a.page.getByRole('button', { name: '보내기', exact: true }).click();
    await expect(b.page.getByText(body, { exact: true })).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    // 보낸 쪽은 send 응답 행 하나만 보인다.
    await expect(a.page.getByText(body, { exact: true })).toHaveCount(1);
  });

  test('2 내 턴 결과가 2초 안에 메인 개인 기록에 보이고 저장하지 않은 30칸 편집은 남아 STALE로 이어진다', async ({
    world,
  }) => {
    // 기존 턴 결과 시험(0bac458)의 한도 그대로다.
    test.setTimeout(150_000);
    const b = await world.user('member');
    await openMain(b, world);
    const page = b.page;
    const editor = page.getByTestId('turn-editor');
    await page.getByRole('grid', { name: '예턴 30칸' }).locator('tr[data-slot="1"]').click();
    await editor.getByRole('button', { name: '고른 칸 비우기', exact: true }).click();
    await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    const draftKey = `opensamguk.turnDraft.v1:${b.userId}:${world.id}`;
    const storedDraft = () => page.evaluate((key) => sessionStorage.getItem(key), draftKey);
    const stored = await storedDraft();
    expect(stored).not.toBeNull();

    const logs = page.locator('[data-record-kind="general"] li[data-log-kind]');
    await expect(page.locator('[data-record-kind="general"]')).toBeVisible();
    await expect(logs).toHaveCount(0);
    const committedAt = await advanceTurn(world, b.generalId);
    await expect(logs.first()).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - committedAt).toBeLessThan(2_000);

    // 턴 실행으로 서버 예턴의 revision이 바뀐다. 초안은 덮지 않고 안내만 한다 (TurnEditor.tsx).
    await expect(
      editor.getByText(
        '다른 곳에서 예턴이 바뀌었습니다(다른 탭 저장이나 턴 실행). 저장하면 최신 목록에 다시 적용할지 묻습니다.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    expect(await storedDraft()).toBe(stored);

    const saved = page.waitForResponse(isCall('turns.set'));
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    expect(await trpcResult(await saved, 'turns.set')).toMatchObject({ ok: false, reason: 'STALE' });
    const stale = page.getByTestId('stale-alert');
    await expect(stale).toContainText('다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.');
    await expect(stale).toContainText('내 편집 1건은 버리지 않고 보관했습니다.');
    await stale.getByRole('button', { name: '내 편집 다시 적용' }).click();
    await expect(editor.getByText('최신 목록에 내 편집을 다시 적용했습니다. 확인한 뒤 저장하세요.')).toBeVisible();
  });

  test('3 외교 탭은 군주·참모에게만 보인다', async ({ world }) => {
    for (const role of ['ruler', 'adviser', 'member', 'ronin'] as const) {
      const user = await world.user(role);
      const leader = role === 'ruler' || role === 'adviser';
      const unread = await apiQuery<Unread>(user, 'message.unread', { worldId: world.id });
      expect(unread.DIPLOMACY === null).toBe(!leader);
      expect(unread.NATION === null).toBe(role === 'ronin');
      await openMessages(user, world);
      // 새 월드라 개인 목록은 비어 있다. 이 빈 목록은 권한 값을 정한 뒤 서버에서 받은 결과라서 탭도 서버 응답으로 그려진 뒤다.
      await expect(user.page.getByText('메시지가 없습니다')).toBeVisible();
      await expect(user.page.getByRole('tab', { name: /^국가/ })).toHaveCount(role === 'ronin' ? 0 : 1);
      await expect(user.page.getByRole('tab', { name: /^외교/ })).toHaveCount(leader ? 1 : 0);
    }
  });

  test('4 연결을 끊었다 이으면 전체를 다시 읽고 지도 선택·30칸 초안·작성 칸·공지 초안·목록이 그대로다', async ({
    world,
  }) => {
    // 기존 재연결 시험(0bac458)처럼 한도를 따로 정하지 않고 프로젝트 기본을 따른다.
    const a = await world.user('ruler');
    await seedPrivateMessages(world, 'member', 'ruler', 3);
    await openMain(a, world);
    const page = a.page;

    // 지도에서 내 도시가 아닌 도시를 고른다. 선택은 주소의 ?city에 있다.
    const map = page.getByTestId('world-map');
    const city = map.locator('[data-city-key]:not([data-mine])').first();
    const cityKey = await city.getAttribute('data-city-key');
    await city.click();
    const selected = new RegExp(`[?&]city=${cityKey}(&|$)`);
    await expect(page).toHaveURL(selected);

    const editor = page.getByTestId('turn-editor');
    await page.getByRole('grid', { name: '예턴 30칸' }).locator('tr[data-slot="2"]').click();
    await editor.getByRole('button', { name: '고른 칸 비우기', exact: true }).click();
    await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

    const noticeBox = page.getByTestId('nation-notice');
    await noticeBox.getByRole('button', { name: '고치기', exact: true }).click();
    await noticeBox.getByRole('textbox').fill('고치던 공지');

    await page.getByTestId('message-button').click();
    const drawer = page.locator('#message-drawer');
    await drawer.getByRole('tab', { name: /^개인/ }).click();
    const compose = drawer.getByRole('textbox', { name: '메시지 내용' });
    await compose.fill('끊긴 동안 쓰던 글');
    await expect(drawer.locator('[data-message-id]')).toHaveCount(3);
    const rowsBefore = await messageIds(page, drawer);

    const calls = recordTrpc(page);
    const since = await reconnect(page);
    // ready 하나가 전체 무효화를 정확히 한 번 부르는 것은 realtime.test.ts가 본다. 여기서는 실제 재연결 뒤 각 키를 다시 받는지 본다.
    // world.map(30초)과 message.recipients(60초)는 아직 신선하면 브라우저 재연결 재조회로는 다시 받지 않는다.
    const required = [
      'home.get',
      'turns.get',
      'world.map',
      'message.unread',
      'message.list',
      'message.recipients',
      'notice.nation.get',
    ];
    await expect
      .poll(() => required.filter((path) => !calls.some((call) => call.path === path && call.at >= since)), {
        timeout: 10_000,
      })
      .toEqual([]);

    await expect(page).toHaveURL(selected);
    await expect(map.locator(`[data-city-key="${cityKey}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(compose).toHaveValue('끊긴 동안 쓰던 글');
    await expect(noticeBox.getByRole('textbox')).toHaveValue('고치던 공지');
    const rowsAfter = await messageIds(page, drawer);
    expect(new Set(rowsAfter).size).toBe(rowsAfter.length);
    expect(rowsAfter).toEqual(rowsBefore);
  });

  test('5 공지를 고치면 소속 장수가 다음 접속 때 팝업을 보고, 띄운 채 다시 고치면 띄운 판을 보낸 뒤 새 판을 한 번 더 본다', async ({
    world,
  }) => {
    const a = await world.user('ruler');
    const b = await world.user('member');
    const first = await apiMutate<NoticeView>(world, a, 'notice.nation.set', { worldId: world.id, body: '첫 공지' });
    await openMain(b, world);
    const popup = b.page.getByTestId('nation-notice-popup');
    await expect(popup).toContainText('첫 공지');
    await expect(popup).toHaveAttribute('data-revision', String(first.revision));

    // 다른 군주 세션이 다시 고친다. 실시간 알림으로 캐시는 새 판이 되지만 띄운 팝업은 첫 판 그대로다.
    const refetched = b.page.waitForResponse(isCall('notice.nation.get'));
    const second = await apiMutate<NoticeView>(world, a, 'notice.nation.set', { worldId: world.id, body: '둘째 공지' });
    await refetched;
    await expect(popup).toHaveAttribute('data-revision', String(first.revision));
    await expect(popup).toContainText('첫 공지');

    const nationId = ROLES.member.nationId;
    let closed = await closePopup(b.page);
    expect(closed.input).toEqual([{ worldId: world.id, nationId, revision: first.revision }]);
    expect(closed.result).toMatchObject({ nationId, revision: second.revision, unseen: true });
    await expect(popup).toHaveAttribute('data-revision', String(second.revision));
    await expect(popup).toContainText('둘째 공지');

    closed = await closePopup(b.page);
    expect(closed.input).toEqual([{ worldId: world.id, nationId, revision: second.revision }]);
    expect(closed.result).toMatchObject({ nationId, revision: second.revision, unseen: false });
    await expect(popup).toHaveCount(0);

    const fetched = b.page.waitForResponse(isCall('notice.nation.get'));
    await b.page.reload();
    await expect(b.page.getByRole('heading', { level: 1, name: '메인' })).toBeVisible();
    expect(await trpcResult(await fetched, 'notice.nation.get')).toMatchObject({ unseen: false });
    await expect(popup).toHaveCount(0);
  });

  test('6 같은 revision인 두 국가 사이에서 옮기면 닫을 때 원래 국가의 판을 보내고 새 국가 공지가 뜨며 재야가 되면 뜨지 않는다', async ({
    world,
  }) => {
    test.setTimeout(120_000);
    const m = await world.user('member');
    const page = m.page;
    await setNationNotice(world, 1, '1번 국가 공지', 3);
    await setNationNotice(world, 2, '2번 국가 공지', 3);
    await openMain(m, world);
    const popup = page.getByTestId('nation-notice-popup');
    await expect(popup).toHaveAttribute('data-nation-id', '1');
    await expect(popup).toHaveAttribute('data-revision', '3');
    await expect(popup).toContainText('1번 국가 공지');

    // 국가를 옮기고 실시간 신호로 화면이 새 home과 새 국가의 공지를 받게 한다. 띄운 팝업은 1번 국가의 판 그대로다.
    await setGeneral(world, m.generalId, { nationId: 2, officerLevel: 1 });
    let moved = waitResult(page, 'home.get', homeNation(2));
    let fresh = waitResult(page, 'notice.nation.get', (data) => (data as NoticeView | null)?.nationId === 2);
    await refreshSignal(world);
    await moved;
    await fresh;
    await expect(popup).toHaveAttribute('data-nation-id', '1');
    await expect(popup).toContainText('1번 국가 공지');
    let closed = await closePopup(page);
    expect(closed.input).toEqual([{ worldId: world.id, nationId: 1, revision: 3 }]);
    expect(closed.result).toMatchObject({ nationId: 2, revision: 3, unseen: true });
    await expect(popup).toHaveAttribute('data-nation-id', '2');
    await expect(popup).toContainText('2번 국가 공지');

    // 닫지 않고 새로고침하면 다시 뜬다.
    await page.reload();
    await expect(popup).toHaveAttribute('data-nation-id', '2');
    closed = await closePopup(page);
    expect(closed.input).toEqual([{ worldId: world.id, nationId: 2, revision: 3 }]);
    expect(closed.result).toMatchObject({ nationId: 2, revision: 3, unseen: false });
    await expect(popup).toHaveCount(0);
    let fetched = page.waitForResponse(isCall('notice.nation.get'));
    await page.reload();
    expect(await trpcResult(await fetched, 'notice.nation.get')).toMatchObject({ nationId: 2, unseen: false });
    await expect(popup).toHaveCount(0);

    // 재야가 되면 닫을 때 응답이 null이라 다시 띄우지 않는다.
    await setNationNotice(world, 2, '2번 국가 새 공지', 4);
    await page.reload();
    await expect(popup).toHaveAttribute('data-revision', '4');
    await setGeneral(world, m.generalId, { nationId: null, officerLevel: 0 });
    moved = waitResult(page, 'home.get', homeNation(null));
    fresh = waitResult(page, 'notice.nation.get', (data) => data === null);
    await refreshSignal(world);
    await moved;
    await fresh;
    await expect(popup).toHaveAttribute('data-nation-id', '2');
    await expect(popup).toHaveAttribute('data-revision', '4');
    closed = await closePopup(page);
    expect(closed.input).toEqual([{ worldId: world.id, nationId: 2, revision: 4 }]);
    expect(closed.result).toBeNull();
    await expect(popup).toHaveCount(0);
    fetched = page.waitForResponse(isCall('notice.nation.get'));
    await page.reload();
    expect(await trpcResult(await fetched, 'notice.nation.get')).toBeNull();
    await expect(popup).toHaveCount(0);
  });

  test('7 직책이 해제되면 쓰던 외교 글은 서버 거절과 함께 남고 신호 뒤 외교 탭과 공지 고치기가 사라진다', async ({
    world,
  }) => {
    const r = await world.user('adviser');
    // 같은 계정의 두 탭. 메인 탭에서 국가 공지 칸을, 메시지 탭에서 외교 작성 칸을 본다.
    await openMain(r, world);
    const noticeBox = r.page.getByTestId('nation-notice');
    await expect(noticeBox.getByRole('button', { name: '고치기', exact: true })).toBeVisible();
    const page = await r.context.newPage();
    const messages: T210User = { ...r, page };
    await openMessages(messages, world);
    await page.getByRole('tab', { name: /^외교/ }).click();
    await page.getByRole('combobox', { name: '받는 국가' }).selectOption(String(ROLES.rival.nationId));
    const box = page.getByRole('textbox', { name: '메시지 내용' });
    await box.fill('동맹을 청합니다');

    await setGeneral(world, r.generalId, { nationId: 1, officerLevel: 1 });
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('이 범위의 메시지를 읽을 수 없습니다.');
    await expect(box).toHaveValue('동맹을 청합니다');
    await expect(box).toHaveAccessibleDescription('이 범위의 메시지를 읽을 수 없습니다.');

    await refreshSignal(world);
    await expect(page.getByRole('tab', { name: /^외교/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^국가/ })).toHaveCount(1);
    // DisabledReason은 '고치기'와 숨은 ' (사용 불가)'를 이어 이름을 만든다. 사이 공백 처리만 허용한다.
    await expect(noticeBox.getByRole('button', { name: /^고치기\s*\(사용 불가\)$/ })).toBeVisible();
    await expect(noticeBox.getByRole('button', { name: '고치기', exact: true })).toHaveCount(0);
  });

  test('8 보낸 행과 ready 재조회, 다음 쪽이 겹쳐도 같은 id는 한 줄이고 탭 안 읽음 수가 서버와 같다', async ({
    world,
  }) => {
    test.setTimeout(120_000);
    const a = await world.user('ruler');
    await seedPrivateMessages(world, 'member', 'ruler', 25);
    await openMessages(a, world);
    const page = a.page;
    const rows = page.locator('[data-message-id]');
    await expect(rows).toHaveCount(20);
    await expect(page.getByRole('button', { name: '이전 메시지 더 보기' })).toBeVisible();

    await page.getByRole('combobox', { name: '받는 장수' }).selectOption(String(ROLES.member.generalId));
    await page.getByRole('textbox', { name: '메시지 내용' }).fill('맨 위에 들어갈 글');
    const sent = page.waitForResponse(isCall('message.send'));
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await sent;
    await expect(rows.first()).toContainText('맨 위에 들어갈 글');
    await expect(rows).toHaveCount(21);

    const calls = recordTrpc(page);
    const since = await reconnect(page);
    await expect
      .poll(() => calls.some((call) => call.path === 'message.list' && call.at >= since), { timeout: 10_000 })
      .toBe(true);
    // 다시 받은 첫 쪽은 보낸 행을 포함한 최신 20개다. 먼저 넣었던 행과 겹쳐도 한 줄이고, 밀려난 행은 다음 쪽에서 온다.
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toContainText('맨 위에 들어갈 글');
    await page.getByRole('button', { name: '이전 메시지 더 보기' }).click();
    await expect(rows).toHaveCount(26);
    const ids = await messageIds(page);
    expect(new Set(ids).size).toBe(26);
    await expect(rows.first()).toContainText('맨 위에 들어갈 글');

    const unread = await apiQuery<Unread>(a, 'message.unread', { worldId: world.id });
    await expect(page.getByRole('tab', { name: /^개인/ })).toHaveAccessibleName(
      unread.PRIVATE ? `개인, 안 읽음 ${unread.PRIVATE}건` : '개인',
    );
  });

  test('9 메시지 단추를 키보드로 열고 닫으면 초점이 돌아오고 보내기 연결 실패 뒤에도 글과 오류 안내가 남는다', async ({
    world,
  }) => {
    const b = await world.user('member');
    await openMain(b, world);
    const page = b.page;
    const button = page.getByTestId('message-button');
    const drawer = page.locator('#message-drawer');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(drawer).toBeFocused();
    await drawer.getByRole('tab', { name: /^개인/ }).click();
    await drawer.getByRole('combobox', { name: '받는 장수' }).selectOption(String(ROLES.ruler.generalId));
    const box = drawer.getByRole('textbox', { name: '메시지 내용' });
    await box.fill('끊겨도 남을 글');
    await box.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(drawer).toBeFocused();
    await expect(box).toHaveValue('끊겨도 남을 글');

    // 보내기 요청만 네트워크에서 끊는다. 서버 응답이 없으므로 연결을 확인하라는 문장이 입력칸 설명으로 붙는다.
    await page.route('**/trpc/**', (route) =>
      trpcCalls(route.request()).some((call) => call.path === 'message.send')
        ? route.abort('internetdisconnected')
        : route.continue(),
    );
    await drawer.getByRole('button', { name: '보내기', exact: true }).click();
    const failure = '보내지 못했습니다. 연결을 확인하고 다시 보내세요.';
    await expect(drawer.getByRole('alert')).toHaveText(failure);
    await expect(box).toHaveValue('끊겨도 남을 글');
    await expect(box).toHaveAccessibleDescription(failure);
    await page.unroute('**/trpc/**');
  });
});
