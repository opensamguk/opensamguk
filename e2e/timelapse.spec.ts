import type { Page, Request, Response } from '@playwright/test';
import type { Prisma } from '../packages/db/src/index';
import { createAccount, TEST_PASSWORD, withE2eDb } from './account';
import { aFrame, CITY_KEYS, dateOf, expect, insertFrame, removeFrame, test, type PreparedWorld } from './timelapseSeed';

// T4-36 · AC-P2-17 (나): 기록 화면의 영토 재생 탭. 실제 웹·API·PostgreSQL로 돈다 (docs/plans/T4-36.md 4.2).
// timelapseSeed의 worker fixture가 이 파일만의 새 _test DB와 그 DB를 쓰는 API·Vite 서버를 띄우고 월드 다섯 개를 준비한다.
// A·B·C·M은 DB 준비 프레임, P는 실제 엔진의 월간 정산 저장과 출병 멸망을 지난 월드다.
// 응답을 지어내지 않는다. page.route는 E9·E10에서 실제 요청을 잡아 두는 데만 쓰고 E9는 그대로 흘려보낸다.
// 기대값은 화면 변환 함수로 만들지 않고 준비 값에서 직접 적는다.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const FRAMES = 'timelapse.frames';
interface FramesInput {
  worldId: string;
  cursor?: string;
}
interface FramesBody {
  items: Array<{ tick: number; nations: Array<{ id: number; name: string; color: string }> }>;
  currentNations: Array<{ id: number; name: string; color: string }>;
  nextCursor: string | null;
}
interface BatchEntry {
  result?: { data: FramesBody };
  error?: { data?: { code?: string; httpStatus?: number } };
}

// httpBatchLink는 같은 때 보낸 다른 조회와 한 요청으로 묶을 수 있다. 주소의 경로 목록에서 위치를 찾아 그 입력을 읽는다.
const pathsOf = (url: string) => new URL(url).pathname.split('/').pop()!.split(',');
function framesInput(url: string): FramesInput | undefined {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/trpc/')) return undefined;
  const index = pathsOf(url).indexOf(FRAMES);
  if (index < 0) return undefined;
  const raw = parsed.searchParams.get('input');
  return ((raw ? JSON.parse(raw) : {}) as Record<string, FramesInput>)[String(index)];
}

// 브라우저가 보낸 영토 재생 요청의 입력을 보낸 순서대로 모은다.
function watchFrames(page: Page) {
  const seen: FramesInput[] = [];
  page.on('request', (request) => {
    const input = framesInput(request.url());
    if (input) seen.push(input);
  });
  return seen;
}

// 화면이 받은 서버 원본 응답에서 영토 재생 항목을 그대로 읽는다. 바꾸거나 대신 돌려주지 않는다.
async function framesEntry(response: Response): Promise<BatchEntry | undefined> {
  const body = (await response.json()) as BatchEntry[];
  return body[pathsOf(response.url()).indexOf(FRAMES)];
}
const firstPageOf = (page: Page, worldId: string) =>
  page.waitForResponse((response) => {
    const input = framesInput(response.url());
    return input?.worldId === worldId && input.cursor === undefined;
  });

// 계정 행만 이 worker의 DB에 만든다. createAccount가 넣은 세션 쿠키는 지우고 자기 웹 출처의 로그인 화면으로 들어간다.
// 만든 계정의 이메일을 돌려준다. E2가 그 계정 행을 찾을 때 쓴다.
async function login(page: Page) {
  const email = await createAccount(page);
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');
  return email;
}

const tabUrl = (world: PreparedWorld) => `/w/${world.id}/records?tab=timelapse`;
// 기록 화면의 Panel이 바깥 영역이고 TimelapseView의 영역이 그 안에 같은 이름으로 있다. 바깥 것을 쓴다.
const panel = (page: Page) => page.getByRole('region', { name: '영토 재생', exact: true }).first();
const dateLine = (page: Page) => page.getByTestId('timelapse-date');
const recordTabs = (page: Page) => page.getByRole('navigation', { name: '기록 종류' });
const recordTab = (page: Page, name: string) => recordTabs(page).getByRole('link', { name, exact: true });
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const position = (text: string | null) => Number(/\((\d+)\/\d+\)/.exec(text ?? '')?.[1] ?? Number.NaN);

// 저장된 색 문자열을 브라우저가 계산한 rgb 값으로 바꾼다. 점 채움의 계산값과 견준다.
const cssColor = (page: Page, color: string) =>
  page.evaluate((value) => {
    const probe = document.createElement('i');
    probe.style.color = value;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  }, color);
