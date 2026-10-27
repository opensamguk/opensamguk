import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import { readCampaignState, type CampaignState, type WorldView } from '@opensamguk/rules';

// 같은 World 행 잠금 아래 호출한다. General.crew와 부곡에 병력을 중복 저장하지 않는다.
export function readStoredCampaign(value: unknown, world: WorldView, seed: string): CampaignState | undefined {
  if (!world.ruleFeatures?.includes('campaign-v1')) {
    if (value !== null && value !== undefined) throw new Error('휘하 기능을 끈 월드에 부곡 저장 상태가 있습니다.');
    return undefined;
  }
  if (Object.values(world.generals).some((general) => general.crew !== 0))
    throw new Error('부곡 월드의 General.crew에 병력을 중복 저장할 수 없습니다.');
  return readCampaignState(value, world, seed);
}

// 전후 값은 같은 World 잠금·리스 펜싱 트랜잭션의 스냅샷이어야 한다.
// CAS가 어긋나면 일부 상태를 덮어쓰지 않고 호출자의 전체 턴을 롤백한다.
export async function persistCampaignState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
): Promise<void> {
  const original = before.campaign,
    final = next.campaign;
  if (!original && !final) {
    if (before.ruleFeatures?.includes('campaign-v1') || next.ruleFeatures?.includes('campaign-v1'))
      throw new Error('휘하 기능을 켠 월드의 저장 상태가 없습니다.');
    return;
  }
  if (!original || !final) throw new Error('진행 중인 월드의 휘하 기능을 추가하거나 지울 수 없습니다.');
  const originalState = readStoredCampaign(original, before, original.seed);
  const finalState = readStoredCampaign(final, next, original.seed);
  if (isDeepStrictEqual(originalState, finalState)) return;
  const changed = await tx.$executeRaw`
    UPDATE "World" SET "campaignState" = ${JSON.stringify(finalState)}::jsonb
    WHERE id = ${worldId} AND "campaignState" = ${JSON.stringify(originalState)}::jsonb
  `;
  if (changed !== 1) throw new Error('저장할 휘하 상태가 바뀌었습니다.');
}
