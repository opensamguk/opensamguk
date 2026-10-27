import { test, expect, apiMutate, apiQuery } from './t210-fixture';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

test('INT-17 네 계략이 실제 명령 목록·30칸·출사한 장수의 엔진 실행과 연결된다', async ({ world }) => {
  const user = await world.user('member');
  const db = world.hold.db;
  const initial = commandInitial();
  initial.statRules = { ...FIVE_STAT_RULES };
  initial.ruleFeatures = ['five-stats', 'personnel', 'policy', 'stratagem-basic', 'treaty'];
  initial.nations = initial.nations.map((nation) => ({ ...nation, isNpc: false }));
  initial.generals = initial.generals.map((general) => ({
    ...general,
    politics: 50,
    charm: 50,
    nextTurnTick: 1000000,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT17 계략 화면',
    turnTermMinutes: 60,
    endYear: null,
  });
  const hold = await holdLease(worldId);
  try {
    await controlClock(db, worldId, 'start');
    const creating = apiMutate<{ status: string }>(world, user, 'general.create', {
      worldId,
      name: '계략화면',
      portraitId: null,
      leadership: 55,
      strength: 70,
      intel: 80,
      politics: 35,
      charm: 35,
    });
    await expect
      .poll(() => db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } }))
      .toBe(1);
    const loop = new TurnLoop(hold.db, hold.lease);
    await loop.advanceTo(0);
    expect((await creating).status).toBe('created');
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId: user.userId } } });
    await apiMutate(world, user, 'turns.set', {
      worldId,
      revision: 0,
      slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
    });
    await loop.advanceTo(actor.nextTurnTick);
    const commandKeys = ['fire_attack', 'sabotage', 'incite', 'plunder'];
    const list = await apiQuery<Array<{ key: string; name: string }>>(user, 'commands.list', { worldId });
    expect(list.filter((command) => commandKeys.includes(command.key)).map((command) => command.name)).toEqual([
      '화계',
      '파괴',
      '선동',
      '탈취',
    ]);
    expect(list.some((command) => command.key === 'riot')).toBe(false);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: actor.id } } });
    await apiMutate(world, user, 'turns.set', {
      worldId,
      revision: general.turnRevision,
      slots: [
        ...commandKeys.map((commandKey) => ({ commandKey, args: { cityKey: 2 } })),
        ...Array.from({ length: 26 }, () => null),
      ],
    });
    await user.page.goto(`/w/${worldId}/turns`);
    const editor = user.page.getByTestId('turn-editor');
    await expect(editor.locator('tbody tr')).toHaveCount(30);
    for (const [index, name] of ['화계', '파괴', '선동', '탈취'].entries())
      await expect(editor.locator(`tr[data-slot="${index + 1}"]`)).toContainText(name);
    const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: actor.id } } });
    const tick = actor.nextTurnTick + TICKS_PER_MONTH;
    await loop.advanceTo(tick - 1);
    const ready = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: actor.id } } });
    expect(ready.nextTurnTick).toBe(tick);
    expect(await loop.advanceTo(tick)).toEqual([{ generalId: actor.id, tick, commandKey: 'fire_attack' }]);
    const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: actor.id } } });
    expect(ready.gold - after.gold).toBe(100);
    expect(after.turnRevision).toBe(before.turnRevision + 1);
    await user.page.reload();
    await expect(editor.locator('tr[data-slot="1"]')).toContainText('파괴');
    await user.page.screenshot({ path: 'test-results/int17-basic-stratagems.png', fullPage: true });
  } finally {
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