const city = (page: Page, cityKey: number) =>
  panel(page).locator(`[data-testid="timelapse-map"] [data-city-key="${cityKey}"]`);
async function fillOf(page: Page, cityKey: number) {
  const dot = city(page, cityKey).locator('circle');
  return dot.evaluate((node) => getComputedStyle(node).fill);
}
const legend = (page: Page) => panel(page).getByLabel('이 달의 국가별 도시 수');

test('E1 위쪽 메뉴 기록에서 영토 재생 탭으로 가고 새로고침 뒤에도 같은 탭이며 다른 기록 탭 3종은 그대로 열린다', async ({
  page,
  timelapseStack,
}) => {
  const { p } = timelapseStack.worlds;
  await login(page);
  await page.goto(`/w/${p.id}/map`);
  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '기록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${p.id}/records`));
  await recordTab(page, '영토 재생').click();

  const opened = async () => {
    await expect(page).toHaveURL(tabUrl(p));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('기록 · 영토 재생');
    await expect(recordTab(page, '영토 재생')).toHaveAttribute('aria-current', 'page');
    await expect(dateLine(page)).toContainText(`(1/${p.ticks.length})`);
  };
  await opened();
  await page.reload();
  await opened();

  for (const [label, title] of [
    ['내 장수', '개인 기록'],
    ['국가 역사', '국가 기록'],
    ['월드 정세', '중원 정세'],
  ] as const) {
    await recordTab(page, label).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`기록 · ${label}`);
    await expect(recordTab(page, label)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
    await expect(dateLine(page)).toHaveCount(0);
  }
});

test('E2 장수 없는 새 계정으로 A를 열면 첫 페이지와 cursor 300000으로 정확히 두 번 받고 같은 화면에서 장수를 맡아 SSE가 이어져도 다시 받지 않는다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  const email = await login(page);
  const user = await withE2eDb((db) => db.user.findUniqueOrThrow({ where: { email }, select: { id: true } }));
  // 1단계. 서버의 /sse는 이 월드에 내 장수가 없으면 404로 닫는다 (apps/server/src/realtime/index.ts). 먼저 DB에서 장수가 없음을 확인한다.
  expect(await withE2eDb((db) => db.general.count({ where: { worldId: a.id, userId: user.id } }))).toBe(0);
  const sse: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/sse') sse.push(response.status());
  });
  // 화면의 EventSource가 받은 ready를 센다. 연결과 이벤트는 그대로 두고 듣는 곳만 하나 더한다.
  await page.addInitScript(() => {
    const counter = window as unknown as { t436Ready: number };
    counter.t436Ready = 0;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args: ConstructorParameters<typeof EventSource>) {
        super(...args);
        this.addEventListener('ready', () => {
          counter.t436Ready += 1;
        });
      }
    };
  });
  const readyCount = () => page.evaluate(() => (window as unknown as { t436Ready: number }).t436Ready);
  const seen = watchFrames(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  expect(seen).toEqual([{ worldId: a.id }, { worldId: a.id, cursor: '300000' }]);
  const range = panel(page).getByRole('slider', { name: '재생 위치' });
  await expect(range).toHaveAttribute('min', '0');
  await expect(range).toHaveAttribute('max', '34');
  await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[0]!)} (1/35)`);
  await expect.poll(() => sse.length).toBeGreaterThan(0);
  expect(sse.every((status) => status === 404)).toBe(true);
  await expect(page.getByTestId('realtime-status')).not.toHaveAttribute('data-realtime', 'open');
  expect(await readyCount()).toBe(0);
  expect(seen).toHaveLength(2);
  // 같은 패널이 끝까지 남는지 날짜 줄 요소로 본다. 다시 불러오거나 다시 마운트하면 이 요소가 문서에서 떨어진다.
  const shown = await dateLine(page).elementHandle();

  // 2단계. 이 worker DB에서 A의 주인 없는 장수 하나를 이 계정에 맡긴다. 화면은 다시 열지 않고 끝에 원래 userId로 되돌린다.
  const general = await withE2eDb((db) =>
    db.general.findFirstOrThrow({
      where: { worldId: a.id, userId: null, nationId: null },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true },
    }),
  );
  const where = { worldId_id: { worldId: a.id, id: general.id } };
  await withE2eDb((db) => db.general.update({ where, data: { userId: user.id } }));
  try {
    // useWorldEvents는 서버가 닫은 연결을 1·2·5·10·30초 간격으로 다시 연다. 다음 시도가 맡긴 장수를 보고 이어진다.
    await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-realtime', 'open', { timeout: 45_000 });
    await expect.poll(() => sse.at(-1)).toBe(200);
    await expect.poll(readyCount).toBeGreaterThan(0);
    // ready를 받으면 화면은 invalidateQueries()로 모든 쿼리를 무효화한다. 이 쿼리는 다시 받지 않아야 한다.
    await page.waitForTimeout(1_500);
    expect(seen).toHaveLength(2);
    expect(await shown.evaluate((node) => node.isConnected)).toBe(true);
    await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  } finally {
    await withE2eDb((db) => db.general.update({ where, data: { userId: general.userId } }));
  }
});

test('E3 첫 화면은 가장 오래된 달이고 재생하면 날짜가 오름차순으로 바뀌며 정지하면 그대로이고 이전·다음은 한 달씩이다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  await login(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  const first = `${await dateOf(a, a.ticks[0]!)} (1/35)`;
  await expect(dateLine(page)).toHaveText(first);

  const positions: number[] = [];
  await button(page, '재생').click();
  await expect
    .poll(
      async () => {
        const at = position(await dateLine(page).textContent());
        if (positions.at(-1) !== at) positions.push(at);
        return positions.length;
      },
      { timeout: 15_000, intervals: [200] },
    )
    .toBeGreaterThanOrEqual(6);
  expect(positions[0]).toBe(1);
  expect(positions.every((at, i) => i === 0 || at > positions[i - 1]!)).toBe(true);

  await button(page, '정지').click();
  const stopped = await dateLine(page).textContent();
  await page.waitForTimeout(1_500);
  await expect(dateLine(page)).toHaveText(stopped!);

  await button(page, '처음').click();
  await expect(dateLine(page)).toHaveText(first);
  await expect(button(page, '처음')).toBeDisabled();
  await expect(button(page, '이전')).toBeDisabled();
  await button(page, '다음').click();
  await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[1]!)} (2/35)`);
  await button(page, '이전').click();
  await expect(dateLine(page)).toHaveText(first);

  await panel(page).getByRole('slider', { name: '재생 위치' }).focus();
  await page.keyboard.press('End');
  await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[34]!)} (35/35)`);
  await expect(button(page, '다음')).toBeDisabled();
  await button(page, '이전').click();
  await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[33]!)} (34/35)`);
});

