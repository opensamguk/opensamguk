import type { Prisma } from './generated/prisma/client';

// 월드 행을 가장 먼저 잠근다. 엔진은 리스 행 뒤에 이 잠금을 잡는다.
// 장수 행을 먼저 잠그면 월간 정산과 교착할 수 있다.
export async function nextActionSequence(tx: Prisma.TransactionClient, worldId: string): Promise<number> {
  const world = await tx.world.update({
    where: { id: worldId },
    data: { actionSequence: { increment: 1 } },
    select: { actionSequence: true },
  });
  return world.actionSequence;
}
