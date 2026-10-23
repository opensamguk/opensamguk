import type { Page, Response } from '@playwright/test';
import type { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import type { PublicMapsOutput } from '../apps/web/src/publicMap/contract';
import { createAccount, e2eDatabaseUrl, TEST_PASSWORD, withE2eDb } from './account';
import { holdLease, releaseHold, type LeaseHold } from './game';
import { expect, test } from './publicMapFixture';

// T2-25 · AC-M2-20: 로그인 화면과 로비의 지연 공개 지도. 실제 서버(world.publicMaps), 실제 DB, 실제 엔진 사본으로 돈다.
// 공개 지도는 공개 월드 전체를 보이므로 publicMapFixture가 이 파일만의 새 _test DB와 그 DB를 쓰는 API·Vite 서버를 띄운다.
// 다른 시험이 공유 DB에 남긴 월드와 섞이지 않는다. 이 DB의 월드는 이 파일이 만든 셋뿐이다.
// 시험이 월드 셋을 직접 만들고 엔진 TurnLoop로 사본을 찍는다. 찍는 시각(publicMapNow)만 과거로 정하고
// 서버는 평소 현재 시각으로 지연을 판정한다. 가 월드는 20분 전 사본 A와 5분 전 사본 B, 나 월드는 30분 전 사본 하나를
// 남기고 멈춘 월드, 다 월드는 사본이 없는 월드다. 사본 B는 지연 10분 안이라 이 파일이 도는 동안 공개되지 않는다.
// TurnLoop는 실제 실행권(holdLease)으로 돌고 시험이 끝날 때까지 세 월드의 실행권을 쥔다.
// 기대값은 화면 변환 함수로 만들지 않고 fixture 값을 직접 적는다.

test.use({ timezoneId: 'UTC' });

type WorldInit = Awaited<ReturnType<typeof monthlyFixture>>;
interface CitySpec {
  key: number;
  name: string;
  level: number;
  x: number;
  y: number;
  nationId: number | null;
  links: number[];
}
interface WorldSpec {
  nations: Array<{ id: number; name: string; color: string }>;
  cities: CitySpec[];
}
interface Made {
  id: string;
  name: string;
  status: 'RUNNING' | 'PAUSED';
  hold: LeaseHold;
}
interface SnapshotData {
  cities: Array<{ key: string; nationId: number | null }>;
  nations: Array<{ id: number; name: string; color: string }>;
}

const MINUTE = 60_000;
const PATH = 'world.publicMaps';
const DELAY = '10분 이상 지난 상태입니다';

// 엔진 월간 fixture(도시 4, 국가 2, 장수 3)의 키·수도·장수 위치는 그대로 두고 이름·좌표·소유·연결·색만 정한다.
const GA: WorldSpec = {
  nations: [
    { id: 1, name: '위', color: '#000080' },
    { id: 2, name: '오', color: '#ff0000' },
  ],
  cities: [
    { key: 1, name: '업', level: 7, x: 120, y: 90, nationId: 1, links: [2] },
    { key: 2, name: '허창', level: 6, x: 300, y: 220, nationId: 2, links: [1, 3, 4] },
    { key: 3, name: '낙양', level: 8, x: 480, y: 120, nationId: 1, links: [2] },
    { key: 4, name: '완', level: 5, x: 320, y: 400, nationId: 2, links: [2] },
  ],
};
// 지도 끝(25, 20)과 (680, 480)에 도시를 두어 좁은 화면에서 가로로 가장 넓게 그려지게 한다.
const NA: WorldSpec = {
  nations: [
    { id: 1, name: '촉', color: '#008000' },
    { id: 2, name: '한', color: '#ffd700' },
  ],
  cities: [
    { key: 1, name: '성도', level: 8, x: 25, y: 20, nationId: 1, links: [2] },
    { key: 2, name: '면죽', level: 4, x: 250, y: 200, nationId: null, links: [1, 3] },
    { key: 3, name: '한중', level: 6, x: 460, y: 300, nationId: 1, links: [2, 4] },
    { key: 4, name: '장안', level: 8, x: 680, y: 480, nationId: 2, links: [3] },
  ],
};
// 사본 A를 찍은 뒤 가 월드에서 바꾸는 것. 사본 B가 이 값을 담는다.
const B_NATION = { id: 2, name: '사본 B 오', color: '#00aa00' };
// 사본 B를 찍은 뒤 다시 바꾼 현재 값. 어느 사본에도 없다.
const NOW_NATION = { name: '지금 오', color: '#123456' };

// 서버 원본 응답의 기대값. 도시 key·links는 문자열이다 (T2-24).
const RAW_GA = {
  cities: [
    { key: '1', name: '업', level: 7, x: 120, y: 90, nationId: 1, links: ['2'] },
    { key: '2', name: '허창', level: 6, x: 300, y: 220, nationId: 2, links: ['1', '3', '4'] },
    { key: '3', name: '낙양', level: 8, x: 480, y: 120, nationId: 1, links: ['2'] },
    { key: '4', name: '완', level: 5, x: 320, y: 400, nationId: 2, links: ['2'] },
  ],
  nations: [
    { id: 1, name: '위', color: '#000080' },
    { id: 2, name: '오', color: '#ff0000' },
  ],
};
const RAW_NA = {
  cities: [
    { key: '1', name: '성도', level: 8, x: 25, y: 20, nationId: 1, links: ['2'] },
    { key: '2', name: '면죽', level: 4, x: 250, y: 200, nationId: null, links: ['1', '3'] },
    { key: '3', name: '한중', level: 6, x: 460, y: 300, nationId: 1, links: ['2', '4'] },
    { key: '4', name: '장안', level: 8, x: 680, y: 480, nationId: 2, links: ['3'] },
  ],
  nations: [
    { id: 1, name: '촉', color: '#008000' },
    { id: 2, name: '한', color: '#ffd700' },
  ],
};

// 화면에 그려진 기대값. 도시 점 색은 브라우저 계산값, 연결선은 양 끝 좌표다.
const DRAWN_GA = {
  cities: [
    { key: '1', label: '업, 위', fill: 'rgb(0, 0, 128)' },
    { key: '2', label: '허창, 오', fill: 'rgb(255, 0, 0)' },
    { key: '3', label: '낙양, 위', fill: 'rgb(0, 0, 128)' },
    { key: '4', label: '완, 오', fill: 'rgb(255, 0, 0)' },
  ],
  lines: ['120,90,300,220', '300,220,320,400', '300,220,480,120'],
  legend: '공백지 0위 2오 2',
  nations: [
    { id: '1', text: '위 2', swatch: 'rgb(0, 0, 128)' },
    { id: '2', text: '오 2', swatch: 'rgb(255, 0, 0)' },
  ],
};
const DRAWN_NA = {
  cities: [
    { key: '1', label: '성도, 촉', fill: 'rgb(0, 128, 0)' },
    { key: '2', label: '면죽, 공백지', fill: 'rgb(214, 208, 196)' },
    { key: '3', label: '한중, 촉', fill: 'rgb(0, 128, 0)' },
    { key: '4', label: '장안, 한', fill: 'rgb(255, 215, 0)' },
  ],
  lines: ['25,20,250,200', '250,200,460,300', '460,300,680,480'],
  legend: '공백지 1촉 2한 1',
  nations: [
    { id: '1', text: '촉 2', swatch: 'rgb(0, 128, 0)' },
    { id: '2', text: '한 1', swatch: 'rgb(255, 215, 0)' },
  ],
};

interface Fixture {
  ga: Made;
  na: Made;
  da: Made;
  a: number;
  b: number;
  paused: number;
  generalNames: string[];
}
let made: Made[] = [];
let fx: Fixture | undefined;

function fixture(): Fixture {
  if (!fx) throw new Error('공개 지도 fixture를 만들지 못했습니다.');
  return fx;
}

function shape(template: WorldInit, spec: WorldSpec): WorldInit {
  const state = structuredClone(template);
  state.nations = state.nations.map((nation) => {
    const { name, color } = spec.nations.find((entry) => entry.id === nation.id)!;
    return { ...nation, name, color };
  });
  state.cities = state.cities.map((city) => {
    const { name, level, x, y, nationId, links } = spec.cities.find((entry) => entry.key === city.cityKey)!;
    return { ...city, name, level, x, y, nationId, connections: links };
  });
  state.diplomacies = [];
  return state;
}

const floorMinute = (time: number) => Math.floor(time / MINUTE) * MINUTE;
const iso = (time: number) => new Date(time).toISOString();

test.beforeAll(async ({ publicMapStack }) => {
  // 아래에서 DB를 쓰는 도우미가 모두 이 파일의 DB를 가리키는지 먼저 확인한다.
  if (e2eDatabaseUrl() !== publicMapStack.databaseUrl) throw new Error('공개 지도 E2E가 자기 DB를 쓰지 않습니다.');
  const [{ monthlyFixture }, { saveInitialWorld }, { TurnLoop }] = await Promise.all([
    import('../apps/engine/test/monthlyFixture'),
    import('../apps/engine/src/world/persistence'),
    import('../apps/engine/src/turnLoop'),
  ]);
  const template = await monthlyFixture();
  const tag = `${Date.now() % 100_000}`;
  await withE2eDb(async (db) => {
    const create = async (spec: WorldSpec, name: string, status: Made['status']): Promise<Made> => {
      const { worldId } = await saveInitialWorld(db, shape(template, spec), {
        name,
        turnTermMinutes: 60,
        endYear: null,
      });
      // TurnLoop가 쓸 실행권을 RUNNING으로 바꾸기 전에 잡는다.
      const world: Made = { id: worldId, name, status, hold: await holdLease(worldId) };
      made.push(world);
      await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING', clockAnchorAt: new Date() } });
      return world;
    };
    // 실제 엔진의 턴 루프로 tick까지 진행한다. 사본은 턴과 같은 트랜잭션에서 at 시각으로 찍힌다.
    const snapshot = async (world: Made, tick: number, at: number) => {
      await new TurnLoop(world.hold.db, world.hold.lease, { publicMapNow: () => at }).advanceTo(tick);
      if (world.hold.lost) throw world.hold.lost;
    };

    const ga = await create(GA, `E2E 지도 ${tag} 가`, 'RUNNING');
    const na = await create(NA, `E2E 지도 ${tag} 나`, 'PAUSED');
    const da = await create(GA, `E2E 지도 ${tag} 다`, 'RUNNING');
    const now = Date.now();
    const a = floorMinute(now - 20 * MINUTE);
    const b = floorMinute(now - 5 * MINUTE);
    const paused = floorMinute(now - 30 * MINUTE);

    await snapshot(ga, 100, a);
    await db.$transaction([
      db.city.update({ where: { worldId_cityKey: { worldId: ga.id, cityKey: 3 } }, data: { nationId: 2 } }),
      db.nation.update({
        where: { worldId_id: { worldId: ga.id, id: B_NATION.id } },
        data: { name: B_NATION.name, color: B_NATION.color },
      }),
    ]);
    await snapshot(ga, 10_000, b);
    await db.nation.update({ where: { worldId_id: { worldId: ga.id, id: B_NATION.id } }, data: NOW_NATION });

    await snapshot(na, 100, paused);
    await db.world.update({ where: { id: na.id }, data: { status: 'PAUSED' } });

    fx = { ga, na, da, a, b, paused, generalNames: template.generals.map((general) => general.name) };
  });
});

// 실행권과 그 DB 연결을 놓는다. 그 뒤 publicMapFixture가 연결 0을 확인하고 이 파일의 DB를 지운다.
test.afterAll(async () => {
  const worlds = made;
  made = [];
  fx = undefined;
  for (const world of worlds) await releaseHold(world.hold);
});

// httpBatchLink라 같은 때 보낸 health와 한 요청으로 묶여 올 수 있다. 주소의 경로 목록에서 순서를 찾는다.
const pathsOf = (response: Response) => new URL(response.url()).pathname.split('/').pop()!.split(',');

// 화면이 받은 서버 원본 응답을 그대로 읽는다. 바꾸거나 대신 돌려주지 않는다.
async function open(page: Page, url: string): Promise<PublicMapsOutput> {
  const response = page.waitForResponse((entry) => pathsOf(entry).includes(PATH));
  await page.goto(url);
  const done = await response;
  const body = (await done.json()) as Array<{ result?: { data: PublicMapsOutput } }>;
  const entry = body[pathsOf(done).indexOf(PATH)];
  if (!entry?.result) throw new Error(`${PATH} 응답이 없습니다`);
  return entry.result.data;
}

const area = (page: Page) => page.getByTestId('public-map');
const tabs = (page: Page) => area(page).getByRole('tab');
const worldMap = (page: Page) => area(page).getByTestId('world-map');
const when = (page: Page) => area(page).getByTestId('public-map-when');

async function choose(page: Page, index: number, worldId: string) {
  await tabs(page).nth(index).click();
  await expect(tabs(page).nth(index)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('data-world-id', worldId);
}

// 기준 시각 줄의 기대값. 브라우저 시간대를 UTC로 두었으므로 찍은 시각을 UTC로 읽어 적는다.
function whenText(takenAt: number, year: number, month: number): string {
  const at = new Date(takenAt);
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();
  const today = iso(takenAt).slice(0, 10) === new Date().toISOString().slice(0, 10);
  const day = today ? '' : `${at.getUTCMonth() + 1}월 ${at.getUTCDate()}일 `;
  return `${year}년 ${month}월 · ${day}${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}시${minute === 0 ? '' : ` ${minute}분`} 기준`;
}

// 지금 고른 탭의 지도에서 도시 키·이름표·점 색, 연결선, 범례를 읽는다.
async function drawn(page: Page) {
  const map = worldMap(page);
  await expect(map).toHaveCount(1);
  await expect(map.locator('[data-city-key]')).toHaveCount(4);
  const legend = area(page).getByLabel('지도 범례');
  return {
    cities: await map.locator('[data-city-key]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        key: node.getAttribute('data-city-key'),
        label: node.getAttribute('aria-label'),
        fill: getComputedStyle(node.querySelector('circle')!).fill,
      })),
    ),
    lines: (
      await map
        .locator('line')
        .evaluateAll((nodes) =>
          nodes.map((node) => ['x1', 'y1', 'x2', 'y2'].map((name) => node.getAttribute(name)).join(',')),
        )
    ).sort(),
    legend: await legend.textContent(),
    nations: await legend.locator('[data-nation-id]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-nation-id'),
        text: node.textContent,
        swatch: getComputedStyle(node.querySelector('span')!).backgroundColor,
      })),
    ),
  };
}

