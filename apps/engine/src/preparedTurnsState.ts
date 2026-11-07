import type { Prisma } from '@opensamguk/db';
import { readPreparedTurns, type WorldView } from '@opensamguk/rules';

export async function persistPreparedTurns(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  const original = readPreparedTurns(before.preparedTurns, before),
    final = readPreparedTurns(next.preparedTurns, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중 명령 준비 기능을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, preparedTurnsState: { equals: original as Prisma.InputJsonValue } },
    data: { preparedTurnsState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('명령 준비 상태가 바뀌어 저장을 취소했습니다.');
}
