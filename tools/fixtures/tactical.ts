import type { PrismaClient } from '../../packages/db/src/index';
import { acquireLease, assertLease, releaseLease } from '../../apps/engine/src/lease';
import { settlePendingBattle } from '../../apps/engine/test/tacticalSettlement';
import { commandInitial } from '../../packages/rules/test/commandFixture';

// AC-INT-09 / AC-M2-03: 전술 배치에 필요한 세 칸 이상을 갖춘 합성 지도다.
export function tacticalCommandInitial() {
  const initial = commandInitial();
  for (const city of initial.cities) {
    city.x = city.cityKey * 64;
    city.y = 64;
  }
  for (const site of initial.operationalMap!.sites) {
    if (site.kind !== 'CITY') continue;
    const city = initial.cities.find((city) => city.cityKey === site.anchorKey)!;
    site.position = { x: city.x, y: city.y };
  }
  return initial;
}

// AC-INT-09 / AC-M1-14: 실제 정산·battle.step 원장을 쓰되 회의 마감까지 벽시계로 기다리지 않는다.
export async function settleFixtureBattles(db: PrismaClient, worldId: string) {
  const lease = await acquireLease(db, worldId, undefined, 120_000);
  if (!lease) throw Error('전술 고정물 실행권이 없습니다.');
  try {
    await settlePendingBattle(db, worldId);
    await assertLease(db, lease);
  } finally {
    await releaseLease(db, lease);
  }
}