test('로그아웃 상태 /login에서 공개 월드 셋이 탭이고 탭마다 그 월드의 지도 하나와 기준 시각 줄로 바뀐다', async ({
  page,
}) => {
  const { ga, na, da, a, paused } = fixture();
  const raw = await open(page, '/login');
  // 서버 원본: 문자열 key·links 도시가 실제로 온다.
  expect(raw.delayMinutes).toBe(10);
  expect(raw.worlds.map(({ id, name, status }) => ({ id, name, status }))).toEqual([
    { id: ga.id, name: ga.name, status: 'RUNNING' },
    { id: na.id, name: na.name, status: 'PAUSED' },
    { id: da.id, name: da.name, status: 'RUNNING' },
  ]);
  expect(raw.worlds[0]!.map).toEqual({ takenAt: iso(a), year: 191, month: 1, ...RAW_GA });
  expect(raw.worlds[1]!.map).toEqual({ takenAt: iso(paused), year: 191, month: 1, ...RAW_NA });
  expect(raw.worlds[2]!.map).toBeNull();

  await expect(tabs(page)).toHaveText([ga.name, `${na.name}멈춤`, da.name]);
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('data-world-id', ga.id);
  expect(await drawn(page)).toEqual(DRAWN_GA);
  await expect(when(page)).toHaveText(whenText(a, 191, 1) + DELAY);
  await expect(when(page).locator('time')).toHaveAttribute('datetime', iso(a));
  await page.screenshot({ path: 'test-results/t2-25-login.png', fullPage: true });

  await choose(page, 1, na.id);
  expect(await drawn(page)).toEqual(DRAWN_NA);
  await expect(when(page)).toHaveText(whenText(paused, 191, 1) + DELAY);

  await choose(page, 2, da.id);
  await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
  await expect(worldMap(page)).toHaveCount(0);
  await expect(when(page)).toHaveCount(0);
});

