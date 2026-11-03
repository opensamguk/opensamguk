import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES } from '../packages/rules/src/index';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { test, expect, type LegalStack } from './legalFixture';

// AC-P2-33: 실제 공개 웹·HTTP·PG·엔진. 짧은 인공 월드이며 전체 기수·장애 복구를 대신하지 않는다.
async function actor(stack: LegalStack, browser: Browser) {
  const id = randomUUID(),
    session = newSession(Date.now());
  await stack.db.user.create({
    data: {
      id,
      email: `${id}@example.invalid`,
      emailVerifiedAt: new Date(),
      passwordHash: 'not-a-login-hash',
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  const context = await browser.newContext({ baseURL: stack.origin, viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return { id, context, page: await context.newPage() };
}
async function world(stack: LegalStack, options: { winner?: string; five?: boolean; off?: boolean } = {}) {
  const initial = commandInitial();
  initial.seed = `heritage-browser-${randomUUID()}`;
  for (const general of initial.generals) general.nextTurnTick = 1_000_000;
  if (options.winner) {
    initial.nations = initial.nations.filter((nation) => nation.id === 1);
    initial.cities = initial.cities.map((city) => ({ ...city, nationId: 1 }));
    initial.generals = initial.generals.filter((general) => general.id === 1);
    initial.generals[0]!.userId = options.winner;
    initial.generals[0]!.nextTurnTick = 100;
    initial.diplomacies = [];
    delete initial.nationTurns;
  }
  if (options.five) {
    initial.statRules = FIVE_STAT_RULES;
    initial.generals = initial.generals.map((general) => ({ ...general, politics: 50, charm: 50 }));
  }
  const { worldId } = await saveInitialWorld(stack.db, initial, {
    name: '유산 화면 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: [...(options.five ? ['five-stats'] : []), ...(options.off ? [] : ['heritage-v1']), 'policy'],
    ...(options.off ? {} : { featureData: { 'heritage-v1': { version: 1 } } }),
  });
  await controlClock(stack.db, worldId, 'start');
  return worldId;
}
async function advance(stack: LegalStack, id: string, tick = 0) {
  const lease = await acquireLease(stack.db, id, randomUUID(), 120000);
  if (!lease) throw Error('유산 화면 시험 실행권이 없습니다.');
  try {
    await new TurnLoop(stack.db, lease).advanceTo(tick);
  } finally {
    await releaseLease(stack.db, lease);
  }
}
async function earn(stack: LegalStack, userId: string) {
  for (let i = 0; i < 3; i++) await advance(stack, await world(stack, { winner: userId }), 100);
  expect((await stack.db.heritageAccount.findUniqueOrThrow({ where: { userId } })).balance).toBe(6);
}
async function pending(stack: LegalStack, worldId: string, userId: string) {
  await expect
    .poll(() => stack.db.inputEvent.count({ where: { worldId, userId, kind: 'general.create', status: 'PENDING' } }), {
      timeout: 10000,
    })
    .toBe(1);
}
const allocation = (page: Page) => page.getByRole('group', { name: '유산 능력치 (선택)', exact: true });

test('AC-P2-33 실제 보상·5능력치 유산 생성·계정 기록과 키보드·세 화면 폭', async ({
  legalStack: stack,
  browser,
}, info) => {
  test.setTimeout(180000);
  const player = await actor(stack, browser),
    errors: string[] = [],
    sent: unknown[] = [];
  player.page.on('pageerror', (error) => errors.push(error.message));
  player.page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/trpc/general.create'))
      sent.push(request.postDataJSON());
  });
  try {
    await earn(stack, player.id);
    const id = await world(stack, { five: true });
    await player.page.goto(`/w/${id}/create`);
    const panel = allocation(player.page);
    await expect(panel).toBeVisible();
    await expect(panel.getByText('0 / 6', { exact: true })).toBeVisible();
    await player.page.getByLabel('이름', { exact: true }).fill('유산장수');
    for (const stat of ['정치', '매력']) {
      const increase = panel.getByRole('button', { name: `${stat} 유산 늘리기`, exact: true });
      await increase.focus();
      for (let i = 0; i < 3; i++) await player.page.keyboard.press('Enter');
      await expect(increase).toBeDisabled();
      await expect(panel.getByRole('button', { name: `${stat} 유산 줄이기`, exact: true })).toBeFocused();
    }
    for (const button of await panel.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    for (const width of [375, 768, 1440])
      for (const colorScheme of ['light', 'dark'] as const) {
        await player.page.setViewportSize({ width, height: 1000 });
        await player.page.emulateMedia({ colorScheme });
        expect(await player.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await player.page.screenshot({
          path: info.outputPath(`heritage-create-${width}-${colorScheme}.png`),
          fullPage: true,
        });
      }
    await player.page.getByRole('button', { name: '장수 만들기 (유산 6점 사용)', exact: true }).click();
    await pending(stack, id, player.id);
    await advance(stack, id);
    await expect(player.page).toHaveURL(new RegExp(`/w/${id}$`));
    await expect(player.page.getByText('유산장수', { exact: true }).first()).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      0: {
        expectedUserId: player.id,
        politics: 55,
        charm: 55,
        heritage: { politics: 3, charm: 3 },
      },
    });
    const general = await stack.db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId: id, userId: player.id } },
    });
    expect([general.politics, general.charm]).toEqual([58, 58]);
    const event = await stack.db.inputEvent.findFirstOrThrow({ where: { worldId: id, kind: 'general.create' } });
    expect(event.payload).not.toHaveProperty('expectedUserId');
    await player.page.goto('/account');
    const history = player.page.getByRole('region', { name: '유산 포인트', exact: true });
    await expect(history).toBeVisible();
    await expect(history.getByText('생성 사용', { exact: true })).toBeVisible();
    await expect(history.getByText('기수 지급', { exact: true })).toHaveCount(3);
    await expect(history).not.toContainText(player.id);
    await expect(history).not.toContainText(id);
    for (const width of [375, 768, 1440])
      for (const colorScheme of ['light', 'dark'] as const) {
        await player.page.setViewportSize({ width, height: 1000 });
        await player.page.emulateMedia({ colorScheme });
        expect(await player.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await player.page.screenshot({
          path: info.outputPath(`heritage-account-${width}-${colorScheme}.png`),
          fullPage: true,
        });
      }
    const old = await world(stack, { off: true });
    await player.page.goto(`/w/${old}/create`);
    await expect(player.page.getByRole('heading', { name: '장수 생성', exact: true })).toBeVisible();
    await expect(player.page.getByLabel('이름', { exact: true })).toBeVisible();
    await expect(allocation(player.page)).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await player.context.close();
  }
});

