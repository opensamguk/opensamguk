import { expect, test, type Browser, type Page } from '@playwright/test';
import { createAccount, withE2eDb } from './account';
import {
  ApiError,
  e2eWorld,
  holdLease,
  mutate,
  newGeneralName,
  query,
  releaseHold,
  setTurns,
  stubPortraits,
  turns,
  type LeaseHold,
} from './game';

// T1-27 기수 종료 화면과 가속 표시. 실제 서버·전용 DB와 T1-26의 실제 TurnLoop 경로로 월드를 끝낸다.
// 시험 월드는 T1-26 시험 도우미(prepareSeasonWorld)의 짧은 월드다. 시작 연도와 종료 연도가 같아 가속하면 몇 초 안에 끝난다.
// 이 월드는 T1-18 데모나 AC-M1-17 증거가 아니다.
//
// pnpm dev의 엔진 감독은 RUNNING·PAUSED 월드마다 엔진을 띄운다. 그래서 시험이 월드를 시작하기 전에 실행권을 먼저 잡고
// (e2e/game.ts의 대기 월드와 같은 방식) 그 실행권으로 TurnLoop을 돌린다. 감독의 엔진은 실행권을 얻지 못해 기다린다.
// 두 화면이 가속 진행 중을 보인 뒤에 루프를 시작해 짧은 월드가 15초 조회 주기 안에 끝나 버리지 않게 한다.
//
// 화면에는 포커스·visibilitychange를 보내지 않고 새로고침하지 않는다. 모드 전환과 종료는 주기 조회로만 따라와야 한다.

type Summary = {
  status: string;
  clockMode: string;
  gameDate: { year: number; month: number };
  result: null | {
    reason: 'UNIFIED' | 'END_YEAR';
    year: number;
    month: number;
    winner: null | { nationId: number; name: string; color: string };
    remainingNations: number;
  };
};

const REASON_TEXT = { UNIFIED: '천하통일', END_YEAR: '종료 연도 도달' } as const;
const WATCHED = ['world.summary', 'home.get', 'records.'];

interface Screen {
  page: Page;
  // 문서 탐색 횟수. 처음 연 한 번만 있어야 한다.
  navigations: number;
  // 화면이 보낸 tRPC 프로시저 이름. httpBatchLink가 한 요청에 쉼표로 묶어 보낸다.
  calls: string[];
}

async function openScreen(browser: Browser): Promise<Screen> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await createAccount(page);
  await stubPortraits(page);
  const screen: Screen = { page, navigations: 0, calls: [] };
  // framenavigated는 주소만 바뀌는 탐색에도 불리므로 문서 load만 센다.
  page.on('load', () => {
    screen.navigations += 1;
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/trpc/')) screen.calls.push(...url.pathname.slice('/trpc/'.length).split(','));
  });
  return screen;
}

const watchedCalls = (screen: Screen) => screen.calls.filter((name) => WATCHED.some((w) => name.startsWith(w)));

// 시험이 실행권을 쥔 채 시작한 짧은 종료 월드. 루프는 시험이 이 실행권으로 직접 돌린다.
async function seasonWorld(reason: 'END_YEAR' | 'UNIFIED') {
  const { prepareSeasonWorld } = await import('../apps/engine/test/seasonFixture');
  let hold: LeaseHold | undefined;
  const { worldId, initial } = await withE2eDb((db) =>
    prepareSeasonWorld(db, reason, {
      beforeStart: async (id) => {
        hold = await holdLease(id);
      },
    }),
  );
  if (!hold) throw new Error('시험 월드의 실행권을 잡지 못했습니다.');
  const { TurnLoop } = await import('../apps/engine/src/turnLoop');
  return { worldId, startYear: initial.startYear, hold, loop: new TurnLoop(hold.db, hold.lease) };
}

async function clock(worldId: string, action: 'accelerate' | 'pause' | 'resume') {
  const { controlClock } = await import('../apps/engine/src/world/clock');
  await withE2eDb((db) => controlClock(db, worldId, action));
}

