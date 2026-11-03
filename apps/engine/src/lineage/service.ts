import { decideLineageAction, lineageControlRevisions, resetLineageControl, reconcileLineage } from '@opensamguk/rules';
import type { LineageOrder, LineageRepository } from './port';

export async function processLineageOrder(repository: LineageRepository, order: LineageOrder) {
  const reject = (code: string, message: string, reason?: string) => ({
    status: 'REJECTED' as const,
    result: { code, message, ...(reason === undefined ? {} : { reason }) },
  });
  if (!order.running) return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  if (!(await repository.isUserActive(order.userId))) return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (await repository.isSanctioned(order.worldId, order.userId))
    return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (order.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  const before = await repository.loadForGeneral(order.worldId, order.generalId);
  if (before.state.generals[order.generalId]?.userId !== order.userId)
    return reject('NOT_OWNER', '현재 사용자의 장수가 아닙니다.');
  const outcome = decideLineageAction(before.state, order.generalId, order.payload, order.tick);
  if (!outcome.ok) return reject(outcome.code, outcome.message, outcome.reason);
  const at = { tick: order.tick, sequence: order.sequence };
  if (outcome.result.action === 'succession.confirm') {
    const toId = outcome.result.successorId!;
    const revisions = lineageControlRevisions(before.revisions[order.generalId]!, before.revisions[toId]!);
    if (!revisions.ok) return reject(revisions.code, revisions.message);
    const next = resetLineageControl(
      before,
      { ...before, state: outcome.world },
      order.generalId,
      toId,
      'HUMAN',
      order.tick,
    );
    await repository.saveControl(order.worldId, before, next, order.generalId, toId, at);
  } else await repository.save(order.worldId, before.state, outcome.world, at);
  return { status: 'APPLIED' as const, result: outcome.result };
}

export async function reconcileLineageOrder(
  repository: LineageRepository,
  worldId: string,
  at: { tick: number; sequence: number },
) {
  const before = await repository.load(worldId),
    next = reconcileLineage(before, at.tick);
  if (JSON.stringify(before.lineage) !== JSON.stringify(next.lineage)) await repository.save(worldId, before, next, at);
}
