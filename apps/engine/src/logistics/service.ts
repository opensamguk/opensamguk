import { applyLogisticsInput } from '@opensamguk/rules';
import type { LogisticsOrder, LogisticsRepository } from './port';

export async function processLogisticsOrder(repository: LogisticsRepository, order: LogisticsOrder) {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (!order.running) return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  if (!(await repository.isUserActive(order.userId))) return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (await repository.isSanctioned(order.worldId, order.userId))
    return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (order.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  const before = await repository.loadForGeneral(order.worldId, order.generalId);
  const outcome = applyLogisticsInput(before, order.payload, order.generalId, {
    tick: order.tick,
    userId: order.userId,
    userActive: true,
  });
  if (!outcome.ok) return reject(outcome.code, outcome.message);
  await repository.save(order.worldId, before, outcome.state, outcome.result.movements, {
    tick: order.tick,
    sequence: order.sequence,
  });
  return { status: 'APPLIED' as const, result: outcome.result };
}
