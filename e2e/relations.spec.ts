import { randomUUID } from 'node:crypto';
import { createWorldFromCli } from '../apps/engine/src/admin/creation';
import { controlClock } from '../apps/engine/src/world/clock';
import { composeInitialWorld, readInitialResources } from '../apps/engine/src/world/resources';
import { newSession } from '../apps/server/src/auth/session';
import { RELATIONS_FEATURE } from '../packages/rules/src/index';
import { expect, test } from './legalFixture';

test('AC-P2-20 장수 정보에 등장한 인물의 혈연·결의·군신만 표시한다', async ({ browser, legalStack }) => {
  const { db, origin } = legalStack;
  const resources = await readInitialResources(db, { scenario: '1030', map: 'che' });
  const initial = composeInitialWorld(resources, 'relations-browser-1030');
  const options = { name: '관계 화면 검증', turnTermMinutes: 60, endYear: null };
  const create = async (ruleFeatures: string[]) => {
    const { worldId } = await createWorldFromCli(db, initial, { ...options, ruleFeatures }, resources);
    await controlClock(db, worldId, 'start');
    return worldId;
  };
  const enabled = await create([RELATIONS_FEATURE]);
  const disabled = await create([]);
  const year = initial.startYear;
  await db.general.updateMany({
    where: { worldId: enabled, id: { in: [47, 50, 281, 389] } },
    data: { activeFromYear: year },
  });
  await db.general.update({
    where: { worldId_id: { worldId: enabled, id: 370 } },
    data: { activeFromYear: year + 1 },
  });

  const userId = randomUUID();
  const session = newSession(Date.now());
  await db.user.create({
    data: {
      id: userId,
      email: `${userId}@example.invalid`,
      emailVerifiedAt: new Date(),
      passwordHash: 'not-a-login-hash',
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
  });
  await db.general.updateMany({
    where: { worldId: { in: [enabled, disabled] }, id: 281 },
    data: { userId, activeFromYear: year },
  });
  const context = await browser.newContext({ baseURL: origin });
  try {
    await context.addCookies([{ name: 'sid', value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const card = page.getByRole('region', { name: '장수 정보', exact: true });
    const relations = card.getByRole('region', { name: '인물 관계', exact: true });

    await page.goto(`/w/${enabled}`);
    await expect(relations.getByText('관우 · 결의', { exact: true })).toBeVisible();
    await expect(relations.getByText('조운 · 군신', { exact: true })).toBeVisible();
    await expect(relations.getByText('제갈량', { exact: false })).toHaveCount(0);

    await db.general.update({ where: { worldId_id: { worldId: enabled, id: 281 } }, data: { userId: null } });
    await db.general.update({ where: { worldId_id: { worldId: enabled, id: 47 } }, data: { userId } });
    await page.reload();
    await expect(relations.getByText('관평 · 혈연', { exact: true })).toBeVisible();
    await expect(relations.getByText('유비 · 결의', { exact: true })).toBeVisible();

    await page.goto(`/w/${disabled}`);
    await expect(card.getByRole('strong').filter({ hasText: /^유비$/ })).toBeVisible();
    await expect(relations).toHaveCount(0);
  } finally {
    await context.close();
  }
});
