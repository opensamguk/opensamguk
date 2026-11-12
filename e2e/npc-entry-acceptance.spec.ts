import { randomUUID } from 'node:crypto';
import { acquireLease, releaseLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { newSession } from '../apps/server/src/auth/session';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { expect, test } from './legalFixture';

test('AC-M3-14 네 역할에서 NPC를 맡고 이미 맡긴 무장을 제외하며 직접 생성한다', async ({ legalStack, browser }) => {
  test.setTimeout(150_000);
  const { db, origin } = legalStack;
  const initial = commandInitial();
  initial.generals.push({
    ...initial.generals[2]!,
    id: 5,
    name: '장수5',
    leadership: 60,
    strength: 60,
    intel: 60,
  });
  for (const general of initial.generals) general.nextTurnTick = 1_000_000;
  const { worldId } = await saveInitialWorld(db, initial, {
    name: '역할별 입장 인수 검증',
    turnTermMinutes: 60,
    endYear: null,
    ruleFeatures: ['policy'],
  });
  const worldUrl = `/w/${worldId}`;
  const lease = await acquireLease(db, worldId, randomUUID(), 180_000);
  if (!lease) throw new Error('입장 시험 월드의 실행권이 없습니다.');
  const loop = new TurnLoop(db, lease);
  const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
  const actor = async (role: 'ADMIN' | 'USER' = 'USER') => {
    const id = randomUUID();
    const now = Date.now();
    const session = newSession(now);
    await db.user.create({
      data: {
        id,
        role,
        email: `${id}@example.test`,
        emailVerifiedAt: new Date(now),
        passwordHash: 'not-a-login-hash',
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
    });
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 375, height: 812 } });
    contexts.push(context);
    await context.addCookies([{ name: 'sid', value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    return { id, page: await context.newPage() };
  };
  const processEntry = async (userId: string, kind: string) => {
    const where = { worldId, userId, kind };
    await expect.poll(() => db.inputEvent.count({ where: { ...where, status: 'PENDING' } })).toBe(1);
    await loop.advanceTo(0);
    expect(await db.inputEvent.count({ where: { ...where, status: 'APPLIED' } })).toBe(1);
  };

  try {
    const admin = await actor('ADMIN');
    const setting = await admin.page.request.post('/trpc/admin.world.requestSetting', {
      headers: { Origin: origin },
      data: {
        worldId,
        expectedUserId: admin.id,
        idempotencyKey: randomUUID(),
        reason: '역할별 입장 인수 검증',
        setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
      },
    });
    expect(setting.ok()).toBe(true);
    await loop.advanceTo(0);
    await controlClock(db, worldId, 'start');

    for (const [role, label, generalId] of [
      ['ruler', '군주', 1],
      ['core', '중견', 3],
      ['retainer', '부하', 5],
      ['free', '재야', 4],
    ] as const) {
      const { id, page } = await actor();
      const name = `장수${generalId}`;
      await page.goto(`${worldUrl}/create`);
      const panel = page.getByRole('region', { name: 'NPC 무장 맡기', exact: true });
      await panel.getByRole('button', { name: 'NPC 무장 맡기', exact: true }).click();
      await panel.getByRole('combobox', { name: '역할' }).selectOption(role);
      const group = panel.getByRole('group', { name: `${label} 무장`, exact: true });
      await group.getByRole('radio', { name: new RegExp(name) }).check();
      await panel.getByRole('button', { name: `${name}(으)로 시작`, exact: true }).click();
      await processEntry(id, 'general.possess');
      await expect(page).toHaveURL(new URL(worldUrl, origin).href);
      await expect(page.getByRole('region', { name: '장수 정보', exact: true }).getByRole('strong').first()).toHaveText(
        name,
      );
      const saved = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: id } } });
      expect(saved.id).toBe(generalId);
      expect(await db.generalLog.count({ where: { worldId, generalId, kind: 'possess' } })).toBe(1);
    }

    const { id, page } = await actor();
    await page.goto(`${worldUrl}/create`);
    const panel = page.getByRole('region', { name: 'NPC 무장 맡기', exact: true });
    const toggle = panel.getByRole('button', { name: 'NPC 무장 맡기', exact: true });
    await toggle.click();
    await expect(panel.getByRole('option')).toHaveText(['군주 (1)', '중견 (0)', '부하 (0)', '재야 (0)']);
    await expect(panel.getByRole('radio', { name: /장수2/ })).toBeVisible();
    await expect(panel.getByRole('radio', { name: /장수[1345]/ })).toHaveCount(0);
    await toggle.click();
    await page.getByLabel('이름', { exact: true }).fill('검증장수');
    await page.getByLabel('통솔', { exact: true }).fill('70');
    await page.getByLabel('무력', { exact: true }).fill('70');
    await page.getByLabel('지력', { exact: true }).fill('60');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await processEntry(id, 'general.create');
    await expect(page).toHaveURL(new URL(worldUrl, origin).href);
    const saved = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: id } } });
    expect(saved).toMatchObject({ name: '검증장수', nationId: null, officerLevel: 0 });
    expect(saved.id).toBeGreaterThan(5);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await releaseLease(db, lease);
  }
});