test('E4 실제 출병으로 멸망한 국가 2는 첫 달에 저장된 이름·색으로 그려지고 둘째 달에는 지도·범례에 없다', async ({
  page,
  timelapseStack,
}) => {
  const { p, pSaved } = timelapseStack.worlds;
  const [alive, removed] = await withE2eDb((db) =>
    Promise.all([
      db.nation.findUnique({ where: { worldId_id: { worldId: p.id, id: 2 } } }),
      db.removedNation.findUnique({ where: { worldId_nationId: { worldId: p.id, nationId: 2 } } }),
    ]),
  );
  expect(alive).toBeNull();
  expect(removed).not.toBeNull();

  await login(page);
  await page.goto(tabUrl(p));
  await expect(panel(page).locator('[data-frame-tick="10000"]')).toBeVisible();
  await expect(dateLine(page)).not.toContainText('국가 기록 없음');
  await expect(city(page, 2)).toHaveAttribute('data-nation-id', '2');
  await expect(city(page, 2).locator('title')).toHaveText(`도시2, ${pSaved.removed.name}`);
  expect(await fillOf(page, 2)).toBe(await cssColor(page, pSaved.removed.color));
  await expect(legend(page).locator('[data-nation-id="2"]')).toContainText(pSaved.removed.name);

  await button(page, '다음').click();
  await expect(panel(page).locator('[data-frame-tick="20000"]')).toBeVisible();
  await expect(dateLine(page)).not.toContainText('국가 기록 없음');
  await expect(panel(page).getByTestId('timelapse-map')).toBeVisible();
  await expect(city(page, 2)).toHaveAttribute('data-nation-id', '1');
  await expect(panel(page).locator('[data-testid="timelapse-map"] [data-nation-id="2"]')).toHaveCount(0);
  await expect(legend(page).locator('[data-nation-id="2"]')).toHaveCount(0);
});

