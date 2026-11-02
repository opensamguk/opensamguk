import { createHash } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { expect, type LegalStack } from './legalFixture';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease } from './game';
import { cleanupHeldWorld } from './heldWorldCleanup';
import type { LegalPolicy } from '../apps/server/src/legal/policy';

export async function formalConsent(
  page: Page,
  stack: LegalStack,
  info: TestInfo,
  helpers: {
    policy(tag: string): LegalPolicy;
    account(stack: LegalStack, page: Page): Promise<{ id: string }>;
    checkBoth(page: Page): Promise<void>;
    mobile(page: Page, width: number): Promise<void>;
  },
) {
  await stack.restart(helpers.policy('formal-before'));
  const user = await helpers.account(stack, page);
  const worlds: Array<{ id: string; hold: Awaited<ReturnType<typeof holdLease>> }> = [];
  const errors: unknown[] = [];
  const observations: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const initial = await loadInitialWorld({
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'legal-formal-191-' + index,
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
        name: '동의 화면 정식191-' + index,
        turnTermMinutes: 60,
        endYear: 201,
      });
      let hold: Awaited<ReturnType<typeof holdLease>>;
      try {
        hold = await holdLease(worldId);
      } catch {
        throw new Error('자기 실행권을 얻지 못한 정식 월드를 보존합니다.');
      }
      worlds.push({ id: worldId, hold });
      await controlClock(hold.db, worldId, 'start');
      const destination = `/w/${worldId}/create`;
      await page.goto(stack.origin + destination);
      if (index === 0) {
        await expect(page.getByRole('heading', { name: '현재 문서 동의', exact: true })).toBeVisible();
        expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
        await helpers.checkBoth(page);
        await page.getByRole('button', { name: '동의하고 계속하기' }).click();
      }
      await expect(page.getByRole('spinbutton')).toHaveCount(5);
      await page.getByLabel('이름', { exact: true }).fill('동의장수' + index);
      await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
      await expect
        .poll(() => hold.db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
        .toBe(1);
      await new TurnLoop(hold.db, hold.lease).advanceTo(0);
      await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
      const human = await stack.db.general.findUniqueOrThrow({
        where: { worldId_userId: { worldId, userId: user.id } },
        select: { id: true },
      });
      expect(await stack.db.generalTurn.count({ where: { worldId, generalId: human.id } })).toBe(30);
      expect(await stack.db.general.count({ where: { worldId, userId: null } })).toBe(491);
      expect(await stack.db.generalTurn.count({ where: { worldId } })).toBe(492 * 30);
      expect(
        (await stack.db.world.findUniqueOrThrow({ where: { id: worldId }, select: { ruleFeatures: true } }))
          .ruleFeatures,
      ).toEqual(initial.ruleFeatures);
    }
    const main = `/w/${worlds[0]!.id}?city=40`;
    await page.goto(stack.origin + main);
    const editor = page.getByTestId('turn-editor');
    await expect(editor.locator('tr[data-slot]')).toHaveCount(30);
    const draft = async (slot: number) => {
      await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
      await editor.locator(`tr[data-slot="${slot}"]`).click();
      await editor.getByLabel('명령 찾기').fill('농지 개간');
      await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
      await editor.getByRole('button', { name: `${slot}번 칸에 넣기`, exact: true }).click();
      await expect(editor.locator(`tr[data-slot="${slot}"]`)).toContainText('농지 개간');
    };
    await draft(1);
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    await draft(2);
    const snapshot = async (worldId: string) =>
      createHash('sha256')
        .update(
          JSON.stringify(
            await stack.db.generalTurn.findMany({
              where: { worldId },
              orderBy: [{ generalId: 'asc' }, { slot: 'asc' }],
            }),
          ),
        )
        .digest('hex');
    const snapshots = async () => {
      const values: string[] = [];
      for (const world of worlds) values.push(await snapshot(world.id));
      return values;
    };
    const before = await snapshots();
    await stack.restart(helpers.policy('formal-after'));
    const denied = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname.includes('turns.set'),
    );
    observations.push(denied);
    void denied.catch(() => undefined);
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    expect((await denied).status()).toBe(403);
    await expect(page.getByRole('heading', { name: '현재 문서 동의', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe(main);
    expect(await snapshots()).toEqual(before);
    for (const width of [375, 1280]) {
      await helpers.mobile(page, width);
      await page.screenshot({ path: info.outputPath(`formal-reconsent-${width}.png`), fullPage: true });
    }
    await helpers.checkBoth(page);
    await page.getByRole('button', { name: '동의하고 계속하기' }).click();
    await expect(page).toHaveURL(stack.origin + main);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.locator('tr[data-slot="2"]')).toContainText('농지 개간');
    expect(await snapshots()).toEqual(before);
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor.getByText('저장했습니다.', { exact: true })).toBeVisible();
    expect(await snapshot(worlds[1]!.id)).toBe(before[1]);
    const human = await stack.db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId: worlds[0]!.id, userId: user.id } },
      select: { id: true },
    });
    const slots = await stack.db.generalTurn.findMany({
      where: { worldId: worlds[0]!.id, generalId: human.id },
      orderBy: { slot: 'asc' },
    });
    expect(slots).toHaveLength(30);
    expect(slots.slice(0, 2).map((slot) => slot.commandKey)).toEqual(['farm', 'farm']);
    expect(await stack.db.consentRecord.count({ where: { userId: user.id } })).toBe(4);
  } catch (error) {
    errors.push(error);
  }
  try {
    await page.close();
  } catch (error) {
    errors.push(error);
  }
  for (const result of await Promise.allSettled(observations))
    if (result.status === 'rejected') errors.push(result.reason);
  for (const world of worlds.reverse()) {
    try {
      await cleanupHeldWorld(world.hold, process.env.DATABASE_URL!);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '동의 화면 정식 두 월드 인수 또는 자기 월드 정리 실패');
}