test('로그인 뒤 /lobby의 월드 목록 위에 같은 탭과 지도가 있고 로그아웃하면 /login에 다시 보인다', async ({ page }) => {
  const { ga, na, da } = fixture();
  // 계정 행만 이 파일의 DB에 만든다. createAccount가 넣은 세션 쿠키는 지우고 화면에서 로그인한다.
  const email = await createAccount(page);
  await page.context().clearCookies();
  await open(page, '/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/lobby');

  await expect(tabs(page)).toHaveText([ga.name, `${na.name}멈춤`, da.name]);
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
  expect(await drawn(page)).toEqual(DRAWN_GA);
  const card = page.getByRole('article', { name: ga.name, exact: true });
  await expect(card).toBeVisible();
  const mapBox = await area(page).boundingBox();
  const listBox = await page.getByRole('heading', { level: 2, name: '월드', exact: true }).boundingBox();
  expect(mapBox && listBox && mapBox.y + mapBox.height <= listBox.y).toBe(true);

  // 지도 탭을 바꿔도 월드 카드와 주소는 그대로다.
  const cards = await page.getByRole('article').allTextContents();
  await choose(page, 1, na.id);
  expect(await drawn(page)).toEqual(DRAWN_NA);
  expect(await page.getByRole('article').allTextContents()).toEqual(cards);
  await expect(page).toHaveURL('/lobby');
  await page.screenshot({ path: 'test-results/t2-25-lobby.png', fullPage: true });

  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL('/login');
  await expect(tabs(page)).toHaveText([ga.name, `${na.name}멈춤`, da.name]);
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
  expect(await drawn(page)).toEqual(DRAWN_GA);
});

