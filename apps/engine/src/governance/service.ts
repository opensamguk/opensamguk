import { decideGovernanceAction, reconcileGovernance } from '@opensamguk/rules';
import type { GovernanceOrder, GovernanceRepository } from './port';

export async function processGovernanceOrder(repository: GovernanceRepository, order: GovernanceOrder) {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (!order.running) return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  if (!(await repository.isUserActive(order.userId))) return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (await repository.isSanctioned(order.worldId, order.userId))
    return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (order.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  const before = await repository.loadForGeneral(order.worldId, order.generalId);
  if (before.generals[order.generalId]?.userId !== order.userId)
    return reject('NOT_OWNER', '현재 사용자의 장수가 아닙니다.');
  const outcome = decideGovernanceAction(before, order.generalId, order.payload, order.tick);
  if (!outcome.ok) return reject(outcome.code, outcome.message);
  await repository.save(order.worldId, before, outcome.state, { tick: order.tick, sequence: order.sequence });
  return { status: 'APPLIED' as const, result: outcome.result };
}

export async function reconcileGovernanceOrder(
  repository: GovernanceRepository,
  worldId: string,
  at: { tick: number; sequence: number },
) {
  const before = await repository.load(worldId),
    next = reconcileGovernance(before, at.tick);
  if (JSON.stringify(before.governance) !== JSON.stringify(next.governance))
    await repository.save(worldId, before, next, at);
}
