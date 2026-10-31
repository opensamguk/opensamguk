import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { expect, type LegalStack } from './legalFixture';
import { TEST_PASSWORD } from './account';
import { hashPassword } from '../apps/server/src/auth/password';
import { newSession } from '../apps/server/src/auth/session';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease } from './game';
import { releaseLease } from '../apps/engine/src/lease';

let password: Promise<string> | undefined;
export async function sanctionAccount(stack: LegalStack, page: Page, admin = false) {
  password ??= hashPassword(TEST_PASSWORD);
  const session = newSession(Date.now());
  const user = await stack.db.user.create({
    data: {
      email: `sanction-${randomUUID()}@example.test`,
      passwordHash: await password,
      emailVerifiedAt: new Date(),
      sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
    },
    select: { id: true, email: true },
  });
  if (admin) await changeAdminRole(stack.db, { email: user.email, role: 'ADMIN', reason: '제재 화면 시험 준비' });
  await page
    .context()
    .addCookies([{ name: 'sid', value: session.token, url: stack.origin, httpOnly: true, sameSite: 'Lax' }]);
  return user;
}

export const sanctionCalls = (request: Request, name: string) =>
  new URL(request.url()).pathname.split('/').at(-1)?.split(',').includes(name) ?? false;

export async function readSanctionTarget(page: Page, stack: LegalStack, userId: string) {
  await page.goto(stack.origin + '/admin/users');
  await page.getByLabel('상세 조회할 사용자 UUID', { exact: true }).fill(userId);
  await page.getByRole('button', { name: '상세 조회', exact: true }).click();
  const actions = page.getByRole('region', { name: '제재 조치', exact: true });
  await expect(actions.getByText('대상 ' + userId, { exact: true })).toBeVisible();
  return actions;
}

export async function formalSanctionWorlds(stack: LegalStack, page: Page, userId: string) {
  const worlds: Array<{ id: string; hold: Awaited<ReturnType<typeof holdLease>> }> = [];
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const world of worlds.reverse()) {
      const { hold } = world;
      hold.done.abort();
      // 제재가 참조하는 월드는 삭제하지 않는다. 전용 fixture가 연결0·OID를 확인한 DB만 정리한다.
      for (const action of [
        async () => {
          await hold.renewal;
          if (hold.lost) throw hold.lost;
        },
        () => releaseLease(hold.db, hold.lease),
        () => hold.db.$disconnect(),
      ])
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
    }
    if (errors.length) throw new AggregateError(errors, '제재 화면 정식 월드 정리 실패');
  };
  try {
    for (let index = 0; index < 2; index++) {
      const initial = await loadInitialWorld({
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'sanction-ui-' + index,
      });
      initial.ruleFeatures = [
        'campaign-assignment-v2',
        'campaign-v1',
        'five-stats',
        'operational-map',
        'personnel',
        'policy',
        'stratagem-basic',
        'treaty',
      ];
      expect(initial.generals).toHaveLength(491);
      expect(initial.nations).toHaveLength(21);
      const { worldId } = await saveInitialWorld(stack.db, initial, {
        name: '제재 화면 정식191-' + index,
        turnTermMinutes: 60,
        endYear: 201,
      });
      const hold = await holdLease(worldId);
      worlds.push({ id: worldId, hold });
      await controlClock(hold.db, worldId, 'start');
      await page.goto(stack.origin + `/w/${worldId}/create`);
      await page.getByLabel('이름', { exact: true }).fill('제재장수' + index);
      await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
      await expect
        .poll(() => stack.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
        .toBe(1);
      await new TurnLoop(hold.db, hold.lease).advanceTo(0);
      await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
      const human = await stack.db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
      expect(await stack.db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
      expect(await stack.db.general.count({ where: { worldId, userId: null } })).toBe(491);
    }
    return { worlds, cleanup };
  } catch (error) {
    const errors = [error];
    try {
      await cleanup();
    } catch (failure) {
      errors.push(failure);
    }
    throw new AggregateError(errors, '제재 화면 정식 월드 준비 실패', { cause: error });
  }
}