// 장수 생성 요청은 엔진이 처리한다. 저장된 tick까지만 진행해 생성 요청만 처리하고 장수 턴·정산은 하지 않는다.
async function createGeneral(page: Page, worldId: string, world: Awaited<ReturnType<typeof seasonWorld>>) {
  await mutate(page, 'general.create', {
    worldId,
    name: newGeneralName(),
    leadership: 55,
    strength: 55,
    intel: 55,
    portraitId: null,
  });
  const stored = await world.hold.db.world.findUniqueOrThrow({ where: { id: worldId }, select: { clockTick: true } });
  expect(await world.loop.advanceTo(stored.clockTick)).toEqual([]);
  const mine = await query<{ general: { id: number } | null }>(page, 'general.mine', { worldId });
  expect(mine.general).not.toBeNull();
}

async function runToEnd(world: Awaited<ReturnType<typeof seasonWorld>>) {
  for (;;) {
    const batch = await world.loop.poll();
    if (batch.status === 'ENDED' && !batch.more) return;
  }
}

// 결과 칸의 이유·승자·연월·남은 국가 수가 서버 값과 같은지 본다.
async function expectResult(page: Page, worldId: string) {
  const summary = await query<Summary>(page, 'world.summary', { worldId });
  expect(summary.status).toBe('ENDED');
  const result = summary.result!;
  const region = page.getByRole('region', { name: '기수 결과' });
  await expect(region.getByTestId('season-reason')).toHaveText(REASON_TEXT[result.reason]);
  await expect(region.getByTestId('season-winner')).toHaveText(result.winner ? result.winner.name : '승자 없음');
  await expect(region.getByTestId('season-date')).toHaveText(`${result.year}년 ${result.month}월`);
  await expect(region.getByTestId('season-nations')).toHaveText(String(result.remainingNations));
  await expect(page.getByTestId('game-date')).toHaveText(`${result.year}년 ${result.month}월`);
  await expect(page.getByTestId('next-turn')).toHaveText('종료');
  return result;
}

// 종료 뒤 20초 동안 월드 요약·내 장수·기록 요청이 없어야 한다. 다른 tRPC 요청도 없는지 함께 본다.
async function expectQuiet(screens: Screen[]) {
  for (const screen of screens) await screen.page.waitForLoadState('networkidle');
  for (const screen of screens) screen.calls = [];
  await screens[0]!.page.waitForTimeout(20_000);
  for (const screen of screens) {
    expect(watchedCalls(screen)).toEqual([]);
    expect(screen.calls).toEqual([]);
    expect(screen.navigations).toBe(1);
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // world.list의 첫 RUNNING 월드를 쓰는 다른 시험이 이 파일의 짧은 월드를 고르지 않도록 기본 E2E 월드를 먼저 만든다.
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await createAccount(page);
    await e2eWorld(page);
  } finally {
    await context.close();
  }
});

test('실시간 월드를 가속하면 두 화면이 따라오고 종료 연도에 이르면 승자 없음 결과가 나온다', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const world = await seasonWorld('END_YEAR');
  try {
    const a = await openScreen(browser);
    const b = await openScreen(browser);
    await createGeneral(a.page, world.worldId, world);
    for (const screen of [a, b]) await screen.page.goto(`/w/${world.worldId}`);
    await expect(a.page.getByTestId('next-turn')).toContainText('다음 턴까지');
    await expect(b.page.getByTestId('next-turn')).toHaveText('내 장수 없음');
    await expect(a.page.getByTestId('game-date')).toHaveText(`${world.startYear}년 1월`);

    await clock(world.worldId, 'accelerate');
    for (const screen of [a, b])
      await expect(screen.page.getByTestId('next-turn')).toHaveText('가속 진행 중', { timeout: 20_000 });

    // 장수가 없는 화면은 가속 중에도 home.get을 주기 조회하지 않는다. 전환 때 받은 한 번이 지나간 뒤부터 센다.
    // 같은 동안 world.summary는 5초마다 받으므로 주기 조회는 살아 있다. 16초는 예턴 편집기의 15초 주기를 넘긴다.
    await b.page.waitForTimeout(2_000);
    b.calls = [];
    await b.page.waitForTimeout(16_000);
    expect(b.calls.filter((name) => name === 'home.get')).toEqual([]);
    expect(b.calls.filter((name) => name === 'world.summary').length).toBeGreaterThanOrEqual(2);

    // 가속 중 5초 주기로 연월이 바뀌는지 본다. 석 달만 진행한 뒤 멈추고 화면이 4월을 받는지 확인한다.
    const { TICKS_PER_MONTH } = await import('../packages/rules/src/index');
    await world.loop.advanceTo(3 * TICKS_PER_MONTH);
    for (const screen of [a, b])
      await expect(screen.page.getByTestId('game-date')).toHaveText(`${world.startYear}년 4월`, { timeout: 10_000 });

    await runToEnd(world);
    for (const screen of [a, b])
      await expect(screen.page.getByRole('region', { name: '기수 결과' })).toBeVisible({ timeout: 10_000 });
    const result = await expectResult(a.page, world.worldId);
    expect(result).toMatchObject({ reason: 'END_YEAR', winner: null, year: world.startYear, month: 12 });
    await expectResult(b.page, world.worldId);
    await expectQuiet([a, b]);

    await a.page.screenshot({ path: testInfo.outputPath('season-end-year.png'), fullPage: true });
    await testInfo.attach('season-end-year', { path: testInfo.outputPath('season-end-year.png') });
    await a.page.reload();
    await expectResult(a.page, world.worldId);
  } finally {
    await releaseHold(world.hold);
  }
});

