import type { Prisma } from '@opensamguk/db';
import { decideStratagemCardsAction } from '@opensamguk/rules';
import type { QueuedInputHandler } from '../features';
import { databaseNow } from '../lease';
import { loadWorld } from '../worldLoader';
import { persistEffects } from '../persist';

export const processStratagemCardsInput: QueuedInputHandler = async (tx, world, event, context) => {
  if (event.kind !== 'stratagem-cards.act') throw Error('계략 패 입력 종류를 확인하세요.');
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  if ((await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } }))?.status !== 'ACTIVE')
    return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const now = await databaseNow(tx);
  if (
    await tx.sanction.findFirst({
      where: {
        userId: event.userId,
        liftedAt: null,
        AND: [
          { OR: [{ worldId: null }, { worldId: world.id }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      select: { id: true },
    })
  )
    return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId"=${world.id} AND id=${event.generalId} FOR UPDATE`;
  const before = await loadWorld(tx, world.id);
  if (before.generals[event.generalId]?.userId !== event.userId)
    return reject('NOT_OWNER', '현재 사용자의 장수가 아닙니다.');
  const outcome = decideStratagemCardsAction(before, event.generalId, event.payload, context.tick);
  if (!outcome.ok) return reject(outcome.code, outcome.message);
  await persistEffects(tx, world.id, outcome.state, [{ kind: 'world', state: outcome.state }], context, before);
  return { status: 'APPLIED', result: outcome.result as Prisma.InputJsonValue };
};
