import type { Prisma } from '@opensamguk/db';
import type { QueuedInputHandler } from '../features';
import { PgLogisticsRepository } from './repository';
import { processLogisticsOrder } from './service';

export const processLogisticsInput: QueuedInputHandler = async (tx, world, event, context) => {
  if (event.kind !== 'logistics.order') throw new Error('물류 입력 종류를 확인하세요.');
  const result = await processLogisticsOrder(new PgLogisticsRepository(tx), {
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
