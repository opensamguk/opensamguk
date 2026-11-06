import type { Prisma } from '@opensamguk/db';
import {
  assertNationLifecycle,
  readNationLifecycle,
  type NationLifecycleEffects,
  type WorldView,
} from '@opensamguk/rules';
import { appendNationHistory } from './commandPersistence';

export async function persistNationLifecycle(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
) {
  const original = readNationLifecycle(before.nationLifecycle, before);
  const final = readNationLifecycle(next.nationLifecycle, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중 국가 변천 기능을 바꿀 수 없습니다.');
  assertNationLifecycle(before);
  assertNationLifecycle(next);
  if (JSON.stringify(original) === JSON.stringify(final)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, nationLifecycleState: { equals: original as Prisma.InputJsonValue } },
    data: { nationLifecycleState: final as Prisma.InputJsonValue },
  });
  if (changed.count !== 1) throw new Error('방랑 상태가 바뀌어 저장을 취소했습니다.');
}

export async function persistNationLifecycleMonth(
  tx: Prisma.TransactionClient,
  worldId: string,
  effects: NationLifecycleEffects,
  { tick, sequence }: { tick: number; sequence: number },
) {
  if (effects.reports.length) {
    const last = await tx.generalLog.findFirst({
      where: { worldId, sequence },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });
    let ordinal = Math.max(1, (last?.ordinal ?? 0) + 1);
    await tx.generalLog.createMany({
      data: effects.reports.map((report) => ({
        ...report,
        worldId,
        tick,
        sequence,
        ordinal: ordinal++,
        commandKey: 'disband',
        kind: 'success',
      })),
    });
  }
  for (const entry of effects.history) await appendNationHistory(tx, worldId, tick, entry.nationId, entry.text);
}
