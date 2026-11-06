import type { Prisma } from '@opensamguk/db';
import { readNationStrategy, type WorldView } from '@opensamguk/rules';
// 같은 World 행 잠금과 명령·월 정산 트랜잭션에서 CAS로 저장한다.
export async function persistNationStrategy(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  const original = readNationStrategy(before.nationStrategy, before),
    final = readNationStrategy(next.nationStrategy, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중 전략 기능을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, nationStrategyState: { equals: original as Prisma.InputJsonValue } },
    data: { nationStrategyState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('전략 대기 상태가 바뀌어 저장을 취소했습니다.');
}