test('지연 시간 전에는 바뀐 도시 소유·국가 이름·색 대신 사본 A를 보이고 멈춘 월드는 마지막 사본을 보인다', async ({
  page,
}) => {
  const { ga, na, a, b, paused } = fixture();
  // 사본 B가 공개되기 전이어야 이 시험이 뜻이 있다.
  expect(Date.now()).toBeLessThan(b + 10 * MINUTE);
  const [gaRows, naRows, city, nation, naWorld] = await withE2eDb((db) =>
    Promise.all([
      db.publicMapSnapshot.findMany({ where: { worldId: ga.id }, orderBy: { takenAt: 'asc' } }),
      db.publicMapSnapshot.findMany({ where: { worldId: na.id }, orderBy: { takenAt: 'asc' } }),
      db.city.findUniqueOrThrow({
        where: { worldId_cityKey: { worldId: ga.id, cityKey: 3 } },
        select: { nationId: true },
      }),
      db.nation.findUniqueOrThrow({
        where: { worldId_id: { worldId: ga.id, id: B_NATION.id } },
        select: { name: true, color: true },
      }),
      db.world.findUniqueOrThrow({ where: { id: na.id }, select: { status: true } }),
    ]),
  );
  // 엔진이 찍은 사본 B에는 바뀐 소유와 이름·색이 있고 현재 DB는 그 뒤로 또 바뀌었다.
  expect(gaRows.map((row) => [row.takenAt.getTime(), row.tick, row.year, row.month])).toEqual([
    [a, 100, 191, 1],
    [b, 10_000, 191, 2],
  ]);
  const later = gaRows[1]!.data as unknown as SnapshotData;
  expect(later.cities.find((entry) => entry.key === '3')?.nationId).toBe(2);
  expect(later.nations.find((entry) => entry.id === B_NATION.id)).toEqual(B_NATION);
  expect(city.nationId).toBe(2);
  expect(nation).toEqual(NOW_NATION);
  expect(naRows.map((row) => [row.takenAt.getTime(), row.tick])).toEqual([[paused, 100]]);
  expect(naWorld.status).toBe('PAUSED');

  const raw = await open(page, '/login');
  expect(raw.worlds[0]!.map).toEqual({ takenAt: iso(a), year: 191, month: 1, ...RAW_GA });
  expect(JSON.stringify(raw)).not.toMatch(/사본 B 오|지금 오|#00aa00|#123456/);

  // 낙양(3)은 지금 오 소유지만 화면은 사본 A대로 위의 색과 이름이다.
  expect(await drawn(page)).toEqual(DRAWN_GA);
  await expect(when(page).locator('time')).toHaveAttribute('datetime', iso(a));
  await expect(area(page)).not.toContainText(/사본 B 오|지금 오/);

  await choose(page, 1, na.id);
  expect(await drawn(page)).toEqual(DRAWN_NA);
  await expect(when(page).locator('time')).toHaveAttribute('datetime', iso(paused));
});

test('장수·병력·보급·국고는 응답과 화면에 없고 지도는 읽기 전용이다', async ({ page }) => {
  const { ga, na, generalNames } = fixture();
  const raw = await open(page, '/login');
  const text = JSON.stringify(raw);
  expect(Object.keys(raw).sort()).toEqual(['delayMinutes', 'worlds']);
  for (const world of raw.worlds) expect(Object.keys(world).sort()).toEqual(['id', 'map', 'name', 'status']);
  for (const map of [raw.worlds[0]!.map!, raw.worlds[1]!.map!]) {
    expect(Object.keys(map).sort()).toEqual(['cities', 'month', 'nations', 'takenAt', 'year']);
    for (const city of map.cities)
      expect(Object.keys(city).sort()).toEqual(['key', 'level', 'links', 'name', 'nationId', 'x', 'y']);
    for (const nation of map.nations) expect(Object.keys(nation).sort()).toEqual(['color', 'id', 'name']);
  }
  expect(generalNames).toHaveLength(3);
  for (const name of generalNames) expect(text).not.toContain(name);

  for (const [index, world] of [ga, na].entries()) {
    await choose(page, index, world.id);
    const map = worldMap(page);
    await expect(map).toHaveCount(1);
    await expect(map.locator('[data-supplied], [data-cut], [data-mine]')).toHaveCount(0);
    await expect(map.getByRole('button')).toHaveCount(0);
    await expect(map.locator('[tabindex]')).toHaveCount(0);
    await expect(area(page)).not.toContainText(/보급|내 위치|병력|장수|국고/);
    for (const name of generalNames) await expect(area(page)).not.toContainText(name);
  }
  await worldMap(page).locator('[data-city-key="1"]').click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
});

test('사본 없는 월드 탭은 안내만 두고 공개 월드가 0개면 문구 없이 자리만 남기며 양식 위치는 그대로다', async ({
  page,
}) => {
  const { ga, na, da } = fixture();
  expect(await withE2eDb((db) => db.publicMapSnapshot.count({ where: { worldId: da.id } }))).toBe(0);
  await open(page, '/login');
  await choose(page, 2, da.id);
  await expect(page.getByRole('tabpanel')).toHaveText('아직 공개 지도가 없습니다');
  await expect(worldMap(page)).toHaveCount(0);
  const email = await page.getByLabel('이메일').boundingBox();
  const slot = await area(page).boundingBox();
  expect(email && slot).toBeTruthy();

  // 이 파일의 세 월드만 잠깐 PREOPEN으로 돌려 공개할 월드를 0개로 만든다. 끝나면 원래 상태로 되돌린다.
  const worlds = [ga, na, da];
  await withE2eDb((db) =>
    db.world.updateMany({ where: { id: { in: worlds.map((world) => world.id) } }, data: { status: 'PREOPEN' } }),
  );
  try {
    const raw = await open(page, '/login');
    expect(raw.worlds).toEqual([]);
    await expect(area(page)).toHaveAttribute('data-empty', 'true');
    await expect(area(page)).toHaveText('');
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByText('아직 공개 지도가 없습니다')).toHaveCount(0);
    expect(await page.getByLabel('이메일').boundingBox()).toEqual(email);
    const empty = await area(page).boundingBox();
    expect(empty && [empty.x, empty.y, empty.width]).toEqual([slot!.x, slot!.y, slot!.width]);
  } finally {
    await withE2eDb(async (db) => {
      for (const world of worlds) await db.world.update({ where: { id: world.id }, data: { status: world.status } });
    });
  }
});

