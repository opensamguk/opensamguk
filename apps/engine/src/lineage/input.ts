import type { Prisma } from '@opensamguk/db';
import type { QueuedInputHandler } from '../features';
import { PgLineageRepository } from './repository';
import { processLineageOrder } from './service';

export const processLineageInput: QueuedInputHandler = async (tx, world, event, context) => {
  if (event.kind !== 'lineage.act') throw Error('가문 입력 종류를 확인하세요.');
  const outcome = await processLineageOrder(new PgLineageRepository(tx), {
    worldId: world.id,
    running: world.status === 'RUNNING',
    userId: event.userId,
    generalId: event.generalId,
    payload: event.payload,
    tick: context.tick,
    sequence: context.sequence,
  });
  return { status: outcome.status, result: outcome.result as Prisma.InputJsonValue };
};
