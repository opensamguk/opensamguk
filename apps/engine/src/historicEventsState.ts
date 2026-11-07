import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import { readHistoricEventsState, type ReplayState } from '@opensamguk/rules';

// 호출자는 월드 행 잠금을 잡고 사건 효과와 같은 트랜잭션에서 저장한다.
export async function persistHistoricEventsState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: ReplayState,
  next: ReplayState,
) {
  const original = before.historicEvents;
  const candidate = next.historicEvents;
  if (!original && !candidate) return;
  if (
    !original ||
    !candidate ||
    before.state.startYear !== next.state.startYear ||
    !isDeepStrictEqual(original.config, candidate.config)
  )
    throw new Error('진행 중 역사 사건 설정을 바꿀 수 없습니다.');
  const config = original.config;
  const stored = readHistoricEventsState(original.state, config, before.state.startYear, before.monthlyTick);
  const updated = readHistoricEventsState(candidate.state, config, next.state.startYear, next.monthlyTick);
  if (isDeepStrictEqual(stored, updated)) return;
  const changed = await tx.world.updateMany({
    where: { id: worldId, monthlyTick: before.monthlyTick, historicEventsState: { equals: stored } },
    data: { historicEventsState: updated },
  });
  if (changed.count !== 1) throw new Error('역사 사건 상태가 바뀌어 저장을 취소했습니다.');
}
