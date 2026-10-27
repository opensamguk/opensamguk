import type { AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';
import type { Route } from '@playwright/test';
import { test, expect, apiMutate, apiQuery } from './t210-fixture';
import { rngFor } from '../packages/shared/src/index';
import { applyCampaignRelationship } from '../packages/rules/src/index';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadReplayState } from '../apps/engine/src/monthly';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

type Board = inferRouterOutputs<AppRouter>['campaign']['get'];
// 두 사람의 생성·본인 동의·여러 입력의 확정 조회를 실제 화면에서 검사한다.
// 기존 시험 제한은 바꾸지 않는다. 정식 한 기수 완주는 INT-12에서 별도로 검사한다.
test('AC-INT-11 정식491명 생성·사람 동의·NPC 영입·부곡 지휘·재접속·375px', async ({ world }) => {
  test.setTimeout(120000);
  const owner = await world.user('member'),
    target = await world.user('ronin');
  const db = world.hold.db;
  let seed = '';
  for (let index = 0; index < 1000000; index++) {
    const value = `int11-formal-${index}`;
    if (
      [owner, target].every((user) => {
        const rng = rngFor(value, 'create', user.userId);
        rng.next();
        rng.next();
        const offset = rng.int(0, 9999);
        return offset > 0 && offset <= 100;
      })
    ) {
      seed = value;
      break;
    }
  }
  expect(seed).not.toBe('');
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed,
  });
  initial.ruleFeatures = [
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
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT11 정식 조작',
    turnTermMinutes: 60,
    endYear: 201,
  });
  const hold = await holdLease(worldId);
  const panel = (user: typeof owner) => user.page.getByRole('region', { name: '개인 휘하·부곡' });
  let tick = 0;
  const advance = () => new TurnLoop(hold.db, hold.lease).advanceTo(tick);
  const pending = (kind: string) =>
    expect.poll(() => db.inputEvent.count({ where: { worldId, kind, status: 'PENDING' } })).toBe(1);
  try {
    await controlClock(db, worldId, 'start');
    for (const [index, user] of [owner, target].entries()) {
      await user.page.goto(`/w/${worldId}/create`);
      await expect(user.page.getByRole('spinbutton')).toHaveCount(5);
      await expect(user.page.getByText('능력치 (합계 275, 각각 15~90)')).toBeVisible();
      await user.page.getByLabel('이름', { exact: true }).fill(`화면장수${index}`);
      await user.page.getByRole('button', { name: '책사', exact: true }).click();
      await expect(user.page.getByRole('spinbutton', { name: '지력', exact: true })).toHaveValue('90');
      await user.page.getByRole('button', { name: '고르게 나누기' }).click();
      const pattern = '**/trpc/general.create*';
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tasks: Promise<PromiseSettledResult<unknown>>[] = [];
      const track = <T>(task: Promise<T>) => {
        tasks.push(
          task.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          ),
        );
        return task;
      };
      const failures: unknown[] = [];
      let delivered = false;
      let failed = false;
      const onFailed = (request: { url(): string }) => {
        if (request.url().includes('/trpc/general.create')) failed = true;
      };
      const holdResponse = (route: Route) => {
        return track(
          (async () => {
            const response = await route.fetch();
            await gate;
            delivered = true;
            await route.fulfill({ response });
          })(),
        );
      };
      if (index === 0) {
        await user.page.route(pattern, holdResponse);
        user.page.on('requestfailed', onFailed);
      }
      try {
        await user.page.getByRole('button', { name: '장수 만들기', exact: true }).click();
        await pending('general.create');
        await advance();
        if (index === 0) {
          // 실제 생성 응답만 보류한다. ready와 같은 캐시 무효화로 실제 mine 조회가 먼저 도착하게 한다.
          const observed = track(
            user.page.waitForResponse(
              async (response) => {
                if (
                  !new URL(response.url()).pathname.split('/').at(-1)?.split(',').includes('general.mine') ||
                  response.status() >= 400
                )
                  return false;
                const body: unknown = await response.json();
                return (Array.isArray(body) ? body : [body]).some(
                  (row) => row?.result?.data?.general?.name === `화면장수${index}`,
                );
              },
              { timeout: 5000 },
            ),
          );
          await user.page.evaluate(
            async ({ moduleUrl, id }) => {
              const { queryClient, trpc } = await import(moduleUrl);
              await queryClient.invalidateQueries({ queryKey: trpc.general.mine.queryKey({ worldId: id }) });
            },
            { moduleUrl: '/src/trpc.ts', id: worldId },
          );
          await observed;
          expect(delivered).toBe(false);
          expect(failed).toBe(false);
        }
        await expect(user.page).toHaveURL(`${world.stack.webOrigin}/w/${worldId}`);
      } catch (error) {
        failures.push(error);
      } finally {
        release();
        const results = await Promise.all(tasks);
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        if (index === 0) {
          try {
            if (!user.page.isClosed()) await user.page.unroute(pattern, holdResponse);
          } catch (error) {
            failures.push(error);
          } finally {
            user.page.off('requestfailed', onFailed);
          }
        }
      }
      if (failures.length) throw new AggregateError([...new Set(failures)], '장수 생성 경합 검사 실패');
    }
    const humans = await db.general.findMany({
      where: { worldId, userId: { in: [owner.userId, target.userId] } },
      orderBy: { id: 'asc' },
    });
    expect(humans.map((general) => general.id)).toEqual([492, 493]);
    expect(humans.every((general) => general.nextTurnTick <= 100)).toBe(true);
    for (const user of [owner, target])
      await apiMutate(world, user, 'turns.set', {
        worldId,
        revision: 0,
        slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
      });
    tick = Math.max(...humans.map((general) => general.nextTurnTick));
    await advance();
    await owner.page.reload();
    await target.page.reload();
    const ownerId = humans[0]!.id,
      targetId = humans[1]!.id;
    const targetTurns = await db.generalTurn.findMany({
      where: { worldId, generalId: targetId },
      orderBy: { slot: 'asc' },
    });
    expect(targetTurns).toHaveLength(30);
    await expect(panel(owner)).toBeVisible();
    const editor = owner.page.getByTestId('turn-editor');
    await editor.locator('tr[data-slot="1"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: /에 넣기$/ }).click();
    await expect(editor.locator('tr[data-slot="1"]')).toContainText('농지 개간');
    await panel(owner).getByRole('button', { name: '화면장수1에게 제안', exact: true }).click();
    await pending('campaign.relationship');
    await advance();
    await target.page.reload();
    await expect(panel(target)).toContainText('화면장수0의 가신 제안');
    await panel(target).getByRole('button', { name: '수락', exact: true }).click();
    await pending('campaign.relationship');
    await advance();
    await expect(panel(owner)).toContainText('화면장수0 → 화면장수1 (가신)');
    await expect(editor.locator('tr[data-slot="1"]')).toContainText('농지 개간');
    expect(
      await db.generalTurn.findMany({ where: { worldId, generalId: targetId }, orderBy: { slot: 'asc' } }),
    ).toEqual(targetTurns);
    const replay = await db.$transaction((tx) => loadReplayState(tx, worldId));
    const candidates = await apiQuery<Board>(owner, 'campaign.get', { worldId });
    const npc = candidates.people.find((person) => {
      if (person.isHuman || !candidates.candidates.includes(person.id)) return false;
      const outcome = applyCampaignRelationship(
        replay.state,
        { type: 'offer', targetId: person.id, relation: 'LIEUTENANT', revision: candidates.revision },
        ownerId,
        replay.state.campaign,
        { tick, userId: owner.userId, userActive: true },
      );
      return outcome.ok && outcome.result.accepted === true;
    });
    expect(npc).toBeDefined();
    await panel(owner).getByLabel('제안할 관계').selectOption('LIEUTENANT');
    await expect(panel(owner)).toContainText('금500');
    await expect(panel(owner)).toContainText('호응 52%');
    await panel(owner)
      .getByRole('button', { name: `${npc!.name}에게 제안`, exact: true })
      .click();
    await pending('campaign.relationship');
    await advance();
    await expect(panel(owner)).toContainText(`화면장수0 → ${npc!.name} (부장)`);
    await panel(owner).getByLabel('새 부곡 지휘관').selectOption(String(npc!.id));
    await panel(owner).getByRole('button', { name: '빈 부곡 편성' }).click();
    await pending('campaign.unit');
    const input = await db.inputEvent.findFirstOrThrow({
      where: { worldId, kind: 'campaign.unit', status: 'PENDING' },
    });
    await owner.page.reload();
    await expect(panel(owner)).toContainText('요청을 처리하는 중');
    await advance();
    await expect(panel(owner)).toContainText('소유 부곡 1개');
    const after = await apiQuery<Board>(owner, 'campaign.get', { worldId });
    expect(after.units).toHaveLength(1);
    expect(after.units[0]).toMatchObject({ ownerId, commanderId: npc!.id, troops: 0 });
    expect(await db.inputEvent.count({ where: { worldId, idempotencyKey: input.idempotencyKey } })).toBe(1);
    await panel(owner).getByLabel(`부곡 ${after.units[0]!.id} 지휘관`).selectOption(String(ownerId));
    await pending('campaign.unit');
    await advance();
    await expect
      .poll(async () => (await apiQuery<Board>(owner, 'campaign.get', { worldId })).units[0]!.commanderId)
      .toBe(ownerId);
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: ownerId } } });
    const turns = await db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId, id: ownerId } },
      select: { turnRevision: true },
    });
    await apiMutate(world, owner, 'turns.set', {
      worldId,
      revision: turns.turnRevision,
      slots: [
        { commandKey: 'recruit', args: { amount: 10, crewType: 1100, unitId: after.units[0]!.id } },
        ...Array.from({ length: 29 }, () => null),
      ],
    });
    tick = actor.nextTurnTick;
    await advance();
    await owner.page.reload();
    const garrison = owner.page.getByRole('table', { name: /^주둔 장수/ });
    await expect(garrison.getByRole('columnheader', { name: '정치' })).toBeVisible();
    await expect(garrison.getByRole('columnheader', { name: '매력' })).toBeVisible();
    const ownRow = garrison
      .getByRole('row')
      .filter({ has: owner.page.getByRole('cell', { name: '화면장수0', exact: true }) });
    await expect(ownRow.getByRole('cell').nth(7)).toHaveText('10');
    expect((await apiQuery<Board>(owner, 'campaign.get', { worldId })).units[0]!.troops).toBe(10);
    expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: ownerId } } })).crew).toBe(0);
    expect(
      await db.generalTurn.findMany({ where: { worldId, generalId: targetId }, orderBy: { slot: 'asc' } }),
    ).toEqual(targetTurns);
    await owner.page.setViewportSize({ width: 375, height: 812 });
    await owner.page.reload();
    await expect(panel(owner)).toBeVisible();
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    expect(
      (await panel(owner).getByRole('button', { name: '빈 부곡 편성' }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await owner.page.screenshot({ path: 'test-results/int11-formal-campaign-mobile.png', fullPage: true });
  } finally {
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
