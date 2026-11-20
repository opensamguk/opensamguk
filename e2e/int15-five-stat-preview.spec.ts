import { test, expect, apiMutate } from './t210-fixture';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { FIVE_STAT_RULES, TICKS_PER_MONTH } from '../packages/rules/src/index';
import { saveFixtureWorld } from './worldFixture';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';
import { renewLease } from '../apps/engine/src/lease';
import { loadReplayState } from '../apps/engine/src/monthly';

// AC-INT-15 화면 연결. 기존 격리 fixture의 실제 API·PostgreSQL·Vite를 사용한다.
// 정식 491명 한 기수 인수는 INT-12에서 별도로 검증한다.
test('INT-15 예약 화면의 비용·능력치 점수·상승량이 실제 실행과 같다', async ({ world }) => {
  const user = await world.user('member');
  const { page, userId } = user;
  const db = world.hold.db;
  const initial = commandInitial();
  initial.statRules = { ...FIVE_STAT_RULES };
  initial.nations = initial.nations.map((nation) => ({ ...nation, isNpc: false }));
  initial.cities[0]!.commerce = 1000;
  for (const site of initial.operationalMap!.sites)
    if (site.kind === 'CITY' && site.anchorKey === 1) site.initial.commerce = 1000;
  initial.generals = initial.generals.map((row, index) => ({
    ...row,
    userId: index === 0 ? userId : null,
    leadership: 55,
    strength: 35,
    intel: 50,
    politics: 90,
    charm: 45,
    nextTurnTick: index === 0 ? 60_100 : 1000000,
    crew: 0,
    train: 20,
    atmos: 20,
    injury: 0,
  }));
  const { worldId } = await saveFixtureWorld(db, initial, {
    name: 'INT15 화면 연결',
    turnTermMinutes: 60,
    endYear: null,
  });
  const hold = await holdLease(worldId);
  try {
    await controlClock(db, worldId, 'start');
    const loop = new TurnLoop(hold.db, hold.lease, { beforeCommit: (tx) => renewLease(tx, hold.lease) });
    // 빈 도시 원장에 실제 6월 세수를 적립하고, 100명 모병에 필요한 철을 구입한다.
    await loop.advanceTo(60_000);
    const goods = await db.inputEvent.create({
      data: {
        worldId,
        userId,
        generalId: 1,
        kind: 'logistics.order',
        idempotencyKey: 'int15-iron',
        status: 'PENDING',
        payload: { type: 'trade', cityKey: 1, good: 'iron', side: 'buy', amount: 2 },
      },
    });
    await loop.advanceTo(60_000);
    expect((await db.inputEvent.findUniqueOrThrow({ where: { id: goods.id } })).status).toBe('APPLIED');
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const commands = [
      { commandKey: 'farm', args: {} },
      { commandKey: 'recruit', args: { amount: 100, crewType: 1100 } },
    ];
    await apiMutate(world, user, 'turns.set', {
      worldId,
      revision: actor.turnRevision,
      slots: [...commands, ...Array.from({ length: 28 }, () => null)],
    });
    await page.goto(`/w/${worldId}/turns`);
    const editor = page.getByTestId('turn-editor');
    const row = (slot: number) => editor.locator(`tr[data-slot="${slot}"]`);
    await expect(row(1)).toContainText('능력치 점수 90');
    await expect(row(1)).toContainText('금 100');
    await expect(row(2)).toContainText('금 923');
    await expect(editor.locator('tbody tr')).toHaveCount(30);
    const before = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    await loop.advanceTo(actor.nextTurnTick);
    const after = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    expect(before.gold - after.gold).toBe(100);
    await page.reload();
    await expect(row(1)).toContainText('금 923');
    const cityGold = async () =>
      (await db.$transaction((tx) => loadReplayState(tx, worldId))).state.cityResources!.cities['1']!.gold;
    // 모병 미리보기와 실제 차감의 비교 대상은 장수 금이 아니라 도시 금이다.
    const recruitTick = actor.nextTurnTick + TICKS_PER_MONTH;
    await loop.advanceTo(recruitTick - 1);
    const goldBefore = await cityGold();
    await loop.advanceTo(recruitTick);
    expect(goldBefore - (await cityGold())).toBe(923);
    await page.screenshot({ path: 'test-results/int15-five-stat-preview.png', fullPage: true });
  } finally {
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