test('E5 국가 1의 지금 이름·색을 바꾸면 응답의 currentNations만 바뀌고 화면은 두 달 모두 저장값이다', async ({
  page,
  timelapseStack,
}) => {
  const { p, pSaved } = timelapseStack.worlds;
  const where = { worldId_id: { worldId: p.id, id: 1 } };
  const now = { name: '지금 바뀐 국호', color: '#123456' };
  const before = await withE2eDb((db) => db.nation.findUniqueOrThrow({ where, select: { name: true, color: true } }));
  expect(before).not.toEqual(now);
  // 준비 단계의 DB 변경이다. 규칙을 바꾸지 않고 끝에 되돌린다.
  await withE2eDb((db) => db.nation.update({ where, data: now }));
  try {
    await login(page);
    const response = firstPageOf(page, p.id);
    await page.goto(tabUrl(p));
    const body = (await framesEntry(await response))?.result?.data;
    expect(body?.currentNations.find(({ id }) => id === 1)).toEqual({ id: 1, ...now });
    expect(body?.items.map(({ nations }) => nations.find(({ id }) => id === 1))).toEqual([pSaved.first, pSaved.first]);

    await page.reload();
    const savedColor = await cssColor(page, pSaved.first.color);
    for (const tick of p.ticks) {
      await expect(panel(page).locator(`[data-frame-tick="${tick}"]`)).toBeVisible();
      await expect(city(page, 1)).toHaveAttribute('data-nation-id', '1');
      await expect(city(page, 1).locator('title')).toHaveText(`도시1, ${pSaved.first.name}`);
      expect(await fillOf(page, 1)).toBe(savedColor);
      await expect(legend(page).locator('[data-nation-id="1"]')).toContainText(pSaved.first.name);
      await expect(panel(page)).not.toContainText(now.name);
      if (tick !== p.ticks.at(-1)) await button(page, '다음').click();
    }
  } finally {
    await withE2eDb((db) => db.nation.update({ where, data: before }));
  }
});

test('E6 M의 둘째 달은 지도·범례 대신 기록 없음 안내이고 첫째·셋째 달은 그려지며 재생도 그 달을 지나간다', async ({
  page,
  timelapseStack,
}) => {
  const { m } = timelapseStack.worlds;
  const dates = await Promise.all(m.ticks.map((tick) => dateOf(m, tick)));
  await login(page);
  await page.goto(tabUrl(m));
  const map = panel(page).getByTestId('timelapse-map');
  await expect(dateLine(page)).toHaveText(`${dates[0]} (1/3)`);
  await expect(map).toBeVisible();

  await button(page, '다음').click();
  await expect(dateLine(page)).toHaveText(`${dates[1]} (2/3) 국가 기록 없음`);
  await expect(panel(page).getByText('이 시점의 국가 기록이 없습니다.')).toBeVisible();
  await expect(panel(page).getByText('다른 달을 골라 주세요.')).toBeVisible();
  await expect(panel(page).locator('svg')).toHaveCount(0);
  await expect(panel(page).locator('[data-city-key]')).toHaveCount(0);
  await expect(legend(page)).toHaveCount(0);

  await button(page, '다음').click();
  await expect(dateLine(page)).toHaveText(`${dates[2]} (3/3)`);
  await expect(map).toBeVisible();
  await button(page, '처음').click();
  await expect(dateLine(page)).toHaveText(`${dates[0]} (1/3)`);
  await expect(map).toBeVisible();

  await button(page, '재생').click();
  await expect(panel(page).getByText('이 시점의 국가 기록이 없습니다.')).toBeVisible();
  await expect(dateLine(page)).toHaveText(`${dates[2]} (3/3)`, { timeout: 5_000 });
  await expect(map).toBeVisible();
  // 마지막 달에 닿으면 더 받을 것이 없어 정지한다.
  await expect(button(page, '재생')).toBeVisible();
});