test('AC-P2-33 실제 다른 월드 사용 뒤 수동 잔액 확인과 계정 전환은 이전 배분을 다시 보내지 않는다', async ({
  legalStack: stack,
  browser,
}) => {
  test.setTimeout(180000);
  const player = await actor(stack, browser),
    other = await actor(stack, browser);
  try {
    await earn(stack, player.id);
    await earn(stack, other.id);
    const id = await world(stack, { five: true }),
      elsewhere = await world(stack, { five: true });
    await player.page.goto(`/w/${id}/create`);
    await player.page.getByLabel('이름', { exact: true }).fill('옛유산');
    const panel = allocation(player.page);
    for (const stat of ['정치', '매력'])
      for (let i = 0; i < 3; i++) await panel.getByRole('button', { name: `${stat} 유산 늘리기`, exact: true }).click();
    const elsewhereRequest = player.context.request.post('/trpc/general.create?batch=1', {
      headers: { origin: stack.origin },
      data: {
        0: {
          worldId: elsewhere,
          expectedUserId: player.id,
          name: '먼저사용',
          portraitId: null,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
          heritage: { leadership: 3, intel: 3 },
        },
      },
    });
    await pending(stack, elsewhere, player.id);
    await advance(stack, elsewhere);
    expect((await elsewhereRequest).status()).toBe(200);
    await player.page.getByRole('button', { name: '장수 만들기 (유산 6점 사용)', exact: true }).click();
    await pending(stack, id, player.id);
    await advance(stack, id);
    const refresh = player.page.getByRole('button', { name: '잔액 다시 확인', exact: true });
    await expect(refresh).toBeVisible();
    await expect(player.page.getByLabel('이름', { exact: true })).toHaveValue('옛유산');
    expect(await stack.db.inputEvent.count({ where: { worldId: id, kind: 'general.create' } })).toBe(1);
    // 실제 새 기수 보상으로 잔액을 다시 채운다. UI는 수동 확인 전 자동 제출하지 않는다.
    await earn(stack, player.id);
    await expect(refresh).toBeVisible();
    expect(await stack.db.inputEvent.count({ where: { worldId: id, kind: 'general.create' } })).toBe(1);
    await refresh.click();
    await expect(player.page.getByRole('button', { name: '장수 만들기 (유산 6점 사용)', exact: true })).toBeEnabled();
    // 다른 탭의 로그인 변경과 같은 실제 서버 세션 교체다. 오래된 화면의 기대 계정은 A로 남아야 한다.
    await player.context.clearCookies();
    await player.context.addCookies(await other.context.cookies());
    await player.page.getByRole('button', { name: '장수 만들기 (유산 6점 사용)', exact: true }).click();
    await expect(player.page.getByRole('alert').filter({ hasText: /계정이 바뀌/ })).toBeVisible();
    await expect(player.page.getByLabel('이름', { exact: true })).toHaveValue('');
    await expect(player.page.getByRole('button', { name: '장수 만들기 (유산 6점 사용)', exact: true })).toBeHidden();
    expect(await stack.db.inputEvent.count({ where: { worldId: id, kind: 'general.create' } })).toBe(1);
    expect(await stack.db.general.count({ where: { worldId: id, userId: other.id } })).toBe(0);
    for (const userId of [player.id, other.id])
      expect((await stack.db.heritageAccount.findUniqueOrThrow({ where: { userId } })).balance).toBe(6);
  } finally {
    await player.context.close();
    await other.context.close();
  }
});
