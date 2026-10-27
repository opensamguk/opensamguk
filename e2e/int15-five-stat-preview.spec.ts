import { test, expect, apiMutate } from './t210-fixture';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES } from '../packages/rules/src/index';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

// AC-INT-15 화면 연결. 기존 격리 fixture의 실제 API·PostgreSQL·Vite를 사용한다.
// 정식 491명 한 기수 인수는 INT-12에서 별도로 검증한다.
test('INT-15 예약 화면의 비용·능력치 점수·상승량이 실제 실행과 같다', async ({ world }) => {
  const user = await world.user('member');
  const { page, userId } = user;
  const db = world.hold.db;
  const initial = commandInitial();
  initial.statRules = { ...FIVE_STAT_RULES };
  initial.ruleFeatures = ['five-stats', 'policy'];
  initial.generals = initial.generals.map((row, index) => ({
    ...row,
    userId: index === 0 ? userId : null,
    leadership: 55,
    strength: 35,
    intel: 50,
    politics: 90,
    charm: 45,
    nextTurnTick: index === 0 ? 100 : 1000000,
    crew: 100,
    train: 20,
    atmos: 20,
    injury: 0,
  }));
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT15 화면 연결',
    turnTermMinutes: 60,
    endYear: null,
  });
  const hold = await holdLease(worldId);
  try {
    await controlClock(db, worldId, 'start');
    const commands = [
      { commandKey: 'farm', args: {} },
      { commandKey: 'recruit', args: { amount: 100, crewType: 1100 } },
      { commandKey: 'train', args: {} },
      { commandKey: 'morale', args: {} },
    ];
    await apiMutate(world, user, 'turns.set', {
      worldId,
      revision: 0,
      slots: [...commands, ...Array.from({ length: 26 }, () => null)],
    });
    await page.goto(`/w/${worldId}/turns`);
    const editor = page.getByTestId('turn-editor');
    const row = (slot: number) => editor.locator(`tr[data-slot="${slot}"]`);
    await expect(row(1)).toContainText('능력치 점수 90');
    await expect(row(1)).toContainText('금 100');
    await expect(row(2)).toContainText('금 923');
    await expect(row(3)).toContainText('상승 10');
    await expect(row(4)).toContainText('상승 9');
    await expect(editor.locator('tbody tr')).toHaveCount(30);
    const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    await new TurnLoop(hold.db, hold.lease).advanceTo(100);
    const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    expect(before.gold - after.gold).toBe(100);
    await page.reload();
    await expect(row(1)).toContainText('금 923');
    await page.screenshot({ path: 'test-results/int15-five-stat-preview.png', fullPage: true });
  } finally {
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