test('E7 C는 빈 상태이고 cities 없는 행을 넣으면 서버 500을 한 번 다시 물은 뒤 다시 시도가 있는 오류가 보인다', async ({
  page,
  timelapseStack,
}) => {
  const { c } = timelapseStack.worlds;
  await login(page);
  await page.goto(tabUrl(c));
  await expect(panel(page).getByText('영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다')).toBeVisible();

  const tick = 10_000;
  await withE2eDb((db) =>
    db.yearbookSnapshot.create({
      data: {
        worldId: c.id,
        tick,
        year: c.startYear,
        month: 2,
        sequence: 1,
        data: {},
        stateHash: 't4-36-e2e-broken',
      },
    }),
  );
  try {
    const seen = watchFrames(page);
    const responses: Response[] = [];
    page.on('response', (response) => {
      if (framesInput(response.url())) responses.push(response);
    });
    await page.reload();
    const alert = panel(page).getByRole('alert');
    await expect(alert).toContainText('불러오지 못했습니다');
    await expect(alert.getByRole('button', { name: '다시 시도' })).toBeVisible();
    expect(seen).toEqual([{ worldId: c.id }, { worldId: c.id }]);
    const entries = await Promise.all(responses.map(framesEntry));
    expect(entries.map((entry) => entry?.error?.data?.httpStatus)).toEqual([500, 500]);
  } finally {
    await withE2eDb((db) => removeFrame(db, c.id, tick));
  }
});

test('E8 A의 31번째 행이 깨지면 30개월은 재생되고 한 번 다시 물은 뒤 이어 받기 오류가 보이며 되돌린 뒤 다시 시도하면 35개월이다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  const where = { worldId_tick: { worldId: a.id, tick: a.ticks[30]! } };
  const original = await withE2eDb((db) => db.yearbookSnapshot.findUniqueOrThrow({ where, select: { data: true } }));
  const restore = () =>
    withE2eDb((db) => db.yearbookSnapshot.update({ where, data: { data: original.data as Prisma.InputJsonValue } }));
  await withE2eDb((db) => db.yearbookSnapshot.update({ where, data: { data: {} } }));
  try {
    await login(page);
    const seen = watchFrames(page);
    await page.goto(tabUrl(a));
    await expect(panel(page).getByText('다음 기록을 불러오지 못했습니다.')).toBeVisible();
    await expect(panel(page).getByText('30개월 불러옴')).toBeVisible();
    expect(seen).toEqual([{ worldId: a.id }, { worldId: a.id, cursor: '300000' }, { worldId: a.id, cursor: '300000' }]);
    await button(page, '다음').click();
    await expect(dateLine(page)).toHaveText(`${await dateOf(a, a.ticks[1]!)} (2/30)`);

    await restore();
    await button(page, '다시 시도').click();
    await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
    await expect(panel(page).getByText('다음 기록을 불러오지 못했습니다.')).toHaveCount(0);
    expect(seen).toHaveLength(4);
  } finally {
    await restore();
  }
});

