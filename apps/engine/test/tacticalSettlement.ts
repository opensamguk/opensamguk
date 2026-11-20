import type { PrismaClient } from '@opensamguk/db';
import { processTacticalStep } from '../src/tacticalBattle';
import { loadWorld } from '../src/worldLoader';

// 게임 tick을 움직이지 않고 실제 엔진으로 예약 전투의 각 창을 마감한다.
export async function settlePendingBattle(db: PrismaClient, worldId: string) {
  for (let step = 0; step < 40; step++) {
    const state = await db.$transaction((tx) => loadWorld(tx, worldId));
    const battle = state.campaign?.tactical?.battles.find((row) => !row.settled);
    if (!battle) return;
    if (battle.fault) throw Error(battle.fault);
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await processTacticalStep(tx, world, new Date(Math.max(Date.now(), battle.deadlineAt)));
      },
      { timeout: 30_000 },
    );
  }
  throw Error('전술 전투가 40회 안에 정산되지 않았습니다.');
}
