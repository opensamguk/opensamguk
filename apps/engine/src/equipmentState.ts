import type { Prisma } from '@opensamguk/db';
import { readEquipmentState, type WorldView } from '@opensamguk/rules';

// World 행 잠금을 가진 호출자의 같은 트랜잭션에서 CAS로 쓴다.
export async function persistEquipmentState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  if (!before.ruleFeatures?.includes('equipment-v1') && !next.ruleFeatures?.includes('equipment-v1')) {
    if (before.equipment !== undefined || next.equipment !== undefined)
      throw new Error('장비 기능을 끈 월드에 상태가 있습니다.');
    return;
  }
  if (
    !before.equipment ||
    !next.equipment ||
    !before.ruleFeatures?.includes('equipment-v1') ||
    !next.ruleFeatures?.includes('equipment-v1')
  )
    throw new Error('진행 중 장비 기능을 바꿀 수 없습니다.');
  const original = readEquipmentState(before.equipment, before),
    final = readEquipmentState(next.equipment, next);
  if (JSON.stringify(original.config) !== JSON.stringify(final.config))
    throw new Error('진행 중 장비 설정을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, equipmentState: { equals: original as Prisma.InputJsonValue } },
    data: { equipmentState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('장비 상태가 바뀌어 저장을 취소했습니다.');
}
