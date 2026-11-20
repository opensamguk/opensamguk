import type { Prisma } from '@opensamguk/db';
import type { QueuedInputHandler } from '../features';
import { PgLineageRepository } from './repository';
import { processLineageOrder } from './service';

// 순환 import 중 등록표가 읽을 수 있도록 함수 선언으로 둔다.
export function processLineageInput(...args: Parameters<QueuedInputHandler>): ReturnType<QueuedInputHandler> {
  return handleLineageInput(...args);
}
const handleLineageInput: QueuedInputHandler = async (tx, world, event, context) => {
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