test('방향키·Home·End로 탭을 옮기고 aria-selected와 초점이 따라간다', async ({ page }) => {
  const { ga, na, da } = fixture();
  await open(page, '/login');
  const all = tabs(page);
  const at = async (index: number, worldId: string) => {
    await expect(all.nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect(all.nth(index)).toBeFocused();
    await expect(all.nth(index)).toHaveAttribute('tabindex', '0');
    await expect(area(page).locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('data-world-id', worldId);
  };
  await all.first().focus();
  await page.keyboard.press('ArrowRight');
  await at(1, na.id);
  await expect(all.nth(0)).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowLeft');
  await at(0, ga.id);
  await page.keyboard.press('ArrowLeft');
  await at(2, da.id);
  await page.keyboard.press('ArrowRight');
  await at(0, ga.id);
  await page.keyboard.press('End');
  await at(2, da.id);
  await page.keyboard.press('Home');
  await at(0, ga.id);
});

test('375px에서는 로그인 양식 아래로 지도가 내려가고 가로 스크롤이 없다', async ({ page }) => {
  const { na } = fixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/login');
  const below = async () => {
    const form = await page.getByRole('button', { name: '로그인', exact: true }).boundingBox();
    const map = await area(page).boundingBox();
    return Boolean(form && map && map.y >= form.y + form.height);
  };
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  expect(await drawn(page)).toEqual(DRAWN_GA);
  expect(await below()).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 나 월드는 지도 양 끝에 도시가 있다.
  await choose(page, 1, na.id);
  expect(await drawn(page)).toEqual(DRAWN_NA);
  expect(await below()).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const map = await worldMap(page).boundingBox();
  expect(map && map.x >= 0 && map.x + map.width <= 375).toBe(true);
  await page.screenshot({ path: 'test-results/t2-25-login-375.png', fullPage: true });
});
