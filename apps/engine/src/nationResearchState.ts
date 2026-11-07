import type { Prisma } from '@opensamguk/db';
import { readNationResearch, type WorldView } from '@opensamguk/rules';

export async function persistNationResearch(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  const original = readNationResearch(before.nationResearch, before),
    final = readNationResearch(next.nationResearch, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중 병종 연구 기능을 바꿀 수 없습니다.');
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, nationResearchState: { equals: original as Prisma.InputJsonValue } },
    data: { nationResearchState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('병종 연구 상태가 바뀌어 저장을 취소했습니다.');
}
