import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import { lineageStateSchema } from '../packages/rules/src/index';
import { newSession } from '../apps/server/src/auth/session';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { test, expect, type LegalStack } from './legalFixture';

// AC-P2-32·35 실제 공개 웹·HTTP·PG·엔진이다. 인공 4명과 등장 1년 설정이며 정식491·전체 기수·CF 증거는 아니다.
const family = (page: Page) => page.getByRole('region', { name: '가문', exact: true });
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

test('AC-P2-32 실제 성별 선택·사람 혼인 수락·계승 동의와 세 화면 폭', async ({ legalStack: stack, browser }, info) => {
  test.setTimeout(180000);
  const initial = commandInitial();
  initial.seed = 'lineage-browser-family';
  initial.generals = initial.generals.map((general) => ({
    ...general,
    sex: general.id === 2 ? 'MALE' : general.id === 3 ? 'FEMALE' : 'UNKNOWN',
    nextTurnTick: 1_000_000,
  }));
  initial.diplomacies = initial.diplomacies.map((row) => ({ ...row, state: 'NON_AGGRESSION', untilTick: 300000 }));
  const config = structuredClone(lineageTestConfig);
  config.birth.comingOfAgeYears = 1;
  const { worldId } = await saveInitialWorld(stack.db, initial, {
    name: '가문 화면 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
    ruleFeatures: ['lineage-v1', 'personnel', 'policy'],
    featureData: { 'lineage-v1': config },
  });
  await controlClock(stack.db, worldId, 'start');
  const advance = async (tick: number) => {
    const lease = await acquireLease(stack.db, worldId, randomUUID(), 120000);
    if (!lease) throw Error('가문 화면 검증 실행권이 없습니다.');
    try {
      await new TurnLoop(stack.db, lease).advanceTo(tick);
    } finally {
      await releaseLease(stack.db, lease);
    }
  };
  const father = await actor(stack, browser),
    mother = await actor(stack, browser),
    errors: string[] = [];
  for (const page of [father.page, mother.page]) page.on('pageerror', (error) => errors.push(error.message));
  const create = async (player: typeof father, name: string, sex: '남' | '여') => {
    await player.page.goto(`/w/${worldId}/create`);
    const group = player.page.getByRole('group', { name: '성별 (필수)' });
    await expect(group.getByRole('radio', { name: '남', exact: true })).not.toBeChecked();
    await expect(group.getByRole('radio', { name: '여', exact: true })).not.toBeChecked();
    await player.page.getByLabel('이름', { exact: true }).fill(name);
    await player.page.getByLabel('통솔', { exact: true }).fill('70');
    await player.page.getByLabel('무력', { exact: true }).fill('70');
    await player.page.getByLabel('지력', { exact: true }).fill('60');
    await group.getByRole('radio', { name: sex, exact: true }).check();
    await player.page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect
      .poll(() =>
        stack.db.inputEvent.count({ where: { worldId, userId: player.id, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    await advance(0);
    const general = await stack.db.general.findFirstOrThrow({ where: { worldId, userId: player.id } });
    expect(general.sex).toBe(sex === '남' ? 'MALE' : 'FEMALE');
    await player.page.goto(`/w/${worldId}/me`);
    await expect(family(player.page)).toBeVisible();
    return general.id;
  };
  const orders = () =>
    stack.db.inputEvent.findMany({ where: { worldId, kind: 'lineage.act' }, orderBy: { createdAt: 'asc' } });
  const apply = async (count: number) => {
    await expect.poll(async () => (await orders()).length).toBe(count);
    await advance((await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).clockTick);
    await expect.poll(async () => (await orders()).filter((row) => row.status === 'APPLIED').length).toBe(count);
  };
  try {
    const from = await create(father, '가문부모', '남'),
      other = await create(mother, '가문배우자', '여');
    await father.page.reload();
    await family(father.page).getByRole('tab', { name: '혼인', exact: true }).click();
    await family(father.page)
      .locator('article')
      .filter({ hasText: '가문배우자' })
      .getByRole('button', { name: '혼인 제안', exact: true })
      .click();
    await father.page
      .getByRole('dialog', { name: '혼인 제안', exact: true })
      .getByRole('button', { name: '혼인 요청 보내기', exact: true })
      .click();
    await apply(1);
    await mother.page.reload();
    await family(mother.page).getByRole('tab', { name: /^제안/ }).click();
    await family(mother.page).getByRole('button', { name: '수락', exact: true }).click();
    await mother.page
      .getByRole('dialog', { name: '혼인 제안 수락', exact: true })
      .getByRole('button', { name: '수락 보내기', exact: true })
      .click();
    await apply(2);
    await advance(10000);
    await advance(120000);
    const lineage = lineageStateSchema.parse(
      (await stack.db.world.findUniqueOrThrow({ where: { id: worldId } })).lineageState,
    );
    const entry = Object.entries(lineage.persons).find(
      ([, person]) => person.parents.includes(from) && person.parents.includes(other),
    );
    if (!entry) throw Error('사람 혼인에서 자녀가 태어나지 않았습니다.');
    const heir = await stack.db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: Number(entry[0]) } } });
    await father.page.reload();
    await family(father.page).getByRole('tab', { name: '계승', exact: true }).click();
    await family(father.page)
      .getByRole('list', { name: '후계 후보' })
      .locator('li')
      .filter({ hasText: heir.name })
      .getByRole('button', { name: '후계자로 지정', exact: true })
      .click();
    await father.page
      .getByRole('dialog', { name: '후계자 지정', exact: true })
      .getByRole('button', { name: '지정 보내기', exact: true })
      .click();
    await apply(3);
    await father.page.route('**/trpc/lineage.submit*', (route) => route.abort());
    await family(father.page).getByRole('button', { name: '지정 해제', exact: true }).first().click();
    await father.page
      .getByRole('dialog', { name: '후계 지정 해제', exact: true })
      .getByRole('button', { name: '해제 보내기', exact: true })
      .click();
    await family(father.page).getByRole('button', { name: '같은 요청 상태 확인', exact: true }).click();
    await expect(family(father.page).getByRole('button', { name: '같은 요청 다시 접수', exact: true })).toBeVisible();
    await expect(
      family(father.page).getByRole('button', { name: '이전 장수 요청 기록 지우기', exact: true }),
    ).toBeHidden();
    const confirmPage = await father.context.newPage();
    confirmPage.on('pageerror', (error) => errors.push(error.message));
    await confirmPage.goto(`/w/${worldId}/me`);
    await family(confirmPage).getByRole('tab', { name: '계승', exact: true }).click();
    await family(confirmPage).getByRole('button', { name: '계승 확정…', exact: true }).click();
    const dialog = confirmPage.getByRole('dialog', { name: /계승 확정/ }),
      confirm = dialog.getByRole('button', { name: '계승 확정 보내기', exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await confirm.click();
    await apply(4);
    await expect
      .poll(
        async () =>
          (await stack.db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: heir.id } } })).userId,
      )
      .toBe(father.id);
    expect(
      (await stack.db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: from } } })).userId,
    ).toBeNull();
    await expect(family(confirmPage).getByText('계승했습니다', { exact: false })).toBeVisible();
    await father.page.unroute('**/trpc/lineage.submit*');
    await father.page.reload();
    await expect(family(father.page).getByRole('button', { name: '같은 요청 다시 접수', exact: true })).toBeHidden();
    await family(father.page).getByRole('button', { name: '이전 장수 요청 기록 지우기', exact: true }).click();
    await expect(
      family(father.page).getByRole('button', { name: '이전 장수 요청 기록 지우기', exact: true }),
    ).toBeHidden();
    expect(await stack.db.inputEvent.count({ where: { worldId, kind: 'lineage.act' } })).toBe(4);
    await expect(
      father.page.locator(`[data-general-id="${heir.id}"]`).getByText('나이', { exact: true }).locator('..'),
    ).toContainText('1세');
    for (const width of [375, 768, 1440])
      for (const colorScheme of ['light', 'dark'] as const) {
        await father.page.setViewportSize({ width, height: 1000 });
        await father.page.emulateMedia({ colorScheme });
        for (const name of ['가문', '혼인', '제안', '계승', '기록']) {
          await family(father.page)
            .getByRole('tab', { name: new RegExp(`^${name}`) })
            .click();
          expect(await father.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
            true,
          );
        }
        await family(father.page).getByRole('tab', { name: '가문', exact: true }).click();
        await father.page.screenshot({ path: info.outputPath(`lineage-${width}-${colorScheme}.png`), fullPage: true });
      }
    expect(errors).toEqual([]);
    await info.attach('lineage-scope', {
      body: JSON.stringify({
        realPostgres: true,
        realHttp: true,
        publicDist: true,
        originalHumanCreation: true,
        recordedNpcSchedule: true,
        full491: false,
        cloudflare: false,
      }),
      contentType: 'application/json',
    });
  } finally {
    await father.context.close();
    await mother.context.close();
  }
});
