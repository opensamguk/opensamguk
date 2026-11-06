import type { Prisma } from '@opensamguk/db';
import { creationSettings, type RecordedInput } from '@opensamguk/rules';

// 초기화 출처 검사에만 쓰며 실행 중인 시계·규칙은 생성 당시 값으로 되돌리지 않는다.
export async function readCreationWorld(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
) {
  if (world.replayFormat !== 3) return world;
  const rows = await tx.inputEvent.findMany({
    where: {
      worldId: world.id,
      status: 'APPLIED',
      kind: { in: ['admin.world.rename', 'admin.world.setEndYear', 'admin.world.setTurnTerm'] },
    },
    select: { sequence: true, tick: true, generalId: true, kind: true, status: true, payload: true, result: true },
    orderBy: { sequence: 'asc' },
  });
  const inputs = rows.map((row) => ({
    ...row,
    sequence: row.sequence!,
    status: 'APPLIED' as const,
  })) as RecordedInput[];
  return { ...world, ...creationSettings(world, inputs) };
}