test('정지 중에 가속으로 바꾸고 재개하면 두 화면이 따라오고 천하통일 결과와 예턴 잠금이 나온다', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const world = await seasonWorld('UNIFIED');
  try {
    const a = await openScreen(browser);
    const b = await openScreen(browser);
    await createGeneral(a.page, world.worldId, world);
    await clock(world.worldId, 'pause');
    for (const screen of [a, b]) await screen.page.goto(`/w/${world.worldId}`);
    for (const screen of [a, b]) await expect(screen.page.getByTestId('next-turn')).toHaveText('일시 정지');

    await clock(world.worldId, 'accelerate');
    await clock(world.worldId, 'resume');
    for (const screen of [a, b])
      await expect(screen.page.getByTestId('next-turn')).toHaveText('가속 진행 중', { timeout: 20_000 });

    await runToEnd(world);
    for (const screen of [a, b])
      await expect(screen.page.getByRole('region', { name: '기수 결과' })).toBeVisible({ timeout: 10_000 });
    const result = await expectResult(a.page, world.worldId);
    expect(result.reason).toBe('UNIFIED');
    expect(result.winner).not.toBeNull();
    await expect(a.page.getByRole('region', { name: '기수 결과' }).getByText(result.winner!.name)).toBeVisible();
    // 종료 전환 때 지도도 다시 받아 승자가 모든 도시를 가진 모습이 결과 칸과 맞는다.
    const map = await query<{ cities: Array<{ nationId: number | null }> }>(a.page, 'world.map', {
      worldId: world.worldId,
    });
    expect(map.cities.every((city) => city.nationId === result.winner!.nationId)).toBe(true);
    for (const screen of [a, b])
      await expect(screen.page.getByLabel('지도 범례')).toContainText(`${result.winner!.name} ${map.cities.length}`);
    await expectResult(b.page, world.worldId);
    await expectQuiet([a, b]);

    // 장수가 있는 계정의 예턴 편집은 막혀 있고 이유를 보여 준다.
    const editor = a.page.getByTestId('turn-editor');
    await expect(editor.getByTestId('turns-locked')).toHaveText('끝난 판이라 예턴을 바꿀 수 없습니다.');
    const save = editor.getByRole('button', { name: '저장 (사용 불가)' });
    await save.click();
    await expect(editor.getByRole('note')).toHaveText('끝난 판이라 예턴을 바꿀 수 없습니다.');

    // 막힌 버튼을 우회해 직접 보낸 저장도 서버가 거부하고 예턴은 그대로다.
    const before = await turns(a.page, world.worldId);
    const rejected = await setTurns(a.page, world.worldId, [{ commandKey: 'rest' }]).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ApiError);
    expect(await turns(a.page, world.worldId)).toEqual(before);

    await a.page.screenshot({ path: testInfo.outputPath('season-unified.png'), fullPage: true });
    await testInfo.attach('season-unified', { path: testInfo.outputPath('season-unified.png') });
    // 새로고침해도, 장수가 없는 다른 계정으로 열어도 같은 결과를 서버에서 다시 읽는다.
    for (const screen of [a, b]) {
      await screen.page.reload();
      await expectResult(screen.page, world.worldId);
    }
    await expect(b.page.getByRole('region', { name: '기수 결과' }).getByText(result.winner!.name)).toBeVisible();
  } finally {
    await releaseHold(world.hold);
  }
});