test('E9 첫 요청을 잡아 둔 동안 불러오는 중이고 흘려보내면 첫 달이다', async ({ page, timelapseStack }) => {
  const { a } = timelapseStack.worlds;
  await login(page);
  let open!: () => void;
  const gate = new Promise<void>((done) => {
    open = done;
  });
  let caught = 0;
  // 실제 요청을 잠깐 붙잡았다가 그대로 서버로 보낸다. 응답은 서버가 만든다.
  await page.route('**/trpc/**', async (route) => {
    const input = framesInput(route.request().url());
    if (input?.worldId === a.id && input.cursor === undefined && caught++ === 0) await gate;
    await route.continue();
  });
  try {
    await page.goto(tabUrl(a));
    await expect.poll(() => caught).toBe(1);
    await expect(panel(page).getByRole('status')).toHaveText('불러오는 중');
    await expect(dateLine(page)).toHaveCount(0);
    open();
    await expect(dateLine(page)).toContainText(`${await dateOf(a, a.ticks[0]!)} (1/`);
    await expect(panel(page).getByRole('status')).toHaveCount(0);
  } finally {
    open();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('E10 재생 중 둘째 페이지를 잡아 둔 채 같은 문서에서 B로 가면 그 요청은 브라우저에서 취소되고 돌아오면 A를 첫 달부터 다시 받는다', async ({
  page,
  timelapseStack,
}) => {
  const { a, b } = timelapseStack.worlds;
  await login(page);
  let held: Request | undefined;
  // 둘째 페이지 요청은 계속 붙잡아 둔다. 화면이 그 요청을 끊어야 브라우저가 실패로 끝낸다.
  await page.route('**/trpc/**', async (route) => {
    const input = framesInput(route.request().url());
    if (held === undefined && input?.worldId === a.id && input.cursor !== undefined) {
      held = route.request();
      return;
    }
    await route.continue();
  });
  const failed = page.waitForEvent('requestfailed', { predicate: (request) => request === held, timeout: 30_000 });
  // 앞 단계가 실패해 기다림이 버려져도 처리되지 않은 거부로 남지 않게 한다. 아래에서 다시 기다린다.
  void failed.catch(() => undefined);
  await page.goto(tabUrl(a));
  await expect(dateLine(page)).toContainText('(1/30)');
  await button(page, '재생').click();
  await expect(button(page, '정지')).toBeVisible();
  await expect.poll(() => held !== undefined).toBe(true);

  await page.evaluate((url) => {
    window.history.pushState(window.history.state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, tabUrl(b));
  const cancelled = await failed;
  expect(cancelled.failure()).not.toBeNull();
  await expect(page).toHaveURL(tabUrl(b));
  const bFirst = `${await dateOf(b, b.ticks[0]!)} (1/3)`;
  await expect(dateLine(page)).toHaveText(bFirst);
  await expect(button(page, '재생')).toBeVisible();

  await page.waitForTimeout(1_500);
  await expect(dateLine(page)).toHaveText(bFirst);
  const shown = (await panel(page).textContent()) ?? '';
  for (const tick of a.ticks) expect(shown).not.toContain(await dateOf(a, tick));
  const shownTick = await panel(page).locator('[data-frame-tick]').getAttribute('data-frame-tick');
  expect(b.ticks.map(String)).toContain(shownTick);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const seen = watchFrames(page);
  await page.goBack();
  await expect(page).toHaveURL(tabUrl(a));
  await expect(dateLine(page)).toContainText(`${await dateOf(a, a.ticks[0]!)} (1/`);
  await expect(button(page, '재생')).toBeVisible();
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  expect(seen[0]).toEqual({ worldId: a.id });
});

test('E11 쿠키 없는 새 브라우저 문맥으로 A 주소를 열면 로그인 화면으로 간다', async ({ browser, timelapseStack }) => {
  const { a } = timelapseStack.worlds;
  const context = await browser.newContext({ baseURL: timelapseStack.webOrigin });
  try {
    const page = await context.newPage();
    await page.goto(tabUrl(a));
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('E12 Tab으로 재생 버튼에 가서 Space로 재생·정지하고 지도 이름에 지금 날짜가 있다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  await login(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  await recordTab(page, '영토 재생').focus();
  const play = button(page, '재생');
  for (let i = 0; i < 10 && !(await play.evaluate((node) => node === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(play).toBeFocused();

  await page.keyboard.press('Space');
  await expect(button(page, '정지')).toBeFocused();
  await expect(dateLine(page)).toHaveAttribute('aria-live', 'off');
  await expect(dateLine(page)).not.toContainText('(1/35)');
  await page.keyboard.press('Space');
  await expect(button(page, '재생')).toBeFocused();
  await expect(dateLine(page)).toHaveAttribute('aria-live', 'polite');

  const date = ((await dateLine(page).textContent()) ?? '').replace(/ \(\d+\/\d+\)$/, '');
  expect(date).toMatch(/^\d+년 \d+월$/);
  await expect(panel(page).getByTestId('timelapse-map')).toHaveAttribute(
    'aria-label',
    `${date} 영토 지도, 도시 ${CITY_KEYS.length}개`,
  );
});

test('E13 다 받은 뒤 다른 기록 탭으로 옮긴 사이 새 달이 쌓이면 다시 열 때 첫 페이지부터 받아 36개월이다', async ({
  page,
  timelapseStack,
}) => {
  const { a } = timelapseStack.worlds;
  await login(page);
  const seen = watchFrames(page);
  await page.goto(tabUrl(a));
  await expect(panel(page).getByText('35개월 불러옴')).toBeVisible();
  expect(seen).toHaveLength(2);

  await recordTab(page, '내 장수').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('기록 · 내 장수');
  const tick = await withE2eDb((db) => insertFrame(db, a, aFrame(35)));
  try {
    await recordTab(page, '영토 재생').click();
    await expect(panel(page).getByText('36개월 불러옴')).toBeVisible();
    expect(seen.slice(2)).toEqual([{ worldId: a.id }, { worldId: a.id, cursor: '300000' }]);
    await panel(page).getByRole('slider', { name: '재생 위치' }).focus();
    await page.keyboard.press('End');
    await expect(dateLine(page)).toHaveText(`${await dateOf(a, tick)} (36/36)`);
    await expect(panel(page).getByTestId('timelapse-map')).toBeVisible();
    await expect(panel(page).locator('[data-frame-tick]')).toHaveAttribute('data-frame-tick', String(tick));
  } finally {
    await withE2eDb((db) => removeFrame(db, a.id, tick));
  }
});
