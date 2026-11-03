import type { Prisma } from '@opensamguk/db';
import type { QueuedInputHandler } from '../features';
import { PgGovernanceRepository } from './repository';
import { processGovernanceOrder } from './service';

export const processGovernanceInput: QueuedInputHandler = async (tx, world, event, context) => {
  if (event.kind !== 'governance.act') throw new Error('황실 입력 종류를 확인하세요.');
  const result = await processGovernanceOrder(new PgGovernanceRepository(tx), {
    worldId: world.id,
    running: world.status === 'RUNNING',
    userId: event.userId,
    generalId: event.generalId,
    payload: event.payload,
    tick: context.tick,
    sequence: context.sequence,
  });
  return { status: result.status, result: result.result as Prisma.InputJsonValue };
};
