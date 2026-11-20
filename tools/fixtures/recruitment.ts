import { logisticsConfigSchema, providedRuleData, type WorldInit } from '../../packages/rules/src/index';
import type { PrismaClient } from '../../packages/db/src/index';
import { acquireLease, releaseLease, renewLease } from '../../apps/engine/src/lease';
import { TurnLoop } from '../../apps/engine/src/turnLoop';
import { recordTestTurns } from '../../apps/engine/test/seasonFixture';

// 모병 조건·휘하 시험은 물류 재고 준비와 분리하되 생성 기록에도 같은 비용 설정을 남긴다.
export function recruitmentFixtureData(initial: WorldInit) {
  const logistics = logisticsConfigSchema.parse(providedRuleData(initial, 60)['logistics-v1']);
  logistics.recruitPer100 = Object.fromEntries(
    Object.keys(logistics.recruitPer100).map((key) => [key, { iron: 0, wood: 0, horses: 0 }]),
  );
  return { 'logistics-v1': logistics };
}

// 실제 1명 모집으로 자기 부곡을 준비한다. 소집해제는 부곡을 삭제하므로 빈 부곡을 만들지 않는다.
export async function prepareFixtureUnit(db: PrismaClient, worldId: string, generalId: number, crewType = 1100) {
  const lease = await acquireLease(db, worldId, undefined, 120_000);
  if (!lease) throw new Error('모병 고정물 실행권이 없습니다.');
  try {
    const loop = new TurnLoop(db, lease, { beforeCommit: (tx) => renewLease(tx, lease) });
    await recordTestTurns(db, worldId, generalId, 'recruit', { amount: 1, crewType, unitId: 'new' });
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    await loop.advanceTo(actor.nextTurnTick);
    const state = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).campaignState as unknown as {
      units: Array<{ id: number; ownerId: number; troops: number }>;
    };
    const unit = state.units.find((unit) => unit.ownerId === generalId);
    if (!unit || unit.troops !== 1) throw new Error('실제 1명 모집 고정물 준비가 실패했습니다.');
    return unit.id;
  } finally {
    await releaseLease(db, lease);
  }
}
